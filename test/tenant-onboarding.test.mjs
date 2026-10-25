// Tenant onboarding: starter seeding, the honest asleep state, and the
// multi-tenant answer path.
//
// The two-tenant harness drives the REAL mesh (createEnvoyMesh) and the
// REAL tenant-agent-state store over an in-memory fake pool, the same
// style as test/tenant-isolation.test.mjs: the fake behaves like a
// database whose queries are tenant-filtered exactly where the SQL says
// so. Tenant A is the hand-wired operator tenant (no readiness signals
// at all), tenant B has a registered runner + a vault credential for
// Gemini only, tenant C never finished connecting anything.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSignupHandler, STARTER_CHANNEL, STARTER_WELCOME_BODY } from '../src/cloud/signup.mjs';
import {
  ASLEEP_NO_PROVIDER_LINE, ASLEEP_NO_RUNNER_LINE, claimGateFor, computeTenantAgentState,
  createTenantAgentStateStore, handleTenantAgentStateRoute, tenantAgentStateOn,
} from '../src/cloud/tenant-agent-state.mjs';
import { createEnvoyMesh } from '../src/cloud/envoy-mesh.mjs';
import { CONFIG_SUBJECT, serializeConfig } from '../src/cloud/envoy-agents.mjs';
import { discoverCommands, expandCommand, resolveCommand } from '../src/agent/commands.mjs';
import {
  discoverTenantCommands, ensureTenantStarterCommands, starterCommandFiles, tenantWorkspacePath,
} from '../src/agent/tenant-workspace.mjs';

// ---------- the pure state ----------

test('agent state: awake needs a runner AND a credential', () => {
  const awake = computeTenantAgentState({ runners: 1, presence: [{ provider: 'gemini', connected: true }], connections: [] });
  assert.equal(awake.state, 'awake');
  assert.deepEqual(awake.connectedProviders, ['gemini']);
  assert.equal(awake.line, null);
});

test('agent state: no credential is the asleep state with the plain-words line', () => {
  const fresh = computeTenantAgentState({});
  assert.equal(fresh.state, 'asleep');
  assert.equal(fresh.reason, 'no-provider');
  assert.equal(fresh.line, 'Your agents wake up when you connect a subscription.');
  assert.equal(fresh.line, ASLEEP_NO_PROVIDER_LINE);
  const runnerOnly = computeTenantAgentState({ runners: 2, presence: [], connections: [] });
  assert.equal(runnerOnly.state, 'asleep');
  assert.equal(runnerOnly.reason, 'no-provider');
});

test('agent state: credential without a runner names the computer, not the subscription', () => {
  const s = computeTenantAgentState({ runners: 0, presence: [], connections: [{ provider_id: 'openai_codex', credential_reference: 'vault://tenant/t/openai' }] });
  assert.equal(s.state, 'asleep');
  assert.equal(s.reason, 'no-runner');
  assert.equal(s.line, ASLEEP_NO_RUNNER_LINE);
  assert.deepEqual(s.connectedProviders, ['openai'], 'openai_codex maps to the ChatGPT seat');
});

test('agent state: a connection without a vault reference is not a credential', () => {
  const s = computeTenantAgentState({ runners: 1, presence: [{ provider: 'grok', connected: false }], connections: [{ provider_id: 'gemini', credential_reference: 'env:GEMINI_API_KEY' }] });
  assert.equal(s.state, 'asleep');
  assert.deepEqual(s.connectedProviders, []);
});

test('claim gate: no signals = ungated (hand-wired tenants unchanged); signals = authoritative', () => {
  assert.equal(claimGateFor(computeTenantAgentState({})), null);
  const gate = claimGateFor(computeTenantAgentState({ runners: 1, presence: [{ provider: 'gemini', connected: true }], connections: [] }));
  assert.deepEqual([...gate].sort(), ['gemini', 'maestro'], 'Maestro rides on a real seat');
  const empty = claimGateFor(computeTenantAgentState({ runners: 1, presence: [], connections: [] }));
  assert.equal(empty.size, 0, 'a registered runner with an empty vault gates everything off');
});

// ---------- signup seeding ----------

function res() { const r = { status: 0, body: '', writeHead(s) { r.status = s; }, end(b) { r.body = b; } }; return r; }

test('signup seeds the starter channel + welcome notice and reports the asleep state', async () => {
  const calls = [];
  const client = {
    query: async (sql, args) => {
      calls.push([sql, args]);
      if (sql.startsWith('select tenant_id from helmion.tenant_memberships')) return { rowCount: 0, rows: [] };
      if (sql.includes('insert into helmion.envoy_channels')) return { rowCount: 1, rows: [{ id: 'chan-1' }] };
      return {};
    },
    release() {},
  };
  const h = createSignupHandler({
    getIdentityImpl: () => ({ getSession: (c) => (c === 'sealed' ? { subject: 'user_new123' } : null) }),
    getPoolImpl: () => ({ connect: async () => client }),
  });
  const r = res();
  await h({ method: 'POST', headers: { cookie: 'helmion_admin_session=sealed' } }, r);
  assert.equal(r.status, 201);
  const body = JSON.parse(r.body);
  assert.equal(body.agentState.state, 'asleep');
  assert.equal(body.agentState.line, ASLEEP_NO_PROVIDER_LINE);
  const channelInsert = calls.find(([sql]) => sql.includes('insert into helmion.envoy_channels'));
  assert.ok(channelInsert, 'starter channel inserted in the signup transaction');
  assert.deepEqual(channelInsert[1].slice(1), [STARTER_CHANNEL.slug, STARTER_CHANNEL.title, STARTER_CHANNEL.kind, 'user_new123']);
  const welcomeInsert = calls.find(([sql]) => sql.includes('insert into helmion.envoy_messages'));
  assert.ok(welcomeInsert, 'welcome notice inserted');
  assert.equal(welcomeInsert[1][1], 'chan-1');
  assert.equal(welcomeInsert[1][2], 'system:envoy');
  assert.equal(welcomeInsert[1][3], STARTER_WELCOME_BODY);
  assert.ok(STARTER_WELCOME_BODY.includes(ASLEEP_NO_PROVIDER_LINE), 'the welcome says the agents are asleep until a subscription connects');
  assert.equal(welcomeInsert[1][4], `welcome:${body.tenantId}`);
});

// ---------- tenant workspaces ----------

test('tenant workspace: path mapping is contained and starters stock additively', async () => {
  assert.equal(tenantWorkspacePath('/ws', 'ABC-123'), join('/ws', 'tenants', 'abc-123'));
  assert.throws(() => tenantWorkspacePath('/ws', '../evil'), /cannot name/);
  assert.throws(() => tenantWorkspacePath('/ws', 'a/b'), /cannot name/);

  const starters = await starterCommandFiles();
  assert.deepEqual(starters.map((s) => s.name), ['draft', 'explain', 'plan', 'standup', 'summarize']);

  const dir = await mkdtemp(join(tmpdir(), 'tenant-ws-'));
  const written = await ensureTenantStarterCommands(dir);
  assert.deepEqual(written, ['draft', 'explain', 'plan', 'standup', 'summarize']);
  assert.deepEqual(await ensureTenantStarterCommands(dir), [], 'second stocking writes nothing');

  // An edited starter is the tenant's own now — never overwritten.
  const draftPath = join(dir, '.helmion', 'commands', 'draft.md');
  await writeFile(draftPath, '---\ndescription: Mine\n---\nMY OWN DRAFT\n');
  assert.deepEqual(await ensureTenantStarterCommands(dir), []);
  assert.match(await readFile(draftPath, 'utf8'), /MY OWN DRAFT/);
});

test('tenant workspace: the real discovery path expands the tenant starters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tenant-root-'));
  const tenantDir = tenantWorkspacePath(root, 'tenant-b');
  await ensureTenantStarterCommands(tenantDir);

  // Discovery straight against the tenant dir finds all five.
  const own = await discoverCommands({ workspace: tenantDir, builtins: [], plugins: [], includeUser: false });
  assert.deepEqual(own.list.map((c) => c.name), ['draft', 'explain', 'plan', 'standup', 'summarize']);
  const draft = resolveCommand(own, 'draft');
  assert.ok(draft);
  assert.match(expandCommand(draft.body, 'tel bryce the sight is reddy', { argumentNames: draft.argumentNames }), /tel bryce the sight is reddy/);

  // Merged discovery: the bridge workspace's own /draft wins; the
  // tenant's other starters fill the gaps. HOME is pointed at the empty
  // tmp root so the user tier (~/.helmion/commands) cannot leak in.
  const base = join(root, 'bridge-ws');
  await mkdir(join(base, '.helmion', 'commands'), { recursive: true });
  await writeFile(join(base, '.helmion', 'commands', 'draft.md'), '---\ndescription: Operator draft\n---\nBASE-DRAFT for $ARGUMENTS\n');
  const prevHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const merged = await discoverTenantCommands({ workspace: base, tenantDir, builtins: [], plugins: [] });
    assert.match(resolveCommand(merged, 'draft').body, /BASE-DRAFT/);
    assert.ok(resolveCommand(merged, 'plan'), 'tenant starter fills the gap');
    assert.equal(merged.list.length, 5);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  }
});

// ---------- the two-tenant harness ----------

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const C = 'cccccccc-3333-4333-8333-333333333333';
const CH_A = 'a0000000-0000-4000-8000-00000000000a';
const CH_B = 'b0000000-0000-4000-8000-00000000000b';
const CH_C = 'c0000000-0000-4000-8000-00000000000c';
const past = (ms) => new Date(Date.now() - ms).toISOString();

function harnessTables() {
  const cfg = (agents) => serializeConfig({ agents, joined: Object.fromEntries(agents.map((p) => [p, past(3_600_000)])), discord: null, pendingLink: null });
  const msg = (tenant_id, channel_id, author_subject, author_kind, body, id, minsAgo = 5) => ({
    id, tenant_id, channel_id, author_subject, author_kind, body, idempotency_key: `key-${id}`, created_at: past(minsAgo * 60_000), metadata: null,
  });
  return {
    tenant_memberships: [
      { tenant_id: A, subject: 'user_a', role: 'owner', active: true },
      { tenant_id: B, subject: 'user_b', role: 'owner', active: true },
      { tenant_id: C, subject: 'user_c', role: 'owner', active: true },
    ],
    envoy_channels: [
      { id: CH_A, tenant_id: A, slug: 'team', title: 'Team', kind: 'team' },
      { id: CH_B, tenant_id: B, slug: 'team', title: 'Team', kind: 'team' },
      { id: CH_C, tenant_id: C, slug: 'team', title: 'Team', kind: 'team' },
    ],
    envoy_messages: [
      msg(A, CH_A, CONFIG_SUBJECT, 'system', cfg(['gemini']), 'c0ffee00-0000-4000-8000-0000000000a0', 60),
      // Bite 2 (impostor removal): an unnamed message in an ordinary
      // channel earns NO agent turn, so A's ask names its agent — like
      // B's — and A stays the ungated control for the claim gate below.
      msg(A, CH_A, 'user_a', 'human', '@gemini morning update please', 'a1500000-0000-4000-8000-0000000000a1', 5),
      msg(B, CH_B, CONFIG_SUBJECT, 'system', cfg(['gemini', 'grok']), 'c0ffee00-0000-4000-8000-0000000000b0', 60),
      msg(B, CH_B, 'user_b', 'human', '@gemini write the summary', 'b1500000-0000-4000-8000-0000000000b1', 5),
      msg(B, CH_B, 'user_b', 'human', '@grok check the numbers', 'b2500000-0000-4000-8000-0000000000b2', 4),
      msg(C, CH_C, CONFIG_SUBJECT, 'system', cfg(['gemini']), 'c0ffee00-0000-4000-8000-0000000000c0', 60),
      msg(C, CH_C, 'user_c', 'human', 'is anyone there?', 'c1500000-0000-4000-8000-0000000000c1', 5),
    ],
    // B finished pairing a computer; C started a pairing code and never
    // finished — a started code is not a registered runner.
    desktop_links: [
      { tenant_id: B, subject: 'user_b', token_hash: 'hash-b', revoked_at: null },
      { tenant_id: C, subject: 'user_c', token_hash: null, revoked_at: null },
    ],
    // B's runner vault holds Gemini. It reports Grok as not connected.
    runner_provider_presence: [
      { tenant_id: B, provider: 'gemini', connected: true },
      { tenant_id: B, provider: 'grok', connected: false },
    ],
    provider_connections: [],
  };
}

function harnessPool(tables) {
  let seq = 100;
  const nextId = () => `f0000000-0000-4000-8000-${String(seq++).padStart(12, '0')}`;
  const client = {
    async query(text, vals = []) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      if (/^(begin|commit|rollback)/i.test(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes('set_config')) return { rows: [{}], rowCount: 1 };
      if (sql.includes('insert into helmion.envoy_messages')) {
        const [tenant_id, channel_id, author_subject, author_kind, body, idempotency_key] = vals;
        const dupe = tables.envoy_messages.some((r) => r.tenant_id === tenant_id && r.channel_id === channel_id && r.author_subject === author_subject && r.idempotency_key === idempotency_key);
        if (dupe) return { rows: [], rowCount: 0 };
        const row = { id: nextId(), tenant_id, channel_id, author_subject, author_kind, body, idempotency_key, created_at: new Date().toISOString(), metadata: null };
        tables.envoy_messages.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('from helmion.tenant_memberships')) {
        const rows = tables.tenant_memberships.filter((r) => r.tenant_id === vals[0] && r.subject === vals[1] && r.active);
        return { rows: rows.map((r) => ({ role: r.role })), rowCount: rows.length };
      }
      if (sql.includes('from helmion.desktop_links')) {
        const n = tables.desktop_links.filter((r) => r.tenant_id === vals[0] && r.token_hash !== null && r.revoked_at === null).length;
        return { rows: [{ n }], rowCount: 1 };
      }
      if (sql.includes('from helmion.runner_provider_presence')) {
        const rows = tables.runner_provider_presence.filter((r) => r.tenant_id === vals[0]);
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('from helmion.provider_connections')) {
        const rows = tables.provider_connections.filter((r) => r.tenant_id === vals[0]);
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('distinct on (channel_id)')) {
        const byChannel = new Map();
        for (const r of tables.envoy_messages.filter((x) => x.tenant_id === vals[0] && x.author_subject === vals[1])) {
          const cur = byChannel.get(r.channel_id);
          if (!cur || r.created_at > cur.created_at || (r.created_at === cur.created_at && r.id > cur.id)) byChannel.set(r.channel_id, r);
        }
        const rows = [...byChannel.values()].map((r) => ({ channel_id: r.channel_id, body: r.body }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('from helmion.envoy_channels')) {
        const rows = tables.envoy_channels.filter((r) => r.tenant_id === vals[0] && r.id === vals[1]);
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('from helmion.envoy_messages') && sql.includes('idempotency_key=$4')) {
        const rows = tables.envoy_messages.filter((r) => r.tenant_id === vals[0] && r.channel_id === vals[1] && r.author_subject === vals[2] && r.idempotency_key === vals[3]);
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('from helmion.envoy_messages') && sql.includes('author_subject=$3')) {
        const rows = tables.envoy_messages.filter((r) => r.tenant_id === vals[0] && r.channel_id === vals[1] && r.author_subject === vals[2]).sort((x, y) => y.created_at.localeCompare(x.created_at) || y.id.localeCompare(x.id));
        return { rows: rows.slice(0, 1).map((r) => ({ body: r.body })), rowCount: Math.min(rows.length, 1) };
      }
      if (sql.includes('from helmion.envoy_messages')) {
        const rows = tables.envoy_messages
          .filter((r) => r.tenant_id === vals[0] && r.channel_id === vals[1] && r.author_subject !== vals[2] && r.created_at > vals[3])
          .sort((x, y) => y.created_at.localeCompare(x.created_at) || y.id.localeCompare(x.id))
          .slice(0, 40);
        return { rows, rowCount: rows.length };
      }
      throw new Error(`harness pool: unexpected query: ${sql.slice(0, 100)}`);
    },
    release() {},
  };
  return { connect: async () => client };
}

test('two tenants: B is claimed and answered by its own runner; C stays asleep and untouched', async () => {
  const tables = harnessTables();
  const pool = harnessPool(tables);
  const mesh = createEnvoyMesh({ pool, publishImpl: async () => {} });
  const store = createTenantAgentStateStore(pool);
  const devA = { tenantId: A, subject: 'user_a', role: 'owner', viaDeviceToken: true };
  const devB = { tenantId: B, subject: 'user_b', role: 'owner', viaDeviceToken: true };
  const ownerC = { tenantId: C, subject: 'user_c', role: 'owner' };

  // States first: B awake, C asleep with the plain-words line, A the
  // hand-wired tenant — no signals, so claiming is not gated for it.
  const stateB = await store.stateFor(B);
  assert.equal(stateB.state, 'awake');
  assert.deepEqual(stateB.connectedProviders, ['gemini']);
  const stateC = await store.stateFor(C);
  assert.equal(stateC.state, 'asleep');
  assert.equal(stateC.line, 'Your agents wake up when you connect a subscription.');
  assert.equal(stateC.hasRunner, false, 'a pairing code that was never exchanged is not a runner');
  assert.equal((await store.stateFor(A)).gated, false);

  // B's runner polls for both agents it would like to serve. Only the
  // Gemini message is handed over — B has no Grok credential — and the
  // withheld provider is named, not silently dropped.
  const workB = await mesh.agentWork(devB, 'gemini,grok');
  assert.deepEqual(workB.work.map((w) => w.message.id), ['b1500000-0000-4000-8000-0000000000b1']);
  assert.deepEqual(workB.work[0].agents, ['gemini']);
  assert.deepEqual(workB.withheld, [{ provider: 'grok', reason: 'no-provider' }]);
  assert.equal(workB.agentState.state, 'awake');

  // The stub runner answers as B's Gemini; the work clears.
  const reply = await mesh.postAsAgent(devB, { channelId: CH_B, provider: 'gemini', replyTo: 'b1500000-0000-4000-8000-0000000000b1', body: 'Summary ready.' });
  assert.equal(reply.receipt.durable, true);
  const workBAfter = await mesh.agentWork(devB, 'gemini,grok');
  assert.equal(workBAfter.work.length, 0);
  assert.deepEqual(workBAfter.withheld, [{ provider: 'grok', reason: 'no-provider' }], 'the Grok message is still B\u2019s to connect, never silently served');

  // A's runner (Troy's) gets A's work exactly as before the gate — and
  // nothing of B's or C's, ever.
  const workA = await mesh.agentWork(devA, 'gemini,grok');
  assert.deepEqual(workA.work.map((w) => w.message.id), ['a1500000-0000-4000-8000-0000000000a1']);
  assert.equal(workA.agentState.gated, false);
  assert.equal(workA.withheld, undefined);
  const seenByAorB = [...workA.work, ...workB.work, ...workBAfter.work].map((w) => w.channel.id);
  assert.ok(!seenByAorB.includes(CH_C), 'tenant C\u2019s channel never reaches another tenant\u2019s runner');

  // C has no device token (no runner finished pairing), so C cannot
  // claim work at all — and its message simply stays, asleep.
  await assert.rejects(mesh.agentWork(ownerC, 'gemini'), /DEVICE_TOKEN/);
  const stateOn = await tenantAgentStateOn({ query: (sql, vals) => harnessPool(tables).connect().then((c) => c.query(sql, vals)) }, C);
  assert.equal(stateOn.state, 'asleep');
});

test('agent-state route: answers only its own path, 503 when the database is not configured', async () => {
  const prev = process.env.HELMION_DATABASE_URL;
  delete process.env.HELMION_DATABASE_URL;
  try {
    const sent = [];
    const handled = await handleTenantAgentStateRoute({
      request: { method: 'GET', headers: {} }, response: {},
      requestUrl: new URL('http://x/api/admin/envoy/agent-state'),
      activeTenantActor: async () => ({ tenantId: B, subject: 'user_b', role: 'owner' }),
      send: (_r, status, body) => sent.push([status, JSON.parse(body)]),
      TenantAuthorizationError: class extends Error {},
    });
    assert.equal(handled, true);
    assert.equal(sent[0][0], 503);
    const other = await handleTenantAgentStateRoute({
      request: { method: 'GET', headers: {} }, response: {},
      requestUrl: new URL('http://x/api/admin/envoy/channels'),
      activeTenantActor: async () => { throw new Error('must not be called'); },
      send: () => { throw new Error('must not send'); },
      TenantAuthorizationError: class extends Error {},
    });
    assert.equal(other, false);
  } finally {
    if (prev === undefined) delete process.env.HELMION_DATABASE_URL; else process.env.HELMION_DATABASE_URL = prev;
  }
});
