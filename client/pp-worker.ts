// Web Worker: does the CPU-heavy blind-RSA client math off the main thread so
// activation parallelises across cores. One worker owns a contiguous shard of
// the batch. It MUST keep its Client instances between the two phases because
// finalize() needs the blind state created by createTokenRequest():
//
//   main -> {blind}    -> worker generates its shard's blinded requests
//   main <- {blinded}
//   (main POSTs the whole batch to /pp/issue, gets signatures)
//   main -> {finalize} -> worker unblinds its shard using the retained Clients
//   main <- {finalized}

import { TokenChallenge, TOKEN_TYPES, publicVerif } from '@cloudflare/privacypass-ts';

const { Client, BlindRSAMode, TokenResponse } = publicVerif;
const MODE = BlindRSAMode.PSS;

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let clients: InstanceType<typeof Client>[] = [];

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === 'blind') {
    const { start, count, pk, issuerName } = msg as {
      start: number;
      count: number;
      pk: string;
      issuerName: string;
    };
    const pkBytes = b64urlDecode(pk);
    const challenge = new TokenChallenge(
      TOKEN_TYPES.BLIND_RSA.value,
      issuerName,
      new Uint8Array(0),
    );
    clients = new Array(count);
    const blinded = new Array<string>(count);
    for (let i = 0; i < count; i++) {
      const c = new Client(MODE);
      const req = await c.createTokenRequest(challenge, pkBytes);
      clients[i] = c;
      blinded[i] = b64urlEncode(req.serialize());
      if ((i & 15) === 0) self.postMessage({ type: 'progress', phase: 'blind', done: i });
    }
    self.postMessage({ type: 'blinded', start, blinded });
  } else if (msg.type === 'finalize') {
    const { start, signatures } = msg as { start: number; signatures: string[] };
    const tokens = new Array<string>(signatures.length);
    for (let i = 0; i < signatures.length; i++) {
      const tokRes = TokenResponse.deserialize(b64urlDecode(signatures[i]));
      const token = await clients[i].finalize(tokRes);
      tokens[i] = b64urlEncode(token.serialize());
      if ((i & 15) === 0) self.postMessage({ type: 'progress', phase: 'finalize', done: i });
    }
    self.postMessage({ type: 'finalized', start, tokens });
    clients = [];
  }
};
