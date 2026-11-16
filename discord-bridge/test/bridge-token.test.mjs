// Per-provider bridge token (audit bite AT-3, T8 weakness 1; fix
// bite FIX-A3), Discord side. The bridge presents its own
// HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD first when that value is set
// and falls back to the shared HELMIAN_ENVOY_BRIDGE_TOKEN
// otherwise, and its cloud calls ride the Discord-scoped routes
// (bridge/discord/<route>) so the route itself names the provider
// whose token the cloud checks. index.mjs wires exactly this:
// envoyBridgeToken() for the value, provider: 'discord' for the
// routes — pinned here at the bridge-core harness level.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, envoyBridgeToken } from '../bridge-core.mjs';

const DISCORD = 'd'.repeat(40);
const SHARED = 'h'.repeat(40);

test('envoyBridgeToken: the discord token first, the shared token as fallback', () => {
  assert.equal(envoyBridgeToken({ HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD: DISCORD, HELMIAN_ENVOY_BRIDGE_TOKEN: SHARED }), DISCORD);
  assert.equal(envoyBridgeToken({ HELMIAN_ENVOY_BRIDGE_TOKEN: SHARED }), SHARED);
  assert.equal(envoyBridgeToken({ HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD: `  ${DISCORD}  `, HELMIAN_ENVOY_BRIDGE_TOKEN: SHARED }), DISCORD, 'values are trimmed, as the env read has always done');
  assert.equal(envoyBridgeToken({ HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD: '   ', HELMIAN_ENVOY_BRIDGE_TOKEN: SHARED }), SHARED, 'a blank per-provider value is not set');
  assert.equal(envoyBridgeToken({}), '');
});

test('with provider discord, cloud calls ride the discord-scoped routes carrying the presented token', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.authorization });
    return { ok: true, status: 200, json: async () => ({ valid: true, links: [] }) };
  };
  const b = createBridge({ cloud: 'https://h', token: DISCORD, provider: 'discord', fetchImpl, stateDir: await mkdtemp(join(tmpdir(), 'db-')) });
  await b.refreshLinks();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://h/api/admin/envoy/bridge/discord/links');
  assert.equal(calls[0].auth, `Bearer ${DISCORD}`);
});

test('without a provider, cloud calls keep the legacy unscoped routes', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.authorization });
    return { ok: true, status: 200, json: async () => ({ valid: true, links: [] }) };
  };
  const b = createBridge({ cloud: 'https://h', token: SHARED, fetchImpl, stateDir: await mkdtemp(join(tmpdir(), 'db-')) });
  await b.refreshLinks();
  assert.equal(calls[0].url, 'https://h/api/admin/envoy/bridge/links');
  assert.equal(calls[0].auth, `Bearer ${SHARED}`);
});
