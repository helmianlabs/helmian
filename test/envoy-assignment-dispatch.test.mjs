// Bite M3 of the Maestro/Helm/Librarian fix programme (DESIGN 2.3,
// risks at 2.5): mesh assignment dispatch. A human message carrying
// the coordinator's mark (metadata.maestroAssignment, written by
// bite M2 in envoy-assignments.mjs) is handed out per part, not per
// message: the due set is the distinct owners of its parts, each
// owner's work item carries only its part (the slice the prompt
// renders from), a settled owner's parts are never re-handed, an
// unassigned part is never handed to anyone, connector arming is
// resolved per part for the part's owner alone, and neither the
// assignment post nor the part replies open Free-Willy debate
// turns. The Postgres test is the DESIGN desk test: one message,
// two parts, two owners — each owner's work item contains only its
// part, no other seat receives a work item, and the channel record
// shows the assignment post followed by the two owners' replies
// and no one else's. It runs when HELMIAN_TEST_PG_URL points at a
// scratch database with the full sql/ chain applied; skipped
// otherwise.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createEnvoyMesh, maestroPartPlan } from '../src/cloud/envoy-mesh.mjs';
import { createEnvoyStore } from '../src/cloud/envoy-chat.mjs';
import { agentPrompt } from '../src/cloud/envoy-agents.mjs';

const url = process.env.HELMIAN_TEST_PG_URL;
const skip = !url && 'HELMIAN_TEST_PG_URL not set';

const part = (n, text, owner) => ({
  n,
  text,
  owner,
  ownerName: owner ? owner[0].toUpperCase() + owner.slice(1) : null,
  namedOwner: owner,
  namedOwnerName: owner ? owner[0].toUpperCase() + owner.slice(1) : null,
  unassignedReason: owner ? null : 'not-seated',
});
const RECORD = {
  v: 1,
  sequential: false,
  parts: [
    part(1, 'Claude: draft the release notes.', 'claude'),
    part(2, 'Gemini: draft the changelog.', 'gemini'),
    part(3, 'Mistral: draft the FAQ.', null),
    part(4, 'Claude: draft the summary.', 'claude'),
  ],
};

test('maestroPartPlan: surviving parts in part order, owners as recorded', () => {
  const plan = maestroPartPlan(RECORD, { members: ['claude', 'gemini', 'grok'], messageId: 'm1', at: 1000 });
  assert.deepEqual(plan.map(({ part: p, owner }) => [p.n, owner]), [[1, 'claude'], [2, 'gemini'], [4, 'claude']],
    'the unassigned part is never in the plan; a seat owning two parts appears once per part');
});

test('maestroPartPlan: settled, unwanted, late-joined and off-roster owners lose their parts', () => {
  const base = { members: ['claude', 'gemini', 'grok'], messageId: 'm1', at: 1000 };
  // One reply settles every part that seat owns (the reply record
  // is per seat per message).
  assert.deepEqual(
    maestroPartPlan(RECORD, { ...base, answered: new Set(['agent:claude|m1']) }).map(({ owner }) => owner),
    ['gemini'],
  );
  // A poll that does not serve the owner does not hand its part out.
  assert.deepEqual(
    maestroPartPlan(RECORD, { ...base, isWanted: (p) => p !== 'gemini' }).map(({ part: p }) => p.n),
    [1, 4],
  );
  // An owner who joined after the message landed is not handed it.
  assert.deepEqual(
    maestroPartPlan(RECORD, { ...base, joined: { gemini: new Date(2000).toISOString() } }).map(({ part: p }) => p.n),
    [1, 4],
  );
  // An owner outside the roster is not handed anything, however
  // the record names them.
  assert.deepEqual(
    maestroPartPlan(RECORD, { ...base, members: ['claude', 'grok'] }).map(({ part: p }) => p.n),
    [1, 4],
  );
  // A malformed record plans nothing.
  assert.deepEqual(maestroPartPlan(null, base), []);
  assert.deepEqual(maestroPartPlan({}, base), []);
  assert.deepEqual(maestroPartPlan({ parts: 'nope' }, base), []);
});

test('agentPrompt without a slice is the prompt it has always composed, byte for byte', () => {
  const expected = 'You are Claude, an agent member of the #build channel in Helmian Envoy. Other agents here: Gemini. If you were given a slice of work, start your reply with "Claim:" and the slice you are taking, so you do not overlap the others. Be concise.\n\nRecent conversation:\n(none)\n\nReply to this message from Troy:\nship it';
  const input = { provider: 'claude', channelTitle: 'build', members: ['claude', 'gemini'], message: { authorName: 'Troy', body: 'ship it' } };
  assert.equal(agentPrompt(input), expected);
  assert.equal(agentPrompt({ ...input, slice: null }), expected);
  // A slice carrying no real part is no slice at all.
  assert.equal(agentPrompt({ ...input, slice: { n: 0, total: 2, text: 'x', job: 'ship it' } }), expected);
  assert.equal(agentPrompt({ ...input, slice: { n: 3, total: 2, text: 'x', job: 'ship it' } }), expected);
  assert.equal(agentPrompt({ ...input, slice: { n: 1, total: 2, text: '   ', job: 'ship it' } }), expected);
});

test('agentPrompt slice: the role line names the part, the job rides as context, the part is the message answered', () => {
  const job = '@Maestro: two jobs. Claude: draft the release notes. Gemini: draft the changelog.';
  const p = agentPrompt({
    provider: 'claude', channelTitle: 'build', members: ['claude', 'gemini'],
    message: { authorName: 'Troy', body: job },
    slice: { n: 1, total: 2, text: 'Claude: draft the release notes.', job },
  });
  assert.match(p, /Your slice is part 1 of 2; answer only it\./);
  assert.ok(p.endsWith('Reply to this message from Troy:\nClaude: draft the release notes.'),
    'the message being answered is the part text, never the whole job');
  assert.ok(p.includes(`The full job this slice belongs to, for context only:\n${job}`),
    'the full job rides as a context block');
  assert.ok(p.indexOf('Your slice is part') < p.indexOf('The full job this slice'),
    'the slice sentence is in the role line, before the job block');
  assert.ok(p.indexOf('The full job this slice') < p.indexOf('Recent conversation:'),
    'the job block renders beside the notebook block, before the history');
  // The notebook block still renders, ahead of the job block.
  const withNotebook = agentPrompt({
    provider: 'claude', channelTitle: 'build', members: ['claude', 'gemini'],
    message: { authorName: 'Troy', body: job }, notebook: 'SHARED NOTEBOOK:\n- a filed fact',
    slice: { n: 2, total: 2, text: 'Gemini: draft the changelog.', job },
  });
  assert.ok(withNotebook.indexOf('SHARED NOTEBOOK') < withNotebook.indexOf('The full job this slice'));
  assert.match(withNotebook, /Your slice is part 2 of 2; answer only it\./);
});

test('assignment dispatch wiring: agentWork routes marked messages per part and keeps part replies out of debate', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/cloud/envoy-mesh.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('maestroPartPlan(assignment,'), 'agentWork plans a marked message per part');
  assert.ok(src.includes('slice: { n: part.n, total: assignment.parts.length, text: part.text, job: message.body }'),
    'each part item carries only its part as the slice, with the full job attached');
  assert.ok(src.includes('markedIds.has(String(row.idempotency_key).slice(6))'),
    'a reply to a marked message is excluded from debate routing');
  assert.ok(src.includes('message.metadata?.maestroAssignment) continue;'),
    'the assignment post itself is never a work source');
});

test('mesh assignment dispatch on Postgres: one message, two owners, per-part work, settled once, no debate from part replies', { skip }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const tenantId = `t-${randomUUID().slice(0, 8)}`;
  const owner = { tenantId, subject: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`, role: 'owner', get sessionId() { return randomUUID(); }, get requestId() { return randomUUID(); } };
  const device = { tenantId, subject: owner.subject, role: 'owner', viaDeviceToken: true };
  await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantId, 'Assignment dispatch test']);
  await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantId, owner.subject, 'owner']);
  const mesh = createEnvoyMesh({ pool, publishImpl: async () => {}, nameLookup: async () => 'Troy' });
  const chat = createEnvoyStore(pool);
  // The message-1 shape (DESIGN 2.4): a Maestro lead line and one
  // enumerated line per part, each part naming its owner. Mistral
  // is a real seat but not a member of this channel, so the third
  // part is left unassigned (not-a-member) — deterministically.
  const JOB = [
    'Maestro: I have a three-part job. Assign one owner per part.',
    'Part one: Claude: draft the release notes.',
    'Part two: Gemini: draft the changelog.',
    'Part three: Mistral: draft the FAQ.',
  ].join('\n');
  try {
    const { channel } = await chat.createChannel(owner, { slug: 'assign-desk', title: 'Assignment Desk', kind: 'team' });
    for (const provider of ['claude', 'gemini', 'grok']) await mesh.changeConfig(owner, { action: 'add-agent', channelId: channel.id, provider });
    await new Promise((r) => setTimeout(r, 20));
    // The marked message: sent through the ordinary send path, so
    // the coordinator (bite M2) writes the record and the
    // assignment post exactly as it does in production. Mistral
    // is not seated, so the third part is left unassigned.
    const human = (await chat.appendMessage(owner, { channelId: channel.id, body: JOB, idempotencyKey: randomUUID() })).receipt.message;
    // The record is read from the raw row: the chat read model
    // (envoy-chat.mjs rowMessage) normalizes metadata to its
    // known keys and does not surface the coordinator's record,
    // while the mesh reads the raw metadata — as this dispatch
    // does in production.
    const rawHuman = await pool.query('select metadata from helmion.envoy_messages where tenant_id=$1 and id=$2', [tenantId, human.id]);
    assert.deepEqual(rawHuman.rows[0].metadata.maestroAssignment.parts.map((p) => p.owner), ['claude', 'gemini', null],
      'the coordinator marked the message: two owned parts, one unassigned');
    const listed = (await chat.listMessages(owner, channel.id)).messages;
    const post = listed[listed.findIndex((m) => m.id === human.id) + 1];
    assert.equal(post.authorSubject, 'agent:maestro', 'the assignment post follows the marked message');

    const workFor = async (providers) => (await mesh.agentWork(device, providers)).work.filter((w) => w.channel.id === channel.id);
    // Phase 1: per-part hand-out. Exactly two work items, one per
    // owner, each carrying only its part; Grok — seated, but owner
    // of nothing — receives no work item, and neither does anyone
    // for the unassigned part or the assignment post.
    let work = await workFor('claude,gemini,grok');
    assert.equal(work.length, 2, 'one work item per surviving part, nothing else');
    const claudeItem = work.find((w) => w.agents[0] === 'claude');
    const geminiItem = work.find((w) => w.agents[0] === 'gemini');
    assert.deepEqual(claudeItem.agents, ['claude']);
    assert.deepEqual(geminiItem.agents, ['gemini']);
    assert.equal(claudeItem.message.id, human.id);
    assert.deepEqual(claudeItem.slice, { n: 1, total: 3, text: 'Claude: draft the release notes.', job: JOB });
    assert.deepEqual(geminiItem.slice, { n: 2, total: 3, text: 'Gemini: draft the changelog.', job: JOB });
    assert.ok(!work.some((w) => w.agents.includes('grok')), 'no other seat receives a work item');
    assert.ok(!work.some((w) => w.message.id === post.id), 'the assignment post is never handed out');

    // Phase 2: Free-Willy changes nothing for a marked message —
    // no roster fan-out, and the assignment post opens no debate.
    await mesh.changeConfig(owner, { action: 'set-debate-mode', channelId: channel.id, debateMode: 'free-willy' });
    work = await workFor('claude,gemini,grok');
    assert.equal(work.length, 2, 'a marked message dispatches per part in debate mode too');
    assert.ok(work.every((w) => w.message.id === human.id && w.slice), 'every item is a part of the marked message');

    // Phase 3: Claude answers its part. Its reply settles Claude
    // (no re-hand), Gemini's part is still handed out, and the
    // reply itself opens no debate turn for anyone.
    const claudeReply = (await mesh.postAsAgent(device, { channelId: channel.id, provider: 'claude', replyTo: human.id, body: 'Release notes drafted.' })).receipt.message;
    work = await workFor('gemini,grok');
    assert.equal(work.length, 1, "only Gemini's unanswered part remains");
    assert.deepEqual(work[0].agents, ['gemini']);
    assert.equal(work[0].slice.n, 2);
    assert.ok(!work.some((w) => w.message.id === claudeReply.id), 'a part reply opens no debate turn');

    // Phase 4: Gemini answers. The message is fully settled: no
    // work for it, and Gemini's reply opens no debate turn either.
    const geminiReply = (await mesh.postAsAgent(device, { channelId: channel.id, provider: 'gemini', replyTo: human.id, body: 'Changelog drafted.' })).receipt.message;
    work = await workFor('claude,gemini,grok');
    assert.equal(work.length, 0, 'both owners settled: nothing is handed out again');
    assert.ok(!work.some((w) => w.message.id === geminiReply.id));

    // The channel record: the assignment post followed by the two
    // owners' replies and no one else's. Agent-authored messages
    // only: the debate-mode change in phase 2 leaves a system
    // notice in the record, which is channel traffic, not a reply.
    const record = (await chat.listMessages(owner, channel.id)).messages;
    const after = record.slice(record.findIndex((m) => m.id === human.id) + 1).filter((m) => m.authorKind === 'agent');
    assert.deepEqual(after.map((m) => m.authorSubject), ['agent:maestro', 'agent:claude', 'agent:gemini'],
      'assignment post, then the two owners\u2019 replies, and no one else\u2019s');
    assert.equal(after[1].id, claudeReply.id);
    assert.equal(after[2].id, geminiReply.id);

    // Phase 5 (control): debate routing itself is alive — an
    // ordinary agent post in the same channel, same mode, DOES
    // open a turn for a peer. The exclusions above are therefore
    // the marked-message rule, not a broken debate path.
    const note = (await mesh.postAsAgent(device, { channelId: channel.id, provider: 'claude', body: 'A note for the room.', idempotencyKey: `note-${randomUUID()}` })).receipt.message;
    work = await workFor('gemini,grok');
    assert.ok(work.some((w) => w.message.id === note.id && (w.agents.includes('gemini') || w.agents.includes('grok'))),
      'an unmarked agent post still opens a debate turn');
    await mesh.drainFilingTail?.();
  } finally {
    await pool.query("delete from helmion.audit_events where tenant_id like 't-%'").catch(() => {});
    await pool.query("delete from helmion.tenants where tenant_id like 't-%'").catch(() => {});
    await pool.end();
  }
});
