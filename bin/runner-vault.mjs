#!/usr/bin/env node
// Runner vault CLI (v1): manage the per-user encrypted credential vault.
// Run on the runner as the same user that runs the bridge (e.g. `helmian`),
// so the token path and vault path line up with bin/pc-bridge.mjs.
//
//   node bin/runner-vault.mjs status
//   node bin/runner-vault.mjs store gemini            # prompts, input hidden
//   echo "$KEY" | node bin/runner-vault.mjs store gemini --stdin
//   node bin/runner-vault.mjs wipe gemini
//
// Flags: --token-path <p> --vault-path <p>
// The vault key is derived from the bridge's device token; the cloud never
// sees plaintext. `status` prints presence-only (provider + updated_at).
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openVault, readDeviceToken, defaultVaultPath, PROVIDER_KEY_ENV } from '../src/runner/vault.mjs';

function usage() {
  console.log(`usage:
  node bin/runner-vault.mjs status [--token-path P] [--vault-path P]
  node bin/runner-vault.mjs store <provider> [--stdin] [--token-path P] [--vault-path P]
  node bin/runner-vault.mjs wipe <provider> [--token-path P] [--vault-path P]

providers: ${Object.keys(PROVIDER_KEY_ENV).join(', ')}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { cmd: argv[0], provider: null, stdin: false, tokenPath: null, vaultPath: null };
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--stdin') args.stdin = true;
    else if (a === '--token-path') args.tokenPath = rest[++i];
    else if (a === '--vault-path') args.vaultPath = rest[++i];
    else if (!args.provider) args.provider = a;
    else usage();
  }
  return args;
}

// Hidden prompt: keystrokes are not echoed.
function promptHidden(query) {
  const muted = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stdout.write(query);
  return new Promise((resolve) => {
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!['status', 'store', 'wipe'].includes(args.cmd)) usage();

  const tokenPath = args.tokenPath || join(homedir(), 'AppData', 'Roaming', 'Helmian', 'pc-bridge-token.json');
  const vaultPath = args.vaultPath || defaultVaultPath(homedir());
  const token = await readDeviceToken(tokenPath);
  if (!token) {
    console.error('vault closed: bridge has not paired yet (no device token).');
    process.exit(1);
  }
  const vault = await openVault({ vaultPath, deviceToken: token });

  if (args.cmd === 'status') {
    const rows = await vault.status();
    if (rows.length === 0) console.log('vault is empty.');
    else for (const r of rows) console.log(`${r.provider}: ${r.credential_type}, updated ${r.updated_at}`);
    return;
  }

  const provider = String(args.provider || '').toLowerCase();
  if (!PROVIDER_KEY_ENV[provider]) {
    console.error(`unknown provider: ${args.provider}`);
    usage();
  }

  if (args.cmd === 'wipe') {
    const res = await vault.wipe(provider);
    console.log(res.existed ? `wiped ${provider}.` : `${provider} was not in the vault.`);
    return;
  }

  // store
  const secret = args.stdin ? await readStdin() : await promptHidden(`paste ${provider} key (hidden): `);
  if (!secret) {
    console.error('empty value, nothing stored.');
    process.exit(1);
  }
  await vault.set(provider, 'api_key', secret);
  console.log(`stored ${provider} key in the vault.`);
}

main().catch((err) => {
  console.error('vault error:', err?.message ?? err);
  process.exit(1);
});
