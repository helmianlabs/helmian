// Per-provider bridge token (audit bite AT-3, T8 weakness 1; fix
// bite FIX-A3), Slack side — the mirror of the Discord pins. The
// bridge presents its own HELMIAN_ENVOY_BRIDGE_TOKEN_SLACK first
// when that value is set and falls back to the shared
// HELMIAN_ENVOY_BRIDGE_TOKEN otherwise, and its cloud calls ride
// the Slack-scoped routes (bridge/slack/<route>) so the route
// itself names the provider whose token the cloud checks.
// index.mjs wires exactly this: envoyBridgeToken() for the value,
// provider: 'slack' for the routes — pinned here at the
// bridge-core harness level.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridge, envoyBridgeToken } from '../bridge-core.mjs';

const SLACK = 's'.repeat(40);
const SHARED = 'h'.repeat(40);

test('envoyBridgeToken: the slack token first, the shared token as fallback', () => {
  assert.equal(envoyBridgeToken({ HELMIAN_ENVOY_BRIDGE_TOKEN_SLACK: SLACK, HELMIAN_ENVOY_BRIDGE_TOKEN: SHARED }), SLACK);
  assert.equal(envoyBridgeToken({ HELMIAN_ENVOY_BRIDGE_TOKEN: SHARED }), SHARED);
  assert.equal(envoyBridgeToken({ HELMIAN_ENVOY_BRIDGE_TOKEN_SLACK: `  ${SLACK}  `, HELMIAN_ENVOY_BRIDGE_TOKEN: SHARED }), SLACK, 'values are trimmed, as the env read has always done');
  assert.equal(envoyBridgeToken({ HELMIAN_ENVOY_BRIDGE_TOKEN_SLACK: '   ', HELMIAN_ENVOY_BRIDGE_TOKEN: SHARED }), SHARED, 'a blank per-provider value is not set');
  assert.equal(envoyBridgeToken({}), '');
});

test('with provider slack, cloud calls ride the slack-scoped routes carrying the presented token', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.authorization });
    return { ok: true, status: 200, json: async () => ({ valid: true, links: [], slackLinks: [] }) };
  };
  const b = createBridge({ cloud: 'https://h', token: SLACK, provider: 'slack', fetchImpl });
  await b.refreshLinks();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://h/api/admin/envoy/bridge/slack/links');
  assert.equal(calls[0].auth, `Bearer ${SLACK}`);
});

test('without a provider, cloud calls keep the legacy unscoped routes', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.authorization });
    return { ok: true, status: 200, json: async () => ({ valid: true, links: [], slackLinks: [] }) };
  };
  const b = createBridge({ cloud: 'https://h', token: SHARED, fetchImpl });
  await b.refreshLinks();
  assert.equal(calls[0].url, 'https://h/api/admin/envoy/bridge/links');
  assert.equal(calls[0].auth, `Bearer ${SHARED}`);
});
