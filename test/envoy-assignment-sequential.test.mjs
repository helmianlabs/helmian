// Bite M5 of the Maestro/Helm/Librarian fix programme (DESIGN
// 2.3, conducting at 5.3): sequential release — Maestro
// conducts. An assignment record may carry sequential: true
// (the roll call's record, built by envoy-assignments.mjs, is
// sequential by default). With the flag, the mesh releases
// part N+1 only when part N's reply exists in the channel
// record — the same reply-existence fact bite M4's settle
// watcher reads, so a sequential assignment settles part by
// part under M4's unchanged rules: the close line posts once
// when every owned part is in, and an unanswered part is named
// by the unsettled line after the window rather than stalling
// the sequence in silence. Without the flag, a marked message
// releases every surviving part at once, exactly as bite M3
// left it. The Postgres test is the DESIGN conducting proof
// (2.4) at desk scale: a roll call on a two-seat channel is a
// two-part sequential assignment whose second part is not
// handed out until the first part's reply exists, whose
// replies land one seat at a time in roster order, and which
// closes out exactly once. It runs when HELMIAN_TEST_PG_URL
// points at a scratch database with the full sql/ chain
// applied; skipped otherwise.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createEnvoyMesh, maestroPartPlan } from '../src/cloud/envoy-mesh.mjs';
import { createEnvoyStore } from '../src/cloud/envoy-chat.mjs';

const url = process.env.HELMIAN_TEST_PG_URL;
const skip = !url && 'HELMIAN_TEST_PG_URL not set';

const part = (n, text, owner) => ({
  n,
  text,
  owner,
  ownerName: owner ? owner[0].toUpperCase() + owner.slice(1) : null,
  namedOwner: owner,
  namedOwnerName: owner ? owner[0].toUpperCase() + owner.slice(1) : null,
  unassignedReason: owner ? null : 'not-a-member',
});
const ROLL_PARTS = [
  part(1, 'Claude: report in.', 'claude'),
  part(2, 'Gemini: report in.', 'gemini'),
  part(3, 'Grok: report in.', 'grok'),
];
const SEQUENTIAL = { v: 1, sequential: true, parts: ROLL_PARTS };
const PARALLEL = { v: 1, sequential: false, parts: ROLL_PARTS };
const MEMBERS = ['claude', 'gemini', 'grok'];
const planNs = (record, opts = {}) => maestroPartPlan(record, { members: MEMBERS, messageId: 'm1', at: 1000, ...opts }).map(({ part: p }) => p.n);

test('maestroPartPlan sequential: only the frontier part is released, then the next, in order', () => {
  assert.deepEqual(planNs(SEQUENTIAL), [1], 'nothing answered: only part 1 is out');
  assert.deepEqual(planNs(SEQUENTIAL, { answered: new Set(['agent:claude|m1']) }), [2],
    'part 1 answered: part 2 releases, part 3 still waits');
  assert.deepEqual(planNs(SEQUENTIAL, { answered: new Set(['agent:claude|m1', 'agent:gemini|m1']) }), [3]);
  assert.deepEqual(planNs(SEQUENTIAL, { answered: new Set(['agent:claude|m1', 'agent:gemini|m1', 'agent:grok|m1']) }), [],
    'every part answered: nothing is handed out again');
});

test('maestroPartPlan sequential: a later part answered out of turn releases nothing early', () => {
  // The reply record is what it is — if part 2's owner somehow
  // has a reply in the record before part 1's owner does, the
  // round still waits on part 1: conducting is order, not
  // completion counting.
  assert.deepEqual(planNs(SEQUENTIAL, { answered: new Set(['agent:gemini|m1']) }), [1]);
  assert.deepEqual(planNs(SEQUENTIAL, { answered: new Set(['agent:gemini|m1', 'agent:grok|m1']) }), [1]);
});

test('maestroPartPlan sequential: an unassigned part never gates the round', () => {
  const record = { v: 1, sequential: true, parts: [part(1, 'Claude: a.', 'claude'), part(2, 'Mistral: b.', null), part(3, 'Gemini: c.', 'gemini')] };
  assert.deepEqual(planNs(record), [1]);
  assert.deepEqual(planNs(record, { answered: new Set(['agent:claude|m1']) }), [3],
    'the unassigned part is skipped, not waited on — the settle rule (bite M4)');
});

test('maestroPartPlan sequential: one reply settles every part its seat owns, and the round moves on', () => {
  const record = {
    v: 1, sequential: true,
    parts: [part(1, 'Claude: a.', 'claude'), part(2, 'Claude: b.', 'claude'), part(3, 'Gemini: c.', 'gemini')],
  };
  assert.deepEqual(planNs(record), [1], 'the second of the seat\u2019s parts waits behind its first');
  assert.deepEqual(planNs(record, { answered: new Set(['agent:claude|m1']) }), [3],
    'the seat\u2019s one reply settles both its parts (the reply record is per seat per message)');
});

test('maestroPartPlan sequential: the gate is reply existence alone — a frontier that cannot be handed out still holds the round', () => {
  // Part 1's owner is off this poll's roster: the part cannot
  // be planned, and part 2 does not jump the queue. The settle
  // watcher's unsettled line is what names the stall after the
  // window (bite M4); the plan itself never silently reorders.
  assert.deepEqual(maestroPartPlan(SEQUENTIAL, { members: ['gemini', 'grok'], messageId: 'm1', at: 1000 }), []);
  assert.deepEqual(planNs(SEQUENTIAL, { isWanted: (p) => p !== 'claude' }), []);
  assert.deepEqual(planNs(SEQUENTIAL, { joined: { claude: new Date(2000).toISOString() } }), []);
});

test('maestroPartPlan: a record without the sequential flag releases every surviving part at once (bite M3 unchanged)', () => {
  assert.deepEqual(planNs(PARALLEL), [1, 2, 3]);
  const unflagged = { v: 1, parts: ROLL_PARTS };
  assert.deepEqual(planNs(unflagged), [1, 2, 3], 'a record with no flag at all is a parallel record');
  assert.deepEqual(planNs(PARALLEL, { answered: new Set(['agent:claude|m1']) }), [2, 3],
    'settled owners still lose their parts, as M3 left it');
});

test('sequential wiring: the mesh gates on the record flag, and the coordinator builds sequential roll calls', async () => {
  const { readFile } = await import('node:fs/promises');
  const mesh = await readFile(new URL('../src/cloud/envoy-mesh.mjs', import.meta.url), 'utf8');
  assert.ok(mesh.includes('assignment?.sequential === true'), 'maestroPartPlan reads the record\u2019s sequential flag');
  const assignments = await readFile(new URL('../src/cloud/envoy-assignments.mjs', import.meta.url), 'utf8');
  assert.ok(assignments.includes('buildMaestroRollCallAssignment'), 'the coordinator builds the roll call record');
  assert.ok(assignments.includes('sequential: true'), 'the roll call record carries the flag');
  assert.ok(assignments.includes('isMaestroRollCall(body)'), 'the coordinator consults the roll call ask');
});

test('mesh sequential release on Postgres: a roll call is conducted one seat at a time, in roster order, and closes out once', { skip }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const tenantId = `t-${randomUUID().slice(0, 8)}`;
  const owner = { tenantId, subject: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`, role: 'owner', get sessionId() { return randomUUID(); }, get requestId() { return randomUUID(); } };
  const device = { tenantId, subject: owner.subject, role: 'owner', viaDeviceToken: true };
  await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantId, 'Sequential release test']);
  await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantId, owner.subject, 'owner']);
  const mesh = createEnvoyMesh({ pool, publishImpl: async () => {}, nameLookup: async () => 'Troy' });
  const chat = createEnvoyStore(pool);
  const ROLL_CALL = 'Maestro, run a roll call. One agent at a time, in order.';
  const rowsByKey = async (key) => (await pool.query(
    'select * from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and idempotency_key=$3',
    [tenantId, channel.id, key],
  )).rows;
  let channel;
  try {
    ({ channel } = await chat.createChannel(owner, { slug: 'roll-call-desk', title: 'Roll Call Desk', kind: 'team' }));
    for (const provider of ['claude', 'gemini']) await mesh.changeConfig(owner, { action: 'add-agent', channelId: channel.id, provider });
    await new Promise((r) => setTimeout(r, 20));
    const workFor = async (messageId) => (await mesh.agentWork(device, 'claude,gemini')).work
      .filter((w) => w.channel.id === channel.id && w.message.id === messageId);

    // The roll call, sent through the ordinary send path: the
    // coordinator writes a sequential record with one report-in
    // part per seated agent, in roster order, and the
    // assignment post names them in that order.
    const human = (await chat.appendMessage(owner, { channelId: channel.id, body: ROLL_CALL, idempotencyKey: randomUUID() })).receipt.message;
    const rawHuman = await pool.query('select metadata from helmion.envoy_messages where tenant_id=$1 and id=$2', [tenantId, human.id]);
    const record = rawHuman.rows[0].metadata.maestroAssignment;
    assert.equal(record.sequential, true, 'the roll call record is sequential');
    assert.deepEqual(record.parts.map((p) => [p.n, p.owner, p.text]), [
      [1, 'claude', 'Claude: report in.'],
      [2, 'gemini', 'Gemini: report in.'],
    ], 'one report-in part per connected seat, in roster order');
    const listed = (await chat.listMessages(owner, channel.id)).messages;
    const post = listed[listed.findIndex((m) => m.id === human.id) + 1];
    assert.equal(post.authorSubject, 'agent:maestro', 'the assignment post follows the roll call');
    assert.equal(post.body, [
      'Maestro here. This job has 2 parts, one owner per part:',
      'Part 1: Claude: "Claude: report in."',
      'Part 2: Gemini: "Gemini: report in."',
    ].join('\n'), 'the post names the seats in roster order');

    // Phase 1: only part 1 is released. Gemini's part exists in
    // the record but is not handed out — on this poll or the
    // next — while Claude has not answered.
    let work = await workFor(human.id);
    assert.equal(work.length, 1, 'a sequential assignment releases one part at a time');
    assert.deepEqual(work[0].agents, ['claude']);
    assert.deepEqual(work[0].slice, { n: 1, total: 2, text: 'Claude: report in.', job: ROLL_CALL });
    // The first poll claimed part 1 (bite J): a later poll gets
    // nothing while the claim stands. Expire the claim the way the
    // claim suite does, and the re-offer still holds part 2 back.
    work = await workFor(human.id);
    assert.equal(work.length, 0, 'while part 1 is claimed, a later poll is handed nothing');
    await pool.query('update helmion.envoy_work_claims set expires_at = now() - interval \'1 second\' where tenant_id = $1 and message_id = $2', [tenantId, human.id]);
    work = await workFor(human.id);
    assert.equal(work.length, 1, 'a later poll still holds part 2 back');
    assert.equal(work[0].slice.n, 1);

    // Phase 2: Claude reports in. Part 2 releases; part 1 does
    // not come back; nothing has closed out yet.
    await mesh.postAsAgent(device, { channelId: channel.id, provider: 'claude', replyTo: human.id, body: 'Claude reporting in.' });
    work = await workFor(human.id);
    assert.equal(work.length, 1, 'part 1 answered: part 2 is the only work out');
    assert.deepEqual(work[0].agents, ['gemini']);
    assert.equal(work[0].slice.n, 2);
    await mesh.drainFilingTail();
    assert.equal((await rowsByKey(`maestro-closeout:${human.id}`)).length, 0, 'one part still out: no close line');

    // Phase 3: Gemini reports in. The round is fully settled:
    // no work remains, and bite M4's close-out posts the close
    // line exactly once and files exactly one completion
    // record — a sequential assignment settles under the same
    // rules as any other.
    await mesh.postAsAgent(device, { channelId: channel.id, provider: 'gemini', replyTo: human.id, body: 'Gemini reporting in.' });
    work = await workFor(human.id);
    assert.equal(work.length, 0, 'both parts in: nothing is handed out again');
    await mesh.drainFilingTail();
    const close = await rowsByKey(`maestro-closeout:${human.id}`);
    assert.equal(close.length, 1, 'exactly one close line');
    assert.equal(close[0].author_subject, 'agent:maestro');
    assert.equal(close[0].body, 'All parts are in');
    const completion = (await pool.query(
      'select key, value from helmion.context_entries where project_slug=$1 and key=$2',
      [tenantId, `completion:${human.id}`],
    )).rows;
    assert.equal(completion.length, 1, 'exactly one completion record');
    assert.deepEqual(completion[0].value.parts.map((p) => [p.n, p.owner]), [[1, 'claude'], [2, 'gemini']]);
    await mesh.agentWork(device, 'claude,gemini');
    await mesh.drainFilingTail();
    assert.equal((await rowsByKey(`maestro-closeout:${human.id}`)).length, 1, 'later polls never post a second close line');

    // The channel record: the assignment post, then the two
    // report-ins landing one seat at a time in roster order,
    // then the close line — the conducting proof of DESIGN 2.4
    // in the record alone.
    const recordRows = (await chat.listMessages(owner, channel.id)).messages;
    const after = recordRows.slice(recordRows.findIndex((m) => m.id === human.id) + 1).filter((m) => m.authorKind === 'agent');
    assert.deepEqual(after.map((m) => m.authorSubject), ['agent:maestro', 'agent:claude', 'agent:gemini', 'agent:maestro'],
      'assignment post, the report-ins in roster order, then the close line, and no one else\u2019s');

    // Control: a non-sequential marked message in the same
    // channel still releases all its parts at once — sequential
    // release is the roll call's flag, not a new default.
    const JOB = [
      'Maestro: I have a two-part job. Assign one owner per part.',
      'Part one: Claude: draft the release notes.',
      'Part two: Gemini: draft the changelog.',
    ].join('\n');
    const human2 = (await chat.appendMessage(owner, { channelId: channel.id, body: JOB, idempotencyKey: randomUUID() })).receipt.message;
    const rawHuman2 = await pool.query('select metadata from helmion.envoy_messages where tenant_id=$1 and id=$2', [tenantId, human2.id]);
    assert.equal(rawHuman2.rows[0].metadata.maestroAssignment.sequential, false, 'the enumerated job\u2019s record is not sequential');
    const work2 = await workFor(human2.id);
    assert.equal(work2.length, 2, 'both parts are handed out on the same poll, as bite M3 left it');
    assert.deepEqual(work2.map((w) => w.slice.n).sort(), [1, 2]);
    await mesh.drainFilingTail?.();
  } finally {
    await pool.query("delete from helmion.audit_events where tenant_id like 't-%'").catch(() => {});
    await pool.query("delete from helmion.tenants where tenant_id like 't-%'").catch(() => {});
    await pool.end();
  }
});
