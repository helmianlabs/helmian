// Current-user protected enrollment secret for starting first-party Herald
// relay sessions. It is never written to the repository or passed on a command line.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { userInfo } from 'node:os';
import { dpapiProtectCurrentUser, dpapiUnprotectCurrentUser } from '../windows/owner-key-store.mjs';

export function defaultHeraldOwnerSecretPath() {
  const root = process.env.LOCALAPPDATA;
  if (!root) throw new Error('LOCALAPPDATA is unavailable.');
  return join(root, 'Helmion', 'Herald', 'owner-enrollment.dpapi.json');
}

function restrictWindowsAcl(path) {
  if (process.platform !== 'win32') return;
  const account = userInfo().username;
  const result = spawnSync('icacls.exe', [path, '/inheritance:r', '/grant:r', `${account}:(F)`, 'SYSTEM:(F)'], {
    windowsHide: true, encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error('Windows could not restrict the Herald enrollment file.');
}

export async function saveHeraldOwnerSecret(secret, path = defaultHeraldOwnerSecretPath()) {
  const plain = Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(String(secret ?? ''), 'utf8');
  if (plain.length < 32) { plain.fill(0); throw new Error('Herald owner enrollment secret is too short.'); }
  let protectedBytes;
  try {
    protectedBytes = dpapiProtectCurrentUser(plain);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ version: 1, protection: 'Windows CurrentUser DPAPI', value: protectedBytes.toString('base64') })}\n`, { encoding: 'utf8', mode: 0o600 });
    restrictWindowsAcl(path);
    return path;
  } finally { plain.fill(0); protectedBytes?.fill(0); }
}

export async function loadHeraldOwnerSecret(path = defaultHeraldOwnerSecretPath()) {
  const record = JSON.parse(await readFile(path, 'utf8'));
  if (record?.version !== 1 || record?.protection !== 'Windows CurrentUser DPAPI' || typeof record?.value !== 'string') {
    throw new Error('Herald owner enrollment record is invalid.');
  }
  const encrypted = Buffer.from(record.value, 'base64');
  try { return dpapiUnprotectCurrentUser(encrypted); }
  finally { encrypted.fill(0); }
}
