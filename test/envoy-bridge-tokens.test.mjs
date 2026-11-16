// Per-provider bridge tokens (audit bite AT-3, T8 weakness 1; fix
// bite FIX-A3). One shared secret used to gate every bridge route
// for both bridges; now the cloud also accepts a per-provider
// token, checked against the provider the ROUTE serves — the
// provider comes from the route's own first segment
// (bridge/discord/<route>, bridge/slack/<route>), never from a
// claim inside the request body. The shared token stays accepted
// on the scoped routes as the rotation fallback, and the legacy
// unscoped routes take the shared token only, exactly as before.
//
// These pins run the real route handler with a stub mesh: the
// token gate is what is under test, and it answers before any
// store call, so the only store method a passing request reaches
// is bridgeLinks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleEnvoyMeshRoute, bridgeProviderTokenOk } from '../src/cloud/envoy-mesh.mjs';

const DISCORD = 'd'.repeat(40);
const SLACK = 's'.repeat(40);
const SHARED = 'h'.repeat(40);
const ENV_KEYS = ['HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD', 'HELMIAN_ENVOY_BRIDGE_TOKEN_SLACK', 'HELMIAN_ENVOY_BRIDGE_TOKEN'];

async function withEnv(vars, fn) {
  const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) { if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of ENV_KEYS) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
}

const mesh = { bridgeLinks: async () => ({ links: [], slackLinks: [] }) };

async function call(path, token) {
  const sent = [];
  const send = (_r, status, body) => sent.push([status, JSON.parse(body)]);
  const request = { method: 'GET', headers: token ? { authorization: `Bearer ${token}` } : {} };
  const handled = await handleEnvoyMeshRoute({ request, response: {}, requestUrl: new URL(`http://x${path}`), send, mesh });
  assert.equal(handled, true);
  return sent[0];
}

const ALL_SET = { HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD: DISCORD, HELMIAN_ENVOY_BRIDGE_TOKEN_SLACK: SLACK, HELMIAN_ENVOY_BRIDGE_TOKEN: SHARED };

test('discord route accepts the discord token and the shared token, refuses the slack token', async () => {
  await withEnv(ALL_SET, async () => {
    assert.equal((await call('/api/admin/envoy/bridge/discord/links', DISCORD))[0], 200);
    assert.equal((await call('/api/admin/envoy/bridge/discord/links', SHARED))[0], 200, 'the shared fallback is the rotation window');
    const refused = await call('/api/admin/envoy/bridge/discord/links', SLACK);
    assert.equal(refused[0], 401);
    assert.equal(refused[1].code, 'ENVOY_BRIDGE_UNAUTHORIZED');
    assert.equal((await call('/api/admin/envoy/bridge/discord/links', null))[0], 401);
  });
});

test('slack route mirrors: accepts the slack token and the shared token, refuses the discord token', async () => {
  await withEnv(ALL_SET, async () => {
    assert.equal((await call('/api/admin/envoy/bridge/slack/links', SLACK))[0], 200);
    assert.equal((await call('/api/admin/envoy/bridge/slack/links', SHARED))[0], 200);
    assert.equal((await call('/api/admin/envoy/bridge/slack/links', DISCORD))[0], 401);
    assert.equal((await call('/api/admin/envoy/bridge/slack/links', null))[0], 401);
  });
});

test('legacy unscoped route takes the shared token only, exactly as before', async () => {
  await withEnv(ALL_SET, async () => {
    assert.equal((await call('/api/admin/envoy/bridge/links', SHARED))[0], 200);
    assert.equal((await call('/api/admin/envoy/bridge/links', DISCORD))[0], 401, 'a per-provider token does not widen to the unscoped routes');
    assert.equal((await call('/api/admin/envoy/bridge/links', SLACK))[0], 401);
  });
});

test('no tokens configured refuses 503 on scoped and legacy routes alike', async () => {
  await withEnv({}, async () => {
    for (const path of ['/api/admin/envoy/bridge/discord/links', '/api/admin/envoy/bridge/slack/links', '/api/admin/envoy/bridge/links']) {
      const r = await call(path, DISCORD);
      assert.equal(r[0], 503, path);
      assert.equal(r[1].code, 'ENVOY_BRIDGE_NOT_CONFIGURED');
    }
  });
});

test('a short per-provider token counts as not configured', async () => {
  await withEnv({ HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD: 'short' }, async () => {
    // Nothing usable is configured for either provider: 503, even
    // presenting the short value itself.
    assert.equal((await call('/api/admin/envoy/bridge/discord/links', 'short'))[0], 503);
    assert.equal((await call('/api/admin/envoy/bridge/slack/links', SLACK))[0], 503);
    assert.equal(bridgeProviderTokenOk({ headers: { authorization: 'Bearer short' } }, 'discord'), null);
  });
  await withEnv({ HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD: 'short', HELMIAN_ENVOY_BRIDGE_TOKEN: SHARED }, async () => {
    // The short value configures nothing, but the shared fallback
    // on the same route is live.
    assert.equal((await call('/api/admin/envoy/bridge/discord/links', SHARED))[0], 200);
    assert.equal((await call('/api/admin/envoy/bridge/discord/links', 'short'))[0], 401);
  });
});

test('bridgeProviderTokenOk: provider scope, shared fallback, unscoped shape', () => {
  const req = (t) => ({ headers: { authorization: `Bearer ${t}` } });
  const env = { HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD: DISCORD, HELMIAN_ENVOY_BRIDGE_TOKEN_SLACK: SLACK, HELMIAN_ENVOY_BRIDGE_TOKEN: SHARED };
  assert.equal(bridgeProviderTokenOk(req(DISCORD), 'discord', env), true);
  assert.equal(bridgeProviderTokenOk(req(SHARED), 'discord', env), true);
  assert.equal(bridgeProviderTokenOk(req(SLACK), 'discord', env), false);
  assert.equal(bridgeProviderTokenOk(req(SLACK), 'slack', env), true);
  assert.equal(bridgeProviderTokenOk(req(SHARED), 'slack', env), true);
  assert.equal(bridgeProviderTokenOk(req(DISCORD), 'slack', env), false);
  assert.equal(bridgeProviderTokenOk(req(SHARED), null, env), true);
  assert.equal(bridgeProviderTokenOk(req(DISCORD), null, env), false);
  assert.equal(bridgeProviderTokenOk(req(DISCORD), 'discord', {}), null);
  assert.equal(bridgeProviderTokenOk(req(DISCORD), 'discord', { HELMIAN_ENVOY_BRIDGE_TOKEN_SLACK: SLACK }), null, 'the other provider being configured does not configure this route');
});
