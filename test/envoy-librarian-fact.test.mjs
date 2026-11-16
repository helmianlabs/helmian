// The Librarian's fact filing (bite L1, Maestro / Helm / Librarian
// programme): a human addresses the Librarian with a file request,
// the fact files through the one store under the tenant's own
// slug, the Librarian confirms in the channel as agent:librarian
// quoting what was filed, and the send is marked so the desk is
// never handed it. The parser is pinned pure; the hook runs the
// real chat store and the real librarian store over a scripted
// pool (the helm-kb test idiom — only the database is fake); the
// end-to-end exercise against a real database stays with the
// HELMIAN_TEST_PG_URL suite at the bottom.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createEnvoyStore, librarianFactRequestIn, postLibrarianFactIfNeeded,
  LIBRARIAN_SUBJECT, LIBRARIAN_FACT_KEY_PREFIX, EMPTY_DESK_ANSWER_BODY,
} from '../src/cloud/envoy-chat.mjs';
import { HELM_KB_KEY_PREFIX } from '../src/cloud/helm-kb.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CHANNEL_A = '33333333-3333-4333-8333-333333333333';
const CHANNEL_B = '44444444-4444-4444-8444-444444444444';
const ownerA = { tenantId: TENANT_A, subject: 'user_owner_a', role: 'owner', sessionId: 's1', requestId: 'r1' };
const ownerB = { tenantId: TENANT_B, subject: 'user_owner_b', role: 'owner', sessionId: 's2', requestId: 'r2' };
const FACT = 'The approvals pop-up lets a user approve a PC action in place, without navigating away, and it was proven on 2026-11-15';

// ---------- the parser (pure) ----------

test('librarianFactRequestIn: the two file shapes, in their address forms', () => {
  assert.equal(librarianFactRequestIn(`Librarian: file this fact. ${FACT}`), FACT);
  assert.equal(librarianFactRequestIn('Librarian, remember: the door code is 4419'), 'the door code is 4419');
  assert.equal(librarianFactRequestIn('Librarian: file this fact: the build is green'), 'the build is green');
  assert.equal(librarianFactRequestIn('Librarian: file this fact the build is green'), 'the build is green');
  assert.equal(librarianFactRequestIn('@Librarian: file this fact. the build is green'), 'the build is green');
  assert.equal(librarianFactRequestIn('Hey Librarian, remember: the build is green'), 'the build is green');
  assert.equal(librarianFactRequestIn('the Librarian: file this fact. the build is green'), 'the build is green');
});

test('librarianFactRequestIn: everything else files nothing', () => {
  // A recall ask is not a filing (recall answers are bite L2).
  assert.equal(librarianFactRequestIn('Librarian: what do you have filed about the pop-up'), null);
  // An instruction with no fact after it files nothing.
  assert.equal(librarianFactRequestIn('Librarian: file this fact.'), null);
  assert.equal(librarianFactRequestIn('Librarian: file this fact'), null);
  assert.equal(librarianFactRequestIn('Librarian, remember:'), null);
  // A near-miss word is not the instruction.
  assert.equal(librarianFactRequestIn('Librarian: file this factoid. the build is green'), null);
  // The instruction must lead: a sentence about filing, an
  // instruction behind a please, and a mention named mid-message
  // are talk, not filings — the send falls through untouched.
  assert.equal(librarianFactRequestIn('Librarian: please file this fact. the build is green'), null);
  assert.equal(librarianFactRequestIn('please @Librarian file this fact. the build is green'), null);
  assert.equal(librarianFactRequestIn('ask the Librarian to file this fact. the build is green'), null);
  // Another role's address is not the Librarian's.
  assert.equal(librarianFactRequestIn('Claude: file this fact. the build is green'), null);
  assert.equal(librarianFactRequestIn('Maestro: file this fact. the build is green'), null);
  assert.equal(librarianFactRequestIn(''), null);
  assert.equal(librarianFactRequestIn(null), null);
});

// ---------- the hook, on a scripted pool ----------

function factFakePool({ connections = [], failEntries = false } = {}) {
  const messages = [];
  const entries = new Map();
  const projects = new Set();
  let nextId = 1;
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
        if (failEntries) throw new Error('context_entries is unavailable');
        entries.set(`${vals[0]}|${vals[1]}`, JSON.parse(vals[2]));
        return { rows: [], rowCount: 1 };
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

test('a file request files the fact, confirms it as the Librarian, and marks the send', async () => {
  const { pool, messages, entries } = factFakePool();
  const store = createEnvoyStore(pool);
  const out = await store.appendMessage(ownerA, { channelId: CHANNEL_A, body: `Librarian: file this fact. ${FACT}`, idempotencyKey: 'send-1' });
  const messageId = out.receipt.message.id;
  // The fact is in the notebook, under the tenant's own slug.
  const entry = entries.get(`${TENANT_A}|fact:${messageId}`);
  assert.ok(entry, 'the fact entry landed under the tenant slug');
  assert.equal(entry.fact, FACT);
  assert.equal(entry.subject, 'user_owner_a');
  assert.equal(entry.channelId, CHANNEL_A);
  // Exactly one confirmation, from the Librarian, quoting the fact.
  const confirmations = librarianMessages(messages);
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].author_kind, 'agent');
  assert.equal(confirmations[0].body, `Filed: ${FACT}`);
  assert.equal(confirmations[0].idempotency_key, `${LIBRARIAN_FACT_KEY_PREFIX}${messageId}`);
  assert.deepEqual(confirmations[0].metadata.librarianFact, { key: `fact:${messageId}`, forSubject: 'user_owner_a' });
  // The send itself is marked, so the mesh never hands it to a seat.
  const human = messages.find((m) => m.id === Number(messageId));
  assert.deepEqual(human.metadata?.librarianFact, { key: `fact:${messageId}`, filedBy: 'librarian' });
  // And nothing else answered: no guide post (the address kept the
  // guide out), no empty-desk line under the confirmation.
  assert.equal(messages.filter((m) => String(m.idempotency_key).startsWith(HELM_KB_KEY_PREFIX)).length, 0);
  assert.ok(!messages.some((m) => m.body === EMPTY_DESK_ANSWER_BODY), 'the empty-desk line does not also fire');
});

test('the remember shape files and confirms the same way', async () => {
  const { pool, messages, entries } = factFakePool();
  const store = createEnvoyStore(pool);
  const out = await store.appendMessage(ownerA, { channelId: CHANNEL_A, body: 'Librarian, remember: the door code is 4419', idempotencyKey: 'send-1' });
  const entry = entries.get(`${TENANT_A}|fact:${out.receipt.message.id}`);
  assert.equal(entry.fact, 'the door code is 4419');
  const confirmations = librarianMessages(messages);
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].body, 'Filed: the door code is 4419');
});

test('a Librarian send that is not a file request falls through untouched', async () => {
  const { pool, messages, entries } = factFakePool();
  const store = createEnvoyStore(pool);
  const out = await store.appendMessage(ownerA, { channelId: CHANNEL_A, body: 'Librarian: what do you have filed about the pop-up', idempotencyKey: 'send-1' });
  assert.equal(entries.size, 0, 'nothing filed');
  assert.equal(librarianMessages(messages).length, 0, 'no confirmation');
  const human = messages.find((m) => m.id === Number(out.receipt.message.id));
  assert.equal(human.metadata?.librarianFact, undefined, 'no mark — the mesh hands the send on as today');
  // The fall-through is the whole pre-L1 shape: on this empty desk
  // the send still gets the empty-desk answer, exactly as a
  // role-addressed send the role hook leaves unanswered does.
  assert.equal(messages.filter((m) => m.body === EMPTY_DESK_ANSWER_BODY).length, 1);
});

test('a fact filed in one tenant is invisible in another tenant\u2019s notebook', async () => {
  const { pool, entries } = factFakePool();
  const store = createEnvoyStore(pool);
  const a = await store.appendMessage(ownerA, { channelId: CHANNEL_A, body: `Librarian: file this fact. ${FACT}`, idempotencyKey: 'send-a' });
  const b = await store.appendMessage(ownerB, { channelId: CHANNEL_B, body: `Librarian: file this fact. ${FACT}`, idempotencyKey: 'send-b' });
  // The same words, two tenants: each entry sits under its own
  // slug and under no other key — no shared row, no NULL slug.
  assert.equal(entries.get(`${TENANT_A}|fact:${a.receipt.message.id}`).fact, FACT);
  assert.equal(entries.get(`${TENANT_B}|fact:${b.receipt.message.id}`).fact, FACT);
  assert.equal(entries.get(`${TENANT_B}|fact:${a.receipt.message.id}`), undefined);
  assert.equal(entries.get(`${TENANT_A}|fact:${b.receipt.message.id}`), undefined);
  assert.equal(entries.size, 2);
  for (const key of entries.keys()) assert.ok(key.startsWith(`${TENANT_A}|`) || key.startsWith(`${TENANT_B}|`), `every entry is slugged: ${key}`);
});

test('a filing failure confirms nothing, marks nothing, and never fails the send', async () => {
  const { pool, messages, entries } = factFakePool({ failEntries: true });
  const store = createEnvoyStore(pool);
  const out = await store.appendMessage(ownerA, { channelId: CHANNEL_A, body: `Librarian: file this fact. ${FACT}`, idempotencyKey: 'send-1' });
  assert.ok(out.receipt.message.id, 'the send itself stands');
  assert.equal(entries.size, 0);
  assert.equal(librarianMessages(messages).length, 0, 'an unfiled fact is never confirmed');
  const human = messages.find((m) => m.id === Number(out.receipt.message.id));
  assert.equal(human.metadata?.librarianFact, undefined, 'and never marked — the desk still sees the send');
});

test('the hook itself: a non-file body is a no-op before any store exists', async () => {
  const out = await postLibrarianFactIfNeeded({
    pool: null, tenantId: TENANT_A, channelId: CHANNEL_A, messageId: '1',
    senderSubject: 'user_owner_a', senderRole: 'owner', body: 'Librarian: what is filed about the pop-up',
  });
  assert.deepEqual(out, { filed: false });
});

// ---------- end to end on a real database (HELMIAN_TEST_PG_URL) ----------

const pgUrl = process.env.HELMIAN_TEST_PG_URL;
const pgSkip = pgUrl ? false : 'HELMIAN_TEST_PG_URL is not set';

test('fact filing on Postgres: under the tenant slug, confirmed, marked, invisible to another tenant', { skip: pgSkip }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: pgUrl, max: 4 });
  const tenantA = `t-${randomUUID().slice(0, 8)}`;
  const tenantB = `t-${randomUUID().slice(0, 8)}`;
  const owner = { tenantId: tenantA, subject: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`, role: 'owner', get sessionId() { return randomUUID(); }, get requestId() { return randomUUID(); } };
  try {
    await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantA, 'Fact test A']);
    await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantB, 'Fact test B']);
    await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantA, owner.subject, 'owner']);
    const chat = createEnvoyStore(pool);
    const { channel } = await chat.createChannel(owner, { slug: 'facts', title: 'Facts', kind: 'team' });
    const out = await chat.appendMessage(owner, { channelId: channel.id, body: `Librarian: file this fact. ${FACT}`, idempotencyKey: randomUUID() });
    const messageId = out.receipt.message.id;
    // Read back under the same tenant slug: the fact, as filed.
    const entry = await pool.query('select project_slug, value from helmion.context_entries where key = $1', [`fact:${messageId}`]);
    assert.equal(entry.rows.length, 1, 'exactly one fact entry');
    assert.equal(entry.rows[0].project_slug, tenantA, 'under the acting tenant\u2019s slug');
    assert.equal(entry.rows[0].value.fact, FACT);
    assert.equal(entry.rows[0].value.subject, owner.subject);
    // Absent from another tenant's read, and bound to no NULL slug.
    const forB = await pool.query('select count(*)::int as n from helmion.context_entries where project_slug = $1 and key = $2', [tenantB, `fact:${messageId}`]);
    assert.equal(forB.rows[0].n, 0);
    const nullSlug = await pool.query('select count(*)::int as n from helmion.context_entries where project_slug is null and key = $1', [`fact:${messageId}`]);
    assert.equal(nullSlug.rows[0].n, 0);
    // The channel record: the send, marked, and one confirmation.
    const msgs = await pool.query('select id, author_subject, body, metadata from helmion.envoy_messages where tenant_id = $1 and channel_id = $2 order by id', [tenantA, channel.id]);
    const confirmations = msgs.rows.filter((r) => r.author_subject === LIBRARIAN_SUBJECT);
    assert.equal(confirmations.length, 1);
    assert.equal(confirmations[0].body, `Filed: ${FACT}`);
    const human = msgs.rows.find((r) => String(r.id) === String(messageId));
    assert.equal(human.metadata?.librarianFact?.key, `fact:${messageId}`);
    assert.equal(human.metadata?.librarianFact?.filedBy, 'librarian');
  } finally {
    await pool.end();
  }
});
