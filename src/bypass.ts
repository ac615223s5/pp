// Operator bypass cookie: a stateless, HMAC-signed token that lets a device
// skip token/session metering entirely. Entered as a password on the activation
// page (see /pp/bypass in server.ts); the cookie is what the verifier trusts.
//
// Value format: `<expiryMs>.<hmacHex>` where hmac = HMAC-SHA256(secret, expiryMs).
// Stateless by design — no DB row, so nothing to sweep and no link to persist.
// The secret is derived from the issuer private key (see keys.ts), so a key
// rotation invalidates every outstanding bypass cookie, matching token epochs.

import { createHmac, timingSafeEqual } from 'node:crypto';

function sign(secret: Buffer, expiry: string): string {
  return createHmac('sha256', secret).update(`bypass|${expiry}`).digest('hex');
}

// Mint a fresh bypass cookie value valid for `maxAgeMs` from now.
export function mintBypassCookie(secret: Buffer, maxAgeMs: number): string {
  const expiry = String(Date.now() + maxAgeMs);
  return `${expiry}.${sign(secret, expiry)}`;
}

// True iff `value` is a well-formed, unexpired, correctly-signed bypass cookie.
// Constant-time on the signature to avoid leaking it byte-by-byte.
export function verifyBypassCookie(secret: Buffer, value: string | null): boolean {
  if (!value) return false;
  const dot = value.indexOf('.');
  if (dot < 1) return false;
  const expiry = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  const expiryMs = Number(expiry);
  if (!Number.isFinite(expiryMs) || expiryMs < Date.now()) return false;
  const expected = sign(secret, expiry);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
