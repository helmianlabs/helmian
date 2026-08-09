// Current-Windows-user protected storage for the account-bound Herald Desktop
// registration credential. The credential is never written in plaintext.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { userInfo } from 'node:os';
import { dpapiProtectCurrentUser, dpapiUnprotectCurrentUser } from '../windows/owner-key-store.mjs';

export function defaultHeraldDesktopRegistrationPath() {
  const root = process.env.LOCALAPPDATA;
  if (!root) throw new Error('LOCALAPPDATA is unavailable.');
  return join(root, 'Helmion', 'Herald', 'desktop-registration.dpapi.json');
}

export async function saveHeraldDesktopRegistration(
  registration,
  path = defaultHeraldDesktopRegistrationPath(),
) {
  const value = validateRegistration(registration);
  const plain = Buffer.from(JSON.stringify(value), 'utf8');
  let protectedBytes;
  try {
    protectedBytes = dpapiProtectCurrentUser(plain);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({
      version: 1,
      protection: 'Windows CurrentUser DPAPI',
      value: protectedBytes.toString('base64'),
    })}\n`, { encoding: 'utf8', mode: 0o600 });
    restrictWindowsAcl(path);
    return path;
  } finally { plain.fill(0); protectedBytes?.fill(0); }
}

export async function loadHeraldDesktopRegistration(
  path = defaultHeraldDesktopRegistrationPath(),
) {
  const record = JSON.parse(await readFile(path, 'utf8'));
  if (record?.version !== 1 || record?.protection !== 'Windows CurrentUser DPAPI'
    || typeof record?.value !== 'string') {
    throw new Error('Herald Desktop registration record is invalid.');
  }
  const encrypted = Buffer.from(record.value, 'base64');
  let plain;
  try {
    plain = dpapiUnprotectCurrentUser(encrypted);
    return validateRegistration(JSON.parse(plain.toString('utf8')));
  } finally { encrypted.fill(0); plain?.fill(0); }
}

function validateRegistration(value) {
  let origin;
  try { origin = new URL(value?.origin).origin; }
  catch { throw new Error('Herald Desktop registration origin is invalid.'); }
  if (!/^https:\/\//.test(origin)
    || !/^desktop_[A-Za-z0-9_-]{20,80}$/.test(String(value?.desktopId ?? ''))
    || !/^[A-Za-z0-9_-]{43,128}$/.test(String(value?.registrationToken ?? ''))
    || !Number.isFinite(new Date(value?.credentialExpiresAt).getTime())) {
    throw new Error('Herald Desktop registration is invalid.');
  }
  return Object.freeze({
    version: 1,
    origin,
    desktopId: value.desktopId,
    displayName: String(value.displayName ?? 'Helmian Desktop').trim().slice(0, 60),
    registrationToken: value.registrationToken,
    credentialExpiresAt: new Date(value.credentialExpiresAt).toISOString(),
  });
}

function restrictWindowsAcl(path) {
  if (process.platform !== 'win32') return;
  const account = userInfo().username;
  const result = spawnSync('icacls.exe', [
    path, '/inheritance:r', '/grant:r', `${account}:(F)`, 'SYSTEM:(F)',
  ], { windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error('Windows could not restrict the Herald Desktop registration file.');
  }
}
