// Bite M4 of the Maestro/Helm/Librarian fix programme (DESIGN
// 2.3, risks at 2.5, settle rule at 5.6): settle watching and
// close-out. On each poll the mesh's deferred tail asks the
// watcher (envoy-assignments.mjs) to check the channel's open
// assignments in the work window. When every part with an
// owner has that owner's reply in the channel record, Maestro
// posts the one close line, "All parts are in", as
// agent:maestro, and the close-out files exactly one
// completion record through the Librarian. When a part's
// owner has posted nothing within the work window, Maestro
// posts one line naming the part and the owner as unanswered,
// once per part — an unsettled part reads as a failed part in
// the channel record, never as silence. Both lines are
// idempotent by their idempotency keys, so re-runs, duplicate
// triggers, and reply order can never double-post them. An
// unmarked message is never watched. The Postgres test is the
// DESIGN desk test plus the brief's phases, on the recorded
// message-1 shape. It runs when HELMIAN_TEST_PG_URL points at
// a scratch database with the full sql/ chain applied;
// skipped otherwise.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createEnvoyMesh } from '../src/cloud/envoy-mesh.mjs';
import { createEnvoyStore } from '../src/cloud/envoy-chat.mjs';
import {
  MAESTRO_CLOSEOUT_BODY, MAESTRO_SETTLE_WINDOW_MS,
  maestroSettlePlan, maestroUnsettledBody,
} from '../src/cloud/envoy-assignments.mjs';
import { librarianCompletionEntryFor } from '../src/cloud/envoy-librarian.mjs';

const url = process.env.HELMIAN_TEST_PG_URL;
const skip = !url && 'HELMIAN_TEST_PG_URL not set';

const part = (n, owner) => ({
  n,
  text: `part ${n} text`,
  owner,
  ownerName: owner ? owner[0].toUpperCase() + owner.slice(1) : null,
  namedOwner: owner,
  namedOwnerName: owner ? owner[0].toUpperCase() + owner.slice(1) : null,
  unassignedReason: owner ? null : 'not-a-member',
});
// The message-1 shape as the coordinator records it: Claude and
// Gemini own a part each; the third part is unassigned.
const RECORD = { v: 1, sequential: false, parts: [part(1, 'claude'), part(2, 'gemini'), part(3, null)] };
const AGED = MAESTRO_SETTLE_WINDOW_MS + 60_000;

test('maestroSettlePlan: every owned part answered is the close-out, once', () => {
  const both = new Set(['claude', 'gemini']);
  assert.deepEqual(maestroSettlePlan(RECORD, { settledOwners: both }),
    { allSettled: true, closeOut: true, unsettled: [] });
  // The close line already stands: settled, but nothing more to post.
  assert.deepEqual(maestroSettlePlan(RECORD, { settledOwners: both, closed: true }),
    { allSettled: true, closeOut: false, unsettled: [] });
  // The unassigned part never blocks the close-out: it has no
  // owner to wait for, and the assignment post already named it.
  // One reply settles every part its seat owns.
  const twoPartsOneSeat = { v: 1, sequential: false, parts: [part(1, 'claude'), part(2, 'claude')] };
  assert.deepEqual(maestroSettlePlan(twoPartsOneSeat, { settledOwners: new Set(['claude']) }),
    { allSettled: true, closeOut: true, unsettled: [] });
});

test('maestroSettlePlan: an unanswered part is named only once its owner had the whole window', () => {
  const one = new Set(['claude']);
  // Young: Gemini may still answer; nothing is named, nothing closes.
  assert.deepEqual(maestroSettlePlan(RECORD, { settledOwners: one, ageMs: 5 * 60_000 }),
    { allSettled: false, closeOut: false, unsettled: [] });
  // Aged past the window with no reply: part 2 is due its line.
  const aged = maestroSettlePlan(RECORD, { settledOwners: one, ageMs: AGED });
  assert.equal(aged.allSettled, false);
  assert.equal(aged.closeOut, false);
  assert.deepEqual(aged.unsettled.map((p) => p.n), [2]);
  // Already named: never named again.
  assert.deepEqual(maestroSettlePlan(RECORD, { settledOwners: one, ageMs: AGED, namedUnsettled: new Set([2]) }).unsettled, []);
  // Nobody answered an aged assignment: both owned parts are
  // named; the unassigned part is not (it has no owner to name).
  assert.deepEqual(maestroSettlePlan(RECORD, { settledOwners: new Set(), ageMs: AGED }).unsettled.map((p) => p.n), [1, 2]);
  // A record with no owned parts settles nothing and names nothing.
  const unowned = { v: 1, sequential: false, parts: [part(1, null), part(2, null)] };
  assert.deepEqual(maestroSettlePlan(unowned, { settledOwners: new Set(), ageMs: AGED }),
    { allSettled: false, closeOut: false, unsettled: [] });
  assert.deepEqual(maestroSettlePlan(null, { settledOwners: new Set(), ageMs: AGED }),
    { allSettled: false, closeOut: false, unsettled: [] });
});

test('the settle lines: the close line is exact, the unsettled line names part and owner with no answer posted', () => {
  assert.equal(MAESTRO_CLOSEOUT_BODY, 'All parts are in');
  assert.equal(maestroUnsettledBody({ n: 2, owner: 'gemini', ownerName: 'Gemini' }), 'Part 2: no answer posted from Gemini.');
  assert.equal(maestroUnsettledBody({ n: 1, owner: 'claude', ownerName: null }), 'Part 1: no answer posted from claude.');
});

test('librarianCompletionEntryFor: one keyed record per marked message, owned parts only', () => {
  const entry = librarianCompletionEntryFor({
    channelId: 'chan-1', channelSlug: 'desk', channelTitle: 'Desk',
    messageId: 'msg-1', humanSubject: 'user_abc', assignment: RECORD, at: '2026-11-16T00:00:00.000Z',
  });
  assert.equal(entry.key, 'completion:msg-1');
  assert.equal(entry.value.channel, 'Desk');
  assert.equal(entry.value.slug, 'desk');
  assert.equal(entry.value.channelId, 'chan-1');
  assert.equal(entry.value.subject, 'user_abc');
  assert.deepEqual(entry.value.parts, [
    { n: 1, owner: 'claude', ownerName: 'Claude' },
    { n: 2, owner: 'gemini', ownerName: 'Gemini' },
  ], 'the unassigned part is not in the record: it was never handed out');
  assert.deepEqual(entry.value.seats, ['claude', 'gemini']);
  assert.equal(entry.value.at, '2026-11-16T00:00:00.000Z');
  assert.equal(librarianCompletionEntryFor({ channelId: 'chan-1' }), null);
  assert.equal(librarianCompletionEntryFor({ messageId: 'msg-1' }), null);
  assert.equal(librarianCompletionEntryFor(null), null);
});

test('settle wiring: agentWork runs the watcher in its deferred tail and files completions through the Librarian', async () => {
  const { readFile } = await import('node:fs/promises');
  const mesh = await readFile(new URL('../src/cloud/envoy-mesh.mjs', import.meta.url), 'utf8');
  assert.ok(mesh.includes('settleMaestroAssignmentsIfNeeded({ pool, tenantId: actor.tenantId, channelIds: [...settleChannelIds],'),
    'the poll tail runs the settle watcher once for the channels the poll served');
  assert.ok(mesh.includes('fileAssignmentCompletion(librarian, actor, completion, librarianOpts)'),
    'settled assignments file their completion record through the Librarian in the same tail');
  const assignments = await readFile(new URL('../src/cloud/envoy-assignments.mjs', import.meta.url), 'utf8');
  assert.ok(assignments.includes("export const MAESTRO_CLOSEOUT_BODY = 'All parts are in';"),
    'the close line is the design\u2019s exact words');
  assert.ok(assignments.includes('maestro-closeout:') && assignments.includes('maestro-unsettled:'),
    'both settle lines carry their own idempotency keys');
});

test('mesh assignment settle on Postgres: close line once, one completion record, unsettled line once, unmarked untouched', { skip }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const tenantId = `t-${randomUUID().slice(0, 8)}`;
  const owner = { tenantId, subject: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`, role: 'owner', get sessionId() { return randomUUID(); }, get requestId() { return randomUUID(); } };
  const device = { tenantId, subject: owner.subject, role: 'owner', viaDeviceToken: true };
  await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantId, 'Assignment settle test']);
  await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantId, owner.subject, 'owner']);
  const mesh = createEnvoyMesh({ pool, publishImpl: async () => {}, nameLookup: async () => 'Troy' });
  const chat = createEnvoyStore(pool);
  const jobFor = (a, b, c) => [
    'Maestro: I have a three-part job. Assign one owner per part.',
    `Part one: Claude: ${a}`,
    `Part two: Gemini: ${b}`,
    `Part three: Mistral: ${c}`,
  ].join('\n');
  const rowsByKey = async (key) => (await pool.query(
    'select * from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and idempotency_key=$3',
    [tenantId, channel.id, key],
  )).rows;
  const completionOf = async (messageId) => (await pool.query(
    'select key, value from helmion.context_entries where project_slug=$1 and key=$2',
    [tenantId, `completion:${messageId}`],
  )).rows;
  let channel;
  try {
    ({ channel } = await chat.createChannel(owner, { slug: 'settle-desk', title: 'Settle Desk', kind: 'team' }));
    for (const provider of ['claude', 'gemini', 'grok']) await mesh.changeConfig(owner, { action: 'add-agent', channelId: channel.id, provider });
    await new Promise((r) => setTimeout(r, 20));
    const poll = async () => { const out = await mesh.agentWork(device, 'claude,gemini,grok'); await mesh.drainFilingTail(); return out; };

    // Message 1: the recorded shape — Claude and Gemini own a
    // part each, the Mistral part is unassigned (not a member).
    const human1 = (await chat.appendMessage(owner, { channelId: channel.id, body: jobFor('draft the release notes.', 'draft the changelog.', 'draft the FAQ.'), idempotencyKey: randomUUID() })).receipt.message;
    await poll();
    assert.equal((await rowsByKey(`maestro-closeout:${human1.id}`)).length, 0, 'nothing settled yet: no close line');
    assert.equal((await pool.query("select 1 from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and idempotency_key like 'maestro-unsettled:%'", [tenantId, channel.id])).rowCount, 0,
      'a young assignment names nobody unanswered');

    // One of the two due seats replies: still no close line, no
    // completion record, and the outstanding part is not named
    // while its owner still has the window.
    await mesh.postAsAgent(device, { channelId: channel.id, provider: 'claude', replyTo: human1.id, body: 'Release notes drafted.' });
    await poll();
    assert.equal((await rowsByKey(`maestro-closeout:${human1.id}`)).length, 0, 'one reply of two: no close line');
    assert.equal((await completionOf(human1.id)).length, 0, 'one reply of two: no completion record');

    // The second reply lands: exactly one close line, after the
    // second reply, in the design's exact words, and exactly
    // one completion record through the Librarian.
    const geminiReply1 = (await mesh.postAsAgent(device, { channelId: channel.id, provider: 'gemini', replyTo: human1.id, body: 'Changelog drafted.' })).receipt.message;
    await poll();
    const close1 = await rowsByKey(`maestro-closeout:${human1.id}`);
    assert.equal(close1.length, 1, 'both replies in: exactly one close line');
    assert.equal(close1[0].author_subject, 'agent:maestro');
    assert.equal(close1[0].author_kind, 'agent');
    assert.equal(close1[0].body, 'All parts are in');
    const record1 = (await chat.listMessages(owner, channel.id)).messages;
    assert.ok(record1.findIndex((m) => m.id === close1[0].id) > record1.findIndex((m) => m.id === geminiReply1.id),
      'the close line lands after the second reply');
    const completion1 = await completionOf(human1.id);
    assert.equal(completion1.length, 1, 'exactly one completion record');
    assert.deepEqual(completion1[0].value.seats, ['claude', 'gemini']);
    assert.deepEqual(completion1[0].value.parts.map((p) => [p.n, p.owner]), [[1, 'claude'], [2, 'gemini']]);

    // Duplicate settle triggers — more polls, the coordinator's
    // road re-walked — never post a second close line or file
    // a second record.
    await poll();
    await poll();
    assert.equal((await rowsByKey(`maestro-closeout:${human1.id}`)).length, 1, 're-fired settle triggers: still one close line');
    assert.equal((await completionOf(human1.id)).length, 1, 're-fired settle triggers: still one completion record');

    // Message 2: the replies land in the swapped order — Gemini
    // first, Claude second. Still exactly one close line, after
    // the second reply.
    const human2 = (await chat.appendMessage(owner, { channelId: channel.id, body: jobFor('write the summary.', 'write the outline.', 'write the appendix.'), idempotencyKey: randomUUID() })).receipt.message;
    await mesh.postAsAgent(device, { channelId: channel.id, provider: 'gemini', replyTo: human2.id, body: 'Outline written.' });
    await poll();
    assert.equal((await rowsByKey(`maestro-closeout:${human2.id}`)).length, 0, 'swapped order, one reply in: no close line yet');
    const claudeReply2 = (await mesh.postAsAgent(device, { channelId: channel.id, provider: 'claude', replyTo: human2.id, body: 'Summary written.' })).receipt.message;
    await poll();
    const close2 = await rowsByKey(`maestro-closeout:${human2.id}`);
    assert.equal(close2.length, 1, 'swapped order: exactly one close line');
    const record2 = (await chat.listMessages(owner, channel.id)).messages;
    assert.ok(record2.findIndex((m) => m.id === close2[0].id) > record2.findIndex((m) => m.id === claudeReply2.id),
      'the close line lands after the second reply, whichever order they came in');
    assert.equal((await completionOf(human2.id)).length, 1);

    // Message 3: only Claude answers, and the message ages past
    // the work window. Gemini's part is named once as
    // unanswered; Claude's answered part and the unassigned
    // part are not named; there is no close line and no
    // completion record; a later poll names nothing again.
    const human3 = (await chat.appendMessage(owner, { channelId: channel.id, body: jobFor('check the numbers.', 'check the dates.', 'check the names.'), idempotencyKey: randomUUID() })).receipt.message;
    await mesh.postAsAgent(device, { channelId: channel.id, provider: 'claude', replyTo: human3.id, body: 'Numbers checked.' });
    await pool.query("update helmion.envoy_messages set created_at = now() - interval '31 minutes' where tenant_id=$1 and id=$2", [tenantId, human3.id]);
    await poll();
    const unsettled3 = await rowsByKey(`maestro-unsettled:${human3.id}:2`);
    assert.equal(unsettled3.length, 1, 'the aged, unanswered part is named exactly once');
    assert.equal(unsettled3[0].author_subject, 'agent:maestro');
    assert.equal(unsettled3[0].body, 'Part 2: no answer posted from Gemini.');
    assert.equal((await rowsByKey(`maestro-unsettled:${human3.id}:1`)).length, 0, 'the answered part is not named');
    assert.equal((await rowsByKey(`maestro-unsettled:${human3.id}:3`)).length, 0, 'the unassigned part is not named: it has no owner');
    assert.equal((await rowsByKey(`maestro-closeout:${human3.id}`)).length, 0, 'an unsettled assignment gets no close line');
    assert.equal((await completionOf(human3.id)).length, 0, 'an unsettled assignment files no completion record');
    await poll();
    assert.equal((await rowsByKey(`maestro-unsettled:${human3.id}:2`)).length, 1, 'a later poll does not name the part again');

    // Control: an unmarked message is never watched — no settle
    // lines of either kind are ever written for it.
    const plain = (await chat.appendMessage(owner, { channelId: channel.id, body: 'A plain note for the room, no parts in it.', idempotencyKey: randomUUID() })).receipt.message;
    await poll();
    assert.equal((await rowsByKey(`maestro-closeout:${plain.id}`)).length, 0, 'an unmarked message gets no close line');
    assert.equal((await pool.query("select 1 from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and idempotency_key like $3", [tenantId, channel.id, `maestro-unsettled:${plain.id}:%`])).rowCount, 0,
      'an unmarked message gets no unsettled line');
    const allClose = await pool.query("select count(*)::int as n from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and body='All parts are in'", [tenantId, channel.id]);
    assert.equal(allClose.rows[0].n, 2, 'the channel holds exactly the two close lines, one per settled assignment');
  } finally {
    await pool.query("delete from helmion.audit_events where tenant_id like 't-%'").catch(() => {});
    await pool.query("delete from helmion.tenants where tenant_id like 't-%'").catch(() => {});
    await pool.end();
  }
});
