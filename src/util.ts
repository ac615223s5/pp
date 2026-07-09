// Small encoding helpers shared by the server and admin CLI.

import { createHash, randomBytes } from 'node:crypto';

export function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function b64urlDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

export function sha256hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Unambiguous alphabet (no I/O/0/1).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Invite-code string: 15 random chars grouped 5-5-5 for readability. Used by
// the admin CLI and by BTCPay purchase fulfillment.
export function generateCode(): string {
  const bytes = randomBytes(15);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  return [chars.slice(0, 5), chars.slice(5, 10), chars.slice(10, 15)]
    .map((g) => g.join(''))
    .join('-');
}

// 128-bit random claim token (hex) — the bearer credential in a purchase's
// claim URL. Same idiom as session ids in server.ts.
export function generateClaimToken(): string {
  return randomBytes(16).toString('hex');
}
