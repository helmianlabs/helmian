// The Librarian's recall answers (bite L2, Maestro / Helm /
// Librarian programme): a human addresses the Librarian with a
// recall question, the Librarian answers alone from the filed
// record — quoting the matching entry verbatim, so the date a
// seat dropped twice in one night survives by construction —
// and the send is marked so the desk is never handed it. The
// parser and the matcher are pinned pure; the hook runs the
// real chat store and the real librarian store over a scripted
// pool (the helm-kb / L1 test idiom — only the database is
// fake); the end-to-end exercise against a real database stays
// with the HELMIAN_TEST_PG_URL suite at the bottom.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createEnvoyStore, librarianRecallRequestIn, postLibrarianRecallIfNeeded,
  LIBRARIAN_SUBJECT, LIBRARIAN_RECALL_KEY_PREFIX, EMPTY_DESK_ANSWER_BODY,
} from '../src/cloud/envoy-chat.mjs';
import { matchLibrarianRecall, librarianRecallEntryText } from '../src/cloud/envoy-librarian.mjs';
import { HELM_KB_KEY_PREFIX } from '../src/cloud/helm-kb.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CHANNEL_A = '33333333-3333-4333-8333-333333333333';
const CHANNEL_B = '44444444-4444-4444-8444-444444444444';
const ownerA = { tenantId: TENANT_A, subject: 'user_owner_a', role: 'owner', sessionId: 's1', requestId: 'r1' };
const ownerB = { tenantId: TENANT_B, subject: 'user_owner_b', role: 'owner', sessionId: 's2', requestId: 'r2' };
const FACT = 'The approvals pop-up lets a user approve a PC action in place, without navigating away, and it was proven on 2026-11-15';
const RECALL = 'Librarian: what do you have filed about the approvals pop-up?';

// ---------- the parser (pure) ----------

test('librarianRecallRequestIn: the recall shapes, in their address forms', () => {
  assert.deepEqual(librarianRecallRequestIn(RECALL), { topic: 'the approvals pop-up', incident: false });
  assert.deepEqual(librarianRecallRequestIn('Librarian: what have you filed about the door code?'), { topic: 'the door code', incident: false });
  assert.deepEqual(librarianRecallRequestIn("Librarian, what's filed about the deploy?"), { topic: 'the deploy', incident: false });
  assert.deepEqual(librarianRecallRequestIn('Librarian: what is filed on the payroll run'), { topic: 'the payroll run', incident: false });
  assert.deepEqual(librarianRecallRequestIn('Librarian: what do you have on file about the door code?'), { topic: 'the door code', incident: false });
  assert.deepEqual(librarianRecallRequestIn('@Librarian: what do you have filed about the door code'), { topic: 'the door code', incident: false });
  assert.deepEqual(librarianRecallRequestIn('Hey Librarian, what do you have filed about the door code?'), { topic: 'the door code', incident: false });
  // An incident-shaped topic routes to the incident read.
  assert.deepEqual(librarianRecallRequestIn('Librarian: what do you have filed about the deploy incident?'), { topic: 'the deploy incident', incident: true });
  assert.deepEqual(librarianRecallRequestIn('Librarian: what do you have filed about incidents?'), { topic: 'incidents', incident: true });
});

test('librarianRecallRequestIn: everything else is not a recall', () => {
  // A file request is a filing, never a recall (bite L1's road).
  assert.equal(librarianRecallRequestIn(`Librarian: file this fact. ${FACT}`), null);
  assert.equal(librarianRecallRequestIn('Librarian, remember: the door code is 4419'), null);
  // A recall shape with no topic asks about nothing in
  // particular and falls through.
  assert.equal(librarianRecallRequestIn('Librarian: what do you have filed?'), null);
  assert.equal(librarianRecallRequestIn('Librarian: what do you have filed about?'), null);
  // An ordinary Librarian-addressed ask is not a recall: the
  // name never swallows an ordinary ask.
  assert.equal(librarianRecallRequestIn('Librarian: what is the door code?'), null);
  assert.equal(librarianRecallRequestIn('Librarian: the build is green, pass it on'), null);
  // Another role's address is not the Librarian's.
  assert.equal(librarianRecallRequestIn('Helm: what do you have filed about the pop-up?'), null);
  assert.equal(librarianRecallRequestIn('Maestro: what do you have filed about the pop-up?'), null);
  assert.equal(librarianRecallRequestIn(''), null);
  assert.equal(librarianRecallRequestIn(null), null);
});

// ---------- the matcher (pure) ----------

test('matchLibrarianRecall: a fact quotes verbatim, the date intact', () => {
  const entries = [{ key: 'fact:m1', value: { fact: FACT, human: 'Owner', at: '2026-11-15T00:00:00Z' } }];
  const hit = matchLibrarianRecall(entries, 'the approvals pop-up');
  assert.equal(hit.kind, 'fact');
  assert.equal(hit.text, FACT);
  assert.ok(hit.text.includes('2026-11-15'), 'the whole date survives — the dropped "15" is the failure this road removes');
  assert.equal(hit.key, 'fact:m1');
});

test('matchLibrarianRecall: facts outrank ask records, newest wins a tie', () => {
  const ask = { key: 'chat:c:m0', value: { ask: 'the approvals pop-up question from earlier', human: 'Owner' } };
  const olderFact = { key: 'fact:m1', value: { fact: 'the approvals pop-up, first filing' } };
  const newerFact = { key: 'fact:m2', value: { fact: 'the approvals pop-up, second filing' } };
  // The read orders newest first: the ask is newest overall,
  // but any fact match outranks every ask match, and between
  // the two facts the tie goes to the newest filing (L1/L2).
  const hit = matchLibrarianRecall([ask, newerFact, olderFact], 'the approvals pop-up');
  assert.equal(hit.text, 'the approvals pop-up, second filing');
  // With no fact in the record, the ask record answers.
  const askHit = matchLibrarianRecall([ask], 'the approvals pop-up');
  assert.equal(askHit.kind, 'ask');
  assert.equal(askHit.text, 'the approvals pop-up question from earlier');
  // No topic words, or no word in common: no match.
  assert.equal(matchLibrarianRecall([ask], 'the payroll run'), null);
  assert.equal(matchLibrarianRecall([ask], 'the'), null);
  assert.equal(matchLibrarianRecall([], 'the approvals pop-up'), null);
  // An entry with no prose to quote (a completion record)
  // never answers.
  assert.equal(librarianRecallEntryText({ key: 'completion:m9', value: { parts: [], seats: [] } }), null);
});

// ---------- the hook, on a scripted pool ----------

function recallFakePool({ connections = [], incidents = [] } = {}) {
  const messages = [];
  const entries = new Map();
  const projects = new Set();
  let nextId = 1;
  let entrySeq = 0;
  const client = {
    async query(text, vals = []) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      if (/^(begin|commit|rollback)/i.test(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes('set_config')) return { rows: [], rowCount: 0 };
      if (sql.includes('from helmion.tenant_memberships')) return { rows: [{ role: 'owner' }], rowCount: 1 };
      if (sql.includes('from helmion.desktop_links')) return { rows: [{ n: 0 }], rowCount: 1 };
      if (sql.includes('from helmion.runner_provider_presence')) return { rows: [], rowCount: 0 };
      if (sql.includes('from helmion.provider_connections')) return { rows: connections, rowCount: connections.length };
      if (sql.includes('from helmion.user_profiles')) return { rows: [], rowCount: 0 };
      if (sql.includes('insert into helmion.projects')) { projects.add(vals[0]); return { rows: [], rowCount: 1 }; }
      if (sql.includes('insert into helmion.context_entries')) {
        entries.set(`${vals[0]}|${vals[1]}`, { value: JSON.parse(vals[2]), seq: ++entrySeq });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('from helmion.context_entries')) {
        const [slug, limit] = vals;
        const rows = [...entries.entries()]
          .filter(([k]) => k.startsWith(`${slug}|`))
          .map(([k, v]) => ({ key: k.slice(slug.length + 1), value: v.value, seq: v.seq }))
          .sort((x, y) => y.seq - x.seq)
          .slice(0, Number(limit) || 200)
          .map(({ key, value }) => ({ key, value }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('from helmion.librarian_incidents')) {
        const tenantId = vals[0];
        const pattern = vals.find((v) => typeof v === 'string' && v.startsWith('%'));
        const limit = Number(vals[vals.length - 1]) || 20;
        const needle = pattern ? pattern.replace(/%/g, '').toLowerCase() : null;
        const rows = incidents
          .filter((r) => r.tenant_id === tenantId)
          .filter((r) => !needle || `${r.title} ${r.mistake} ${r.solution ?? ''}`.toLowerCase().includes(needle))
          .sort((x, y) => y.seq - x.seq)
          .slice(0, limit);
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('insert into helmion.envoy_messages')) {
        const [tenantId, channelId, subject] = vals;
        let kind; let body; let key; let metadata = null;
        if (vals.length === 7) { kind = vals[3]; body = vals[4]; key = vals[5]; metadata = vals[6] ? JSON.parse(vals[6]) : null; }
        else if (vals.length === 6) { kind = 'agent'; body = vals[3]; key = vals[4]; metadata = vals[5] ? JSON.parse(vals[5]) : null; }
        else { kind = 'agent'; body = vals[3]; key = vals[4]; }
        const dupe = messages.find((m) => m.tenant_id === tenantId && m.channel_id === channelId && m.author_subject === subject && m.idempotency_key === key);
        if (dupe) return { rows: [], rowCount: 0 };
        const row = { id: nextId++, tenant_id: tenantId, channel_id: channelId, author_subject: subject, author_kind: kind, body, idempotency_key: key, created_at: new Date().toISOString(), metadata };
        messages.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('update helmion.envoy_messages')) {
        const [tenantId, channelId, id, subject, patch] = vals;
        const row = messages.find((m) => m.tenant_id === tenantId && m.channel_id === channelId && m.id === Number(id) && m.author_subject === subject);
        if (row) row.metadata = { ...(row.metadata ?? {}), ...JSON.parse(patch) };
        return { rows: [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('from helmion.envoy_messages') && sql.includes('order by id desc')) {
        const [tenantId, channelId, notSubject, notId] = vals;
        const rows = messages
          .filter((m) => m.tenant_id === tenantId && m.channel_id === channelId && m.author_subject !== notSubject && m.id !== Number(notId))
          .sort((x, y) => y.id - x.id).slice(0, 1);
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('from helmion.envoy_messages')) {
        const [tenantId, channelId, subject, key] = vals;
        const rows = messages.filter((m) => m.tenant_id === tenantId && m.channel_id === channelId && m.author_subject === subject && m.idempotency_key === key);
        return { rows, rowCount: rows.length };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 90)}`);
    },
    release() {},
  };
  return { pool: { async connect() { return client; } }, messages, entries, projects };
}

const librarianMessages = (messages) => messages.filter((m) => m.author_subject === LIBRARIAN_SUBJECT);

test('file then recall: the Librarian answers alone, quoting the fact exactly', async () => {
  const { pool, messages, entries } = recallFakePool();
  const store = createEnvoyStore(pool);
  const filed = await store.appendMessage(ownerA, { channelId: CHANNEL_A, body: `Librarian: file this fact. ${FACT}`, idempotencyKey: 'send-1' });
  const recalled = await store.appendMessage(ownerA, { channelId: CHANNEL_A, body: RECALL, idempotencyKey: 'send-2' });
  const recallId = recalled.receipt.message.id;
  // Exactly two Librarian posts in the channel: the filing
  // confirmation and the recall answer. The answer is the
  // fact itself, verbatim — nothing added, nothing dropped.
  const posts = librarianMessages(messages);
  assert.equal(posts.length, 2);
  const answer = posts.find((m) => m.idempotency_key === `${LIBRARIAN_RECALL_KEY_PREFIX}${recallId}`);
  assert.ok(answer, 'the recall answer posted');
  assert.equal(answer.author_kind, 'agent');
  assert.equal(answer.body, FACT);
  assert.deepEqual(answer.metadata.librarianRecall, { key: `fact:${filed.receipt.message.id}`, forSubject: 'user_owner_a' });
  // The recall send is marked, so the mesh never hands it on.
  const human = messages.find((m) => m.id === Number(recallId));
  assert.deepEqual(human.metadata?.librarianRecall, { key: `fact:${filed.receipt.message.id}`, answeredBy: 'librarian' });
  // The recall filed nothing and answered nothing else: the
  // one fact entry stands alone, no guide post fired (the
  // address kept the guide out), no empty-desk line under it.
  assert.equal(entries.size, 1);
  assert.equal(messages.filter((m) => String(m.idempotency_key).startsWith(HELM_KB_KEY_PREFIX)).length, 0);
  assert.ok(!messages.some((m) => m.body === EMPTY_DESK_ANSWER_BODY), 'the empty-desk line does not also fire');
});

test('a recall with no match says so in one line and files nothing', async () => {
  const { pool, messages, entries } = recallFakePool();
  const store = createEnvoyStore(pool);
  await store.appendMessage(ownerA, { channelId: CHANNEL_A, body: `Librarian: file this fact. ${FACT}`, idempotencyKey: 'send-1' });
  const recalled = await store.appendMessage(ownerA, { channelId: CHANNEL_A, body: 'Librarian: what do you have filed about the payroll run?', idempotencyKey: 'send-2' });
  const posts = librarianMessages(messages);
  assert.equal(posts.length, 2, 'the filing confirmation and the none-found line, nothing else');
  const answer = posts.find((m) => m.idempotency_key === `${LIBRARIAN_RECALL_KEY_PREFIX}${recalled.receipt.message.id}`);
  assert.equal(answer.body, 'I have nothing filed about the payroll run');
  assert.equal(entries.size, 1, 'a recall files nothing — the filed record is unchanged');
  const human = messages.find((m) => m.id === Number(recalled.receipt.message.id));
  assert.deepEqual(human.metadata?.librarianRecall, { key: null, answeredBy: 'librarian' }, 'a none-found recall is still marked: the desk is not handed it');
});

test('two tenants filing the same words recall only their own', async () => {
  const { pool, messages } = recallFakePool();
  const store = createEnvoyStore(pool);
  await store.appendMessage(ownerA, { channelId: CHANNEL_A, body: 'Librarian, remember: the door code is 4419', idempotencyKey: 'send-a1' });
  await store.appendMessage(ownerB, { channelId: CHANNEL_B, body: 'Librarian, remember: the door code is 7777', idempotencyKey: 'send-b1' });
  const recallA = await store.appendMessage(ownerA, { channelId: CHANNEL_A, body: 'Librarian: what do you have filed about the door code?', idempotencyKey: 'send-a2' });
  const recallB = await store.appendMessage(ownerB, { channelId: CHANNEL_B, body: 'Librarian: what do you have filed about the door code?', idempotencyKey: 'send-b2' });
  const answerA = messages.find((m) => m.idempotency_key === `${LIBRARIAN_RECALL_KEY_PREFIX}${recallA.receipt.message.id}`);
  const answerB = messages.find((m) => m.idempotency_key === `${LIBRARIAN_RECALL_KEY_PREFIX}${recallB.receipt.message.id}`);
  assert.equal(answerA.body, 'the door code is 4419');
  assert.equal(answerB.body, 'the door code is 7777');
  // And a topic only the other tenant filed is a none-found
  // here, not a leak. (The topic shares no word with tenant
  // A's own filing: the matcher counts a shared topic word
  // as a match — H4's rule — so the probe topic is chosen
  // word-disjoint from "the door code is 4419".)
  await store.appendMessage(ownerB, { channelId: CHANNEL_B, body: 'Librarian, remember: the vault combination is 9090', idempotencyKey: 'send-b3' });
  const recallVault = await store.appendMessage(ownerA, { channelId: CHANNEL_A, body: 'Librarian: what do you have filed about the vault combination?', idempotencyKey: 'send-a3' });
  const vaultAnswer = messages.find((m) => m.idempotency_key === `${LIBRARIAN_RECALL_KEY_PREFIX}${recallVault.receipt.message.id}`);
  assert.equal(vaultAnswer.body, 'I have nothing filed about the vault combination');
});

test('an incident-shaped recall answers from the incident read', async () => {
  const incidents = [{
    tenant_id: TENANT_A, seq: 1, id: 'inc-1', key: null, category: 'deploy',
    title: 'The deploy pipeline broke on release', mistake: 'shipped without a build check', solution: 'Roll back to the last good bundle',
    actor: 'user_owner_a', source: 'guard', evidence: {}, status: 'solved', supersedes_id: null, superseded_by_id: null, created_at: new Date().toISOString(),
  }];
  const { pool, messages } = recallFakePool({ incidents });
  const store = createEnvoyStore(pool);
  const recalled = await store.appendMessage(ownerA, { channelId: CHANNEL_A, body: 'Librarian: what do you have filed about the deploy incident?', idempotencyKey: 'send-1' });
  const answer = messages.find((m) => m.idempotency_key === `${LIBRARIAN_RECALL_KEY_PREFIX}${recalled.receipt.message.id}`);
  assert.ok(answer, 'the incident answer posted');
  assert.equal(answer.body, '[deploy] The deploy pipeline broke on release — Fix: Roll back to the last good bundle');
});

test('the recall roads do not cross: facts never read incidents, incidents never read facts', async () => {
  const { pool } = recallFakePool();
  const noIncidents = {
    async lookupFacts() { return { found: false }; },
    async lookupIncidents() { throw new Error('the incident read must not run for a fact recall'); },
  };
  const factOut = await postLibrarianRecallIfNeeded({
    pool, tenantId: TENANT_A, channelId: CHANNEL_A, messageId: '101',
    senderSubject: 'user_owner_a', senderRole: 'owner', body: 'Librarian: what do you have filed about the door code?', store: noIncidents,
  });
  assert.equal(factOut.answered, true);
  assert.equal(factOut.found, false);
  const noFacts = {
    async lookupFacts() { throw new Error('the fact read must not run for an incident recall'); },
    async lookupIncidents() { return []; },
  };
  const incidentOut = await postLibrarianRecallIfNeeded({
    pool, tenantId: TENANT_A, channelId: CHANNEL_A, messageId: '102',
    senderSubject: 'user_owner_a', senderRole: 'owner', body: 'Librarian: what do you have filed about incidents?', store: noFacts,
  });
  assert.equal(incidentOut.answered, true);
  assert.equal(incidentOut.found, false);
});

test('the hook itself: a non-recall body is a no-op before any store exists', async () => {
  const out = await postLibrarianRecallIfNeeded({
    pool: null, tenantId: TENANT_A, channelId: CHANNEL_A, messageId: '1',
    senderSubject: 'user_owner_a', senderRole: 'owner', body: `Librarian: file this fact. ${FACT}`,
  });
  assert.deepEqual(out, { answered: false });
});

// ---------- end to end on a real database (HELMIAN_TEST_PG_URL) ----------

const pgUrl = process.env.HELMIAN_TEST_PG_URL;
const pgSkip = pgUrl ? false : 'HELMIAN_TEST_PG_URL is not set';

test('recall on Postgres: file then recall quotes the fact exactly, the date intact; isolation holds', { skip: pgSkip }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: pgUrl, max: 4 });
  const tenantA = `t-${randomUUID().slice(0, 8)}`;
  const tenantB = `t-${randomUUID().slice(0, 8)}`;
  const mkOwner = (tenantId) => ({ tenantId, subject: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`, role: 'owner', get sessionId() { return randomUUID(); }, get requestId() { return randomUUID(); } });
  const ownerPgA = mkOwner(tenantA);
  const ownerPgB = mkOwner(tenantB);
  try {
    await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantA, 'Recall test A']);
    await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantB, 'Recall test B']);
    await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantA, ownerPgA.subject, 'owner']);
    await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantB, ownerPgB.subject, 'owner']);
    const chat = createEnvoyStore(pool);
    const a = await chat.createChannel(ownerPgA, { slug: 'recall-a', title: 'Recall A', kind: 'team' });
    const b = await chat.createChannel(ownerPgB, { slug: 'recall-b', title: 'Recall B', kind: 'team' });
    const nullBefore = await pool.query('select count(*)::int as n from helmion.context_entries where project_slug is null');

    // Message 3, as sent the night that set this design: file
    // the approvals pop-up fact in tenant A.
    await chat.appendMessage(ownerPgA, { channelId: a.channel.id, body: `Librarian: file this fact. ${FACT}`, idempotencyKey: randomUUID() });
    // Message 4: recall it. Exactly one answer, from the
    // Librarian, quoting the fact exactly — the date intact.
    // (Rows are found by their idempotency keys, not by
    // position: message ids are UUIDs and sort in no useful
    // order.)
    const recallOut = await chat.appendMessage(ownerPgA, { channelId: a.channel.id, body: RECALL, idempotencyKey: randomUUID() });
    const msgsA = await pool.query('select id, author_subject, body, metadata, idempotency_key from helmion.envoy_messages where tenant_id = $1 and channel_id = $2', [tenantA, a.channel.id]);
    const answers = msgsA.rows.filter((r) => r.author_subject === LIBRARIAN_SUBJECT);
    assert.equal(answers.length, 2, 'the filing confirmation and the recall answer, no competing answers');
    const recallAnswer = answers.find((r) => r.idempotency_key === `${LIBRARIAN_RECALL_KEY_PREFIX}${recallOut.receipt.message.id}`);
    assert.ok(recallAnswer, 'the recall answer posted');
    assert.equal(recallAnswer.body, FACT, 'the recall quotes the filed fact exactly');
    assert.ok(recallAnswer.body.includes('2026-11-15'), 'the date is intact');
    const recallRow = msgsA.rows.find((r) => String(r.id) === String(recallOut.receipt.message.id));
    assert.equal(recallRow.metadata?.librarianRecall?.answeredBy, 'librarian', 'the recall send is marked');

    // A recall with no match: the none-found line, and the
    // filed record unchanged.
    const missOut = await chat.appendMessage(ownerPgA, { channelId: a.channel.id, body: 'Librarian: what do you have filed about the payroll run?', idempotencyKey: randomUUID() });
    const missRow = await pool.query('select body from helmion.envoy_messages where tenant_id = $1 and author_subject = $2 and idempotency_key = $3', [tenantA, LIBRARIAN_SUBJECT, `${LIBRARIAN_RECALL_KEY_PREFIX}${missOut.receipt.message.id}`]);
    assert.equal(missRow.rows.length, 1);
    assert.equal(missRow.rows[0].body, 'I have nothing filed about the payroll run');
    const entriesA = await pool.query('select count(*)::int as n from helmion.context_entries where project_slug = $1', [tenantA]);
    assert.equal(entriesA.rows[0].n, 1, 'the recalls filed nothing');

    // Isolation: tenant B recalls the same words and hears
    // none-found — tenant A's fact never crosses. Then each
    // tenant files the same words with its own value and
    // recalls only its own.
    const bMiss = await chat.appendMessage(ownerPgB, { channelId: b.channel.id, body: RECALL, idempotencyKey: randomUUID() });
    const bMissRow = await pool.query('select body from helmion.envoy_messages where tenant_id = $1 and author_subject = $2 and idempotency_key = $3', [tenantB, LIBRARIAN_SUBJECT, `${LIBRARIAN_RECALL_KEY_PREFIX}${bMiss.receipt.message.id}`]);
    assert.equal(bMissRow.rows[0].body, 'I have nothing filed about the approvals pop-up');
    await chat.appendMessage(ownerPgA, { channelId: a.channel.id, body: 'Librarian, remember: the door code is 4419', idempotencyKey: randomUUID() });
    await chat.appendMessage(ownerPgB, { channelId: b.channel.id, body: 'Librarian, remember: the door code is 7777', idempotencyKey: randomUUID() });
    const aDoor = await chat.appendMessage(ownerPgA, { channelId: a.channel.id, body: 'Librarian: what do you have filed about the door code?', idempotencyKey: randomUUID() });
    const bDoor = await chat.appendMessage(ownerPgB, { channelId: b.channel.id, body: 'Librarian: what do you have filed about the door code?', idempotencyKey: randomUUID() });
    const aDoorRow = await pool.query('select body from helmion.envoy_messages where tenant_id = $1 and author_subject = $2 and idempotency_key = $3', [tenantA, LIBRARIAN_SUBJECT, `${LIBRARIAN_RECALL_KEY_PREFIX}${aDoor.receipt.message.id}`]);
    const bDoorRow = await pool.query('select body from helmion.envoy_messages where tenant_id = $1 and author_subject = $2 and idempotency_key = $3', [tenantB, LIBRARIAN_SUBJECT, `${LIBRARIAN_RECALL_KEY_PREFIX}${bDoor.receipt.message.id}`]);
    assert.equal(aDoorRow.rows[0].body, 'the door code is 4419');
    assert.equal(bDoorRow.rows[0].body, 'the door code is 7777');
    // Nothing in this test's filings or recalls ever wrote a
    // NULL-slug row: the shared count is exactly where it
    // started (the NULL namespace stays platform-authored).
    const nullSlug = await pool.query('select count(*)::int as n from helmion.context_entries where project_slug is null');
    assert.equal(nullSlug.rows[0].n, nullBefore.rows[0].n);
  } finally {
    await pool.end();
  }
});
