// Operator CLI for invite codes. Run inside the container, e.g.:
//   docker compose exec privacy-pass node dist/admin.js new-code --quota 500
//   docker compose exec privacy-pass node dist/admin.js new-code --quota 500 --count 10
//   docker compose exec privacy-pass node dist/admin.js new-code --daily 50 --cap 500
//   docker compose exec privacy-pass node dist/admin.js list-codes
//   docker compose exec privacy-pass node dist/admin.js revoke-code XXXXX-XXXXX-XXXXX
//
// Balance codes (--quota N) hold a shared pool of N tokens, drawn in capped
// batches across devices/sites until empty. Faucet codes (--daily N) accrue N
// tokens per day up to a cap (--cap, default the quota default) and dispense
// capped draws of whatever has built up each time they're entered.

import { config } from './config.js';
import { Store } from './store.js';
import { generateCode } from './util.js';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function main() {
  const cmd = process.argv[2];
  const store = new Store(config.dbPath);

  switch (cmd) {
    case 'new-code': {
      // Faucet code when --daily is given; --cap (default quota default) is the
      // accumulation ceiling stored in the quota column. Otherwise a balance
      // code with --quota tokens.
      const dailyArg = argValue('--daily');
      const daily = dailyArg !== undefined ? Number(dailyArg) : 0;
      if (dailyArg !== undefined && (!Number.isInteger(daily) || daily < 1)) {
        console.error('daily must be a positive integer');
        process.exit(1);
      }
      const quotaArg = daily > 0 ? argValue('--cap') : argValue('--quota');
      const quota = Number(quotaArg ?? config.quotaDefault);
      if (!Number.isInteger(quota) || quota < 1) {
        console.error(`${daily > 0 ? 'cap' : 'quota'} must be a positive integer`);
        process.exit(1);
      }
      const count = Number(argValue('--count') ?? 1);
      if (!Number.isInteger(count) || count < 1) {
        console.error('count must be a positive integer');
        process.exit(1);
      }
      const label = daily > 0 ? `faucet ${daily}/day, cap ${quota}` : `quota ${quota}`;
      for (let i = 0; i < count; i++) {
        const code = generateCode();
        store.createCode(code, quota, daily, config.accrualPeriodMs);
        // Shareable activation link (prefills the code; user still clicks Activate).
        console.log(`${code}  (${label})  ${config.gatedOrigin}/pp/activate?code=${code}`);
      }
      break;
    }
    case 'list-codes': {
      const rows = store.listCodes();
      if (rows.length === 0) {
        console.log('(no codes)');
        break;
      }
      for (const r of rows) {
        if (r.daily > 0) {
          const avail = store.availableTokens(r, config.accrualPeriodMs);
          console.log(`${r.code}  faucet=${r.daily}/day  cap=${r.quota}  available=${avail}`);
        } else {
          const state = r.drawn >= r.quota ? 'EXHAUSTED' : r.drawn > 0 ? 'partial' : 'unused';
          console.log(
            `${r.code}  quota=${r.quota}  drawn=${r.drawn}  remaining=${r.quota - r.drawn}  ${state}`,
          );
        }
      }
      break;
    }
    case 'list-purchases': {
      // Operator recovery for BTCPay purchases: when a buyer loses the claim
      // URL, match their BTCPay invoice id (or payment time) here and re-send
      // the claim link — or the code directly once settled.
      const rows = store.listPurchases();
      if (rows.length === 0) {
        console.log('(no purchases)');
        break;
      }
      for (const r of rows) {
        console.log(
          `${r.invoice_id}  ${r.package_id}  ${r.status}  tokens=${r.tokens}  ` +
            `claim: ${config.gatedOrigin}/pp/claim?ct=${r.claim_token}  code: ${r.code ?? '-'}`,
        );
      }
      break;
    }
    case 'merge-code': {
      // Fold one balance code's remaining tokens into another (same operation
      // users can do on the activation page via /pp/merge).
      const from = process.argv[3];
      const into = process.argv[4];
      if (!from || !into) {
        console.error('usage: merge-code <from> <into>');
        process.exit(1);
      }
      const result = store.mergeCodes(from, into);
      console.log(
        result.ok
          ? `merged ${result.merged} tokens into ${into} (now ${result.remaining} remaining); ${from} is dead`
          : `not merged (${result.error})`,
      );
      break;
    }
    case 'revoke-code': {
      const code = process.argv[3];
      if (!code) {
        console.error('usage: revoke-code <code>');
        process.exit(1);
      }
      const ok = store.revokeCode(code);
      console.log(ok ? `revoked ${code}` : `not revoked (unknown or fully drawn): ${code}`);
      break;
    }
    case 'bypass-link': {
      // Convenience: print the activation link that prefills the bypass password.
      // The password lives in the environment (PP_BYPASS_PASSWORD), not the db.
      if (!config.bypassPassword) {
        console.error('bypass disabled — set PP_BYPASS_PASSWORD in .env and restart');
        process.exit(1);
      }
      const pw = encodeURIComponent(config.bypassPassword);
      console.log(`link: ${config.gatedOrigin}/pp/activate?pw=${pw}`);
      console.log('(password reusable, unlimited, unlinkable it is NOT — share privately)');
      break;
    }
    default:
      console.error(
        'commands: new-code [--quota N | --daily N [--cap N]] [--count N] | list-codes | list-purchases | merge-code <from> <into> | revoke-code <code> | bypass-link',
      );
      process.exit(1);
  }
}

main();
