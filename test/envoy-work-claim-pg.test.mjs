// Bite J (the no-claim race, letter 727): the dispatch claim on
// Postgres. PG-gated like the neighbouring mesh suites — skipped
// unless HELMIAN_TEST_PG_URL points at a scratch database with the
// full sql chain applied (through sql/091). The burst leg is the
// race itself: one ask, many runners polling the same tenant in
// the same moment through the real agentWork road; exactly one
// poll may carry the work. Set BITEJ_BURST_ONLY=1 to run only the
// burst legs — that is the shape the negative control uses against
// the unpatched tree, where the same assertion fails with every
// poll winning.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createEnvoyMesh } from '../src/cloud/envoy-mesh.mjs';
import { createEnvoyStore } from '../src/cloud/envoy-chat.mjs';

const url = process.env.HELMIAN_TEST_PG_URL;
const skip = !url && 'HELMIAN_TEST_PG_URL not set';
const burstOnly = process.env.BITEJ_BURST_ONLY === '1';

async function seedMesh(pool) {
  const tenantId = `t-${randomUUID().slice(0, 8)}`;
  const owner = { tenantId, subject: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`, role: 'owner', get sessionId() { return randomUUID(); }, get requestId() { return randomUUID(); } };
  // The production poller shape: a device-token actor. Two runners
  // of one tenant are indistinguishable here — that is the race.
  const device = { tenantId, subject: owner.subject, role: 'owner', viaDeviceToken: true };
  await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantId, 'Claim test']);
  await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantId, owner.subject, 'owner']);
  // agentStateImpl models the live runner the polls belong to (the
  // fake suites stub it the same way): a polling runner is present
  // and ungated. The claim path under test is untouched by it.
  const mesh = createEnvoyMesh({ pool, publishImpl: async () => {}, nameLookup: async () => 'Troy', agentStateImpl: async () => ({ state: 'ready', gated: false }) });
  const chat = createEnvoyStore(pool);
  const { channel } = await chat.createChannel(owner, { slug: 'build', title: 'build', kind: 'team' });
  for (const provider of ['claude', 'gemini']) await mesh.changeConfig(owner, { action: 'add-agent', channelId: channel.id, provider });
  await new Promise((r) => setTimeout(r, 20));
  return { tenantId, owner, device, mesh, chat, channel };
}

const handouts = (results, messageId, seat) => results
  .flatMap((r) => r.work)
  .filter((w) => w.message.id === messageId && w.agents.includes(seat))
  .length;

test('the burst: one ask, eight concurrent polls of one tenant — the work is handed out exactly once (bite J)', { skip }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: url, max: 16 });
  try {
    const { device, mesh, chat, owner, channel } = await seedMesh(pool);
    // Distinct asks per round: near-identical repeats trip the
    // channel Guard's duplicate refusal, which answers the ask
    // itself and leaves nothing due — the rounds must differ the
    // way real asks differ.
    const bodies = [
      '@Claude write the release notes for the spring update',
      '@Claude draft the agenda for the co-op meeting on Friday',
      '@Claude summarise the wash plant downtime report',
      '@Claude outline the driver handbook chapter on pre-trips',
      '@Claude prepare the checklist for the yard move next week',
    ];
    for (let round = 0; round < bodies.length; round += 1) {
      const ask = (await chat.appendMessage(owner, { channelId: channel.id, body: bodies[round], idempotencyKey: randomUUID() })).receipt.message;
      const results = await Promise.all(Array.from({ length: 8 }, () => mesh.agentWork(device, 'claude')));
      assert.equal(handouts(results, ask.id, 'claude'), 1, `round ${round}: exactly one of eight concurrent polls carries the ask`);
      await mesh.drainFilingTail();
      // The winning runner does the work and answers, as production
      // does — an ever-growing pile of unanswered asks trips the
      // channel Guard's own stop, which is a different mechanism
      // than the one under test.
      await mesh.postAsAgent(device, { channelId: channel.id, provider: 'claude', replyTo: ask.id, body: `Done — that is round ${round} handled.` });
      await mesh.drainFilingTail();
    }
  } finally {
    await pool.end();
  }
});

test('the burst, two seats: concurrent polls for different seats each win their own seat once, never twice (bite J)', { skip }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: url, max: 16 });
  try {
    const { device, mesh, chat, owner, channel } = await seedMesh(pool);
    const ask = (await chat.appendMessage(owner, { channelId: channel.id, body: '@Claude @Gemini both of you, look at this', idempotencyKey: randomUUID() })).receipt.message;
    const polls = [];
    for (let i = 0; i < 4; i += 1) polls.push(mesh.agentWork(device, 'claude'));
    for (let i = 0; i < 4; i += 1) polls.push(mesh.agentWork(device, 'gemini'));
    const results = await Promise.all(polls);
    assert.equal(handouts(results, ask.id, 'claude'), 1, 'claude is handed the ask exactly once across its four polls');
    assert.equal(handouts(results, ask.id, 'gemini'), 1, 'gemini is handed the ask exactly once across its four polls — the claim never blocks the other seat');
    await mesh.drainFilingTail();
  } finally {
    await pool.end();
  }
});

test('the claim holds across sequential polls, expires back into the window, and a reply still ends the work (bite J)', { skip: skip || (burstOnly && 'burst-only control run') }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  try {
    const { tenantId, device, mesh, chat, owner, channel } = await seedMesh(pool);
    const ask = (await chat.appendMessage(owner, { channelId: channel.id, body: '@Claude sequential: do the thing', idempotencyKey: randomUUID() })).receipt.message;
    let work = (await mesh.agentWork(device, 'claude')).work.filter((w) => w.message.id === ask.id);
    assert.equal(work.length, 1, 'the first poll carries the ask');
    work = (await mesh.agentWork(device, 'claude')).work.filter((w) => w.message.id === ask.id);
    assert.equal(work.length, 0, 'a later poll of the same tenant gets nothing while the claim stands — the pre-fix road handed it out again here');
    // The claim is a lease, not a lock: once it expires (the
    // claiming runner died), the work is offered again, still
    // inside the dispatch window.
    await pool.query('update helmion.envoy_work_claims set expires_at = now() - interval \'1 second\' where tenant_id = $1 and message_id = $2', [tenantId, ask.id]);
    work = (await mesh.agentWork(device, 'claude')).work.filter((w) => w.message.id === ask.id);
    assert.equal(work.length, 1, 'an expired claim hands the work to the next poll');
    work = (await mesh.agentWork(device, 'claude')).work.filter((w) => w.message.id === ask.id);
    assert.equal(work.length, 0, 'the takeover claim holds in its turn');
    // A reply remains the durable end of the work, claim or no claim.
    await mesh.postAsAgent(device, { channelId: channel.id, provider: 'claude', replyTo: ask.id, body: 'Done.' });
    await pool.query('update helmion.envoy_work_claims set expires_at = now() - interval \'1 second\' where tenant_id = $1 and message_id = $2', [tenantId, ask.id]);
    work = (await mesh.agentWork(device, 'claude')).work.filter((w) => w.message.id === ask.id);
    assert.equal(work.length, 0, 'answered is answered, even with the claim expired');
    await mesh.drainFilingTail();
  } finally {
    await pool.end();
  }
});
