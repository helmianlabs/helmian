// Discord MCP tools (research note helmian-connectors-2026-10-25 §6, bite 2):
// the Discord mirror as a REAL tool connector.
//
// What is pinned here:
//  - tools/list (through the repo's real MCP clients, against a real spawned
//    server) returns exactly the three named tools, with the post tool
//    annotated mutating and the reads read-only.
//  - a read tool returns real-shaped data through the bridge's cloud
//    interface (the fixture cloud speaks /api/admin/envoy/bridge/* with the
//    bridge token, like the real cloud).
//  - the mutating post tool carries the Guard outcome surface of the hands
//    pattern: no Guard / Guard deny / Guard pending all execute NOTHING and
//    the result reports the Guard state; only a Guard allow reaches the
//    poster, and an unlinked channel is refused before Guard is asked.
//  - the landed probe (bite 1a) verifies a locally-run instance of the
//    server and writes the receipt with the true tool count.
//  - the plugin declaration names a token SOURCE only — a literal credential
//    anywhere in it would be refused by the remote-declaration rules, so the
//    test scans for one the same way.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { createDiscordMcpCore, createWebhookPoster, DISCORD_MCP_TOOLS } from '../discord-bridge/mcp-core.mjs';
import { createRemoteMcpClient } from '../src/agent/mcp-remote-client.mjs';
import { createMcpClient } from '../src/agent/mcp-client.mjs';
import { createToolConnectionsStore } from '../src/cloud/tool-connections.mjs';
import { probeToolConnection } from '../src/agent/tool-connection-probe.mjs';

const SERVER = new URL('../discord-bridge/mcp-server.mjs', import.meta.url).pathname;
const BRIDGE_TOKEN = 'b'.repeat(40);
const MCP_TOKEN = 'DISCORD-MCP-TEST-TOKEN';
const LINKS = [
  { tenantId: 't1', envoyChannelId: 'e1', guildId: '111111', discordChannelId: '222222', agents: ['claude'] },
  { tenantId: 't1', envoyChannelId: 'e2', guildId: '111111', discordChannelId: '333333', agents: [] },
];
const MESSAGES = [
  { id: 'm1', channelId: 'e1', discordChannelId: '222222', authorKind: 'human', authorName: 'Troy', displayName: 'Troy', body: 'hello from Helmian', createdAt: new Date(Date.now() - 5 * 60_000).toISOString() },
  { id: 'm2', channelId: 'e1', discordChannelId: '222222', authorKind: 'agent', authorName: 'Claude', body: 'agent reply', createdAt: new Date(Date.now() - 4 * 60_000).toISOString() },
  { id: 'm3', channelId: 'e2', discordChannelId: '333333', authorKind: 'agent', authorName: 'Grok', body: 'other channel entirely', createdAt: new Date(Date.now() - 3 * 60_000).toISOString() },
];

// ------------------------------------------------------------ fixture cloud
function startFakeCloud() {
  const state = { auth: [] };
  const server = createServer((req, res) => {
    const ok = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ valid: true, ...body })); };
    state.auth.push(req.headers.authorization ?? null);
    if (req.headers.authorization !== `Bearer ${BRIDGE_TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ valid: false, code: 'ENVOY_BRIDGE_UNAUTHORIZED' })); return;
    }
    if (req.url.startsWith('/api/admin/envoy/bridge/links')) return ok({ links: LINKS });
    if (req.url.startsWith('/api/admin/envoy/bridge/outbound')) return ok({ messages: MESSAGES });
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ valid: false, code: 'ENVOY_BRIDGE_ROUTE_UNKNOWN' }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => new Promise((r) => server.close(r)),
  })));
}

// A fetch-shaped fake cloud for in-process core tests (bridge-core's style).
function fakeFetchCloud() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.authorization });
    const ok = (body) => ({ ok: true, status: 200, json: async () => ({ valid: true, ...body }) });
    if (url.includes('/bridge/links')) return ok({ links: LINKS });
    if (url.includes('/bridge/outbound')) return ok({ messages: MESSAGES });
    return { ok: false, status: 404, json: async () => ({ valid: false, code: 'NOPE' }) };
  };
  return { calls, fetchImpl };
}

const textOf = (result) => (result?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

// ------------------------------------------------------- spawned HTTP server
let fakeCloud;
let child;
let mcpUrl;

before(async () => {
  fakeCloud = await startFakeCloud();
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      HELMIAN_CLOUD: fakeCloud.url,
      HELMIAN_ENVOY_BRIDGE_TOKEN: BRIDGE_TOKEN,
      HELMIAN_DISCORD_MCP_TOKEN: MCP_TOKEN,
      DISCORD_MCP_PORT: '0',
      DISCORD_MCP_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  mcpUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`server did not announce a port; stdout so far: ${buf}`)), 15_000);
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(buf);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited early (${code}); stdout: ${buf}`)); });
  });
});

after(async () => {
  child?.kill('SIGTERM');
  await fakeCloud?.close();
});

test('tools/list through the real remote client: the three named tools, post annotated mutating', { timeout: 30_000 }, async () => {
  const client = await createRemoteMcpClient({ url: mcpUrl, token: MCP_TOKEN, timeoutMs: 10_000 });
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['discord_list_channels', 'discord_read_messages', 'discord_post_message']);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(byName.discord_list_channels.annotations.readOnlyHint, true);
    assert.equal(byName.discord_read_messages.annotations.readOnlyHint, true);
    assert.equal(byName.discord_post_message.annotations.readOnlyHint, false, 'posting is mutating and must say so');
    // The cloud was read with the BRIDGE token — not the MCP token, not a Discord token.
    assert.ok(fakeCloud.state.auth.every((a) => a === `Bearer ${BRIDGE_TOKEN}`));
  } finally { await client.close(); }
});

test('the HTTP entry refuses a caller with no bearer token', { timeout: 30_000 }, async () => {
  await assert.rejects(
    () => createRemoteMcpClient({ url: mcpUrl, timeoutMs: 10_000 }),
    /401/,
  );
});

test('read tools return the fixture bridge data, shaped and channel-filtered', { timeout: 30_000 }, async () => {
  const client = await createRemoteMcpClient({ url: mcpUrl, token: MCP_TOKEN, timeoutMs: 10_000 });
  try {
    const listed = JSON.parse(client.textOf(await client.callTool('discord_list_channels', {})));
    assert.deepEqual(listed.channels.map((c) => c.discordChannelId), ['222222', '333333']);
    assert.deepEqual(listed.channels[0].agents, ['claude']);

    const read = JSON.parse(client.textOf(await client.callTool('discord_read_messages', { channelId: '222222' })));
    assert.equal(read.channel.envoyChannelId, 'e1');
    assert.deepEqual(read.messages.map((m) => m.id), ['m1', 'm2'], 'only the requested channel\u2019s messages');
    assert.equal(read.messages[0].author, 'Troy');
    assert.equal(read.messages[1].body, 'agent reply');

    const miss = await client.callTool('discord_read_messages', { channelId: '999999' });
    assert.equal(miss.isError, true);
    assert.match(client.textOf(miss), /not linked/);
  } finally { await client.close(); }
});

test('stdio mode serves the same tools through the real stdio client', { timeout: 30_000 }, async () => {
  const client = await createMcpClient({
    command: process.execPath,
    args: [SERVER, '--stdio'],
    env: { HELMIAN_CLOUD: fakeCloud.url, HELMIAN_ENVOY_BRIDGE_TOKEN: BRIDGE_TOKEN },
    timeoutMs: 10_000,
  });
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), DISCORD_MCP_TOOLS.map((t) => t.name));
    const listed = JSON.parse(client.textOf(await client.callTool('discord_list_channels', {})));
    assert.equal(listed.channels.length, 2);
  } finally { await client.close(); }
});

// ------------------------------------------------------------- the Guard gate
function guardSpy(outcome) {
  const calls = [];
  return {
    calls,
    live: true,
    async authorize(req) {
      calls.push(req);
      if (outcome === 'allow') return { outcome: 'allow', approvalId: 'appr_1' };
      if (outcome === 'pending') return { outcome: 'pending', approvalId: 'appr_9', reason: 'Waiting for a human to approve in Guard.' };
      return { outcome: 'deny', reason: 'A human denied this in Guard.' };
    },
  };
}
function posterSpy() {
  const calls = [];
  return { calls, async post(args) { calls.push(args); return { parts: 1, username: args.authorName }; } };
}
const coreWith = ({ guard, poster }) => {
  const fake = fakeFetchCloud();
  return { core: createDiscordMcpCore({ cloud: 'https://cloud.example', token: BRIDGE_TOKEN, fetchImpl: fake.fetchImpl, guard, poster }), fake };
};

test('post with NO Guard wired: denied fail-closed, the poster never runs', async () => {
  const poster = posterSpy();
  const { core } = coreWith({ guard: undefined, poster });
  // coreWith passes guard: undefined -> the core's fail-closed default applies.
  const result = await core.callTool('discord_post_message', { channelId: '222222', text: 'hello discord' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Denied: Executive Guard is not live yet, so mutating actions are denied \(fail closed\)\. Nothing was posted\./);
  assert.equal(poster.calls.length, 0);
});

test('post with a Guard DENY: the outcome is reported and nothing executes', async () => {
  const guard = guardSpy('deny');
  const poster = posterSpy();
  const { core } = coreWith({ guard, poster });
  const result = await core.callTool('discord_post_message', { channelId: '222222', text: 'hello discord' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Denied: A human denied this in Guard\. Nothing was posted\./);
  assert.equal(guard.calls.length, 1);
  assert.equal(guard.calls[0].tool, 'discord_post_message');
  assert.equal(poster.calls.length, 0);
});

test('post with a Guard PENDING: the approval state is reported and nothing executes', async () => {
  const guard = guardSpy('pending');
  const poster = posterSpy();
  const { core } = coreWith({ guard, poster });
  const result = await core.callTool('discord_post_message', { channelId: '222222', text: 'hello discord' });
  assert.notEqual(result.isError, true, 'a pending approval is a state to report, not a tool error');
  assert.match(textOf(result), /Waiting for a human approval in Executive Guard \(approval appr_9\)\. Nothing has been posted\./);
  assert.equal(poster.calls.length, 0);
});

test('post with a Guard ALLOW: exactly one post executes through the poster', async () => {
  const guard = guardSpy('allow');
  const poster = posterSpy();
  const { core } = coreWith({ guard, poster });
  const result = await core.callTool('discord_post_message', { channelId: '222222', text: 'hello discord', authorName: 'Claude' });
  assert.notEqual(result.isError, true);
  assert.match(textOf(result), /Posted to Discord channel 222222 through the Helmian mirror/);
  assert.equal(poster.calls.length, 1);
  assert.deepEqual(poster.calls[0], { discordChannelId: '222222', text: 'hello discord', authorName: 'Claude' });
});

test('post to an UNLINKED channel is refused before Guard is ever asked', async () => {
  const guard = guardSpy('allow');
  const poster = posterSpy();
  const { core } = coreWith({ guard, poster });
  const result = await core.callTool('discord_post_message', { channelId: '999999', text: 'hello?' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /not linked.*Guard was not asked/);
  assert.equal(guard.calls.length, 0);
  assert.equal(poster.calls.length, 0);
});

test('the webhook poster IS the bridge delivery: split, named, mentions off', async () => {
  const sent = [];
  const fetchImpl = async (url, init = {}) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
  const poster = createWebhookPoster({ fetchImpl, getWebhook: async () => ({ id: 'w1', token: 'wtok' }) });
  const out = await poster.post({ discordChannelId: '222222', text: 'word '.repeat(900), authorName: 'Claude' });
  assert.ok(out.parts >= 3);
  assert.equal(sent.length, out.parts);
  for (const s of sent) {
    assert.equal(s.url, 'https://discord.com/api/v10/webhooks/w1/wtok?wait=true');
    assert.deepEqual(s.body.allowed_mentions, { parse: [] });
    assert.equal(s.body.username, 'Claude');
    assert.ok(s.body.content.length <= 1900);
  }
  const noHook = createWebhookPoster({ fetchImpl, getWebhook: async () => null });
  await assert.rejects(() => noHook.post({ discordChannelId: '222222', text: 'hi', authorName: 'Claude' }), /no webhook is cached/);
});

// ------------------------------------------------------------ probe (bite 1a)
// The fake pool from tool-connections.test.mjs, simulating helmion.tool_connections.
function fakePool() {
  const rows = new Map();
  const queries = [];
  let tenant = null;
  let seq = 0;
  const keyOf = (scopeKind, scopeId, serviceId) => `${tenant}|${scopeKind}|${scopeId}|${serviceId}`;
  const find = (vals) => rows.get(keyOf(vals[0], vals[1], vals[2]));
  return {
    rows, queries,
    async connect() {
      return {
        async query(text, vals = []) {
          queries.push({ text, vals });
          if (text.includes("set_config('helmion.tenant_id'")) { tenant = vals[0]; return { rows: [] }; }
          if (['begin', 'commit', 'rollback'].includes(text.trim())) return { rows: [] };
          if (text.includes('insert into helmion.tool_connections')) {
            const [scopeKind, scopeId, serviceId, kind, serverRef, credJson, accountLabel, scopesJson, subject] = vals;
            const key = keyOf(scopeKind, scopeId, serviceId);
            const now = new Date();
            const existing = rows.get(key);
            if (existing) {
              const changed = existing.kind !== kind || existing.server_ref !== serverRef;
              Object.assign(existing, { kind, server_ref: serverRef, credential_reference: credJson ? JSON.parse(credJson) : null, account_label: accountLabel, granted_scopes: JSON.parse(scopesJson), updated_by_subject: subject, updated_at: now });
              if (changed) { existing.state = 'registered'; existing.last_verified_at = null; existing.probe_method = null; existing.last_tools_count = null; existing.last_error = null; }
              return { rows: [{ ...existing }] };
            }
            const row = { id: ++seq, tenant_id: tenant, scope_kind: scopeKind, scope_id: scopeId, service_id: serviceId, kind, server_ref: serverRef, credential_reference: credJson ? JSON.parse(credJson) : null, account_label: accountLabel, granted_scopes: JSON.parse(scopesJson), state: 'registered', last_verified_at: null, probe_method: null, last_tools_count: null, last_error: null, updated_by_subject: subject, created_at: now, updated_at: now };
            rows.set(key, row);
            return { rows: [{ ...row }] };
          }
          if (text.includes('from helmion.tool_connections') && text.includes('order by service_id')) {
            let out = [...rows.values()].filter((r) => r.tenant_id === tenant);
            if (text.includes('scope_kind = $')) out = out.filter((r) => r.scope_kind === vals[0]);
            if (text.includes('scope_id = $')) out = out.filter((r) => r.scope_id === vals[vals.length - 1]);
            return { rows: out.map((r) => ({ ...r })) };
          }
          if (text.includes('from helmion.tool_connections')) { const row = find(vals); return { rows: row ? [{ ...row }] : [] }; }
          if (text.includes("set state = 'probing'")) { const row = find(vals); if (!row || row.state === 'revoked') return { rows: [] }; row.state = 'probing'; row.updated_by_subject = vals[3]; row.updated_at = new Date(); return { rows: [{ ...row }] }; }
          if (text.includes("set state = 'verified'")) { const row = find(vals); if (!row) return { rows: [] }; row.state = 'verified'; row.last_verified_at = new Date(); row.probe_method = vals[3]; row.last_tools_count = vals[4]; row.last_error = null; row.updated_by_subject = vals[5]; row.updated_at = new Date(); return { rows: [{ ...row }] }; }
          if (text.includes("set state = 'failed'")) { const row = find(vals); if (!row) return { rows: [] }; row.state = 'failed'; row.probe_method = vals[3]; row.last_error = vals[4]; row.last_verified_at = null; row.last_tools_count = null; row.updated_by_subject = vals[5]; row.updated_at = new Date(); return { rows: [{ ...row }] }; }
          if (text.includes("set state = 'revoked'")) { const row = find(vals); if (!row) return { rows: [] }; row.state = 'revoked'; row.last_verified_at = null; row.last_tools_count = null; row.last_error = null; row.updated_by_subject = vals[3]; row.updated_at = new Date(); return { rows: [{ ...row }] }; }
          throw new Error(`unexpected query: ${text.slice(0, 80)}`);
        },
        release() {},
      };
    },
  };
}

test('the probe verifies a locally-run instance and writes the receipt with the TRUE tool count', { timeout: 30_000 }, async () => {
  const store = createToolConnectionsStore(fakePool());
  const key = { scopeKind: 'workspace', scopeId: 't1', serviceId: 'discord' };
  await store.register('t1', 'user:troy', {
    ...key,
    kind: 'mcp-http',
    serverRef: mcpUrl,
    credentialReference: { type: 'token-source', source: { kind: 'env', name: 'DISCORD_MCP_TEST_TOKEN' } },
    accountLabel: 'Helmian Discord',
    grantedScopes: ['discord.read', 'discord.post'],
  });
  const result = await probeToolConnection({
    store, tenantId: 't1', key, timeoutMs: 10_000,
    env: { DISCORD_MCP_TEST_TOKEN: MCP_TOKEN },
  });
  assert.equal(result.state, 'verified');
  assert.equal(result.toolsCount, 3, 'the receipt counts what tools/list actually answered');
  const row = await store.get('t1', key);
  assert.equal(row.state, 'verified');
  assert.equal(row.probeMethod, 'tools/list');
  assert.equal(row.lastToolsCount, 3);
  assert.ok(row.lastVerifiedAt);
});

// ------------------------------------------------------------- the declaration
test('the plugin declaration names a token SOURCE only — never a literal credential', async () => {
  const raw = await readFile(new URL('../discord-bridge/plugin/.mcp.json', import.meta.url), 'utf8');
  const decl = JSON.parse(raw).mcpServers.discord;
  assert.ok(decl, 'the plugin declares a "discord" server');
  assert.equal(decl.type, 'http');
  assert.ok(decl.url.startsWith('https://'), 'a remote endpoint must be https');
  assert.deepEqual(decl.auth.tokenSource, { kind: 'env', name: 'HELMION_DISCORD_MCP_TOKEN' });
  assert.deepEqual([...decl.tools].sort(), DISCORD_MCP_TOOLS.map((t) => t.name).sort());
  // The remote-declaration refusal rules, applied by scan: no credential
  // field and no Authorization header anywhere in the declaration.
  const forbidden = ['token', 'accessToken', 'access_token', 'apiKey', 'api_key', 'authorization'];
  const walk = (v, path = '') => {
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        assert.ok(!forbidden.includes(k), `declaration carries a literal credential at ${path}${k}`);
        walk(val, `${path}${k}.`);
      }
    }
  };
  walk(decl);
});
