// Helm's setup knowledge base (wiring bite V2, 2026-11-09):
// Maestro answers setup questions in the channel from the guide
// (helm-kb.json), word for word, one step at a time — with zero
// seats connected or a full crew, never routed to a seat — and a
// question the guide cannot answer on an empty desk is filed to
// the unsorted miss queue while the send falls through to polish
// P1's empty-desk answer. These tests run the real store and the
// real shipped guide data against a scripted pool (the
// tenantAgentStateOn reader is production's, so the state chain
// exercised here is the one production runs; only the database
// is fake). The live-database exercise stays with the
// HELMIAN_TEST_PG_URL suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  helmKbEntries,
  helmKbEntryById,
  matchHelmKbEntry,
  helmKbAnswerBody,
  isHelmKbAdvance,
  isHelmKbQuestion,
  helmKbPendingNext,
  postHelmKbAnswerIfNeeded,
  fileHelmKbMiss,
  HELM_KB_SUBJECT,
  HELM_KB_KEY_PREFIX,
} from '../src/cloud/helm-kb.mjs';
import { createEnvoyStore, EMPTY_DESK_ANSWER_BODY, EMPTY_DESK_SUBJECT } from '../src/cloud/envoy-chat.mjs';

const KB_TENANT = '11111111-1111-4111-8111-111111111111';
const KB_CHANNEL = '33333333-3333-4333-8333-333333333333';
const kbOwner = { tenantId: KB_TENANT, subject: 'user_owner', role: 'owner', sessionId: 's1', requestId: 'r1' };

// ---------- the shipped data ----------

test('the shipped guide carries only grounded entries, and the unverified five stay out', () => {
  const entries = helmKbEntries();
  assert.equal(entries.length, 43);
  assert.equal(new Set(entries.map((e) => e.id)).size, 43, 'entry ids are unique');
  for (const entry of entries) assert.equal(entry.status, 'grounded', `${entry.id} ships grounded or not at all`);
  for (const held of ['connector-github', 'connector-notion', 'connector-vercel', 'connector-stripe', 'devices-spoke']) {
    assert.equal(helmKbEntryById(held), null, `${held} is unverified and does not ship`);
  }
  // connector-weather left the held list the day its named proof
  // landed: connectors road R0 ran the live endpoint call on an
  // armed turn (R0-WEATHER-REPORT.md, 2026-11-10), the exact gate
  // COVERAGE.md named for it. It ships grounded or not at all.
  assert.equal(helmKbEntryById('connector-weather')?.status, 'grounded', 'connector-weather ships grounded on the R0 proof');
});

test('the shipped guide keeps the answer rules: one breath, exact words, chains resolve', () => {
  for (const entry of helmKbEntries()) {
    assert.ok(entry.answer.speak.split(/\s+/).length <= 40, `${entry.id} speaks one breath`);
    const body = helmKbAnswerBody(entry);
    assert.ok(!body.includes('—'), `${entry.id} has no em dash`);
    assert.ok(!/\broom\b/i.test(body), `${entry.id} says workspace, never room`);
    if (entry.answer.next) assert.ok(helmKbEntryById(entry.answer.next), `${entry.id} points at a shipped next step`);
  }
});

// ---------- the matcher ----------

test('a grounded question returns its entry, and the spoken body is the entry word for word', () => {
  const start = matchHelmKbEntry('what do I do now');
  assert.equal(start.id, 'start-what-now');
  assert.equal(
    helmKbAnswerBody(start),
    'Welcome. Start with one thing. Look for the card that says Meet Maestro, and press the button on it that says Turn on Maestro. Tell me when it is done, and I will give you the next step.',
  );
  assert.equal(matchHelmKbEntry('how much does it cost').id, 'pricing-cost');
  assert.equal(matchHelmKbEntry('how do I connect an AI').id, 'connect-first-ai-1');
  // A GitHub-shaped ask gets the generic grounded connect walk —
  // the unverified GitHub entry is absent, so nothing unproven is
  // claimed, and the user is still walked.
  assert.equal(matchHelmKbEntry('how do I connect GitHub').id, 'connect-first-ai-1');
  assert.equal(matchHelmKbEntry('please refactor the billing module'), null);
  assert.equal(matchHelmKbEntry('purple monkey dishwasher'), null);
});

test('the Weather connector question — the live miss of 2026-11-10 — returns its entry', () => {
  // Owner walk, twice (04:41 #Team, 05:26 Maestro channel): this
  // exact question matched nothing, so the ask fell to the seats
  // unmarked and ungrounded, and they invented answers. The entry
  // existed as a held draft; R0's live proof grounded it.
  for (const q of [
    'How does the Weather connector work?',
    'What is the Weather connector?',
    'How do I use the Weather connector?',
    'What does the Weather connector do?',
    'Tell me about the Weather connector',
    'how does weather work',
    'does Weather need an account?',
  ]) {
    assert.equal(matchHelmKbEntry(q)?.id, 'connector-weather', `${JSON.stringify(q)} reaches the Weather entry`);
  }
  // The connect-shaped Weather ask still takes the connect chain:
  // connecting comes before any one connector's facts.
  assert.equal(matchHelmKbEntry('how do I connect the weather connector').id, 'connect-first-ai-1');
  // A plain weather ask is crew work, never the guide's: the entry
  // must not capture a forecast request and answer it with setup.
  assert.equal(matchHelmKbEntry("what's the weather in Boise?"), null);
  assert.equal(matchHelmKbEntry('What is the weather like today?'), null);
  assert.equal(matchHelmKbEntry('Claude, what is the forecast for tomorrow?'), null);
});

test('advance words and question shapes are exact, not vibes', () => {
  for (const word of ['done', 'Done.', 'okay', 'OK', 'next', 'ready', 'got it', "it's done"]) {
    assert.equal(isHelmKbAdvance(word), true, `${word} advances`);
  }
  for (const notWord of ['done with the report, sending it now', 'okay what next', 'readiness is everything', '']) {
    assert.equal(isHelmKbAdvance(notWord), false, `${JSON.stringify(notWord)} does not advance`);
  }
  assert.equal(isHelmKbQuestion('where is the product roadmap?'), true);
  assert.equal(isHelmKbQuestion('How do I export this'), true);
  assert.equal(isHelmKbQuestion('just landed in the workspace'), false);
  assert.equal(isHelmKbQuestion('hello'), false);
});

test('the pending step is the guide answer to this person, and only while it is the last word', () => {
  const kbRow = (id, next, forSubject) => ({
    id, author_subject: HELM_KB_SUBJECT, author_kind: 'agent',
    idempotency_key: `${HELM_KB_KEY_PREFIX}${id - 1}`,
    metadata: { helmKb: { entry: 'x', next, forSubject } },
  });
  const mine = { id: 9, author_subject: 'user_owner', author_kind: 'human', idempotency_key: 'send-9', metadata: null };
  assert.equal(helmKbPendingNext([mine, kbRow(8, 'connect-first-ai-1', 'user_owner')], { senderSubject: 'user_owner', beforeId: 9 }), 'connect-first-ai-1');
  assert.equal(helmKbPendingNext([mine, kbRow(8, 'connect-first-ai-1', 'user_someone_else')], { senderSubject: 'user_owner', beforeId: 9 }), null, 'another person\'s step is not pending for me');
  const seatReply = { id: 8, author_subject: 'agent:claude', author_kind: 'agent', idempotency_key: 'reply:7', metadata: null };
  assert.equal(helmKbPendingNext([mine, seatReply, kbRow(7, 'connect-first-ai-1', 'user_owner')], { senderSubject: 'user_owner', beforeId: 9 }), null, 'a seat reply after the step closes the chain');
  const deskLine = { id: 8, author_subject: HELM_KB_SUBJECT, author_kind: 'agent', idempotency_key: 'maestro-empty-desk:7', metadata: null };
  assert.equal(helmKbPendingNext([mine, deskLine, kbRow(7, 'connect-first-ai-1', 'user_owner')], { senderSubject: 'user_owner', beforeId: 9 }), 'connect-first-ai-1', 'the empty-desk line landing mid-chain does not end the walk');
  assert.equal(helmKbPendingNext([mine, kbRow(8, null, 'user_owner')], { senderSubject: 'user_owner', beforeId: 9 }), null, 'the chain end is not a pending step');
});

// ---------- the store road, on a scripted pool ----------

function helmKbFakePool({ connections = [] } = {}) {
  const messages = [];
  const misses = [];
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
      if (sql.includes('insert into helmion.helm_kb_misses')) {
        const [tenantId, channelId, person, question, key] = vals;
        const existing = misses.find((m) => m.tenant_id === tenantId && m.person_subject === person && m.question_key === key);
        if (existing) { existing.seen_count += 1; existing.channel_id = channelId; return { rows: [], rowCount: 1 }; }
        misses.push({ tenant_id: tenantId, channel_id: channelId, person_subject: person, question, question_key: key, seen_count: 1 });
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
      if (sql.includes('from helmion.envoy_messages') && sql.includes('limit 12')) {
        const [tenantId, channelId, notSubject] = vals;
        const rows = messages
          .filter((m) => m.tenant_id === tenantId && m.channel_id === channelId && m.author_subject !== notSubject)
          .sort((x, y) => y.id - x.id).slice(0, 12);
        return { rows, rowCount: rows.length };
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
  return { pool: { async connect() { return client; } }, messages, misses };
}

const maestroMessages = (messages) => messages.filter((m) => m.author_subject === HELM_KB_SUBJECT);

test('zero-seat workspace: a setup question is answered by Maestro from the guide, exactly', async () => {
  const { pool, messages } = helmKbFakePool();
  const store = createEnvoyStore(pool);
  const out = await store.appendMessage(kbOwner, { channelId: KB_CHANNEL, body: 'what do I do now', idempotencyKey: 'send-1' });
  const answers = maestroMessages(messages);
  assert.equal(answers.length, 1, 'one answer, from Maestro');
  assert.equal(answers[0].author_kind, 'agent');
  assert.equal(answers[0].body, helmKbAnswerBody(helmKbEntryById('start-what-now')), 'the entry word for word');
  assert.equal(answers[0].idempotency_key, `${HELM_KB_KEY_PREFIX}${out.receipt.message.id}`);
  assert.deepEqual(answers[0].metadata.helmKb, { entry: 'start-what-now', next: 'empty-desk', forSubject: 'user_owner' });
  assert.ok(!messages.some((m) => m.body === EMPTY_DESK_ANSWER_BODY), 'the generic empty-desk line does not also fire');
});

test('no seat is handed a guide-answered ask: the human message carries the helmKb mark', async () => {
  const { pool, messages } = helmKbFakePool();
  const store = createEnvoyStore(pool);
  const out = await store.appendMessage(kbOwner, { channelId: KB_CHANNEL, body: 'what do I do now', idempotencyKey: 'send-1' });
  const human = messages.find((m) => m.id === Number(out.receipt.message.id));
  assert.deepEqual(human.metadata?.helmKb, { entry: 'start-what-now', answeredBy: 'maestro' });
  // The mesh side of the mark: the dispatch loop skips a marked
  // human message beside the Guard-refusal terminal check (the
  // live path itself is exercised by the Postgres mesh suites).
  const meshSource = readFileSync(new URL('../src/cloud/envoy-mesh.mjs', import.meta.url), 'utf8');
  const guardSkip = meshSource.indexOf('if (message.guard) continue;');
  const kbSkip = meshSource.indexOf('message.metadata?.helmKb');
  assert.ok(guardSkip > -1 && kbSkip > guardSkip, 'the mesh dispatch loop skips helmKb-marked asks after the guard check');
});

test('the chain advances one step per reply, on the person\'s word only', async () => {
  const { pool, messages } = helmKbFakePool();
  const store = createEnvoyStore(pool);
  const send = (body, key) => store.appendMessage(kbOwner, { channelId: KB_CHANNEL, body, idempotencyKey: key });
  const kbAnswers = () => messages.filter((m) => String(m.idempotency_key).startsWith(HELM_KB_KEY_PREFIX));
  await send('what do I do now', 'send-1');
  assert.equal(kbAnswers().length, 1);
  await send('done', 'send-2');
  assert.equal(kbAnswers().length, 2, 'one step for one word');
  assert.equal(kbAnswers()[1].body, helmKbAnswerBody(helmKbEntryById('empty-desk')));
  await send('ready', 'send-3');
  assert.equal(kbAnswers().length, 3);
  assert.equal(kbAnswers()[2].body, helmKbAnswerBody(helmKbEntryById('connect-first-ai-1')));
  await send('purple monkey dishwasher', 'send-4');
  assert.equal(kbAnswers().length, 3, 'a message that is not the word advances nothing');
  // The seam, pinned: the noise send is not the guide's to answer,
  // so on an empty desk it falls through to P1's line — whose own
  // no-stack rule re-arms after any other Maestro word. Exactly
  // one such line lands, and the pending step survives it.
  assert.equal(messages.filter((m) => m.body === EMPTY_DESK_ANSWER_BODY).length, 1, 'the non-setup send gets P1\'s answer, once');
  await send('done', 'send-5');
  assert.equal(kbAnswers().length, 4, 'the step was still pending after the noise');
  assert.equal(kbAnswers()[3].body, helmKbAnswerBody(helmKbEntryById('connect-first-ai-2')));
  await send('done', 'send-6');
  assert.equal(kbAnswers().length, 5);
  assert.equal(kbAnswers()[4].body, helmKbAnswerBody(helmKbEntryById('connect-first-ai-3')));
  await send('done', 'send-7');
  assert.equal(kbAnswers().length, 5, 'the chain end answers nothing more');
});

test('a new question replaces the chain instead of advancing it', async () => {
  const { pool, messages } = helmKbFakePool();
  const store = createEnvoyStore(pool);
  await store.appendMessage(kbOwner, { channelId: KB_CHANNEL, body: 'what do I do now', idempotencyKey: 'send-1' });
  await store.appendMessage(kbOwner, { channelId: KB_CHANNEL, body: 'how much does it cost', idempotencyKey: 'send-2' });
  const answers = maestroMessages(messages);
  assert.equal(answers.length, 2);
  assert.equal(answers[1].body, helmKbAnswerBody(helmKbEntryById('pricing-cost')), 'the question is answered, not the pending step');
});

test('connected workspace: the guide still answers — it never waits for a seat', async () => {
  const { pool, messages, misses } = helmKbFakePool({ connections: [{ provider_id: 'claude', credential_reference: 'vault://seat-credential' }] });
  const store = createEnvoyStore(pool);
  await store.appendMessage(kbOwner, { channelId: KB_CHANNEL, body: 'how much does it cost', idempotencyKey: 'send-1' });
  const answers = maestroMessages(messages);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].body, helmKbAnswerBody(helmKbEntryById('pricing-cost')));
  assert.equal(misses.length, 0);
});

test('connected workspace: the Weather connector question is Maestro\u2019s, word for word, and no seat is handed it', async () => {
  // The exact live failure shape (owner workspace, 2026-11-10): a
  // full crew connected, the guide silent, the seats answering a
  // product question from their own training. On a hit the guide
  // answers on any desk and the human message carries the mark.
  const { pool, messages, misses } = helmKbFakePool({ connections: [{ provider_id: 'claude', credential_reference: 'vault://seat-credential' }] });
  const store = createEnvoyStore(pool);
  const out = await store.appendMessage(kbOwner, { channelId: KB_CHANNEL, body: 'How does the Weather connector work?', idempotencyKey: 'send-1' });
  const answers = maestroMessages(messages);
  assert.equal(answers.length, 1, 'Maestro answers, even with a crew connected');
  assert.equal(answers[0].body, helmKbAnswerBody(helmKbEntryById('connector-weather')), 'the entry word for word');
  const human = messages.find((m) => m.id === Number(out.receipt.message.id));
  assert.deepEqual(human.metadata?.helmKb, { entry: 'connector-weather', answeredBy: 'maestro' }, 'the ask is marked, so the mesh never hands it to a seat');
  assert.equal(misses.length, 0, 'an answered question files no miss');
});

test('a miss on an empty desk is filed to the unsorted queue, and the empty-desk answer still lands', async () => {
  const { pool, messages, misses } = helmKbFakePool();
  const store = createEnvoyStore(pool);
  await store.appendMessage(kbOwner, { channelId: KB_CHANNEL, body: 'where is the product roadmap?', idempotencyKey: 'send-1' });
  assert.equal(misses.length, 1, 'the unanswered question is filed');
  assert.equal(misses[0].question, 'where is the product roadmap?');
  assert.equal(misses[0].question_key, 'where is the product roadmap?');
  assert.equal(misses[0].seen_count, 1);
  const desk = messages.filter((m) => m.author_subject === EMPTY_DESK_SUBJECT && m.body === EMPTY_DESK_ANSWER_BODY);
  assert.equal(desk.length, 1, 'P1\'s answer is the fall-through, unchanged');
  await store.appendMessage(kbOwner, { channelId: KB_CHANNEL, body: 'where is the product roadmap?', idempotencyKey: 'send-2' });
  assert.equal(misses.length, 1, 'a repeat counts on the same row');
  assert.equal(misses[0].seen_count, 2);
  assert.equal(messages.filter((m) => m.body === EMPTY_DESK_ANSWER_BODY).length, 1, 'and the empty-desk answer still does not stack');
});

test('a miss that is not a question is not filed; a connected desk files nothing', async () => {
  const empty = helmKbFakePool();
  const storeA = createEnvoyStore(empty.pool);
  await storeA.appendMessage(kbOwner, { channelId: KB_CHANNEL, body: 'just landed in the workspace', idempotencyKey: 'send-1' });
  assert.equal(empty.misses.length, 0, 'a statement is not an unanswered question');
  assert.equal(empty.messages.filter((m) => m.body === EMPTY_DESK_ANSWER_BODY).length, 1);

  const connected = helmKbFakePool({ connections: [{ provider_id: 'claude', credential_reference: 'vault://seat-credential' }] });
  const storeB = createEnvoyStore(connected.pool);
  await storeB.appendMessage(kbOwner, { channelId: KB_CHANNEL, body: 'where is the product roadmap?', idempotencyKey: 'send-1' });
  assert.equal(connected.misses.length, 0, 'a seat answers it, so it was never unanswered');
  assert.equal(maestroMessages(connected.messages).length, 0, 'and Maestro stays out of the crew\'s way');
});

test('filing is fail-soft: a pool without the queue table files nothing and throws nothing', async () => {
  const throwingPool = {
    async connect() {
      return {
        async query(sql) {
          if (/^(begin|commit|rollback)/i.test(String(sql).trim())) return { rows: [], rowCount: 0 };
          if (String(sql).includes('set_config')) return { rows: [], rowCount: 0 };
          throw new Error('relation "helmion.helm_kb_misses" does not exist');
        },
        release() {},
      };
    },
  };
  assert.equal(await fileHelmKbMiss({ pool: throwingPool, tenantId: KB_TENANT, channelId: KB_CHANNEL, senderSubject: 'user_owner', question: 'what is this?' }), false);
  const out = await postHelmKbAnswerIfNeeded({
    pool: throwingPool, tenantId: KB_TENANT, channelId: KB_CHANNEL, messageId: '1',
    senderSubject: 'user_owner', body: 'what do I do now', stateOn: async () => ({ connectedProviders: [] }),
  }).catch((error) => ({ answered: false, threw: error.message }));
  assert.equal(out.answered, false, 'a broken pool answers nothing — the caller logs and the send stands');
});
