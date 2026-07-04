// Blind RSA (RFC 9474/9578, token type 2) key management.
//
// One epoch for this initial version: a single keypair, generated on first run
// and persisted to KEY_DIR. Verification uses only the current key. Rotation
// overlap (current + previous) is intentionally deferred (see README).
//
// The CryptoKey pair is stored as raw PKCS8/SPKI. RFC 9474 fixes RSABSSA to
// SHA-384, so we re-import with that hash. `getPublicKeyBytes` converts the
// RSA-PSS public key into the on-the-wire "token-key" the client blinds against.

import { publicVerif } from '@cloudflare/privacypass-ts';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { sha256hex } from './util.js';

const { BlindRSAMode, Issuer, getPublicKeyBytes } = publicVerif;

export const MODE = BlindRSAMode.PSS;

export interface IssuerState {
  // Verification stays on the library (CryptoKey, RSA-PSS).
  publicKey: CryptoKey;
  // Signing is a raw RSA private op done with node:crypto for speed — the
  // library's JS blindSign is ~350ms/token, native privateDecrypt is ~1ms and
  // byte-identical. See pp.ts.
  privateKey: KeyObject;
  publicKeyBytes: Uint8Array; // wire token-key
  epoch: string; // stable id derived from the public key
  // HMAC key for signing operator bypass cookies. Derived from the private key,
  // so it survives restarts but a key rotation (new keypair) invalidates every
  // outstanding bypass cookie too — same epoch semantics as tokens.
  bypassSecret: Buffer;
}

const subtle = globalThis.crypto.subtle;

// issuerName is no longer needed for signing (verify ignores origin binding),
// but the parameter is kept so callers don't have to change.
export async function loadOrCreateIssuer(
  keyDir: string,
  _issuerName?: string,
): Promise<IssuerState> {
  const privPath = join(keyDir, 'priv.pkcs8');
  const pubPath = join(keyDir, 'pub.spki');

  let privPkcs8: Uint8Array;
  let publicKey: CryptoKey;

  if (existsSync(privPath) && existsSync(pubPath)) {
    privPkcs8 = new Uint8Array(readFileSync(privPath));
    publicKey = await subtle.importKey(
      'spki',
      new Uint8Array(readFileSync(pubPath)),
      { name: 'RSA-PSS', hash: 'SHA-384' },
      true,
      ['verify'],
    );
  } else {
    const keys = await Issuer.generateKey(MODE, {
      modulusLength: 2048,
      publicExponent: Uint8Array.from([1, 0, 1]),
    });
    privPkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', keys.privateKey));
    const pubSpki = new Uint8Array(await subtle.exportKey('spki', keys.publicKey));
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    writeFileSync(privPath, privPkcs8, { mode: 0o600 });
    writeFileSync(pubPath, pubSpki, { mode: 0o600 });
    publicKey = keys.publicKey;
  }

  const privateKey = createPrivateKey({ key: Buffer.from(privPkcs8), format: 'der', type: 'pkcs8' });
  const publicKeyBytes = await getPublicKeyBytes(publicKey);
  const epoch = sha256hex(publicKeyBytes).slice(0, 16);
  const bypassSecret = createHash('sha256')
    .update(Buffer.from(privPkcs8))
    .update('pp-bypass-secret-v1')
    .digest();
  return { publicKey, privateKey, publicKeyBytes, epoch, bypassSecret };
}
