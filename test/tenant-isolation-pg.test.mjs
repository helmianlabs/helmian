// Tenant isolation against a real database (Bite H, audit letter 724
// and Scribe 797 item 4). The fake-pool suites cannot enforce the
// schema, and production connects as a role that bypasses row-level
// security, so the application-level boundary is the isolation story
// and it has to be proven against real SQL: two seeded tenants with
// unique canary strings, the real modules, and assertions that one
// tenant's canary never appears in the other tenant's reads.
//
// The notebook surface pins the CURRENT behaviour honestly. When
// this suite was written, the reads carried a shared NULL
// namespace: a row with project_slug NULL was read by every tenant
// (the documented pre-tenant semantics; production held exactly
// one such row, key seat-build-winner-2026-11-06). Fix A9 (audit
// AT-5/T13) took the decision and closed the namespace on the
// read side: every read binds the tenant slug exactly, so a
// NULL-slug row is now visible to NO tenant, and the production
// row is dispositioned at deploy time. These tests prove the
// boundary that exists today: tenant-owned rows never cross,
// NULL rows never surface, and the Muse connector's read —
// tenant-only from the start — is unchanged.
//
// Runs when HELMIAN_TEST_PG_URL points at a scratch database with the
// repo's sql/ migrations applied, and skips cleanly without one (the
// connector-outbound-pg.test.mjs pattern). The scratch connection is
// a superuser, mirroring production's RLS-bypass posture: what is
// proven here is the application boundary, not the policies. Each
// test mints its own tenant pair, so tests never share rows.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

const pgUrl = process.env.HELMIAN_TEST_PG_URL;
const pgSkip = pgUrl ? false : 'HELMIAN_TEST_PG_URL is not set';

function makeTenants() {
  const run = randomUUID().slice(0, 8);
  const A = `ta-${run}`;
  const B = `tb-${run}`;
  return {
    run,
    A,
    B,
    CANARY_A: `CANARY-A-${run}`,
    CANARY_B: `CANARY-B-${run}`,
    CANARY_SHARED: `CANARY-SHARED-${run}`,
    actorA: { tenantId: A, subject: 'user-a', role: 'owner', sessionId: 'sess-a', requestId: 'req-a' },
    actorB: { tenantId: B, subject: 'user-b', role: 'owner', sessionId: 'sess-b', requestId: 'req-b' },
  };
}

async function makePool() {
  const { default: pg } = await import('pg');
  return new pg.Pool({ connectionString: pgUrl });
}

async function seedBase(pool, { A, B }) {
  for (const [tenantId, subject] of [[A, 'user-a'], [B, 'user-b']]) {
    await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantId, `Isolation PG ${tenantId}`]);
    await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role, active) values ($1,$2,$3,true)', [tenantId, subject, 'owner']);
    await pool.query('insert into helmion.projects(slug, name) values ($1,$2) on conflict (slug) do nothing', [tenantId, tenantId]);
  }
}

async function cleanup(pool, { A, B, run }) {
  const byTenant = [
    'delete from helmion.audit_outbox where tenant_id=$1',
    'delete from helmion.audit_events where tenant_id=$1',
    'delete from helmion.connector_outbound_messages where tenant_id=$1',
    'delete from helmion.provider_credentials where tenant_id=$1',
    'delete from helmion.tenant_vault_keys where tenant_id=$1',
    'delete from helmion.librarian_incidents where tenant_id=$1',
    'delete from helmion.librarian_rules where tenant_id=$1',
    'delete from helmion.envoy_messages where tenant_id=$1',
    'delete from helmion.envoy_channels where tenant_id=$1',
    'delete from helmion.helm_kb_misses where tenant_id=$1',
    'delete from helmion.workspace_agent_sessions where tenant_id=$1',
    'delete from helmion.desktop_links where tenant_id=$1',
    'delete from helmion.runner_provider_presence where tenant_id=$1',
    'delete from helmion.provider_connections where tenant_id=$1',
    'delete from helmion.context_entries where project_slug=$1',
    'delete from helmion.blockers where project_slug=$1',
    'delete from helmion.tenant_memberships where tenant_id=$1',
    'delete from helmion.projects where slug=$1',
    'delete from helmion.tenants where tenant_id=$1',
  ];
  for (const tenantId of [A, B]) {
    for (const sql of byTenant) await pool.query(sql, [tenantId]).catch(() => {});
  }
  // The shared-namespace canaries seeded by the notebook tests carry
  // this test's run marker in their values and descriptions.
  await pool.query("delete from helmion.context_entries where project_slug is null and value::text like $1", [`%${run}%`]).catch(() => {});
  await pool.query('delete from helmion.blockers where project_slug is null and description like $1', [`%${run}%`]).catch(() => {});
}

// ------------------------------------------------------------------
// Surface 1: the shared notebook (envoy-notebook read, the pre-tenant
// MCP read in the Neon adapter, and the Muse connector memory read).
// ------------------------------------------------------------------

async function seedNotebook(pool, t) {
  const { A, B, CANARY_A, CANARY_B, CANARY_SHARED } = t;
  const entry = (slug, key, value) => pool.query(
    'insert into helmion.context_entries(project_slug, key, value) values ($1,$2,$3::jsonb)',
    [slug, key, JSON.stringify(value)],
  );
  await entry(A, 'canary-a-fact', CANARY_A);
  await entry(B, 'canary-b-fact', CANARY_B);
  // The production NULL row's exact key, carrying a canary value: a
  // row of this shape rode every tenant's prompt until fix A9;
  // today it must surface for no one.
  await entry(null, 'seat-build-winner-2026-11-06', CANARY_SHARED);
  // Same key filed by tenant A and by the shared namespace.
  await entry(A, 'canary-shared-key', `${CANARY_A}-WINS`);
  await entry(null, 'canary-shared-key', `${CANARY_SHARED}-VALUE`);
  const blocker = (slug, status, description, lesson) => pool.query(
    `insert into helmion.blockers(project_slug, status, severity, description, outcome, citation, root_cause, snippet, lesson, resolved_at)
     values ($1,$2,'high',$3,$4,$5,$6,$7,$8, case when $2='RESOLVED' then clock_timestamp() else null end)`,
    [slug, status, description,
      status === 'RESOLVED' ? 'done' : null,
      status === 'RESOLVED' ? 'proof.mjs:1' : null,
      status === 'RESOLVED' ? 'canary cause' : null,
      status === 'RESOLVED' ? 'canary snippet' : null,
      lesson],
  );
  await blocker(A, 'OPEN', `${CANARY_A}-BLOCKER`, null);
  await blocker(B, 'OPEN', `${CANARY_B}-BLOCKER`, null);
  await blocker(null, 'OPEN', `${CANARY_SHARED}-BLOCKER`, null);
  await blocker(A, 'RESOLVED', `${CANARY_A}-OLD`, `${CANARY_A}-LESSON`);
  await blocker(B, 'RESOLVED', `${CANARY_B}-OLD`, `${CANARY_B}-LESSON`);
}

test('notebook: a tenant seat read carries only its own rows — never the other tenant, never the shared rows', { skip: pgSkip }, async () => {
  const { readNotebookBlock } = await import('../src/cloud/envoy-notebook.mjs');
  const t = makeTenants();
  const pool = await makePool();
  try {
    await seedBase(pool, t);
    await seedNotebook(pool, t);
    const blockA = await readNotebookBlock(pool, t.A, { log: () => {} });
    assert.ok(blockA, 'tenant A has a notebook block');
    for (const expected of [t.CANARY_A, `${t.CANARY_A}-BLOCKER`, `${t.CANARY_A}-LESSON`]) {
      assert.ok(blockA.includes(expected), `tenant A block carries ${expected}`);
    }
    assert.ok(!blockA.includes(t.CANARY_B), 'tenant A block never carries tenant B canary');
    assert.ok(!blockA.includes(t.CANARY_SHARED), 'tenant A block never carries the shared NULL rows (fix A9)');
    const blockB = await readNotebookBlock(pool, t.B, { log: () => {} });
    assert.ok(blockB, 'tenant B has a notebook block');
    for (const expected of [t.CANARY_B, `${t.CANARY_B}-BLOCKER`, `${t.CANARY_B}-LESSON`]) {
      assert.ok(blockB.includes(expected), `tenant B block carries ${expected}`);
    }
    assert.ok(!blockB.includes(t.CANARY_A), 'tenant B block never carries tenant A canary');
    assert.ok(!blockB.includes(t.CANARY_SHARED), 'tenant B block never carries the shared NULL rows (fix A9)');
  } finally {
    await cleanup(pool, t);
    await pool.end();
  }
});

test('notebook: where a key exists for the tenant and in the shared rows, the tenant row is the only one ever seen', { skip: pgSkip }, async () => {
  const { readNotebookBlock } = await import('../src/cloud/envoy-notebook.mjs');
  const t = makeTenants();
  const pool = await makePool();
  try {
    await seedBase(pool, t);
    await seedNotebook(pool, t);
    const blockA = await readNotebookBlock(pool, t.A, { log: () => {} });
    assert.ok(blockA.includes(`${t.CANARY_A}-WINS`), 'tenant A sees its own value for the shared key');
    assert.ok(!blockA.includes(`${t.CANARY_SHARED}-VALUE`), 'the shared value never surfaces for tenant A');
    const blockB = await readNotebookBlock(pool, t.B, { log: () => {} });
    assert.ok(!blockB.includes(`${t.CANARY_SHARED}-VALUE`), 'tenant B, with no row of its own, no longer sees the shared value (fix A9)');
    assert.ok(!blockB.includes('canary-shared-key'), 'the shared key itself never surfaces for tenant B');
  } finally {
    await cleanup(pool, t);
    await pool.end();
  }
});

test('notebook: the pre-tenant MCP read (Neon adapter getContext) keeps the same boundary', { skip: pgSkip }, async () => {
  const { createNeonStore } = await import('../src/adapters/neon.mjs');
  const t = makeTenants();
  const pool = await makePool();
  try {
    await seedBase(pool, t);
    await seedNotebook(pool, t);
    const store = await createNeonStore(null, { pool });
    const ctxA = await store.getContext(t.A);
    const aText = JSON.stringify(ctxA);
    assert.ok(aText.includes(t.CANARY_A), 'getContext(A) carries tenant A rows');
    assert.ok(!aText.includes(t.CANARY_SHARED), 'getContext(A) carries no shared rows — fix A9 closed the NULL namespace');
    assert.ok(!aText.includes(t.CANARY_B), 'getContext(A) never carries tenant B rows');
    const ctxB = await store.getContext(t.B);
    const bText = JSON.stringify(ctxB);
    assert.ok(bText.includes(t.CANARY_B), 'getContext(B) carries tenant B rows');
    assert.ok(!bText.includes(t.CANARY_SHARED), 'getContext(B) carries no shared rows — fix A9 closed the NULL namespace');
    assert.ok(!bText.includes(t.CANARY_A), 'getContext(B) never carries tenant A rows');
  } finally {
    await cleanup(pool, t);
    await pool.end();
  }
});

test('notebook: the Muse connector memory read is stricter still (own tenant only, no shared rows)', { skip: pgSkip }, async () => {
  const { createMuseConnectorData } = await import('../src/cloud/muse-connector.mjs');
  const t = makeTenants();
  const pool = await makePool();
  try {
    await seedBase(pool, t);
    await seedNotebook(pool, t);
    const data = createMuseConnectorData(pool);
    const foundA = await data.searchMemory(t.A, 'CANARY');
    assert.ok(foundA.length >= 1, 'tenant A search finds its own entries');
    assert.ok(foundA.every((row) => !JSON.stringify(row).includes(t.CANARY_B)), 'tenant A search never returns tenant B entries');
    assert.ok(foundA.every((row) => !JSON.stringify(row).includes(t.CANARY_SHARED)), 'tenant A search excludes the shared NULL rows by design');
    const aEntry = foundA.find((row) => row.key === 'canary-a-fact');
    assert.ok(aEntry, 'tenant A canary entry is searchable');
    assert.equal(await data.readMemory(t.B, aEntry.id), null, 'tenant B reading tenant A entry id answers exactly like a missing id');
    const sharedRow = await pool.query("select id from helmion.context_entries where project_slug is null and key='seat-build-winner-2026-11-06' and value::text like $1", [`%${t.run}%`]);
    assert.equal(await data.readMemory(t.A, sharedRow.rows[0].id), null, 'even tenant A cannot read the shared row through the connector');
    const read = await data.readMemory(t.A, aEntry.id);
    assert.ok(JSON.stringify(read).includes(t.CANARY_A), 'tenant A reads its own entry in full');
  } finally {
    await cleanup(pool, t);
    await pool.end();
  }
});

// ------------------------------------------------------------------
// Surface 4: channel and message stores, and the librarian's pen.
// ------------------------------------------------------------------

test('envoy: channels and messages never cross, and a cross-tenant append cannot land', { skip: pgSkip }, async () => {
  const { createEnvoyStore } = await import('../src/cloud/envoy-chat.mjs');
  const t = makeTenants();
  const pool = await makePool();
  try {
    await seedBase(pool, t);
    const store = createEnvoyStore(pool);
    const { channel: channelA } = await store.createChannel(t.actorA, { slug: 'team', title: 'Team A', kind: 'team' });
    const { channel: channelB } = await store.createChannel(t.actorB, { slug: 'team', title: 'Team B', kind: 'team' });
    assert.notEqual(channelA.id, channelB.id);
    assert.deepEqual((await store.listChannels(t.actorA)).channels.map((c) => c.id), [channelA.id], 'tenant A lists only its own channel');
    assert.deepEqual((await store.listChannels(t.actorB)).channels.map((c) => c.id), [channelB.id], 'tenant B lists only its own channel');
    await assert.rejects(
      () => store.listChannels({ tenantId: t.B, subject: 'user-a', role: 'owner', sessionId: 's', requestId: 'r' }),
      /not an active member/,
      'an actor who is not a member of the tenant is refused before any read',
    );
    await store.appendMessage(t.actorA, { channelId: channelA.id, body: `${t.CANARY_A} message`, idempotencyKey: `iso-a-${t.run}` });
    const messagesA = await store.listMessages(t.actorA, channelA.id);
    assert.ok(messagesA.messages.some((m) => String(m.body).includes(t.CANARY_A)), 'tenant A reads its own message');
    await assert.rejects(
      () => store.listMessages(t.actorB, channelA.id),
      /not found in this Organization/,
      'tenant B cannot list messages in tenant A channel',
    );
    await assert.rejects(
      () => store.appendMessage(t.actorA, { channelId: channelB.id, body: `${t.CANARY_A} intrusion`, idempotencyKey: `iso-x-${t.run}` }),
      'a message addressed to another tenant channel is refused (the composite tenant+channel foreign key)',
    );
    const stray = await pool.query('select count(*)::int as n from helmion.envoy_messages where tenant_id=$1 and channel_id=$2', [t.A, channelB.id]);
    assert.equal(stray.rows[0].n, 0, 'no cross-tenant message row landed');
    const messagesB = await store.listMessages(t.actorB, channelB.id);
    assert.ok(!messagesB.messages.some((m) => String(m.body).includes(t.CANARY_A)), 'tenant B channel carries no tenant A canary');
  } finally {
    await cleanup(pool, t);
    await pool.end();
  }
});

test('librarian: filed asks and incidents stay under the filing tenant slug', { skip: pgSkip }, async () => {
  const { createLibrarianStore } = await import('../src/cloud/envoy-librarian.mjs');
  const { readNotebookBlock } = await import('../src/cloud/envoy-notebook.mjs');
  const t = makeTenants();
  const pool = await makePool();
  try {
    await seedBase(pool, t);
    const librarian = createLibrarianStore(pool);
    const filed = await librarian.fileAsk(t.actorA, {
      channelId: `chan-${t.run}`, messageId: `msg-${t.run}`, channelTitle: 'Team', humanName: 'User A',
      seats: ['claude'], excerpt: `${t.CANARY_A} ask`,
    });
    assert.equal(filed.filed, true, 'the ask files');
    const row = await pool.query('select project_slug from helmion.context_entries where key=$1', [`chat:chan-${t.run}:msg-${t.run}`]);
    assert.equal(row.rows[0]?.project_slug, t.A, 'the entry is filed under tenant A slug, from the actor, never from caller input');
    const blockB = await readNotebookBlock(pool, t.B, { log: () => {} });
    assert.ok(!String(blockB ?? '').includes(t.CANARY_A), 'tenant B notebook never carries the ask tenant A filed');
    const incident = await librarian.fileIncident(t.actorA, { title: `${t.CANARY_A} incident`, mistake: 'canary mistake', key: `iso-${t.run}` });
    assert.equal(incident.filed, true, 'the incident files');
    const foundA = await librarian.lookupIncidents(t.actorA, { query: t.CANARY_A });
    assert.equal(foundA.length, 1, 'tenant A recalls its own incident');
    const foundB = await librarian.lookupIncidents(t.actorB, { query: t.CANARY_A });
    assert.equal(foundB.length, 0, 'tenant B lookup never returns tenant A incident');
    assert.equal(await librarian.solveIncident(t.actorB, { id: incident.id, solution: 'canary fix' }), false, 'tenant B cannot solve tenant A incident');
    assert.equal(await librarian.solveIncident(t.actorA, { id: incident.id, solution: 'canary fix' }), true, 'tenant A solves its own incident');
  } finally {
    await cleanup(pool, t);
    await pool.end();
  }
});

// ------------------------------------------------------------------
// Surface 5: agent sessions and workspace state reads.
// ------------------------------------------------------------------

test('sessions and state: agent sessions and the workspace state read stay inside the tenant', { skip: pgSkip }, async () => {
  const { createSessionsStore } = await import('../src/cloud/agent-sessions.mjs');
  const { createTenantAgentStateStore } = await import('../src/cloud/tenant-agent-state.mjs');
  const t = makeTenants();
  const pool = await makePool();
  try {
    await seedBase(pool, t);
    const sessions = createSessionsStore(pool);
    const mine = await sessions.create(t.A, { name: `sess-a-${t.run}`, provider: 'claude', routingTier: 'auto' });
    const theirs = await sessions.create(t.B, { name: `sess-b-${t.run}`, provider: 'gemini', routingTier: 'auto' });
    assert.deepEqual((await sessions.list(t.A)).map((s) => s.id), [mine.id], 'tenant A lists only its own session');
    assert.deepEqual((await sessions.list(t.B)).map((s) => s.id), [theirs.id], 'tenant B lists only its own session');
    await assert.rejects(() => sessions.update(t.A, theirs.id, { status: 'active' }), /session not found/, 'tenant A cannot update tenant B session');
    await assert.rejects(() => sessions.close(t.A, theirs.id), /session not found/, 'tenant A cannot close tenant B session');
    assert.equal((await sessions.close(t.A, mine.id)).closed, true, 'tenant A closes its own session');

    // Workspace state signals: A is awake on claude; B has gemini
    // presence and a gemini connection but no runner.
    await pool.query(
      `insert into helmion.desktop_links(tenant_id, subject, code_hash, code_expires_at, token_hash)
       values ($1,'user-a',$2, clock_timestamp() + interval '1 hour', $2)`,
      [t.A, 'a'.repeat(64)],
    );
    await pool.query('insert into helmion.runner_provider_presence(tenant_id, provider_name, connected) values ($1,$2,true)', [t.A, 'claude']);
    await pool.query('insert into helmion.runner_provider_presence(tenant_id, provider_name, connected) values ($1,$2,true)', [t.B, 'gemini']);
    await pool.query(
      `insert into helmion.provider_connections(tenant_id, provider_id, auth_mode, credential_reference, updated_by_subject)
       values ($1,'claude','oauth_subscription',$2,'user-a')`,
      [t.A, `vault://tenant/${t.A}/claude/session`],
    );
    await pool.query(
      `insert into helmion.provider_connections(tenant_id, provider_id, auth_mode, credential_reference, updated_by_subject)
       values ($1,'gemini','oauth_subscription',$2,'user-b')`,
      [t.B, `vault://tenant/${t.B}/gemini/session`],
    );
    const state = createTenantAgentStateStore(pool);
    const stateA = await state.stateFor(t.A);
    assert.equal(stateA.awake, true, 'tenant A is awake on its own signals');
    assert.deepEqual([...stateA.connectedProviders], ['claude'], 'tenant A state names only its own provider');
    const stateB = await state.stateFor(t.B);
    assert.equal(stateB.awake, false, 'tenant B has no runner of its own, so it sleeps');
    assert.equal(stateB.reason, 'no-runner');
    assert.deepEqual([...stateB.connectedProviders], ['gemini'], 'tenant B state names only its own provider');
    assert.ok(!JSON.stringify(stateA).includes('gemini'), 'tenant A state carries nothing of tenant B');
    assert.ok(!JSON.stringify(stateB).includes('claude'), 'tenant B state carries nothing of tenant A');
  } finally {
    await cleanup(pool, t);
    await pool.end();
  }
});
