// BTCPay Server Greenfield API client + webhook signature verification.
// Uses the global fetch (Node 22); no dependencies. The API key needs only
// btcpay.store.cancreateinvoice + btcpay.store.canviewinvoices on the store.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config, type Package } from './config.js';

export interface BtcpayInvoice {
  id: string;
  checkoutLink: string;
  status: 'New' | 'Processing' | 'Expired' | 'Invalid' | 'Settled';
  additionalStatus?: string;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `token ${config.btcpayApiKey}`,
    'Content-Type': 'application/json',
  };
}

// Create an invoice for a package. metadata.orderId carries the claim token so
// the operator can recover a purchase from the BTCPay UI alone (crash between
// invoice creation and the purchases INSERT). NEVER put the invite code in
// metadata — it doesn't exist yet at this point, and must never reach BTCPay.
export async function createInvoice(pkg: Package, claimToken: string): Promise<BtcpayInvoice> {
  const res = await fetch(`${config.btcpayUrl}/api/v1/stores/${config.btcpayStoreId}/invoices`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      amount: pkg.amount, // decimal string per Greenfield spec
      currency: pkg.currency,
      metadata: { orderId: `pp-${claimToken}`, packageId: pkg.id },
      checkout: {
        redirectURL: `${config.gatedOrigin}/pp/claim?ct=${claimToken}`,
        redirectAutomatically: true,
      },
    }),
  });
  if (!res.ok) throw new Error(`btcpay invoice create: HTTP ${res.status}`);
  return (await res.json()) as BtcpayInvoice;
}

// Reconciliation fallback for missed webhooks: the claim-status endpoint asks
// BTCPay directly while a purchase is still pending.
export async function getInvoice(invoiceId: string): Promise<BtcpayInvoice> {
  const res = await fetch(
    `${config.btcpayUrl}/api/v1/stores/${config.btcpayStoreId}/invoices/${encodeURIComponent(invoiceId)}`,
    { headers: authHeaders() },
  );
  if (!res.ok) throw new Error(`btcpay invoice get: HTTP ${res.status}`);
  return (await res.json()) as BtcpayInvoice;
}

// BTCPay signs every webhook delivery over the RAW request bytes:
//   BTCPay-Sig: sha256=<hex(HMAC-SHA256(webhookSecret, rawBody))>
// Any re-serialisation breaks the MAC, so callers must hand us the unparsed
// body. Constant-time compare.
export function verifyWebhookSig(rawBody: Buffer, sigHeader: string | undefined): boolean {
  if (!sigHeader || !sigHeader.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', config.btcpayWebhookSecret).update(rawBody).digest('hex');
  const given = sigHeader.slice('sha256='.length);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'));
}
