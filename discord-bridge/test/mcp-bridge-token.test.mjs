// Per-provider bridge token for the Discord MCP server (audit bite
// AT-3, T8 weakness 1; FIX-A3 rollout precondition 1). FIX-A3 gave
// each bridge its own token but deliberately left this server behind:
// it read the mirror through the legacy unscoped routes with the
// shared HELMIAN_ENVOY_BRIDGE_TOKEN, which blocked retiring the
// shared value. The server now runs the bridge's own posture:
// readConfig picks the credential through bridge-core's
// envoyBridgeToken (HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD first, the
// shared value as fallback only), and buildCore wires the core with
// provider 'discord', so its reads ride the Discord-scoped routes
// (bridge/discord/<route>) like the bridge's own calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createBridgeCloudClient } from '../mcp-core.mjs';
import { readConfig, buildCore } from '../mcp-server.mjs';

const DISCORD = 'd'.repeat(40);
const SHARED = 'h'.repeat(40);
const MCP_TOKEN = 'DISCORD-MCP-TEST-TOKEN';
const SERVER = new URL('../mcp-server.mjs', import.meta.url).pathname;
const LINKS = [
  { tenantId: 't1', envoyChannelId: 'e1', guildId: '111111', discordChannelId: '222222', agents: ['claude'] },
];

test('readConfig: the discord token first, the shared token as fallback only', () => {
  assert.equal(readConfig({ HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD: DISCORD, HELMIAN_ENVOY_BRIDGE_TOKEN: SHARED }).bridgeToken, DISCORD);
  assert.equal(readConfig({ HELMIAN_ENVOY_BRIDGE_TOKEN: SHARED }).bridgeToken, SHARED, 'scoped unset: the shared fallback is presented');
  assert.equal(readConfig({ HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD: '   ', HELMIAN_ENVOY_BRIDGE_TOKEN: SHARED }).bridgeToken, SHARED, 'a blank per-provider value is not set');
  assert.equal(readConfig({}).bridgeToken, '');
});

test('cloud client with provider discord: scoped routes carry the presented token', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.authorization });
    return { ok: true, status: 200, json: async () => ({ valid: true, links: LINKS, messages: [] }) };
  };
  const client = createBridgeCloudClient({ cloud: 'https://h', token: DISCORD, provider: 'discord', fetchImpl });
  await client.links();
  await client.outbound('2026-11-16T00:00:00.000Z');
  assert.equal(calls[0].url, 'https://h/api/admin/envoy/bridge/discord/links');
  assert.equal(calls[0].auth, `Bearer ${DISCORD}`);
  assert.equal(calls[1].url, 'https://h/api/admin/envoy/bridge/discord/outbound?since=2026-11-16T00%3A00%3A00.000Z');
  assert.equal(calls[1].auth, `Bearer ${DISCORD}`);
});

test('cloud client without a provider keeps the legacy unscoped routes', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.authorization });
    return { ok: true, status: 200, json: async () => ({ valid: true, links: LINKS }) };
  };
  const client = createBridgeCloudClient({ cloud: 'https://h', token: SHARED, fetchImpl });
  await client.links();
  assert.equal(calls[0].url, 'https://h/api/admin/envoy/bridge/links');
  assert.equal(calls[0].auth, `Bearer ${SHARED}`);
});

const textOf = (result) => (result?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

test('buildCore wiring: the scoped token is presented on the scoped route', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.authorization });
    return { ok: true, status: 200, json: async () => ({ valid: true, links: LINKS }) };
  };
  const config = readConfig({ HELMIAN_CLOUD: 'https://h', HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD: DISCORD, STATE_DIR: '/nonexistent-state' });
  const core = buildCore(config, { fetchImpl });
  const listed = JSON.parse(textOf(await core.callTool('discord_list_channels', {})));
  assert.deepEqual(listed.channels.map((c) => c.discordChannelId), ['222222']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://h/api/admin/envoy/bridge/discord/links');
  assert.equal(calls[0].auth, `Bearer ${DISCORD}`);
});

test('buildCore wiring: with the scoped value unset, the shared fallback rides the scoped route', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.authorization });
    return { ok: true, status: 200, json: async () => ({ valid: true, links: LINKS }) };
  };
  const config = readConfig({ HELMIAN_CLOUD: 'https://h', HELMIAN_ENVOY_BRIDGE_TOKEN: SHARED, STATE_DIR: '/nonexistent-state' });
  const core = buildCore(config, { fetchImpl });
  await core.callTool('discord_list_channels', {});
  assert.equal(calls[0].url, 'https://h/api/admin/envoy/bridge/discord/links', 'the route is scoped even when the fallback token is presented — the cloud accepts the shared value there');
  assert.equal(calls[0].auth, `Bearer ${SHARED}`);
});

test('spawned server with ONLY the discord token in env reads through the scoped route with it', { timeout: 30_000 }, async () => {
  const seen = [];
  const cloud = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization ?? null });
    if (req.headers.authorization !== `Bearer ${DISCORD}`) {
      res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ valid: false, code: 'ENVOY_BRIDGE_UNAUTHORIZED' })); return;
    }
    if (req.url.startsWith('/api/admin/envoy/bridge/discord/links')) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ valid: true, links: LINKS })); return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ valid: false, code: 'ENVOY_BRIDGE_ROUTE_UNKNOWN' }));
  });
  await new Promise((r) => cloud.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, [SERVER], {
    // A minimal env on purpose: the shared token is ABSENT, so a pass
    // proves the scoped value alone now carries this server.
    env: {
      PATH: process.env.PATH,
      HELMIAN_CLOUD: `http://127.0.0.1:${cloud.address().port}`,
      HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD: DISCORD,
      HELMIAN_DISCORD_MCP_TOKEN: MCP_TOKEN,
      DISCORD_MCP_PORT: '0',
      DISCORD_MCP_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const mcpUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`server did not announce a port; stdout so far: ${buf}`)), 15_000);
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        const m = /listening on (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(buf);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited early (${code}); stdout: ${buf}`)); });
    });
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${MCP_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'discord_list_channels', arguments: {} } }),
    });
    assert.equal(res.status, 200);
    const reply = await res.json();
    const listed = JSON.parse(reply.result.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
    assert.deepEqual(listed.channels.map((c) => c.discordChannelId), ['222222']);
    assert.ok(seen.length >= 1, 'the cloud was read');
    assert.ok(seen.every((s) => s.url.startsWith('/api/admin/envoy/bridge/discord/')), 'every read rode the discord-scoped route, never the legacy one');
    assert.ok(seen.every((s) => s.auth === `Bearer ${DISCORD}`), 'every read presented the discord token');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => cloud.close(r));
  }
});
