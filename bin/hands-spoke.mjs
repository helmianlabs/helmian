#!/usr/bin/env node
// Helmian hands: PC spoke.
//   node bin/hands-spoke.mjs pair [--url https://hands.5-78-222-178.sslip.io] [--roots "E:\Helmion;D:\work"]
//       asks for the hands passphrase (the same one as the memory connector) and saves
//       %APPDATA%\Helmian\hands-spoke.json. Run once. The passphrase is never stored.
//   node bin/hands-spoke.mjs pin-guard <ed25519 x>
//       pins the Executive Guard public key. Until this is done every mutating job is refused.
//   node bin/hands-spoke.mjs            run in the foreground (the HelmianBridge service runs it for you)
import { createInterface } from 'node:readline/promises';
import { writeFile } from 'node:fs/promises';
import { DEFAULT_HANDS_URL, defaultConfigPath, pairSpoke, readSpokeConfig, startSpoke } from '../src/hands/pc-spoke.mjs';

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function askHidden(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = function write(s) { if (s.includes(question)) process.stdout.write(s); };
  const answer = await rl.question(question);
  rl.close();
  process.stdout.write('\n');
  return answer.trim();
}

const cmd = process.argv[2];
if (cmd === 'pair') {
  const url = (flag('url') || DEFAULT_HANDS_URL).replace(/\/+$/, '');
  const roots = (flag('roots') || process.env.HELMIAN_ROOT || process.cwd()).split(';').map((s) => s.trim()).filter(Boolean);
  const passphrase = process.env.HELMIAN_HANDS_PASSPHRASE || await askHidden('Hands passphrase: ');
  const r = await pairSpoke({ url, passphrase, roots });
  console.log(`Paired as ${r.deviceId}. Workspace roots: ${r.roots.join(', ')}. Saved ${r.configPath}. Restart the HelmianBridge service (or run this without "pair").`);
} else if (cmd === 'pin-guard') {
  const x = process.argv[3];
  if (!/^[A-Za-z0-9_-]{43}$/.test(x || '')) { console.error('Usage: pin-guard <43-char base64url Ed25519 x from Guard GET /v1/keys>'); process.exit(2); }
  const cfg = await readSpokeConfig();
  if (!cfg) { console.error('Pair first: node bin/hands-spoke.mjs pair'); process.exit(2); }
  await writeFile(defaultConfigPath(), JSON.stringify({ ...cfg, guardPublicKeyX: x }, null, 2), { mode: 0o600 });
  console.log('Executive Guard key pinned. Mutating actions now need a human Guard approval that this PC verifies.');
} else {
  const config = await readSpokeConfig();
  if (!config) { console.error('Not paired. Run: node bin/hands-spoke.mjs pair'); process.exit(2); }
  const handle = startSpoke({ config });
  const stop = () => { handle.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
