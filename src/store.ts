// SQLite-backed state. Two concerns:
//   invite_codes  - one row per issued code; single-use claim is atomic.
//   spent_tokens  - redeemed token hashes; double-spend guard is atomic.
//
// better-sqlite3 is synchronous, which is exactly what we want for the
// check-and-set primitives (no interleaving inside a single statement).

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CodeRow {
  code: string;
  quota: number;
  used: number;
  created_at: number;
  used_at: number | null;
  // Faucet codes: `daily` tokens accrue per accrual period, capped at `quota`,
  // and every redemption dispenses all that has built up. daily = 0 is an
  // ordinary single-use code (quota is the one-shot batch size). accrued_at is
  // the moving low-water mark the accrual is measured from.
  daily: number;
  accrued_at: number | null;
}

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS invite_codes (
        code       TEXT PRIMARY KEY,
        quota      INTEGER NOT NULL,
        used       INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        used_at    INTEGER
      );
      CREATE TABLE IF NOT EXISTS spent_tokens (
        epoch    TEXT NOT NULL,
        hash     TEXT NOT NULL,
        spent_at INTEGER NOT NULL,
        PRIMARY KEY (epoch, hash)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        points     INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    // Migrate older databases that predate faucet codes.
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(invite_codes)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    if (!cols.has('daily')) {
      this.db.exec('ALTER TABLE invite_codes ADD COLUMN daily INTEGER NOT NULL DEFAULT 0');
    }
    if (!cols.has('accrued_at')) {
      this.db.exec('ALTER TABLE invite_codes ADD COLUMN accrued_at INTEGER');
    }
  }

  // ---- invite codes -------------------------------------------------------

  // Create a single-use code (daily = 0, quota = one-shot batch size) or a
  // faucet code (daily > 0: `daily` tokens accrue per period up to a cap of
  // `quota`). A faucet starts "full" — accrued_at is backdated so the first
  // redemption yields the whole cap, then it refills at `daily` per period.
  createCode(code: string, quota: number, daily = 0, periodMs = 86_400_000): void {
    const now = Date.now();
    const accruedAt =
      daily > 0 ? now - Math.ceil((quota / daily) * periodMs) : null;
    this.db
      .prepare(
        'INSERT INTO invite_codes (code, quota, created_at, daily, accrued_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(code, quota, now, daily, accruedAt);
  }

  getCode(code: string): CodeRow | undefined {
    return this.db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code) as
      | CodeRow
      | undefined;
  }

  listCodes(): CodeRow[] {
    return this.db
      .prepare('SELECT * FROM invite_codes ORDER BY created_at DESC')
      .all() as CodeRow[];
  }

  // Delete an unused code. Returns true if it was removed (spent codes stay).
  revokeCode(code: string): boolean {
    return (
      this.db.prepare('DELETE FROM invite_codes WHERE code = ? AND used = 0').run(code)
        .changes === 1
    );
  }

  // How many tokens a code can dispense right now: the full batch for an unused
  // single-use code, or the accrued-and-capped amount for a faucet code (0 once
  // a single-use code is spent, or before a faucet has built anything up).
  availableTokens(row: CodeRow, periodMs: number, now = Date.now()): number {
    if (row.daily <= 0) return row.used ? 0 : row.quota;
    const at = row.accrued_at ?? row.created_at;
    const accrued = Math.floor(((now - at) / periodMs) * row.daily);
    return Math.max(0, Math.min(row.quota, accrued));
  }

  // Check a code is usable for a batch of `batchSize` tokens WITHOUT consuming
  // it. The handler signs first, then consumes — so a signing failure never
  // burns the code. 'empty' = a faucet code with nothing accrued yet.
  validateForIssue(
    code: string,
    batchSize: number,
    periodMs: number,
  ): 'ok' | 'unknown' | 'used' | 'empty' | 'over_quota' {
    const row = this.getCode(code);
    if (!row) return 'unknown';
    const available = this.availableTokens(row, periodMs);
    if (row.daily <= 0 && row.used) return 'used';
    if (row.daily > 0 && available < 1) return 'empty';
    if (batchSize < 1 || batchSize > available) return 'over_quota';
    return 'ok';
  }

  // Consume a code for `batchSize` tokens after signing. Single-use codes flip
  // to used; faucet codes advance their accrual low-water mark by the dispensed
  // amount's worth of time (keeping the sub-token remainder). Both are atomic
  // check-and-set: a false return means a concurrent redemption won the race
  // (or the faucet drained below batchSize meanwhile) → caller 409s.
  consumeForIssue(code: string, batchSize: number, periodMs: number): boolean {
    const row = this.getCode(code);
    if (!row) return false;
    if (row.daily <= 0) return this.markUsed(code);

    // Advance accrued_at by batchSize/daily periods, but only if the (uncapped)
    // accrual still covers the batch — guarding against a concurrent claim.
    const advance = Math.floor((batchSize / row.daily) * periodMs);
    return (
      this.db
        .prepare(
          `UPDATE invite_codes
           SET accrued_at = COALESCE(accrued_at, created_at) + ?
           WHERE code = ? AND daily > 0
             AND (? - COALESCE(accrued_at, created_at)) * daily >= ? * ?`,
        )
        .run(advance, code, Date.now(), batchSize, periodMs).changes === 1
    );
  }

  // Atomically mark a single-use code used. Returns false if it was already used
  // (a concurrent activation won the race) so the caller can 409.
  markUsed(code: string): boolean {
    return (
      this.db
        .prepare('UPDATE invite_codes SET used = 1, used_at = ? WHERE code = ? AND used = 0')
        .run(Date.now(), code).changes === 1
    );
  }

  // ---- spent tokens -------------------------------------------------------

  // Atomic double-spend check: true iff this hash was newly recorded.
  trySpend(epoch: string, hash: string): boolean {
    return (
      this.db
        .prepare('INSERT OR IGNORE INTO spent_tokens (epoch, hash, spent_at) VALUES (?, ?, ?)')
        .run(epoch, hash, Date.now()).changes === 1
    );
  }

  // ---- points-metered sessions -------------------------------------------

  // Read a session's remaining points without spending (for /pp/points).
  getSessionPoints(id: string): number | null {
    const row = this.db.prepare('SELECT points FROM sessions WHERE id = ?').get(id) as
      | { points: number }
      | undefined;
    return row ? row.points : null;
  }

  createSession(id: string, points: number): void {
    this.db
      .prepare('INSERT INTO sessions (id, points, created_at) VALUES (?, ?, ?)')
      .run(id, points, Date.now());
  }

  // Atomically ADD points to an existing session (a proactive top-up: the SW
  // redeems a token to keep a live session funded so media requests — which
  // bypass the SW and can't self-renew — keep riding it). Returns the new
  // balance, or null if the session doesn't exist (caller opens a fresh one).
  topUpSession(id: string, delta: number): number | null {
    const row = this.db
      .prepare('UPDATE sessions SET points = points + ? WHERE id = ? RETURNING points')
      .get(delta, id) as { points: number } | undefined;
    return row ? row.points : null;
  }

  // Atomically draw `cost` points from a session. Returns the remaining balance,
  // or null if the session is unknown or can't cover the cost (caller then falls
  // back to a token). RETURNING makes the debit-and-read a single statement.
  spendSession(id: string, cost: number): number | null {
    const row = this.db
      .prepare(
        'UPDATE sessions SET points = points - ? WHERE id = ? AND points >= ? RETURNING points',
      )
      .get(cost, id, cost) as { points: number } | undefined;
    return row ? row.points : null;
  }

  // Sweep sessions that can't fund another request or are past max age.
  cleanupSessions(minPoints: number, maxAgeMs: number): number {
    return this.db
      .prepare('DELETE FROM sessions WHERE points < ? OR created_at < ?')
      .run(minPoints, Date.now() - maxAgeMs).changes;
  }
}
