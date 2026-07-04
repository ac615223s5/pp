// Thin facade over the Privacy Pass primitives + the spent-set store.
// The invite-code gate is NOT here: the issuer just blind-signs. Callers
// (server.ts) enforce the code before asking to sign a batch.

import { AuthorizationHeader, TOKEN_TYPES, publicVerif } from '@cloudflare/privacypass-ts';
import { privateDecrypt, constants } from 'node:crypto';
import { MODE, type IssuerState } from './keys.js';
import type { Store } from './store.js';
import { b64urlDecode, b64urlEncode, sha256hex } from './util.js';

const { Origin, TokenRequest } = publicVerif;

export type VerifyResult =
  | { status: 'ok' }
  | { status: 'invalid' } // no/garbled token or bad signature
  | { status: 'spent' }; // valid signature but already redeemed

export class PP {
  private origin: InstanceType<typeof Origin>;

  constructor(
    private state: IssuerState,
    private store: Store,
  ) {
    // No origin binding is enforced by verify(); mode is all we need.
    this.origin = new Origin(MODE);
  }

  // RFC 9578 issuer-directory document served at /pp/token-key.
  tokenKeyDirectory() {
    return {
      'issuer-request-uri': '/pp/issue',
      'token-keys': [
        {
          'token-type': TOKEN_TYPES.BLIND_RSA.value,
          'token-key': b64urlEncode(this.state.publicKeyBytes),
          'not-before': 0,
        },
      ],
    };
  }

  // Blind-sign a batch of serialized TokenRequests (base64url). Returns the
  // blind signatures (base64url), one per input, same order.
  //
  // RSABSSA blindSign is a raw RSA private-key operation on the already-blinded
  // message: s = m^d mod n. node:crypto's privateDecrypt with RSA_NO_PADDING
  // does exactly that in ~1ms — the library's pure-JS blindSign is ~350ms and
  // produces byte-identical output. A TokenResponse serializes to just these
  // signature bytes, which is what the client's finalize() expects.
  issueBatch(blindedB64: string[]): string[] {
    return blindedB64.map((b64) => {
      const req = TokenRequest.deserialize(TOKEN_TYPES.BLIND_RSA, b64urlDecode(b64));
      const sig = privateDecrypt(
        { key: this.state.privateKey, padding: constants.RSA_NO_PADDING },
        Buffer.from(req.blindedMsg),
      );
      return b64urlEncode(new Uint8Array(sig));
    });
  }

  // Verify an `Authorization: PrivateToken token=...` header value, then
  // atomically record the token as spent. Signature-valid but replayed tokens
  // return 'spent'.
  async verifyHeader(headerValue: string | undefined): Promise<VerifyResult> {
    if (!headerValue) return { status: 'invalid' };
    let token;
    try {
      const parsed = AuthorizationHeader.parse(TOKEN_TYPES.BLIND_RSA, headerValue);
      if (parsed.length === 0) return { status: 'invalid' };
      token = parsed[0].token;
    } catch {
      return { status: 'invalid' };
    }

    const ok = await this.origin.verify(token, this.state.publicKey);
    if (!ok) return { status: 'invalid' };

    const hash = sha256hex(token.serialize());
    const fresh = this.store.trySpend(this.state.epoch, hash);
    return fresh ? { status: 'ok' } : { status: 'spent' };
  }
}
