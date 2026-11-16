// The Librarian's incident commands (bite L3, Maestro / Helm /
// Librarian programme): a human reviewing incidents in channel
// — "Librarian: incident <id> is solved: <solution>", "refile
// incident <id> as <category>", "incident <id> is replaced by
// <new incident>" — runs the store's solveIncident /
// refileIncident / supersedeIncident, methods that shipped
// with zero callers, and the Librarian confirms in channel.
// The parser is pinned pure; the hook runs on a stub store
// over a messages-only fake pool (the confirmation and the
// mark are the hook's own SQL); the DESIGN desk test — a
// Guard refusal files an incident, the commands solve, refile
// and supersede it, a second solve posts nothing — runs end
// to end through the real appendMessage and the real store
// in the HELMIAN_TEST_PG_URL suite at the bottom.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createEnvoyStore, librarianIncidentCommandIn, postLibrarianIncidentCommandIfNeeded,
  LIBRARIAN_SUBJECT, LIBRARIAN_INCIDENT_KEY_PREFIX, EMPTY_DESK_ANSWER_BODY,
} from '../src/cloud/envoy-chat.mjs';
import { createLibrarianStore, fileIncidentFromDispatch, readKnowledgeBaseBlock } from '../src/cloud/envoy-librarian.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const CHANNEL_A = '33333333-3333-4333-8333-333333333333';
const ownerA = { tenantId: TENANT_A, subject: 'user_owner_a', role: 'owner', sessionId: 's1', requestId: 'r1' };

// ---------- the parser (pure) ----------

test('librarianIncidentCommandIn: the three command shapes, in their address forms', () => {
  assert.deepEqual(
    librarianIncidentCommandIn('Librarian: incident abc-123 is solved: Restarted the runner and watched it stay up'),
    { kind: 'solve', id: 'abc-123', solution: 'Restarted the runner and watched it stay up' },
  );
  assert.deepEqual(
    librarianIncidentCommandIn('Librarian, refile incident abc-123 as tooling'),
    { kind: 'refile', id: 'abc-123', category: 'tooling' },
  );
  // The category is filed as the store files it: lowercased,
  // a trailing full stop is punctuation, not category.
  assert.deepEqual(
    librarianIncidentCommandIn('Librarian: refile incident abc-123 as Tooling.'),
    { kind: 'refile', id: 'abc-123', category: 'tooling' },
  );
  assert.deepEqual(
    librarianIncidentCommandIn('@Librarian: incident abc-123 is replaced by The runner now runs under the supervisor'),
    { kind: 'supersede', id: 'abc-123', replacement: 'The runner now runs under the supervisor' },
  );
  assert.deepEqual(
    librarianIncidentCommandIn('Hey Librarian: incident abc-123 is solved: Fixed it'),
    { kind: 'solve', id: 'abc-123', solution: 'Fixed it' },
  );
});

test('librarianIncidentCommandIn: everything else is not a command', () => {
  // The L1 and L2 shapes are theirs, never a command: the
  // command shapes must lead the send, and neither a file
  // instruction nor a recall question leads with one.
  assert.equal(librarianIncidentCommandIn('Librarian: file this fact. incident abc-123 is solved: x'), null);
  assert.equal(librarianIncidentCommandIn('Librarian, remember: incident abc-123 is solved: x'), null);
  assert.equal(librarianIncidentCommandIn('Librarian: what do you have filed about incident abc-123?'), null);
  // An ordinary Librarian-addressed ask that merely mentions
  // an incident is not a command: the name never swallows an
  // ordinary ask, and a mention is not a review.
  assert.equal(librarianIncidentCommandIn('Librarian: what happened with incident abc-123?'), null);
  assert.equal(librarianIncidentCommandIn('Librarian: incident abc-123 is still open, any news?'), null);
  assert.equal(librarianIncidentCommandIn('Librarian: the incident abc-123 is solved: x'), null);
  // A shape missing its payload is not the command: a solve
  // needs the colon and the solution, a refile needs its
  // category, a supersede needs the replacement.
  assert.equal(librarianIncidentCommandIn('Librarian: incident abc-123 is solved'), null);
  assert.equal(librarianIncidentCommandIn('Librarian: incident abc-123 is solved:'), null);
  assert.equal(librarianIncidentCommandIn('Librarian: refile incident abc-123'), null);
  assert.equal(librarianIncidentCommandIn('Librarian: incident abc-123 is replaced by'), null);
  // Near-miss wording is not the design's wording.
  assert.equal(librarianIncidentCommandIn('Librarian: incident abc-123 was replaced by a new one'), null);
  assert.equal(librarianIncidentCommandIn('Librarian: refile the incident abc-123 as tooling'), null);
  // Another role's address is not the Librarian's.
  assert.equal(librarianIncidentCommandIn('Helm: incident abc-123 is solved: x'), null);
  assert.equal(librarianIncidentCommandIn('Maestro: incident abc-123 is solved: x'), null);
  assert.equal(librarianIncidentCommandIn(''), null);
  assert.equal(librarianIncidentCommandIn(null), null);
});

// ---------- the hook, on a stub store over a fake pool ----------

function incidentFakePool() {
  const messages = [];
  let nextId = 100;
  const client = {
    async query(text, vals = []) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      if (/^(begin|commit|rollback)/i.test(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes('set_config')) return { rows: [], rowCount: 0 };
      if (sql.includes('insert into helmion.envoy_messages')) {
        const [tenantId, channelId, subject] = vals;
        let kind; let body; let key; let metadata = null;
        if (vals.length === 7) { kind = vals[3]; body = vals[4]; key = vals[5]; metadata = vals[6] ? JSON.parse(vals[6]) : null; }
        else { kind = 'agent'; body = vals[3]; key = vals[4]; metadata = vals[5] ? JSON.parse(vals[5]) : null; }
        const dupe = messages.find((m) => m.tenant_id === tenantId && m.channel_id === channelId && m.author_subject === subject && m.idempotency_key === key);
        if (dupe) return { rows: [], rowCount: 0 };
        const row = { id: ++nextId, tenant_id: tenantId, channel_id: channelId, author_subject: subject, author_kind: kind, body, idempotency_key: key, metadata };
        messages.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('update helmion.envoy_messages')) {
        const [tenantId, channelId, id, subject, patch] = vals;
        const row = messages.find((m) => m.tenant_id === tenantId && m.channel_id === channelId && m.id === Number(id) && m.author_subject === subject);
        if (row) row.metadata = { ...(row.metadata ?? {}), ...JSON.parse(patch) };
        return { rows: [], rowCount: row ? 1 : 0 };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 90)}`);
    },
    release() {},
  };
  return { pool: { async connect() { return client; } }, messages };
}

function stubStore(impl = {}) {
  const calls = [];
  return {
    calls,
    async solveIncident(actor, args) { calls.push(['solve', actor, args]); return impl.solve ? impl.solve(args) : true; },
    async refileIncident(actor, args) { calls.push(['refile', actor, args]); return impl.refile ? impl.refile(args) : { refiled: true, learnedRule: null }; },
    async supersedeIncident(actor, args) {
      calls.push(['supersede', actor, args]);
      if (impl.supersedeThrows) throw new Error(`incident ${args.oldId} is not there to supersede`);
      return impl.supersede ? impl.supersede(args) : { filed: true, id: 'new-incident-id', category: 'unsorted', hits: [] };
    },
  };
}

const seedHuman = (messages, body) => {
  const row = { id: 7, tenant_id: TENANT_A, channel_id: CHANNEL_A, author_subject: 'user_owner_a', author_kind: 'human', body, idempotency_key: 'send-7', metadata: null };
  messages.push(row);
  return row;
};
const runCommand = (pool, store, body) => postLibrarianIncidentCommandIfNeeded({
  pool, tenantId: TENANT_A, channelId: CHANNEL_A, messageId: '7',
  senderSubject: 'user_owner_a', senderRole: 'owner', body, store,
});
const librarianPosts = (messages) => messages.filter((m) => m.author_subject === LIBRARIAN_SUBJECT);

test('the solve command: the store runs, the Librarian confirms, the send is marked', async () => {
  const { pool, messages } = incidentFakePool();
  const human = seedHuman(messages, 'Librarian: incident abc-123 is solved: Restarted the runner');
  const store = stubStore();
  const out = await runCommand(pool, store, human.body);
  assert.deepEqual(out, { handled: true, acted: true, confirmed: true, kind: 'solve', messageId: '101' });
  // The store call: the send's actor, the parsed id and
  // solution, nothing else.
  assert.deepEqual(store.calls, [['solve',
    { tenantId: TENANT_A, subject: 'user_owner_a', role: 'owner' },
    { id: 'abc-123', solution: 'Restarted the runner' }]]);
  // Exactly one confirmation, as agent:librarian, quoting
  // the id and the outcome, under the command's key.
  const posts = librarianPosts(messages);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body, 'Solved incident abc-123: Restarted the runner');
  assert.equal(posts[0].idempotency_key, `${LIBRARIAN_INCIDENT_KEY_PREFIX}7`);
  assert.deepEqual(posts[0].metadata.librarianIncident, { kind: 'solve', id: 'abc-123', forSubject: 'user_owner_a' });
  // The mark landed with the confirmation.
  assert.deepEqual(human.metadata?.librarianIncident, { kind: 'solve', id: 'abc-123', actedBy: 'librarian' });
});

test('a solve the store declines posts nothing and marks nothing', async () => {
  const { pool, messages } = incidentFakePool();
  const human = seedHuman(messages, 'Librarian: incident abc-123 is solved: Again');
  const store = stubStore({ solve: () => false });
  const out = await runCommand(pool, store, human.body);
  assert.deepEqual(out, { handled: true, acted: false, kind: 'solve', reason: 'not-solved' });
  assert.equal(librarianPosts(messages).length, 0, 'a declined command posts nothing');
  assert.equal(human.metadata, null, 'and the send carries no mark: it stands as an ordinary message');
});

test('the refile command: the confirmation names the category and the learned rule', async () => {
  const { pool, messages } = incidentFakePool();
  seedHuman(messages, 'Librarian: refile incident abc-123 as tooling');
  const withRule = stubStore({ refile: () => ({ refiled: true, learnedRule: 'learned.tooling.general' }) });
  const out = await runCommand(pool, withRule, 'Librarian: refile incident abc-123 as tooling');
  assert.equal(out.acted, true);
  assert.deepEqual(withRule.calls[0][2], { id: 'abc-123', toCategory: 'tooling' });
  assert.equal(librarianPosts(messages)[0].body, 'Refiled incident abc-123 as tooling; learned rule learned.tooling.general');

  const second = incidentFakePool();
  seedHuman(second.messages, 'Librarian: refile incident abc-123 as tooling');
  const noRule = stubStore({ refile: () => ({ refiled: true, learnedRule: null }) });
  await runCommand(second.pool, noRule, 'Librarian: refile incident abc-123 as tooling');
  assert.equal(librarianPosts(second.messages)[0].body, 'Refiled incident abc-123 as tooling', 'no rule derived, none claimed');

  const third = incidentFakePool();
  const humanThird = seedHuman(third.messages, 'Librarian: refile incident missing as tooling');
  const declined = stubStore({ refile: () => ({ refiled: false, learnedRule: null }) });
  const outThird = await runCommand(third.pool, declined, humanThird.body);
  assert.deepEqual(outThird, { handled: true, acted: false, kind: 'refile', reason: 'not-refiled' });
  assert.equal(librarianPosts(third.messages).length, 0);
  assert.equal(humanThird.metadata, null);
});

test('the supersede command: the replacement files under the send key, the confirmation names both ids', async () => {
  const { pool, messages } = incidentFakePool();
  const human = seedHuman(messages, 'Librarian: incident abc-123 is replaced by The runner now runs under the supervisor');
  const store = stubStore();
  const out = await runCommand(pool, store, human.body);
  assert.equal(out.acted, true);
  assert.equal(out.kind, 'supersede');
  // The store call: the old id, and the replacement incident
  // built from the command's one description — title and
  // mistake both the description as written, the filing
  // keyed to this send so a re-run declines in the store.
  const [, , args] = store.calls[0];
  assert.equal(args.oldId, 'abc-123');
  assert.deepEqual(args.incident, {
    key: 'supersede:7',
    title: 'The runner now runs under the supervisor',
    mistake: 'The runner now runs under the supervisor',
    actor: 'user_owner_a',
  });
  const posts = librarianPosts(messages);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body, 'Incident abc-123 is replaced by incident new-incident-id');
  assert.deepEqual(human.metadata?.librarianIncident, { kind: 'supersede', id: 'abc-123', actedBy: 'librarian' });
});

test('a supersede the store declines throws to the caller and posts nothing', async () => {
  const { pool, messages } = incidentFakePool();
  const human = seedHuman(messages, 'Librarian: incident missing is replaced by Something else');
  const store = stubStore({ supersedeThrows: true });
  // supersedeIncident's decline is a throw (its existing
  // contract); the hook lets it ride to the caller's log,
  // and the channel effect is the value declines' own:
  // nothing posted, nothing marked.
  await assert.rejects(runCommand(pool, store, human.body), /not there to supersede/);
  assert.equal(librarianPosts(messages).length, 0);
  assert.equal(human.metadata, null);
});

test('the hook itself: a non-command body is a no-op before any store exists', async () => {
  const out = await postLibrarianIncidentCommandIfNeeded({
    pool: null, tenantId: TENANT_A, channelId: CHANNEL_A, messageId: '1',
    senderSubject: 'user_owner_a', senderRole: 'owner', body: 'Librarian: what do you have filed about incidents?',
  });
  assert.deepEqual(out, { handled: false });
});

// ---------- end to end on a real database (HELMIAN_TEST_PG_URL) ----------

const pgUrl = process.env.HELMIAN_TEST_PG_URL;
const pgSkip = pgUrl ? false : 'HELMIAN_TEST_PG_URL is not set';

test('incident commands on Postgres: a Guard refusal files, the commands solve, refile and supersede, a second solve posts nothing', { skip: pgSkip }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: pgUrl, max: 4 });
  const tenantA = `t-${randomUUID().slice(0, 8)}`;
  const mkOwner = (tenantId) => ({ tenantId, subject: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`, role: 'owner', get sessionId() { return randomUUID(); }, get requestId() { return randomUUID(); } });
  const ownerPgA = mkOwner(tenantA);
  try {
    await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantA, 'Incident test A']);
    await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantA, ownerPgA.subject, 'owner']);
    const chat = createEnvoyStore(pool);
    const librarian = createLibrarianStore(pool);
    const a = await chat.createChannel(ownerPgA, { slug: 'incident-a', title: 'Incident A', kind: 'team' });
    const librarianCount = async () => (await pool.query(
      'select count(*)::int as n from helmion.envoy_messages where tenant_id = $1 and channel_id = $2 and author_subject = $3',
      [tenantA, a.channel.id, LIBRARIAN_SUBJECT],
    )).rows[0].n;

    // A Guard refusal files an incident — the existing path,
    // the mesh's own filing call and shape.
    const filed = await fileIncidentFromDispatch(librarian, ownerPgA, {
      key: `guard-ask:${randomUUID()}`,
      title: 'Guard refused an ask in General',
      mistake: 'Please redeploy the webhook listener before the demo',
      actor: ownerPgA.subject, source: 'guard', evidence: { verdict: 'refuse' },
    });
    assert.equal(filed, true, 'the Guard-refusal incident filed');
    const [incident] = await librarian.lookupIncidents(ownerPgA, { query: 'webhook' });
    assert.ok(incident, 'the incident reads back');
    assert.equal(incident.status, 'open');
    assert.equal(incident.category, 'deploy', 'the filing engine filed the redeploy under deploy');

    // The solve command, through the ordinary send path.
    const solution = 'Redeployed the listener and watched it stay up';
    const solveOut = await chat.appendMessage(ownerPgA, {
      channelId: a.channel.id,
      body: `Librarian: incident ${incident.id} is solved: ${solution}`,
      idempotencyKey: randomUUID(),
    });
    assert.equal(await librarianCount(), 1, 'exactly one Librarian post: the solve confirmation');
    const confirm = await pool.query(
      'select body, metadata from helmion.envoy_messages where tenant_id = $1 and author_subject = $2 and idempotency_key = $3',
      [tenantA, LIBRARIAN_SUBJECT, `${LIBRARIAN_INCIDENT_KEY_PREFIX}${solveOut.receipt.message.id}`],
    );
    assert.equal(confirm.rows.length, 1);
    assert.equal(confirm.rows[0].body, `Solved incident ${incident.id}: ${solution}`);
    const solveRow = await pool.query('select metadata from helmion.envoy_messages where tenant_id = $1 and id = $2', [tenantA, solveOut.receipt.message.id]);
    assert.deepEqual(solveRow.rows[0].metadata?.librarianIncident, { kind: 'solve', id: incident.id, actedBy: 'librarian' }, 'the command send is marked');
    const [solved] = await librarian.lookupIncidents(ownerPgA, { query: 'webhook' });
    assert.equal(solved.status, 'solved');
    assert.equal(solved.solution, solution);

    // The retrieval half of the README sentence: the solved
    // incident rides every seat's prompt on the next poll.
    const block = await readKnowledgeBaseBlock(pool, ownerPgA);
    assert.ok(block, 'the knowledge base block is no longer empty');
    assert.ok(block.includes('Guard refused an ask in General'), 'the block names the incident');
    assert.ok(block.includes(`Fix: ${solution}`), 'and carries its fix');

    // The refile command: the category moves, and the move
    // teaches the librarian a learned rule.
    const refileOut = await chat.appendMessage(ownerPgA, {
      channelId: a.channel.id,
      body: `Librarian: refile incident ${incident.id} as tooling`,
      idempotencyKey: randomUUID(),
    });
    assert.equal(await librarianCount(), 2, 'the refile confirmation is the second Librarian post');
    const refileConfirm = await pool.query(
      'select body from helmion.envoy_messages where tenant_id = $1 and author_subject = $2 and idempotency_key = $3',
      [tenantA, LIBRARIAN_SUBJECT, `${LIBRARIAN_INCIDENT_KEY_PREFIX}${refileOut.receipt.message.id}`],
    );
    assert.ok(refileConfirm.rows[0].body.startsWith(`Refiled incident ${incident.id} as tooling`), 'the confirmation names the id and the new category');
    assert.ok(refileConfirm.rows[0].body.includes('learned rule learned.tooling.'), 'and the rule the move derived');
    const moved = await pool.query('select category from helmion.librarian_incidents where tenant_id = $1 and id = $2', [tenantA, incident.id]);
    assert.equal(moved.rows[0].category, 'tooling', 'the incident moved');
    const rules = await pool.query('select rule from helmion.librarian_rules where tenant_id = $1', [tenantA]);
    assert.ok(rules.rows.some((r) => (typeof r.rule === 'string' ? JSON.parse(r.rule) : r.rule)?.layer === 'learned'), 'a learned rule is stored');

    // A second solve of the same incident: the store returns
    // false, and the Librarian posts nothing — no second
    // confirmation, no mark, the first solution untouched.
    const againOut = await chat.appendMessage(ownerPgA, {
      channelId: a.channel.id,
      body: `Librarian: incident ${incident.id} is solved: A second, different fix`,
      idempotencyKey: randomUUID(),
    });
    assert.equal(await librarianCount(), 2, 'the second solve posted nothing');
    const againRow = await pool.query('select metadata from helmion.envoy_messages where tenant_id = $1 and id = $2', [tenantA, againOut.receipt.message.id]);
    assert.equal(againRow.rows[0].metadata?.librarianIncident, undefined, 'and marked nothing');
    const [stillSolved] = await librarian.lookupIncidents(ownerPgA, { query: 'webhook' });
    assert.equal(stillSolved.solution, solution, 'the first solution stands');

    // The supersede command: a second Guard incident is
    // replaced by its successor, pointers both ways.
    const filedSecond = await fileIncidentFromDispatch(librarian, ownerPgA, {
      key: `guard-ask:${randomUUID()}`,
      title: 'Guard refused an ask in General',
      mistake: 'Please restart the flaky deploy runner',
      actor: ownerPgA.subject, source: 'guard', evidence: { verdict: 'refuse' },
    });
    assert.equal(filedSecond, true);
    const [second] = await librarian.lookupIncidents(ownerPgA, { query: 'flaky' });
    assert.ok(second, 'the second incident reads back');
    const supersedeOut = await chat.appendMessage(ownerPgA, {
      channelId: a.channel.id,
      body: `Librarian: incident ${second.id} is replaced by The runner now runs under the supervisor`,
      idempotencyKey: randomUUID(),
    });
    const replacement = await pool.query('select id, title, status from helmion.librarian_incidents where tenant_id = $1 and supersedes_id = $2', [tenantA, second.id]);
    assert.equal(replacement.rows.length, 1, 'the replacement filed');
    assert.equal(replacement.rows[0].title, 'The runner now runs under the supervisor');
    const oldRow = await pool.query('select status, superseded_by_id from helmion.librarian_incidents where tenant_id = $1 and id = $2', [tenantA, second.id]);
    assert.equal(oldRow.rows[0].status, 'superseded');
    assert.equal(String(oldRow.rows[0].superseded_by_id), String(replacement.rows[0].id), 'the pointers agree both ways');
    const supersedeConfirm = await pool.query(
      'select body from helmion.envoy_messages where tenant_id = $1 and author_subject = $2 and idempotency_key = $3',
      [tenantA, LIBRARIAN_SUBJECT, `${LIBRARIAN_INCIDENT_KEY_PREFIX}${supersedeOut.receipt.message.id}`],
    );
    assert.equal(supersedeConfirm.rows[0].body, `Incident ${second.id} is replaced by incident ${replacement.rows[0].id}`);

    // No command drew the empty-desk line: every Librarian
    // send here was the Librarian's road, acted on or
    // declined, never an ask left for an empty desk.
    const deskLines = await pool.query(
      'select count(*)::int as n from helmion.envoy_messages where tenant_id = $1 and channel_id = $2 and body = $3',
      [tenantA, a.channel.id, EMPTY_DESK_ANSWER_BODY],
    );
    assert.equal(deskLines.rows[0].n, 0);
  } finally {
    await pool.end();
  }
});
