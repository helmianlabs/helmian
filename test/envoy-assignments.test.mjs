// Maestro's coordinator (fix programme bite M2, DESIGN 2.3):
// a Maestro-addressed message that parses into explicitly
// enumerated parts gets ONE assignment post from Maestro naming
// exactly one owner per part, and the human message carries the
// parsed assignment record as metadata.maestroAssignment for the
// mesh's per-part dispatch (bite M3). A message the coordinator
// cannot structure falls through untouched: no post, no mark.
// These tests pin the pure parser and owner picker directly, and
// run the real store against a scripted pool in the helm-kb
// pattern (the tenantAgentStateOn reader and parseConfig are
// production's, so the roster and gate exercised here are the
// ones production runs; only the database is fake). The
// live-database exercise stays with the HELMIAN_TEST_PG_URL
// suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseMaestroParts,
  namedOwnerForPart,
  buildMaestroAssignment,
  maestroAssignmentBody,
  postMaestroAssignmentIfNeeded,
  MAESTRO_ASSIGNMENT_SUBJECT,
  MAESTRO_ASSIGNMENT_KEY_PREFIX,
} from '../src/cloud/envoy-assignments.mjs';
import { createEnvoyStore, EMPTY_DESK_ANSWER_BODY } from '../src/cloud/envoy-chat.mjs';
import { CONFIG_SUBJECT, emptyConfig, serializeConfig } from '../src/cloud/envoy-agents.mjs';

const ASG_TENANT = '11111111-1111-4111-8111-111111111111';
const ASG_CHANNEL = '33333333-3333-4333-8333-333333333333';
const asgOwner = { tenantId: ASG_TENANT, subject: 'user_owner', role: 'owner', sessionId: 's1', requestId: 'r1' };

// Tonight's message 1 (YC, 2026-11-15), in the shape DESIGN 2.4
// fixes for the proof: a three-part connector job, an explicit
// instruction to assign one owner per part, part 1 confirming
// Weather stays off.
const MESSAGE_1 = [
  'Maestro: I have a three-part job. Assign one owner per part.',
  'Part one: confirm the Weather connector stays off, and report what the connector library shows for it.',
  'Part two: check the GitHub connector is connected for this workspace, and report its state.',
  'Part three: check the Notion connector is connected for this workspace, and report its state.',
].join('\n');

const MESSAGE_1_PARTS = [
  'confirm the Weather connector stays off, and report what the connector library shows for it.',
  'check the GitHub connector is connected for this workspace, and report its state.',
  'check the Notion connector is connected for this workspace, and report its state.',
];

// ---------- the parser ----------

test('parser: message 1 parses to exactly three parts, in order, with the part text intact', () => {
  const parsed = parseMaestroParts(MESSAGE_1);
  assert.ok(parsed, 'message 1 parses');
  assert.deepEqual(parsed.parts.map((p) => p.n), [1, 2, 3]);
  assert.deepEqual(parsed.parts.map((p) => p.text), MESSAGE_1_PARTS);
});

test('parser: numbered and lettered lists parse, and continuation lines join their part', () => {
  const numbered = parseMaestroParts('Maestro: two jobs.\n1. Check the Weather connector\nand report its state.\n2) Check the GitHub connector.');
  assert.deepEqual(numbered.parts.map((p) => p.text), [
    'Check the Weather connector and report its state.',
    'Check the GitHub connector.',
  ]);
  const lettered = parseMaestroParts('Maestro:\na. Check the Weather connector.\nb. Check the GitHub connector.\nc. Check the Notion connector.');
  assert.deepEqual(lettered.parts.map((p) => p.n), [1, 2, 3]);
  assert.equal(lettered.parts[2].text, 'Check the Notion connector.');
});

test('parser: part markers inline in one paragraph parse, intro excluded', () => {
  const parsed = parseMaestroParts('Maestro, three parts. Part one: check the Weather connector. Part two: check the GitHub connector. Part three: check the Notion connector.');
  assert.deepEqual(parsed.parts.map((p) => p.text), [
    'check the Weather connector.',
    'check the GitHub connector.',
    'check the Notion connector.',
  ]);
});

test('parser: the parts: shapes parse (semicolons on the lead line, plain lines after it)', () => {
  const inline = parseMaestroParts('Maestro: split this into parts: check the Weather connector; check the GitHub connector; check the Notion connector');
  assert.deepEqual(inline.parts.map((p) => p.n), [1, 2, 3]);
  assert.equal(inline.parts[0].text, 'check the Weather connector');
  const listed = parseMaestroParts('Maestro: here is the job, in parts:\ncheck the Weather connector\ncheck the GitHub connector\ncheck the Notion connector');
  assert.deepEqual(listed.parts.map((p) => p.n), [1, 2, 3]);
  assert.equal(listed.parts[2].text, 'check the Notion connector');
});

test('parser: anything not explicitly enumerated in sequence is not a parse', () => {
  for (const body of [
    'Maestro: what is running here?',
    'Maestro: please check the Weather connector.',
    'Maestro: do part one of the plan', // one part is not a multi-part job
    'Maestro:\n1. Check the Weather connector.\n3. Check the Notion connector.\n2. Check the GitHub connector.', // sequence break
    'Maestro:\n1. Check the Weather connector.\nPart two: check the GitHub connector.', // mixed shapes
    'Maestro:\nPart one: check the Weather connector.\nPart three: check the Notion connector.', // gap
    'Maestro: the plan has two parts: the first part is the design', // talks about parts, enumerates none
    '',
    null,
  ]) {
    assert.equal(parseMaestroParts(body), null, `${JSON.stringify(body)} does not parse`);
  }
});

// ---------- named owners ----------

test('named owners: a leading name, an @mention, and assignment words all name the owner', () => {
  assert.deepEqual(namedOwnerForPart('Claude: confirm the Weather connector stays off.'), { owner: 'claude', name: 'Claude' });
  assert.deepEqual(namedOwnerForPart('ChatGPT: review the draft.'), { owner: 'openai', name: 'ChatGPT' });
  assert.deepEqual(namedOwnerForPart('ask @grok to verify the totals'), { owner: 'grok', name: 'Grok' });
  assert.deepEqual(namedOwnerForPart('the totals check is assigned to gemini'), { owner: 'gemini', name: 'Gemini' });
  assert.deepEqual(namedOwnerForPart('Claude to check the connector state'), { owner: 'claude', name: 'Claude' });
});

test('named owners: roles are never owners, and an ordinary opening word is not a naming', () => {
  assert.equal(namedOwnerForPart('@maestro run this part yourself'), null);
  assert.equal(namedOwnerForPart('Note: check the Weather connector.'), null);
  assert.equal(namedOwnerForPart('confirm the Weather connector stays off.'), null);
  assert.equal(namedOwnerForPart('check the GitHub connector is connected.'), null);
});

test('named owners: an explicitly named non-seat comes back unresolved, so the post can say so', () => {
  assert.deepEqual(namedOwnerForPart('the billing check is assigned to Bob'), { owner: null, name: 'Bob', unresolved: true });
});

// ---------- owner picking ----------

const pick = (texts, opts) => buildMaestroAssignment({ parts: texts.map((text, i) => ({ n: i + 1, text })) }, opts);

test('picking: unnamed parts fill the pool in roster order, one each before a second', () => {
  const three = pick(['a job', 'b job', 'c job'], { members: ['claude', 'grok', 'gemini'], gate: null });
  assert.deepEqual(three.parts.map((p) => p.owner), ['claude', 'grok', 'gemini']);
  const four = pick(['a', 'b', 'c', 'd'], { members: ['claude', 'grok'], gate: null });
  assert.deepEqual(four.parts.map((p) => p.owner), ['claude', 'grok', 'claude', 'grok']);
  assert.equal(three.sequential, false, 'the record carries the sequential flag M5 reads, default off');
  assert.equal(three.v, 1);
});

test('picking: a named owner is honoured and counts toward that seat\'s share of the round', () => {
  const built = pick(['Gemini: check the Notion connector.', 'check the Weather connector.', 'check the GitHub connector.'], { members: ['claude', 'grok', 'gemini'], gate: null });
  assert.deepEqual(built.parts.map((p) => p.owner), ['gemini', 'claude', 'grok']);
  assert.equal(built.parts[0].namedOwner, 'gemini');
});

test('picking: a named seat outside the assignable set leaves the part unassigned, with the reason named', () => {
  const notMember = pick(['Mistral: check the Weather connector.', 'check the GitHub connector.'], { members: ['claude', 'grok'], gate: null });
  assert.equal(notMember.parts[0].owner, null);
  assert.equal(notMember.parts[0].unassignedReason, 'not-a-member');
  assert.equal(notMember.parts[0].namedOwnerName, 'Mistral');
  assert.equal(notMember.parts[1].owner, 'claude', 'the other part is still assigned');

  const notConnected = pick(['Mistral: check the Weather connector.', 'check the GitHub connector.'], { members: ['claude', 'mistral'], gate: new Set(['claude']) });
  assert.equal(notConnected.parts[0].owner, null);
  assert.equal(notConnected.parts[0].unassignedReason, 'not-connected');
  assert.equal(notConnected.parts[1].owner, 'claude');

  const notSeat = pick(['the billing check is assigned to Bob', 'check the GitHub connector.'], { members: ['claude'], gate: null });
  assert.equal(notSeat.parts[0].unassignedReason, 'not-a-seat');
});

test('picking: the claim gate binds the fallback pool, and a custom agent assigns through its engine', () => {
  const gated = pick(['a', 'b'], { members: ['claude', 'grok'], gate: new Set(['grok']) });
  assert.deepEqual(gated.parts.map((p) => p.owner), ['grok', 'grok'], 'a gated-out seat takes no part');

  const custom = { handle: 'helper-bot', id: 'helper-bot', name: 'Helper Bot', provider: 'ollama' };
  const viaEngine = pick(['a'], { members: ['helper-bot'], customAgents: [custom], gate: new Set(['ollama']) });
  assert.equal(viaEngine.parts[0].owner, 'helper-bot');
  assert.equal(viaEngine.parts[0].ownerName, 'Helper Bot');
  const engineGated = pick(['a'], { members: ['helper-bot'], customAgents: [custom], gate: new Set(['claude']) });
  assert.equal(engineGated.parts[0].owner, null);
  assert.equal(engineGated.parts[0].unassignedReason, 'no-seat-available');
});

// ---------- the assignment post ----------

test('the post names exactly one owner per assigned part, in order, quotes the part text, and answers nothing', () => {
  const built = pick(
    ['confirm the Weather connector stays off.', 'Mistral: check the GitHub connector.', 'check the Notion connector.'],
    { members: ['claude', 'grok'], gate: null },
  );
  const body = maestroAssignmentBody(built);
  assert.equal(body, [
    'Maestro here. This job has 3 parts, one owner per part:',
    'Part 1: Claude: "confirm the Weather connector stays off."',
    'Part 2: unassigned: the part names Mistral, who is not in this channel: "Mistral: check the GitHub connector."',
    'Part 3: Grok: "check the Notion connector."',
  ].join('\n'));
  assert.ok(!body.includes('\u2014'), 'the post carries no em dash');
});

// ---------- the store road, on a scripted pool ----------

function assignmentsFakePool({ connections = [], agents = null, customAgents = [] } = {}) {
  const messages = [];
  const misses = [];
  let nextId = 1;
  if (agents) {
    const joined = {};
    for (const a of agents) joined[a] = '2026-11-01T00:00:00.000Z';
    for (const c of customAgents) joined[c.handle] = '2026-11-01T00:00:00.000Z';
    messages.push({
      id: nextId++, tenant_id: ASG_TENANT, channel_id: ASG_CHANNEL, author_subject: CONFIG_SUBJECT,
      author_kind: 'system',
      body: serializeConfig({ ...emptyConfig(), agents, joined, customAgents }),
      idempotency_key: 'cfg:test', created_at: new Date().toISOString(), metadata: null,
    });
  }
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
      if (sql.includes('insert into helmion.helm_kb_misses')) {
        misses.push({ question: vals[3] });
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
      if (sql.includes('select body from helmion.envoy_messages')) {
        const [tenantId, channelId, subject] = vals;
        const rows = messages
          .filter((m) => m.tenant_id === tenantId && m.channel_id === channelId && m.author_subject === subject)
          .sort((x, y) => y.id - x.id).slice(0, 1);
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('from helmion.envoy_messages') && sql.includes('limit 12')) {
        const [tenantId, channelId, notSubject] = vals;
        const rows = messages
          .filter((m) => m.tenant_id === tenantId && m.channel_id === channelId && m.author_subject !== notSubject)
          .sort((x, y) => y.id - x.id).slice(0, 12);
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('select author_subject, idempotency_key from helmion.envoy_messages')) {
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
  return { pool: { async connect() { return client; } }, messages, misses };
}

const vaultConnection = (provider_id) => ({ provider_id, credential_reference: `vault://tenant/test/${provider_id}/key` });
const assignmentPosts = (messages) => messages.filter((m) => String(m.idempotency_key).startsWith(MAESTRO_ASSIGNMENT_KEY_PREFIX));

test('store: message 1 gets ONE assignment post, one owner per part, and the human message carries the record', async () => {
  const { pool, messages } = assignmentsFakePool({
    agents: ['claude', 'grok', 'gemini'],
    connections: [vaultConnection('claude'), vaultConnection('grok'), vaultConnection('gemini')],
  });
  const store = createEnvoyStore(pool);
  const out = await store.appendMessage(asgOwner, { channelId: ASG_CHANNEL, body: MESSAGE_1, idempotencyKey: 'send-m1' });
  const posts = assignmentPosts(messages);
  assert.equal(posts.length, 1, 'exactly one assignment post');
  assert.equal(posts[0].author_subject, MAESTRO_ASSIGNMENT_SUBJECT);
  assert.equal(posts[0].author_kind, 'agent');
  assert.equal(posts[0].idempotency_key, `${MAESTRO_ASSIGNMENT_KEY_PREFIX}${out.receipt.message.id}`);
  assert.equal(posts[0].body, [
    'Maestro here. This job has 3 parts, one owner per part:',
    `Part 1: Claude: "${MESSAGE_1_PARTS[0]}"`,
    `Part 2: Grok: "${MESSAGE_1_PARTS[1]}"`,
    `Part 3: Gemini: "${MESSAGE_1_PARTS[2]}"`,
  ].join('\n'));
  const human = messages.find((m) => m.id === Number(out.receipt.message.id));
  const record = human.metadata?.maestroAssignment;
  assert.ok(record, 'the human message carries the assignment record for M3');
  assert.deepEqual(record.parts.map((p) => [p.n, p.owner]), [[1, 'claude'], [2, 'grok'], [3, 'gemini']]);
  assert.deepEqual(record.parts.map((p) => p.text), MESSAGE_1_PARTS);
  assert.deepEqual(posts[0].metadata?.maestroAssignment, record, 'the post carries the same record');
  assert.ok(!messages.some((m) => String(m.idempotency_key).startsWith('helm-kb:')), 'the guide never fires on the dispatch order');
  assert.ok(!messages.some((m) => m.body === EMPTY_DESK_ANSWER_BODY), 'the empty-desk line does not also fire');
});

test('store: owners named per part are honoured, and a part naming a non-member is posted as unassigned', async () => {
  const { pool, messages } = assignmentsFakePool({
    agents: ['claude', 'grok'],
    connections: [vaultConnection('claude'), vaultConnection('grok')],
  });
  const store = createEnvoyStore(pool);
  const body = [
    'Maestro: three parts, owners named.',
    'Part one, Grok: check the GitHub connector is connected.',
    'Part two: confirm the Weather connector stays off.',
    'Part three, Mistral: check the Notion connector is connected.',
  ].join('\n');
  const out = await store.appendMessage(asgOwner, { channelId: ASG_CHANNEL, body, idempotencyKey: 'send-named' });
  const posts = assignmentPosts(messages);
  assert.equal(posts.length, 1);
  assert.ok(posts[0].body.includes('Part 1: Grok: "Grok: check the GitHub connector is connected."'), 'the named owner is honoured');
  assert.ok(posts[0].body.includes('Part 3: unassigned: the part names Mistral, who is not in this channel'), 'the non-member part is named as unassigned, in the open');
  const record = messages.find((m) => m.id === Number(out.receipt.message.id)).metadata?.maestroAssignment;
  assert.deepEqual(record.parts.map((p) => p.owner), ['grok', 'claude', null]);
  assert.equal(record.parts[2].unassignedReason, 'not-a-member');
});

test('store: an unparseable Maestro message gets no assignment and no mark, and behaviour is otherwise unchanged', async () => {
  const { pool, messages } = assignmentsFakePool({
    agents: ['claude', 'grok'],
    connections: [vaultConnection('claude'), vaultConnection('grok')],
  });
  const store = createEnvoyStore(pool);
  const out = await store.appendMessage(asgOwner, { channelId: ASG_CHANNEL, body: 'Maestro: what is running here?', idempotencyKey: 'send-plain' });
  assert.equal(assignmentPosts(messages).length, 0, 'no assignment post');
  const human = messages.find((m) => m.id === Number(out.receipt.message.id));
  assert.equal(human.metadata?.maestroAssignment, undefined, 'no mark');
  assert.equal(messages.filter((m) => m.author_kind === 'agent').length, 0, 'no Maestro message of any kind on a connected desk');
});

test('store: an unaddressed parts message gets no assignment (the coordinator answers only to its address)', async () => {
  const { pool, messages } = assignmentsFakePool({
    agents: ['claude', 'grok', 'gemini'],
    connections: [vaultConnection('claude'), vaultConnection('grok'), vaultConnection('gemini')],
  });
  const store = createEnvoyStore(pool);
  const out = await store.appendMessage(asgOwner, { channelId: ASG_CHANNEL, body: MESSAGE_1.replace('Maestro: ', ''), idempotencyKey: 'send-unaddressed' });
  assert.equal(assignmentPosts(messages).length, 0);
  const human = messages.find((m) => m.id === Number(out.receipt.message.id));
  assert.equal(human.metadata?.maestroAssignment, undefined);
});

test('store: on an empty desk a parseable job still gets exactly one Maestro message, the empty-desk line', async () => {
  const { pool, messages } = assignmentsFakePool();
  const store = createEnvoyStore(pool);
  await store.appendMessage(asgOwner, { channelId: ASG_CHANNEL, body: MESSAGE_1, idempotencyKey: 'send-empty' });
  assert.equal(assignmentPosts(messages).length, 0, 'no seat can take a part, so no assignment post');
  assert.equal(messages.filter((m) => m.body === EMPTY_DESK_ANSWER_BODY).length, 1, 'the send falls through to the empty-desk answer, once');
});

test('store: the hook alone returns the assignment and is idempotent per message', async () => {
  const { pool, messages } = assignmentsFakePool({
    agents: ['claude', 'grok', 'gemini'],
    connections: [vaultConnection('claude'), vaultConnection('grok'), vaultConnection('gemini')],
  });
  const first = await postMaestroAssignmentIfNeeded({ pool, tenantId: ASG_TENANT, channelId: ASG_CHANNEL, messageId: '4242', senderSubject: 'user_owner', body: MESSAGE_1 });
  assert.equal(first.assigned, true);
  assert.deepEqual(first.assignment.parts.map((p) => p.owner), ['claude', 'grok', 'gemini']);
  const second = await postMaestroAssignmentIfNeeded({ pool, tenantId: ASG_TENANT, channelId: ASG_CHANNEL, messageId: '4242', senderSubject: 'user_owner', body: MESSAGE_1 });
  assert.equal(second.assigned, false, 'a replay posts nothing twice');
  assert.equal(assignmentPosts(messages).length, 1);
  const noParse = await postMaestroAssignmentIfNeeded({ pool, tenantId: ASG_TENANT, channelId: ASG_CHANNEL, messageId: '4343', senderSubject: 'user_owner', body: 'Maestro: what is running here?' });
  assert.equal(noParse.assigned, false);
});

test('wiring: the coordinator runs before the guide in appendMessage, and the empty-desk answer yields to it', () => {
  const source = readFileSync(new URL('../src/cloud/envoy-chat.mjs', import.meta.url), 'utf8');
  const coordinator = source.indexOf('postMaestroAssignmentIfNeeded({');
  const guide = source.indexOf('postHelmKbAnswerIfNeeded({');
  assert.ok(coordinator > -1 && guide > coordinator, 'coordinator first, guide second (DESIGN 1.5, D6)');
  assert.ok(source.includes('!assignment?.assigned && !kbAnswer?.answered'), 'the empty-desk answer fires only when neither hook answered');
});
