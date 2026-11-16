// Bite L4 of the Maestro/Helm/Librarian fix programme (DESIGN
// 4.3 bite L4, the one-pen law at 5.2, decision D5): completion
// and search filings ride the pen — every filing path writes
// shared memory through the Librarian's store
// (createLibrarianStore in envoy-librarian.mjs), and no filing
// path writes it directly anywhere else.
//
// The audit this bite ran over the shipped tree found every
// in-scope path already on the pen: the mesh's post-commit
// tail files dispatched asks (allowed and Guard-refused) and
// Guard-refusal incidents through the store's fail-soft
// wrappers, the settle tail files assignment completions the
// same way, and the Librarian hooks in envoy-chat.mjs file
// human facts and run the incident commands through the
// store. This file is the bite's desk proof of that state:
//
//   - a source assertion: the SQL that writes the notebook
//     (helmion.context_entries) and the knowledge base
//     (helmion.librarian_incidents, helmion.librarian_rules)
//     exists in exactly one module, envoy-librarian.mjs. The
//     one sanctioned exception (DESIGN 5.2) is the guide's
//     miss queue, helmion.helm_kb_misses, written only by
//     helm-kb.mjs — asserted as its own one-module set, so
//     the exception can never quietly grow a second writer.
//   - wiring assertions: the mesh tail and the chat hooks
//     hand the Librarian store to the pen's wrappers, and
//     envoy-helm.mjs — whose only filing is the miss queue —
//     holds no shared-memory write of its own.
//   - the Postgres desk test: every filing path exercised
//     twice with the same message ids (a duplicated send, a
//     re-fired poll) still leaves exactly one record per
//     path, under the acting tenant's slug, and nothing else
//     is filed. It runs when HELMIAN_TEST_PG_URL points at a
//     scratch database with the full sql/ chain applied;
//     skipped otherwise.
//
// Two prescriptions were NOT followed, by the brief's own
// conflict rule (name it, never absorb it); both are recorded
// in bite L4's REPORT.md. The completion record keeps bite
// M4's shipped shape — the store's fileAssignmentCompletion
// under key completion:<messageId>, prose-less so recall
// never quotes it as a fact — instead of being re-routed
// through fileFact under an assign: key, which would rename
// the record, give it fact prose, and turn its
// first-filing-stands insert into an upsert. And the Helm
// search filing under key helm:<messageId> lands with bite
// H5 (BITE-MAP: "The Helm search half of this bite lands
// with H5"); there is no search answer in the tree yet to
// file, and envoy-helm.mjs files nothing but misses today.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import {
  createLibrarianStore,
  fileAssignmentCompletion,
  fileDispatchAsk,
  fileIncidentFromDispatch,
  librarianCompletionEntryFor,
} from '../src/cloud/envoy-librarian.mjs';

const SRC = new URL('../src/', import.meta.url);

async function srcFiles() {
  const names = await readdir(SRC, { recursive: true });
  return names.filter((name) => name.endsWith('.mjs')).sort();
}

async function srcText(rel) {
  return readFile(new URL(rel, SRC), 'utf8');
}

// The write shapes, one per shared-memory table: an INSERT or
// UPDATE statement against the table. Comments naming a table
// do not match — only the SQL verbs do.
const WRITE_PATTERNS = {
  'helmion.context_entries': /(?:insert\s+into|update)\s+helmion\.context_entries/i,
  'helmion.librarian_incidents': /(?:insert\s+into|update)\s+helmion\.librarian_incidents/i,
  'helmion.librarian_rules': /(?:insert\s+into|update)\s+helmion\.librarian_rules/i,
  'helmion.helm_kb_misses': /(?:insert\s+into|update)\s+helmion\.helm_kb_misses/i,
};

test('one pen: the Librarian store module is the only writer of the notebook and the knowledge base', async () => {
  const writers = Object.fromEntries(Object.keys(WRITE_PATTERNS).map((table) => [table, []]));
  for (const rel of await srcFiles()) {
    const text = await srcText(rel);
    for (const [table, pattern] of Object.entries(WRITE_PATTERNS)) {
      if (pattern.test(text)) writers[table].push(rel.replaceAll('\\', '/'));
    }
  }
  assert.deepEqual(writers['helmion.context_entries'], ['cloud/envoy-librarian.mjs'],
    'context_entries is written by the Librarian store module and no other');
  assert.deepEqual(writers['helmion.librarian_incidents'], ['cloud/envoy-librarian.mjs'],
    'librarian_incidents is written by the Librarian store module and no other');
  assert.deepEqual(writers['helmion.librarian_rules'], ['cloud/envoy-librarian.mjs'],
    'librarian_rules is written by the Librarian store module and no other');
  assert.deepEqual(writers['helmion.helm_kb_misses'], ['cloud/helm-kb.mjs'],
    'the miss queue keeps exactly its one sanctioned writer (DESIGN 5.2)');
});

test('one pen: the notebook read carries no write — retrieval never files', async () => {
  const notebook = await srcText('cloud/envoy-notebook.mjs');
  for (const [table, pattern] of Object.entries(WRITE_PATTERNS)) {
    assert.equal(pattern.test(notebook), false, `envoy-notebook.mjs never writes ${table}`);
  }
});

test('one pen: every filing call site hands the Librarian store to the pen', async () => {
  const mesh = await srcText('cloud/envoy-mesh.mjs');
  assert.ok(mesh.includes('createLibrarianStore(pool)'), 'the mesh builds the Librarian store from its pool');
  assert.ok(mesh.includes('fileDispatchAsk(librarian, actor, job'), 'dispatched asks file through the pen');
  assert.ok(mesh.includes('fileIncidentFromDispatch(librarian, actor, incident'), 'Guard-refusal incidents file through the pen');
  assert.ok(mesh.includes('fileAssignmentCompletion(librarian, actor, completion'), 'assignment completions file through the pen');

  const chat = await srcText('cloud/envoy-chat.mjs');
  assert.ok(chat.includes('createLibrarianStore(pool)'), 'the chat hooks build the Librarian store from their pool');
  assert.ok(chat.includes('librarian.fileFact('), 'a human file request files through the pen');
  assert.ok(chat.includes('librarian.solveIncident('), 'the solve command runs through the pen');
  assert.ok(chat.includes('librarian.refileIncident('), 'the refile command runs through the pen');
  assert.ok(chat.includes('librarian.supersedeIncident('), 'the supersede command runs through the pen');

  const helm = await srcText('cloud/envoy-helm.mjs');
  for (const [table, pattern] of Object.entries(WRITE_PATTERNS)) {
    assert.equal(pattern.test(helm), false, `envoy-helm.mjs writes no ${table} directly`);
  }
  assert.ok(helm.includes("fileHelmKbMiss") && helm.includes("from './helm-kb.mjs'"),
    'the one filing Helm makes — the unanswered question — rides the miss queue\u2019s own filer');
});

// ---------- the desk test on a real database (HELMIAN_TEST_PG_URL) ----------

const pgUrl = process.env.HELMIAN_TEST_PG_URL;
const pgSkip = pgUrl ? false : 'HELMIAN_TEST_PG_URL is not set';

test('one pen on Postgres: every filing path files exactly one record, and a replay files no second', { skip: pgSkip }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: pgUrl, max: 4 });
  const tenantId = `t-${randomUUID().slice(0, 8)}`;
  const actor = { tenantId, subject: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`, role: 'owner', get sessionId() { return randomUUID(); }, get requestId() { return randomUUID(); } };
  const channelId = randomUUID();
  const silent = { log: () => {} };
  const entriesFor = async (key) => (await pool.query(
    'select project_slug, value from helmion.context_entries where project_slug = $1 and key = $2',
    [tenantId, key],
  )).rows;
  const incidentsFor = async (key) => (await pool.query(
    'select id from helmion.librarian_incidents where tenant_id = $1 and key = $2',
    [tenantId, key],
  )).rows;
  try {
    await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantId, 'One pen test']);
    await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantId, actor.subject, 'owner']);
    const store = createLibrarianStore(pool);

    // The dispatched ask (the mesh tail's road, allowed or
    // Guard-refused alike): filed twice, one entry.
    const askJob = {
      channelId, channelTitle: 'One Pen Desk', messageId: 'm-ask-1',
      humanSubject: actor.subject, humanName: 'Troy', seats: ['claude'],
      guardDecision: 'allow', excerpt: 'plan the launch page', at: '2026-11-16T00:00:00.000Z',
    };
    assert.equal(await fileDispatchAsk(store, actor, askJob, silent), true);
    assert.equal(await fileDispatchAsk(store, actor, askJob, silent), true, 'a replayed filing still lands — on the same one entry');
    const askRows = await entriesFor(`chat:${channelId}:m-ask-1`);
    assert.equal(askRows.length, 1, 'one ask record however often the ask is filed');

    // The human fact (bite L1's road): filed twice, one entry.
    const factJob = {
      channelId, messageId: 'm-fact-1', fact: 'The approvals pop-up was proven on 2026-11-15.',
      humanSubject: actor.subject, humanName: 'Troy', at: '2026-11-16T00:01:00.000Z',
    };
    assert.equal((await store.fileFact(actor, factJob)).filed, true);
    assert.equal((await store.fileFact(actor, factJob)).filed, true);
    const factRows = await entriesFor('fact:m-fact-1');
    assert.equal(factRows.length, 1, 'one fact entry however often the fact is filed');
    assert.equal(factRows[0].value.fact, factJob.fact);

    // The assignment completion (bite M4's road): filed
    // twice, one record — the first filing stands, and the
    // record carries no fact or ask prose, so recall (bite
    // L2) and Helm's lookup (bite H4) never quote a
    // completion as if it were a filed fact.
    const completionJob = {
      channelId, channelTitle: 'One Pen Desk', messageId: 'm-job-1',
      humanSubject: actor.subject,
      assignment: { v: 1, sequential: false, parts: [{ n: 1, owner: 'claude', ownerName: 'Claude' }, { n: 2, owner: 'gemini', ownerName: 'Gemini' }] },
      at: '2026-11-16T00:02:00.000Z',
    };
    assert.equal((await store.fileAssignmentCompletion(actor, completionJob)).filed, true);
    const again = await store.fileAssignmentCompletion(actor, completionJob);
    assert.equal(again.filed, false);
    assert.equal(again.alreadyFiled, true, 'the second filing of a completion is recognised, not rewritten');
    assert.equal(await fileAssignmentCompletion(store, actor, completionJob, silent), true,
      'the fail-soft wrapper reports the record standing');
    const completionRows = await entriesFor('completion:m-job-1');
    assert.equal(completionRows.length, 1, 'one completion record however many polls observe the settle');
    assert.deepEqual(completionRows[0].value, librarianCompletionEntryFor(completionJob).value);
    assert.equal('fact' in completionRows[0].value, false, 'a completion is not a fact entry');
    assert.equal('ask' in completionRows[0].value, false, 'a completion is not an ask record');

    // The Guard-refusal incident (the mesh tail's road):
    // filed twice under its guard-ask key, one incident.
    const refusal = {
      key: 'guard-ask:m-ask-2', title: 'Guard refused an ask in One Pen Desk',
      mistake: 'the refused ask body', actor: actor.subject, source: 'guard',
      evidence: { channelId, verdict: 'refuse' },
    };
    assert.equal(await fileIncidentFromDispatch(store, actor, refusal, silent), true);
    assert.equal(await fileIncidentFromDispatch(store, actor, refusal, silent), false, 'a replayed refusal files no second incident');
    assert.equal((await incidentsFor('guard-ask:m-ask-2')).length, 1, 'one refusal incident however often it is filed');

    // A directly filed incident (the store road the L3
    // commands build on): filed twice on its key, one row.
    const direct = { key: 'manual:m-9', title: 'Deploy broke the desk', mistake: 'the deploy failed' };
    assert.equal((await store.fileIncident(actor, direct)).filed, true);
    assert.equal((await store.fileIncident(actor, direct)).filed, false);
    assert.equal((await incidentsFor('manual:m-9')).length, 1, 'one incident per key');

    // The whole pile, counted: exactly the records above —
    // three notebook entries, two incidents, every one under
    // this tenant, and no filing of this test bound to the
    // NULL slug the notebook read would show every tenant.
    const allEntries = await pool.query('select key from helmion.context_entries where project_slug = $1 order by key', [tenantId]);
    assert.deepEqual(allEntries.rows.map((r) => r.key), [`chat:${channelId}:m-ask-1`, 'completion:m-job-1', 'fact:m-fact-1']);
    const allIncidents = await pool.query('select count(*)::int as n from helmion.librarian_incidents where tenant_id = $1', [tenantId]);
    assert.equal(allIncidents.rows[0].n, 2);
    const nullBound = await pool.query(
      'select count(*)::int as n from helmion.context_entries where project_slug is null and key = any($1)',
      [[`chat:${channelId}:m-ask-1`, 'completion:m-job-1', 'fact:m-fact-1']],
    );
    assert.equal(nullBound.rows[0].n, 0, 'no filing binds the NULL slug');
  } finally {
    await pool.end();
  }
});
