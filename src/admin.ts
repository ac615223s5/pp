// Operator CLI for invite codes. Run inside the container, e.g.:
//   docker compose exec privacy-pass node dist/admin.js new-code --quota 500
//   docker compose exec privacy-pass node dist/admin.js new-code --quota 500 --count 10
//   docker compose exec privacy-pass node dist/admin.js new-code --daily 50 --cap 500
//   docker compose exec privacy-pass node dist/admin.js list-codes
//   docker compose exec privacy-pass node dist/admin.js revoke-code XXXXX-XXXXX-XXXXX
//
// Single-use codes (--quota N) mint one batch of N tokens, then die. Faucet
// codes (--daily N) accrue N tokens per day up to a cap (--cap, default the
// quota default) and dispense everything built up each time they're entered.

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
      // accumulation ceiling stored in the quota column. Otherwise single-use
      // with --quota tokens.
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
          console.log(`${r.code}  quota=${r.quota}  ${r.used ? 'USED' : 'unused'}`);
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
    case 'revoke-code': {
      const code = process.argv[3];
      if (!code) {
        console.error('usage: revoke-code <code>');
        process.exit(1);
      }
      const ok = store.revokeCode(code);
      console.log(ok ? `revoked ${code}` : `not revoked (unknown or already used): ${code}`);
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
        'commands: new-code [--quota N | --daily N [--cap N]] [--count N] | list-codes | list-purchases | revoke-code <code> | bypass-link',
      );
      process.exit(1);
  }
}

main();
