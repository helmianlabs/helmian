import assert from 'node:assert/strict';
import test from 'node:test';
import { handleSpokeSetupRoute, pickSpokeAsset, SPOKE_PAIR_CODE_PATH, SPOKE_DOWNLOAD_PATH } from '../src/cloud/spoke-setup.mjs';
import { createSpokeTokens } from '../hands-mcp/src/spoke-tokens.mjs';
import { looksLikePairCode, loginCommand, providerStatus } from '../src/hands/provider-cli.mjs';

const call = async (path, { method = 'GET', env = {}, actorOk = true, fetchImpl } = {}) => {
  const out = [];
  const handled = await handleSpokeSetupRoute({
    request: { method, headers: {} }, response: {}, requestUrl: new URL(`https://helmian.cloud${path}`),
    activeTenantActor: async () => { if (!actorOk) throw Object.assign(new Error('no'), { status: 403 }); return { tenantId: 't' }; },
    send: (_r, status, body, type, headers) => out.push({ status, body, headers }), env, fetchImpl,
  });
  return { handled, res: out[0] };
};

test('pickSpokeAsset prefers the Setup exe, falls back to the zip, ignores non-spoke releases', () => {
  const rel = [
    { tag_name: 'v0.2.0', assets: [{ name: 'Helmian-Setup-0.2.0-win-x64.exe', browser_download_url: 'x' }] },
    { tag_name: 'spoke-v1.0.2', assets: [{ name: 'Helmian-Spoke-1.0.2-win-x64.zip', browser_download_url: 'zip' }] },
  ];
  assert.deepEqual(pickSpokeAsset(rel), { url: 'zip', name: 'Helmian-Spoke-1.0.2-win-x64.zip', tag: 'spoke-v1.0.2', kind: 'zip' });
  rel.unshift({ tag_name: 'spoke-v1.0.3', assets: [{ name: 'Helmian-Spoke-Setup-1.0.3-win-x64.exe', browser_download_url: 'exe' }] });
  assert.equal(pickSpokeAsset(rel).kind, 'installer');
  assert.equal(pickSpokeAsset(rel, 'macos'), null);
});

test('download redirects to the release asset; mac/linux say coming soon', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [{ tag_name: 'spoke-v1.0.2', assets: [{ name: 'Helmian-Spoke-1.0.2-win-x64.zip', browser_download_url: 'https://gh/zip' }] }] });
  const w = await call(`${SPOKE_DOWNLOAD_PATH}?os=windows`, { fetchImpl });
  assert.equal(w.res.status, 302); assert.equal(w.res.headers.location, 'https://gh/zip');
  const m = await call(`${SPOKE_DOWNLOAD_PATH}?os=macos`);
  assert.equal(JSON.parse(m.res.body).available, false);
});

test('pair-code: needs sign-in, honest 503 when not configured, relays code when configured', async () => {
  assert.equal((await call(SPOKE_PAIR_CODE_PATH, { method: 'POST', actorOk: false })).res.status, 403);
  assert.equal((await call(SPOKE_PAIR_CODE_PATH, { method: 'POST' })).res.status, 503);
  let seenAuth;
  const fetchImpl = async (url, init) => { seenAuth = init.headers.authorization; return { ok: true, json: async () => ({ code: 'ABCD-EFGH', expiresAt: 'z' }) }; };
  const env = { HELMIAN_HANDS_URL: 'https://hands.example', HELMIAN_PAIR_CODE_ISSUER_TOKEN: 'i'.repeat(40) };
  const r = await call(SPOKE_PAIR_CODE_PATH, { method: 'POST', env, fetchImpl });
  assert.equal(r.res.status, 200); assert.equal(JSON.parse(r.res.body).code, 'ABCD-EFGH');
  assert.equal(seenAuth, `Bearer ${'i'.repeat(40)}`);
  assert.ok(!r.res.body.includes('iiii'), 'issuer token never echoed');
});

test('hands pairing codes: single use, expire, wrong codes share the lockout', () => {
  let t = 1_000_000;
  const store = createSpokeTokens({ file: null, passphrase: 'p'.repeat(20), now: () => t });
  const { code } = store.issuePairCode();
  assert.ok(looksLikePairCode(code));
  assert.equal(store.pair({ pairCode: code.toLowerCase(), deviceId: 'pc1' }).ok, true);
  assert.equal(store.pair({ pairCode: code, deviceId: 'pc2' }).ok, false, 'second use refused');
  const c2 = store.issuePairCode().code;
  t += 11 * 60 * 1000;
  assert.equal(store.pair({ pairCode: c2, deviceId: 'pc3' }).status, 401, 'expired');
  assert.equal(store.pair({ passphrase: 'p'.repeat(20), deviceId: 'pc4' }).ok, true, 'passphrase still works');
});

test('provider CLI helper: known logins, Antigravity marked unsupported, never reads token contents', async () => {
  assert.equal(loginCommand('claude', 'win32').args.at(-1), 'claude');
  assert.equal(loginCommand('openai', 'win32').args.at(-1), 'codex login');
  assert.equal(loginCommand('xai', 'linux').args.at(-1), 'grok login');
  assert.equal(loginCommand('antigravity'), null);
  const rows = await providerStatus({ home: '/nonexistent', env: { PATH: '' } });
  assert.equal(rows.find((r) => r.id === 'antigravity').installed, false);
  assert.ok(rows.every((r) => r.signedIn === false));
});
