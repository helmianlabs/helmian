// Bite L5 of the Maestro/Helm/Librarian fix programme (DESIGN
// 5.5, tenant isolation): the isolation proof for the roads
// THIS map built. Every new write path in the map runs under
// withTenantTransaction with requireActiveTenantMembership and
// the acting tenant's slug, and no bite writes a NULL slug —
// because the notebook read's NULL-inclusive predicate means a
// NULL row would be visible to every tenant. This file proves
// that claim with canaries on a real database:
//
//   - two tenants, A and B, each filing through every write
//     road the programme created or touched — the dispatch ask
//     road and the Guard-refusal incident road (the mesh tail's
//     fail-soft wrappers), assignment completions, human facts
//     (bite L1), incident commands (bite L3: solve, refile,
//     supersede), the Helm search filing (bite H5), and the
//     guide's miss queue;
//   - then every read road exercised as the OTHER tenant —
//     the recall read (bite L2), the notebook entries read and
//     Helm's fact answerer (bite H4), the notebook block, the
//     incident lookup, the knowledge base block, the state
//     answer composed from the other tenant's gathered records,
//     and the miss queue read the only way it is ever read,
//     per tenant at the table (sql/084: nothing reads the
//     queue back into a workspace surface) — must see NONE of
//     the first tenant's records: not visible, not quotable,
//     not countable. Each road is also exercised as the filing
//     tenant (the positive control), so "the other tenant sees
//     nothing" can never mean "nothing was written".
//   - cross-tenant incident commands are refused or no-ops:
//     one tenant cannot solve, refile, or supersede the other
//     tenant's incident, and the attempt changes nothing.
//   - after every road has run for both tenants, the NULL-slug
//     row count in each shared-memory table (context_entries,
//     librarian_incidents, librarian_rules, helm_kb_misses) is
//     exactly what it was before: zero new NULL rows.
//
// The parent lane's Bite H file (tenant-isolation-pg.test.mjs)
// proves the older surfaces — channels and messages, sessions,
// the notebook block's shared-row semantics, the connector
// reads. This file covers the M/H/L map's roads and does not
// repeat it; the existing notebook canary
// (envoy-notebook.test.mjs) is exercised alongside, unchanged.
//
// Runs when HELMIAN_TEST_PG_URL points at a scratch database
// with the repo's sql/ chain applied; skipped otherwise. The
// scratch connection is a superuser, mirroring production's
// RLS-bypass posture: what is proven here is the application
// boundary (the slug and tenant_id every road binds), not the
// policies. Each test mints its own tenant pair, so tests
// never share rows.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

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
    actorA: { tenantId: A, subject: 'user-a', role: 'owner', sessionId: 'sess-a', requestId: 'req-a' },
    actorB: { tenantId: B, subject: 'user-b', role: 'owner', sessionId: 'sess-b', requestId: 'req-b' },
  };
}

async function makePool() {
  const { default: pg } = await import('pg');
  return new pg.Pool({ connectionString: pgUrl, max: 4 });
}

async function seedBase(pool, { A, B }) {
  for (const [tenantId, subject] of [[A, 'user-a'], [B, 'user-b']]) {
    await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantId, `Isolation L5 ${tenantId}`]);
    await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role, active) values ($1,$2,$3,true)', [tenantId, subject, 'owner']);
    await pool.query('insert into helmion.projects(slug, name) values ($1,$2) on conflict (slug) do nothing', [tenantId, tenantId]);
  }
}

async function cleanup(pool, { A, B }) {
  const byTenant = [
    'delete from helmion.librarian_incidents where tenant_id=$1',
    'delete from helmion.librarian_rules where tenant_id=$1',
    'delete from helmion.helm_kb_misses where tenant_id=$1',
    'delete from helmion.context_entries where project_slug=$1',
    'delete from helmion.tenant_memberships where tenant_id=$1',
    'delete from helmion.projects where slug=$1',
    'delete from helmion.tenants where tenant_id=$1',
  ];
  for (const tenantId of [A, B]) {
    for (const sql of byTenant) await pool.query(sql, [tenantId]).catch(() => {});
  }
}

const silent = { log: () => {} };

async function nullCounts(pool) {
  const entries = await pool.query('select count(*)::int as n from helmion.context_entries where project_slug is null');
  const incidents = await pool.query('select count(*)::int as n from helmion.librarian_incidents where tenant_id is null');
  const rules = await pool.query('select count(*)::int as n from helmion.librarian_rules where tenant_id is null');
  const misses = await pool.query('select count(*)::int as n from helmion.helm_kb_misses where tenant_id is null');
  return { entries: entries.rows[0].n, incidents: incidents.rows[0].n, rules: rules.rows[0].n, misses: misses.rows[0].n };
}

// The one read whose NULL discipline is a choice, not a schema:
// the recall read (bite L2) binds the tenant's slug EXACTLY,
// where its sibling notebook read deliberately includes the
// shared NULL rows. Pin the choice in the source so a future
// edit that "harmonises" the two reads fails here first.
test('isolation source pin: the recall read binds the tenant slug exactly, never NULL-inclusive', async () => {
  const source = await readFile(new URL('../src/cloud/envoy-librarian.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async lookupFacts(');
  assert.ok(start > 0, 'the recall read exists in the Librarian store');
  const slice = source.slice(start, start + 1600);
  assert.ok(slice.includes('where project_slug = $1'), 'the recall read binds project_slug to the acting tenant');
  assert.ok(!slice.includes('project_slug is null'), 'the recall read never admits the shared NULL rows');
});

// ------------------------------------------------------------------
// Human facts (bite L1's write) against the recall read (bite
// L2), the notebook entries read and Helm's fact answerer
// (bite H4), and the notebook block.
// ------------------------------------------------------------------

test('isolation: a fact one tenant files is invisible to the other on every read road', { skip: pgSkip }, async () => {
  const { createLibrarianStore } = await import('../src/cloud/envoy-librarian.mjs');
  const { readNotebookEntries, readNotebookBlock } = await import('../src/cloud/envoy-notebook.mjs');
  const { helmFactAnswer, HELM_NOTHING_FILED_LINE } = await import('../src/cloud/envoy-helm.mjs');
  const t = makeTenants();
  const pool = await makePool();
  try {
    await seedBase(pool, t);
    const store = createLibrarianStore(pool);
    const factA = `The zorblax launch window opens at dawn. ${t.CANARY_A}`;
    const factB = `The quindle review board meets on Fridays. ${t.CANARY_B}`;
    assert.equal((await store.fileFact(t.actorA, {
      channelId: `chan-a-${t.run}`, messageId: `m-fact-a-${t.run}`, fact: factA,
      humanSubject: t.actorA.subject, humanName: 'User A', at: '2026-11-16T01:00:00.000Z',
    })).filed, true);
    assert.equal((await store.fileFact(t.actorB, {
      channelId: `chan-b-${t.run}`, messageId: `m-fact-b-${t.run}`, fact: factB,
      humanSubject: t.actorB.subject, humanName: 'User B', at: '2026-11-16T01:01:00.000Z',
    })).filed, true);

    // The filing landed under the filer's slug, and only there.
    const raw = await pool.query('select project_slug from helmion.context_entries where key = $1', [`fact:m-fact-a-${t.run}`]);
    assert.deepEqual(raw.rows.map((r) => r.project_slug), [t.A], 'the fact is bound to tenant A and nothing else');

    // Recall (bite L2): the owner finds it verbatim; the other
    // tenant, asking with the very words that match it, finds
    // nothing — and the reverse holds for B's fact.
    const recallA = await store.lookupFacts(t.actorA, { query: 'zorblax launch window' });
    assert.equal(recallA.found, true, 'tenant A recalls its own fact');
    assert.equal(recallA.text, factA, 'the recall quotes the fact verbatim');
    assert.equal(recallA.key, `fact:m-fact-a-${t.run}`);
    const recallB = await store.lookupFacts(t.actorB, { query: 'zorblax launch window' });
    assert.equal(recallB.found, false, 'tenant B recall never finds tenant A fact');
    const recallAcross = await store.lookupFacts(t.actorA, { query: 'quindle review board' });
    assert.equal(recallAcross.found, false, 'tenant A recall never finds tenant B fact');

    // The notebook entries read (bite H4's road): B's entries
    // hold B's fact and no trace of A's.
    const entriesB = await readNotebookEntries(pool, t.B, silent);
    assert.ok(Array.isArray(entriesB));
    assert.ok(!JSON.stringify(entriesB).includes(t.CANARY_A), 'tenant B entries carry no tenant A canary');
    assert.ok(!entriesB.some((e) => e.key === `fact:m-fact-a-${t.run}`), 'tenant A fact key is absent from tenant B entries');
    const entriesA = await readNotebookEntries(pool, t.A, silent);
    assert.ok(entriesA.some((e) => e.key === `fact:m-fact-a-${t.run}`), 'tenant A entries carry its own fact (positive control)');

    // Helm's fact answerer over those entries: for B the
    // question is honestly unanswered; for A it quotes the
    // fact word for word.
    const question = 'what do you have filed about the zorblax launch window?';
    const answerB = helmFactAnswer(entriesB, question);
    assert.equal(answerB.body, HELM_NOTHING_FILED_LINE, 'Helm tells tenant B it has nothing filed');
    assert.ok(!answerB.body.includes(t.CANARY_A));
    const answerA = helmFactAnswer(entriesA, question);
    assert.equal(answerA.body, factA, 'Helm quotes tenant A its own fact verbatim');

    // The notebook block: A's fact rides A's prompts only.
    const blockB = await readNotebookBlock(pool, t.B, silent);
    assert.ok(!String(blockB ?? '').includes(t.CANARY_A), 'tenant B notebook block carries no tenant A fact');
    const blockA = await readNotebookBlock(pool, t.A, silent);
    assert.ok(String(blockA ?? '').includes(t.CANARY_A), 'tenant A notebook block carries its own fact (positive control)');
  } finally {
    await cleanup(pool, t);
    await pool.end();
  }
});

// ------------------------------------------------------------------
// The dispatch ask road and assignment completions (the mesh
// tail's writes) against the recall and entries reads.
// ------------------------------------------------------------------

test('isolation: dispatched asks and assignment completions stay in the filing tenant', { skip: pgSkip }, async () => {
  const { createLibrarianStore, fileDispatchAsk, fileAssignmentCompletion } = await import('../src/cloud/envoy-librarian.mjs');
  const { readNotebookEntries, readNotebookBlock } = await import('../src/cloud/envoy-notebook.mjs');
  const t = makeTenants();
  const pool = await makePool();
  try {
    await seedBase(pool, t);
    const store = createLibrarianStore(pool);
    const chanA = `chan-a-${t.run}`;
    const excerptA = `plan the marlowe launch page ${t.CANARY_A}`;
    assert.equal(await fileDispatchAsk(store, t.actorA, {
      channelId: chanA, channelTitle: 'Marlowe Desk', messageId: `m-ask-a-${t.run}`,
      humanSubject: t.actorA.subject, humanName: 'User A', seats: ['claude'],
      guardDecision: 'allow', excerpt: excerptA, at: '2026-11-16T02:00:00.000Z',
    }, silent), true);
    assert.equal(await fileAssignmentCompletion(store, t.actorA, {
      channelId: chanA, channelTitle: `Marlowe Desk ${t.CANARY_A}`, messageId: `m-job-a-${t.run}`,
      humanSubject: t.actorA.subject,
      assignment: { v: 1, sequential: false, parts: [{ n: 1, owner: 'claude', ownerName: 'Claude' }] },
      at: '2026-11-16T02:05:00.000Z',
    }, silent), true);

    // Both records sit under tenant A's slug; neither is bound
    // to the NULL slug the notebook read shows every tenant.
    const askRows = await pool.query('select project_slug from helmion.context_entries where key = $1', [`chat:${chanA}:m-ask-a-${t.run}`]);
    assert.deepEqual(askRows.rows.map((r) => r.project_slug), [t.A]);
    const completionRows = await pool.query('select project_slug from helmion.context_entries where key = $1', [`completion:m-job-a-${t.run}`]);
    assert.deepEqual(completionRows.rows.map((r) => r.project_slug), [t.A]);
    const nullBound = await pool.query(
      'select count(*)::int as n from helmion.context_entries where project_slug is null and key = any($1)',
      [[`chat:${chanA}:m-ask-a-${t.run}`, `completion:m-job-a-${t.run}`]],
    );
    assert.equal(nullBound.rows[0].n, 0, 'no ask or completion binds the NULL slug');

    // Recall: the owner can be quoted its own ask record; the
    // other tenant cannot.
    const recallA = await store.lookupFacts(t.actorA, { query: 'marlowe launch page' });
    assert.equal(recallA.found, true, 'tenant A recalls its own ask');
    assert.equal(recallA.kind, 'ask');
    assert.equal(recallA.text, excerptA);
    const recallB = await store.lookupFacts(t.actorB, { query: 'marlowe launch page' });
    assert.equal(recallB.found, false, 'tenant B recall never finds tenant A ask');

    // The entries read and the block: no ask key, no completion
    // key, no canary for B.
    const entriesB = await readNotebookEntries(pool, t.B, silent);
    assert.ok(!entriesB.some((e) => e.key === `chat:${chanA}:m-ask-a-${t.run}`), 'tenant A ask key absent from tenant B entries');
    assert.ok(!entriesB.some((e) => e.key === `completion:m-job-a-${t.run}`), 'tenant A completion key absent from tenant B entries');
    assert.ok(!JSON.stringify(entriesB).includes(t.CANARY_A), 'tenant B entries carry no tenant A canary');
    const blockB = await readNotebookBlock(pool, t.B, silent);
    assert.ok(!String(blockB ?? '').includes(t.CANARY_A), 'tenant B notebook block carries neither the ask nor the completion');
  } finally {
    await cleanup(pool, t);
    await pool.end();
  }
});

// ------------------------------------------------------------------
// The Helm search filing (bite H5's write) against the recall
// read and Helm's fact answerer.
// ------------------------------------------------------------------

test('isolation: a filed Helm search answer stays in the filing tenant', { skip: pgSkip }, async () => {
  const { createLibrarianStore, fileHelmSearchAnswer } = await import('../src/cloud/envoy-librarian.mjs');
  const { readNotebookEntries } = await import('../src/cloud/envoy-notebook.mjs');
  const { helmFactAnswer, HELM_NOTHING_FILED_LINE } = await import('../src/cloud/envoy-helm.mjs');
  const t = makeTenants();
  const pool = await makePool();
  try {
    await seedBase(pool, t);
    const store = createLibrarianStore(pool);
    const answerA = `The fenwick harbour ferry runs every hour on the hour. ${t.CANARY_A}\nSources: Fenwick Ferry — https://example.invalid/fenwick`;
    assert.equal(await fileHelmSearchAnswer(store, t.actorA, {
      channelId: `chan-a-${t.run}`, channelTitle: 'Harbour Desk', messageId: `m-search-a-${t.run}`,
      humanSubject: t.actorA.subject, humanName: 'User A',
      question: 'when does the fenwick harbour ferry run?', answer: answerA,
      sources: [{ title: 'Fenwick Ferry', url: 'https://example.invalid/fenwick' }],
      provider: 'tavily', at: '2026-11-16T03:00:00.000Z',
    }, silent), true);

    const raw = await pool.query('select project_slug from helmion.context_entries where key = $1', [`helm:m-search-a-${t.run}`]);
    assert.deepEqual(raw.rows.map((r) => r.project_slug), [t.A], 'the search filing is bound to tenant A');

    // A repeated question is answered from the record — by the
    // tenant that filed it, and by no other.
    const recallA = await store.lookupFacts(t.actorA, { query: 'fenwick harbour ferry' });
    assert.equal(recallA.found, true, 'tenant A recalls its own filed search answer');
    assert.equal(recallA.key, `helm:m-search-a-${t.run}`);
    assert.equal(recallA.text, answerA, 'the filed answer is quoted verbatim, citations and all');
    const recallB = await store.lookupFacts(t.actorB, { query: 'fenwick harbour ferry' });
    assert.equal(recallB.found, false, 'tenant B recall never finds tenant A search filing');

    const entriesB = await readNotebookEntries(pool, t.B, silent);
    assert.ok(!entriesB.some((e) => e.key === `helm:m-search-a-${t.run}`), 'tenant A search key absent from tenant B entries');
    assert.ok(!JSON.stringify(entriesB).includes(t.CANARY_A), 'tenant B entries carry no tenant A canary');
    const answerB = helmFactAnswer(entriesB, 'what is recorded about the fenwick harbour ferry?');
    assert.equal(answerB.body, HELM_NOTHING_FILED_LINE, 'Helm tells tenant B it has nothing filed about the search topic');
    assert.ok(!answerB.body.includes(t.CANARY_A));
  } finally {
    await cleanup(pool, t);
    await pool.end();
  }
});

// ------------------------------------------------------------------
// The Guard-refusal incident road and the knowledge base:
// the incident lookup, the KB block, and the state answer
// composed from gathered records (bite H4's inputs).
// ------------------------------------------------------------------

test('isolation: incidents and the knowledge base never cross tenants', { skip: pgSkip }, async () => {
  const { createLibrarianStore, fileIncidentFromDispatch, readKnowledgeBaseBlock } = await import('../src/cloud/envoy-librarian.mjs');
  const { readNotebookBlock } = await import('../src/cloud/envoy-notebook.mjs');
  const { composeHelmStateAnswer, notebookBlockers } = await import('../src/cloud/envoy-helm.mjs');
  const t = makeTenants();
  const pool = await makePool();
  try {
    await seedBase(pool, t);
    const store = createLibrarianStore(pool);
    // The refusal road (the mesh tail's wrapper), and a direct
    // filing beside it.
    assert.equal(await fileIncidentFromDispatch(store, t.actorA, {
      key: `guard-ask:m-refused-${t.run}`, title: `Guard refused an ask in Zorblax Desk ${t.CANARY_A}`,
      mistake: 'the refused zorblax ask body', actor: t.actorA.subject, source: 'guard',
      evidence: { channelId: `chan-a-${t.run}`, verdict: 'refuse' },
    }, silent), true);
    const direct = await store.fileIncident(t.actorA, {
      key: `manual:m-direct-${t.run}`, title: `Zorblax deploy broke the desk ${t.CANARY_A}`, mistake: 'the zorblax deploy failed',
    });
    assert.equal(direct.filed, true);

    // The lookup: countable by the owner, empty for the other.
    const foundA = await store.lookupIncidents(t.actorA, { query: t.CANARY_A });
    assert.equal(foundA.length, 2, 'tenant A counts both of its incidents');
    const foundB = await store.lookupIncidents(t.actorB, { query: t.CANARY_A });
    assert.equal(foundB.length, 0, 'tenant B lookup never returns tenant A incidents');
    const allB = await store.lookupIncidents(t.actorB, {});
    assert.equal(allB.length, 0, 'tenant B has no incidents of its own in this test');

    // Solve one as its owner: the KB block then carries it for
    // A — title and fix — and carries nothing of it for B.
    assert.equal(await store.solveIncident(t.actorA, { id: direct.id, solution: `pin the zorblax deploy ${t.CANARY_A}` }), true);
    const kbA = await readKnowledgeBaseBlock(pool, t.actorA, silent);
    assert.ok(String(kbA ?? '').includes('Zorblax deploy broke the desk'), 'tenant A knowledge base block carries its solved incident');
    assert.ok(String(kbA ?? '').includes('pin the zorblax deploy'), 'and its fix');
    const kbB = await readKnowledgeBaseBlock(pool, t.actorB, silent);
    assert.ok(!String(kbB ?? '').includes(t.CANARY_A), 'tenant B knowledge base block carries no tenant A incident');

    // The state answer (bite H4) composed from each tenant's
    // own gathered records: B's answer names none of A's open
    // incidents; A's names its own (positive control).
    const blockB = await readNotebookBlock(pool, t.B, silent);
    const stateB = composeHelmStateAnswer({
      openIncidents: await store.lookupIncidents(t.actorB, {}),
      blockers: notebookBlockers(blockB),
    });
    assert.ok(!stateB.includes(t.CANARY_A), 'tenant B state answer carries no tenant A incident');
    assert.ok(!stateB.includes('Zorblax'), 'tenant B state answer names no tenant A work');
    const blockA = await readNotebookBlock(pool, t.A, silent);
    const stateA = composeHelmStateAnswer({
      openIncidents: await store.lookupIncidents(t.actorA, {}),
      blockers: notebookBlockers(blockA),
    });
    assert.ok(stateA.includes('Guard refused an ask in Zorblax Desk'), 'tenant A state answer names its own open incident (positive control)');
  } finally {
    await cleanup(pool, t);
    await pool.end();
  }
});

// ------------------------------------------------------------------
// The incident commands (bite L3): solve, refile, supersede act
// only on the acting tenant's own incidents.
// ------------------------------------------------------------------

test('isolation: incident commands act only on the acting tenant\'s incidents', { skip: pgSkip }, async () => {
  const { createLibrarianStore, readKnowledgeBaseBlock } = await import('../src/cloud/envoy-librarian.mjs');
  const t = makeTenants();
  const pool = await makePool();
  try {
    await seedBase(pool, t);
    const store = createLibrarianStore(pool);
    const one = await store.fileIncident(t.actorA, {
      key: `cmd:one-${t.run}`, title: `Zorblax printer jam ${t.CANARY_A}`, mistake: 'the zorblax printer jammed again',
    });
    const two = await store.fileIncident(t.actorA, {
      key: `cmd:two-${t.run}`, title: `Zorblax ladder slipped ${t.CANARY_A}`, mistake: 'the zorblax ladder was wet',
    });
    assert.equal(one.filed, true);
    assert.equal(two.filed, true);

    // The owner's refile moves the category and derives its
    // learned rule under the owner's tenant — and no rule ever
    // lands under the other tenant.
    const refile = await store.refileIncident(t.actorA, { id: one.id, toCategory: 'tooling' });
    assert.equal(refile.refiled, true, 'tenant A refiles its own incident');
    const moved = await pool.query('select category from helmion.librarian_incidents where tenant_id = $1 and id = $2', [t.A, one.id]);
    assert.equal(moved.rows[0].category, 'tooling');
    if (refile.learnedRule) {
      const rule = await pool.query('select tenant_id from helmion.librarian_rules where id = $1', [refile.learnedRule]);
      assert.deepEqual(rule.rows.map((r) => r.tenant_id), [t.A], 'the learned rule is bound to tenant A');
    }
    const rulesB = await pool.query('select count(*)::int as n from helmion.librarian_rules where tenant_id = $1', [t.B]);
    assert.equal(rulesB.rows[0].n, 0, 'no learned rule lands under tenant B');

    // The other tenant's commands against A's incidents:
    // solve refuses, refile refuses, supersede throws — and
    // nothing about A's incidents changes, and nothing files
    // under B.
    assert.equal(await store.solveIncident(t.actorB, { id: two.id, solution: 'canary fix from B' }), false,
      'tenant B cannot solve tenant A incident');
    const refileB = await store.refileIncident(t.actorB, { id: one.id, toCategory: 'deploy' });
    assert.equal(refileB.refiled, false, 'tenant B cannot refile tenant A incident');
    await assert.rejects(
      () => store.supersedeIncident(t.actorB, {
        oldId: two.id,
        incident: { key: `cmd:replacement-b-${t.run}`, title: `Replacement from B ${t.CANARY_B}`, mistake: 'filed by the wrong tenant' },
      }),
      'tenant B superseding tenant A incident is refused',
    );
    const twoAfter = await pool.query('select status, category from helmion.librarian_incidents where tenant_id = $1 and id = $2', [t.A, two.id]);
    assert.equal(twoAfter.rows[0].status, 'open', 'tenant A incident is untouched by tenant B commands');
    const oneAfter = await pool.query('select category from helmion.librarian_incidents where tenant_id = $1 and id = $2', [t.A, one.id]);
    assert.equal(oneAfter.rows[0].category, 'tooling', 'the refused refile moved nothing');
    const strayB = await pool.query('select count(*)::int as n from helmion.librarian_incidents where tenant_id = $1', [t.B]);
    assert.equal(strayB.rows[0].n, 0, 'no incident files under tenant B');

    // The owner's supersede lands, under the owner: the old
    // incident points forward, the replacement points back.
    const replacement = await store.supersedeIncident(t.actorA, {
      oldId: two.id,
      incident: { key: `cmd:replacement-a-${t.run}`, title: `Zorblax ladder replaced ${t.CANARY_A}`, mistake: 'the zorblax ladder was retired' },
    });
    assert.equal(replacement.filed, true, 'tenant A supersedes its own incident');
    const oldRow = await pool.query('select status, superseded_by_id from helmion.librarian_incidents where tenant_id = $1 and id = $2', [t.A, two.id]);
    assert.equal(oldRow.rows[0].status, 'superseded');
    assert.equal(oldRow.rows[0].superseded_by_id, replacement.id);
    const newRow = await pool.query('select tenant_id, supersedes_id from helmion.librarian_incidents where id = $1', [replacement.id]);
    assert.deepEqual(newRow.rows.map((r) => r.tenant_id), [t.A], 'the replacement is bound to tenant A');
    assert.equal(newRow.rows[0].supersedes_id, two.id);

    // And the other tenant still sees none of it.
    assert.equal((await store.lookupIncidents(t.actorB, { query: t.CANARY_A })).length, 0,
      'tenant B lookup stays empty after every command');
    const kbB = await readKnowledgeBaseBlock(pool, t.actorB, silent);
    assert.ok(!String(kbB ?? '').includes(t.CANARY_A), 'tenant B knowledge base block carries none of it');
  } finally {
    await cleanup(pool, t);
    await pool.end();
  }
});

// ------------------------------------------------------------------
// The guide's miss queue: one row per (tenant, person,
// question); repeats count up on the asker's own row only.
// ------------------------------------------------------------------

test('isolation: the miss queue counts per tenant and never mixes', { skip: pgSkip }, async () => {
  const { fileHelmKbMiss } = await import('../src/cloud/helm-kb.mjs');
  const t = makeTenants();
  const pool = await makePool();
  try {
    await seedBase(pool, t);
    const questionA = `how does the zorblax window open? ${t.CANARY_A}`;
    const questionB = `how does the quindle board meet? ${t.CANARY_B}`;
    const shared = 'what does the harbour light mean?';
    const file = (tenantId, subject, question) => fileHelmKbMiss({
      pool, tenantId, channelId: `chan-${t.run}`, senderSubject: subject, question,
    });
    assert.equal(await file(t.A, t.actorA.subject, questionA), true);
    assert.equal(await file(t.A, t.actorA.subject, questionA), true, 'a repeat files — onto the same row');
    assert.equal(await file(t.B, t.actorB.subject, questionB), true);
    assert.equal(await file(t.A, t.actorA.subject, shared), true);
    assert.equal(await file(t.A, t.actorA.subject, shared), true);
    assert.equal(await file(t.B, t.actorB.subject, shared), true);

    // The queue is read per tenant (sql/084: it is never read
    // back into a workspace surface). A's rows are A's; B's
    // are B's; the shared question stands as one row per
    // tenant with independent counts.
    const rowsA = (await pool.query('select question, seen_count from helmion.helm_kb_misses where tenant_id = $1 order by question', [t.A])).rows;
    const rowsB = (await pool.query('select question, seen_count from helmion.helm_kb_misses where tenant_id = $1 order by question', [t.B])).rows;
    assert.equal(rowsA.length, 2, 'tenant A has exactly its two questions queued');
    assert.equal(rowsB.length, 2, 'tenant B has exactly its two questions queued');
    assert.ok(!rowsA.some((r) => r.question.includes(t.CANARY_B)), 'tenant A queue carries no tenant B question');
    assert.ok(!rowsB.some((r) => r.question.includes(t.CANARY_A)), 'tenant B queue carries no tenant A question');
    assert.equal(rowsA.find((r) => r.question === questionA)?.seen_count, 2, 'tenant A repeat counted on tenant A row');
    assert.equal(rowsA.find((r) => r.question === shared)?.seen_count, 2, 'the shared question counted twice for tenant A');
    assert.equal(rowsB.find((r) => r.question === shared)?.seen_count, 1, 'and once for tenant B — the counts never mix');
    const nullTenant = await pool.query('select count(*)::int as n from helmion.helm_kb_misses where tenant_id is null');
    assert.equal(nullTenant.rows[0].n, 0, 'no miss is bound to a NULL tenant');
  } finally {
    await cleanup(pool, t);
    await pool.end();
  }
});

// ------------------------------------------------------------------
// The NULL invariant: every write road in the map, run for
// both tenants, adds zero NULL-slug rows anywhere.
// ------------------------------------------------------------------

test('isolation: no write road in the map binds a NULL slug', { skip: pgSkip }, async () => {
  const {
    createLibrarianStore, fileDispatchAsk, fileAssignmentCompletion, fileIncidentFromDispatch, fileHelmSearchAnswer,
  } = await import('../src/cloud/envoy-librarian.mjs');
  const { fileHelmKbMiss } = await import('../src/cloud/helm-kb.mjs');
  const t = makeTenants();
  const pool = await makePool();
  try {
    await seedBase(pool, t);
    const store = createLibrarianStore(pool);
    const before = await nullCounts(pool);

    // Every write road, once per tenant.
    for (const [actor, tag] of [[t.actorA, 'a'], [t.actorB, 'b']]) {
      const chan = `chan-${tag}-${t.run}`;
      assert.equal(await fileDispatchAsk(store, actor, {
        channelId: chan, channelTitle: 'Null Desk', messageId: `m-ask-${tag}-${t.run}`,
        humanSubject: actor.subject, humanName: 'User', seats: ['claude'],
        guardDecision: 'allow', excerpt: `a ${tag} ask about the null desk`, at: '2026-11-16T04:00:00.000Z',
      }, silent), true);
      assert.equal((await store.fileFact(actor, {
        channelId: chan, messageId: `m-fact-${tag}-${t.run}`, fact: `The null desk fact for ${tag}.`,
        humanSubject: actor.subject, humanName: 'User', at: '2026-11-16T04:01:00.000Z',
      })).filed, true);
      assert.equal(await fileAssignmentCompletion(store, actor, {
        channelId: chan, channelTitle: 'Null Desk', messageId: `m-job-${tag}-${t.run}`,
        humanSubject: actor.subject,
        assignment: { v: 1, sequential: false, parts: [{ n: 1, owner: 'claude', ownerName: 'Claude' }] },
        at: '2026-11-16T04:02:00.000Z',
      }, silent), true);
      assert.equal(await fileHelmSearchAnswer(store, actor, {
        channelId: chan, channelTitle: 'Null Desk', messageId: `m-search-${tag}-${t.run}`,
        humanSubject: actor.subject, humanName: 'User', question: 'a null desk question?',
        answer: `The null desk answer for ${tag}.`, sources: [{ title: 'Null', url: 'https://example.invalid/null' }],
        provider: 'tavily', at: '2026-11-16T04:03:00.000Z',
      }, silent), true);
      assert.equal(await fileIncidentFromDispatch(store, actor, {
        key: `guard-ask:m-refused-${tag}-${t.run}`, title: `Guard refused an ask in Null Desk ${tag}`,
        mistake: 'the refused ask body', actor: actor.subject, source: 'guard', evidence: { channelId: chan, verdict: 'refuse' },
      }, silent), true);
      const incident = await store.fileIncident(actor, {
        key: `null:${tag}-${t.run}`, title: `Null desk incident ${tag}`, mistake: 'the null desk broke',
      });
      assert.equal(incident.filed, true);
      assert.equal(await store.solveIncident(actor, { id: incident.id, solution: 'fixed the null desk' }), true);
      const second = await store.fileIncident(actor, {
        key: `null2:${tag}-${t.run}`, title: `Null desk second ${tag}`, mistake: 'the null desk broke twice',
      });
      assert.equal((await store.refileIncident(actor, { id: second.id, toCategory: 'tooling' })).refiled, true);
      const third = await store.fileIncident(actor, {
        key: `null3:${tag}-${t.run}`, title: `Null desk third ${tag}`, mistake: 'the null desk broke a third time',
      });
      assert.equal((await store.supersedeIncident(actor, {
        oldId: third.id,
        incident: { key: `null4:${tag}-${t.run}`, title: `Null desk replacement ${tag}`, mistake: 'the null desk was replaced' },
      })).filed, true);
      assert.equal(await fileHelmKbMiss({
        pool, tenantId: actor.tenantId, channelId: chan, senderSubject: actor.subject, question: `a null desk question from ${tag}?`,
      }), true);
    }

    const after = await nullCounts(pool);
    assert.deepEqual(after, before, 'zero new NULL rows in any shared-memory table after every road ran for both tenants');

    // And the rows the roads wrote are all bound to one of the
    // two tenants — counted exactly: per tenant, four notebook
    // entries (ask, fact, completion, search filing), five
    // incidents (the refusal, the solved one, the refiled one,
    // the superseded one, and its replacement), and one miss.
    for (const tenantId of [t.A, t.B]) {
      const entries = await pool.query('select count(*)::int as n from helmion.context_entries where project_slug = $1', [tenantId]);
      assert.equal(entries.rows[0].n, 4, 'four notebook entries under the tenant');
      const incidents = await pool.query('select count(*)::int as n from helmion.librarian_incidents where tenant_id = $1', [tenantId]);
      assert.equal(incidents.rows[0].n, 5, 'five incidents under the tenant');
      const misses = await pool.query('select count(*)::int as n from helmion.helm_kb_misses where tenant_id = $1', [tenantId]);
      assert.equal(misses.rows[0].n, 1, 'one miss under the tenant');
    }
  } finally {
    await cleanup(pool, t);
    await pool.end();
  }
});
