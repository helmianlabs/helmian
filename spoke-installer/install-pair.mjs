#!/usr/bin/env node
// Helmian Spoke installer helper — run once by the Setup program, hidden.
//   1. Pairs this PC (the passphrase arrives in the environment, set by the
//      installer from its own pairing page; it is never stored).
//   2. Pins the Executive Guard public key (fetched live; a known public key
//      is kept as a fallback — public keys are not secrets).
//   3. Registers the HelmianSpoke sign-in task and starts it.
//   4. Writes %APPDATA%\Helmian\spoke-install-status.json so the installer's
//      last page can say honestly whether pairing finished.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const appDir = process.cwd();
const node = path.join(appDir, 'node.exe');
const spoke = path.join(appDir, 'bin', 'hands-spoke.mjs');
const roots = process.env.HELMIAN_SPOKE_ROOTS || homedir();
const GUARD_KEYS_URL = 'https://guard.5-78-222-178.sslip.io/v1/keys';
const FALLBACK_GUARD_X = 'gl0V8jCzSUtxVPlG6ZXtNXljhfGxDCUdpVZC00h0R4I';

const status = { paired: false, guardPinned: false, taskRegistered: false, at: new Date().toISOString() };

function run(args, opts = {}) {
  const r = spawnSync(node, [spoke, ...args], { env: process.env, encoding: 'utf8', timeout: 120000, ...opts });
  return r;
}

const configPath = path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'Helmian', 'hands-spoke.json');
if (!String(process.env.HELMIAN_HANDS_PASSPHRASE || '').trim() && existsSync(configPath)) {
  // Upgrade with the code left blank: keep the existing pairing and roots.
  status.paired = true;
  status.keptPairing = true;
} else {
  try {
    const pair = run(['pair', '--roots', roots]);
    status.paired = pair.status === 0;
  } catch { /* status stays false */ }
}

if (status.paired) {
  try {
    let x = FALLBACK_GUARD_X;
    try {
      const res = await fetch(GUARD_KEYS_URL, { signal: AbortSignal.timeout(8000) });
      const j = await res.json();
      if (j && j.publicKeyJwk && typeof j.publicKeyJwk.x === 'string') x = j.publicKeyJwk.x;
    } catch { /* fallback stands */ }
    const pin = run(['pin-guard', x]);
    status.guardPinned = pin.status === 0;
  } catch { /* mutating actions stay refused until pinned — fail closed */ }

  try {
    const tr = `"${node}" "${spoke}"`;
    const c = spawnSync('schtasks.exe', ['/Create', '/F', '/TN', 'HelmianSpoke', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TR', tr], { encoding: 'utf8', timeout: 60000 });
    status.taskRegistered = c.status === 0;
    if (status.taskRegistered) spawnSync('schtasks.exe', ['/Run', '/TN', 'HelmianSpoke'], { encoding: 'utf8', timeout: 30000 });
  } catch { /* the spoke can still be started by hand; the task is a convenience */ }
}

try {
  const dir = path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'Helmian');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'spoke-install-status.json'), JSON.stringify(status, null, 2) + '\n');
} catch { /* the installer's last page falls back to its caution text */ }

process.exit(status.paired ? 0 : 1);
