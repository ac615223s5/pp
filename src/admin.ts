// Operator CLI for invite codes. Run inside the container, e.g.:
//   docker compose exec privacy-pass node dist/admin.js new-code --quota 500
//   docker compose exec privacy-pass node dist/admin.js list-codes
//   docker compose exec privacy-pass node dist/admin.js revoke-code XXXXX-XXXXX-XXXXX

import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { Store } from './store.js';

// Unambiguous alphabet (no I/O/0/1).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(): string {
  const bytes = randomBytes(15);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  // group 5-5-5 for readability
  return [chars.slice(0, 5), chars.slice(5, 10), chars.slice(10, 15)]
    .map((g) => g.join(''))
    .join('-');
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function main() {
  const cmd = process.argv[2];
  const store = new Store(config.dbPath);

  switch (cmd) {
    case 'new-code': {
      const quota = Number(argValue('--quota') ?? config.quotaDefault);
      if (!Number.isInteger(quota) || quota < 1) {
        console.error('quota must be a positive integer');
        process.exit(1);
      }
      const code = generateCode();
      store.createCode(code, quota);
      console.log(`created ${code}  (quota ${quota})`);
      // Shareable activation link (prefills the code; user still clicks Activate).
      console.log(`link: ${config.gatedOrigin}/pp/activate?code=${code}`);
      break;
    }
    case 'list-codes': {
      const rows = store.listCodes();
      if (rows.length === 0) {
        console.log('(no codes)');
        break;
      }
      for (const r of rows) {
        const state = r.used ? 'USED' : 'unused';
        console.log(`${r.code}  quota=${r.quota}  ${state}`);
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
        'commands: new-code [--quota N] | list-codes | revoke-code <code> | bypass-link',
      );
      process.exit(1);
  }
}

main();
