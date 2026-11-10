// Helmian Site Guard, bite A2: intake rate limits surfaced as Guard
// findings. The limiter + finding-shaping tests always run. The
// mesh end-to-end test runs against a real Postgres when
// HELMIAN_TEST_PG_URL points at a scratch database (same gate as
// test/site-guard.test.mjs); skipped otherwise.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  SITE_GUARD_FINDING_SOURCE,
  SITE_GUARD_RATE_CLASS,
  SITE_GUARD_RATE_WINDOW_MS,
  SITE_GUARD_RATE_FLAG_THRESHOLD,
  SITE_GUARD_RATE_STOP_THRESHOLD,
  createSiteGuardRateLimiter,
  siteGuardSenderKey,
  siteGuardFindingForRateLimit,
  siteGuardRateStopRecord,
  siteGuardRateRefusalText,
  ingestSiteGuardRateFinding,
} from '../src/cloud/site-guard.mjs';
import { normalizeGuardFinding } from '../src/cloud/guard-findings.mjs';

const TENANT = 'tenant-1';
const SENDER = 'user_flood';
// A secret-shaped string standing in for message content: it lives
// only in this test's "message bodies", which the rate path never
// receives. The pins below assert it appears in no finding, record,
// or refusal the rate path produces.
const SECRET_BODY = 'my password is sk-live-EXAMPLESECRET123 and nobody should see it';

function flood(limiter, { tenantId = TENANT, senderKey = SENDER, count, at } = {}) {
  const verdicts = [];
  for (let i = 0; i < count; i += 1) {
    verdicts.push(limiter.observe({ tenantId, senderKey, ...(at !== undefined ? { at } : {}) }));
  }
  return verdicts;
}

test('rate: the thresholds are the settled constants', () => {
  assert.equal(SITE_GUARD_RATE_WINDOW_MS, 60_000);
  assert.equal(SITE_GUARD_RATE_FLAG_THRESHOLD, 30);
  assert.equal(SITE_GUARD_RATE_STOP_THRESHOLD, 90);
  assert.equal(SITE_GUARD_RATE_CLASS, 'intake-rate-limit');
});

test('rate: under the flag line nothing trips, nothing stops, no finding is shaped', () => {
  const limiter = createSiteGuardRateLimiter({ now: () => 1_000_000 });
  const verdicts = flood(limiter, { count: SITE_GUARD_RATE_FLAG_THRESHOLD - 1, at: 1_000_000 });
  for (const verdict of verdicts) {
    assert.equal(verdict.tripped, null);
    assert.equal(verdict.stopped, false);
    assert.equal(verdict.level, 'none');
    assert.equal(siteGuardFindingForRateLimit(verdict, { tenantId: TENANT, channelId: 'c', messageId: 'm' }), null);
  }
  const last = verdicts[verdicts.length - 1];
  assert.equal(last.count, SITE_GUARD_RATE_FLAG_THRESHOLD - 1);
});

test('rate: the flag crossing trips exactly once and the intake proceeds', () => {
  const limiter = createSiteGuardRateLimiter({ now: () => 2_000_000 });
  const verdicts = flood(limiter, { count: SITE_GUARD_RATE_FLAG_THRESHOLD + 5, at: 2_000_000 });
  const trips = verdicts.filter((v) => v.tripped);
  assert.equal(trips.length, 1);
  assert.equal(trips[0].tripped, 'flag');
  assert.equal(trips[0].count, SITE_GUARD_RATE_FLAG_THRESHOLD);
  assert.ok(verdicts.every((v) => v.stopped === false), 'a flag never stops a turn');
  assert.equal(verdicts[verdicts.length - 1].level, 'flag');
});

test('rate: sustained volume trips the stop line once, then stops with no new trips', () => {
  const limiter = createSiteGuardRateLimiter({ now: () => 3_000_000 });
  const verdicts = flood(limiter, { count: 150, at: 3_000_000 });
  const trips = verdicts.filter((v) => v.tripped);
  assert.deepEqual(trips.map((v) => v.tripped), ['flag', 'stop']);
  assert.equal(trips[0].count, SITE_GUARD_RATE_FLAG_THRESHOLD);
  assert.equal(trips[1].count, SITE_GUARD_RATE_STOP_THRESHOLD);
  const firstStopped = verdicts.findIndex((v) => v.stopped);
  assert.equal(firstStopped, SITE_GUARD_RATE_STOP_THRESHOLD - 1, 'the stop posture starts at the crossing message');
  assert.ok(verdicts.slice(firstStopped).every((v) => v.stopped), 'every later message in the window is stopped');
  assert.ok(verdicts.slice(firstStopped + 1).every((v) => v.tripped === null), 'no duplicate trips inside the window');
});

test('rate: the window sliding cools the sender and both lines re-arm', () => {
  let clock = 4_000_000;
  const limiter = createSiteGuardRateLimiter({ now: () => clock });
  const first = flood(limiter, { count: 100 });
  assert.deepEqual(first.filter((v) => v.tripped).map((v) => v.tripped), ['flag', 'stop']);
  // Half a window later the stamps still stand inside the window:
  // the sender is still stopped, and nothing new trips.
  clock += 30_000;
  const stillHot = limiter.observe({ tenantId: TENANT, senderKey: SENDER });
  assert.equal(stillHot.stopped, true);
  assert.equal(stillHot.tripped, null);
  // Past the window every stamp has expired: the count restarts,
  // the posture clears, and a fresh flood trips both lines again —
  // a new window is a new trip, not a continuation.
  clock += SITE_GUARD_RATE_WINDOW_MS + 1_000;
  const cooled = limiter.observe({ tenantId: TENANT, senderKey: SENDER });
  assert.equal(cooled.count, 1);
  assert.equal(cooled.stopped, false);
  assert.equal(cooled.level, 'none');
  const second = flood(limiter, { count: 99 });
  assert.deepEqual(second.filter((v) => v.tripped).map((v) => v.tripped), ['flag', 'stop']);
});

test('rate: counts are kept per tenant and per sender', () => {
  const limiter = createSiteGuardRateLimiter({ now: () => 5_000_000 });
  flood(limiter, { count: SITE_GUARD_RATE_FLAG_THRESHOLD, at: 5_000_000 });
  const otherSender = limiter.observe({ tenantId: TENANT, senderKey: 'user_quiet', at: 5_000_000 });
  assert.equal(otherSender.count, 1);
  assert.equal(otherSender.tripped, null);
  const otherTenant = limiter.observe({ tenantId: 'tenant-2', senderKey: SENDER, at: 5_000_000 });
  assert.equal(otherTenant.count, 1);
  assert.equal(otherTenant.tripped, null);
});

test('rate: findings pass the store normalizer, one standing row per sender, metadata only', () => {
  const limiter = createSiteGuardRateLimiter({ now: () => 6_000_000 });
  const verdicts = flood(limiter, { count: 100, at: 6_000_000 });
  const [flagTrip, stopTrip] = verdicts.filter((v) => v.tripped);
  const context = { tenantId: TENANT, channelId: 'chan-1', channelSlug: 'build', messageId: 'msg-9', authorKind: 'human' };
  const flag = siteGuardFindingForRateLimit(flagTrip, context);
  const stop = siteGuardFindingForRateLimit(stopTrip, context);
  for (const input of [flag, stop]) {
    const normalized = normalizeGuardFinding(input);
    assert.equal(input.source, SITE_GUARD_FINDING_SOURCE);
    assert.equal(normalized.source, 'site-guard');
    assert.equal(input.pageRef, null);
    assert.equal(input.detail.kind, 'helmian-site-guard-rate-limit');
    assert.equal(input.detail.class, 'intake-rate-limit');
    assert.equal(input.detail.senderKey, SENDER);
    assert.equal(input.detail.messageId, 'msg-9');
    // One standing row per (tenant, sender): both trips carry the
    // same fingerprint, so the store dedupes them into a single row
    // whose detail and severity refresh to the latest trip.
    assert.equal(input.fingerprint, 'helmian-site-guard:intake-rate-limit:tenant-1:user_flood');
    // Metadata only: no message content rides a finding — the
    // secret in the sender's message bodies is nowhere in either
    // finding, and no body-shaped key exists in the detail.
    assert.ok(!JSON.stringify(input).includes('EXAMPLESECRET123'), 'finding carries no message content');
    assert.ok(!('body' in input.detail) && !('text' in input.detail));
  }
  assert.equal(flag.severity, 'warning');
  assert.equal(flag.detail.level, 'flag');
  assert.equal(flag.detail.stopped, false);
  assert.equal(flag.detail.count, SITE_GUARD_RATE_FLAG_THRESHOLD);
  assert.match(flag.title, /^Helmian Site Guard flagged a sender in #build — intake rate limit \(30 messages in 60s\)$/);
  assert.equal(stop.severity, 'critical');
  assert.equal(stop.detail.level, 'stop');
  assert.equal(stop.detail.stopped, true);
  assert.equal(stop.detail.count, SITE_GUARD_RATE_STOP_THRESHOLD);
  assert.match(stop.title, /^Helmian Site Guard stopped a sender in #build — intake rate limit \(90 messages in 60s\)$/);
});

test('rate: the stop record and refusal text name the Site Guard and the limit, never the message', () => {
  const limiter = createSiteGuardRateLimiter({ now: () => 7_000_000 });
  const verdicts = flood(limiter, { count: SITE_GUARD_RATE_STOP_THRESHOLD, at: 7_000_000 });
  const stopTrip = verdicts[verdicts.length - 1];
  const record = siteGuardRateStopRecord(stopTrip);
  assert.equal(record.kind, 'helmian-site-guard-rate-limit');
  assert.equal(record.verdict, 'refuse');
  assert.equal(record.stoppedBy, 'helmian-site-guard');
  assert.deepEqual([...record.classes], ['intake-rate-limit']);
  assert.ok(record.hits[0].includes('90 messages in 60 seconds'));
  const text = siteGuardRateRefusalText(stopTrip);
  assert.match(text, /^Helmian Site Guard stopped this message before it reached a seat\./);
  assert.ok(text.includes('intake rate limit'));
  assert.ok(!JSON.stringify(record).includes('EXAMPLESECRET123'));
  assert.ok(!text.includes('EXAMPLESECRET123'));
  // The seeded body itself is what a message would carry; the rate
  // path's outputs above were built without ever seeing it.
  assert.ok(SECRET_BODY.includes('EXAMPLESECRET123'));
});

test('rate: ingest lands one finding per trip across a flood, skips non-trips, and never throws', async () => {
  const limiter = createSiteGuardRateLimiter({ now: () => 8_000_000 });
  const verdicts = flood(limiter, { count: 150, at: 8_000_000 });
  const calls = [];
  const store = { async ingestFinding(actor, input) { calls.push({ actor, input }); return { durability: 'committed', inserted: true }; } };
  const actor = { tenantId: TENANT, subject: 'user_test' };
  const context = { tenantId: TENANT, channelId: 'chan-1', messageId: 'msg-9' };
  let landed = 0;
  for (const verdict of verdicts) {
    landed += await ingestSiteGuardRateFinding(store, actor, verdict, context);
  }
  assert.equal(landed, 2, 'a 150-message flood lands exactly two findings: the flag trip and the stop trip');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].input.detail.level, 'flag');
  assert.equal(calls[1].input.detail.level, 'stop');
  assert.equal(calls[0].input.fingerprint, calls[1].input.fingerprint);
  assert.deepEqual(calls[0].actor, { tenantId: TENANT, subject: 'user_test' });

  const logged = [];
  const down = { async ingestFinding() { throw new Error('findings store is down'); } };
  const stopTrip = verdicts.find((v) => v.tripped === 'stop');
  const landedNone = await ingestSiteGuardRateFinding(down, actor, stopTrip, context, { log: (...a) => logged.push(a.join(' ')) });
  assert.equal(landedNone, 0);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /\[site-guard\] Guard findings write FAILED/);
});

test('rate: the sender key prefers the author subject and falls back to the author kind', () => {
  assert.equal(siteGuardSenderKey({ authorSubject: 'user_abc', authorKind: 'human' }), 'user_abc');
  assert.equal(siteGuardSenderKey({ authorSubject: 'agent:claude@tenant 1', authorKind: 'agent' }), 'agent:claude@tenant_1');
  assert.equal(siteGuardSenderKey({ authorSubject: null, authorKind: 'agent' }), 'kind:agent');
  assert.equal(siteGuardSenderKey({}), 'kind:unknown');
  assert.equal(siteGuardSenderKey({ authorSubject: 'x'.repeat(200) }).length, 128);
});

const url = process.env.HELMIAN_TEST_PG_URL;
const skip = !url && 'HELMIAN_TEST_PG_URL not set';

test('mesh: a flooding sender is flagged once, then stopped at the stop line, with exactly two rate findings witnessed', { skip }, async () => {
  const pg = (await import('pg')).default;
  const { createEnvoyMesh } = await import('../src/cloud/envoy-mesh.mjs');
  const { createEnvoyStore } = await import('../src/cloud/envoy-chat.mjs');
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const tenantId = `t-${randomUUID().slice(0, 8)}`;
  const owner = { tenantId, subject: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`, role: 'owner', get sessionId() { return randomUUID(); }, get requestId() { return randomUUID(); } };
  const device = { tenantId, subject: owner.subject, role: 'owner', viaDeviceToken: true };
  await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantId, 'Site Guard rate test']);
  await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantId, owner.subject, 'owner']);
  const calls = [];
  const guardStore = { async ingestFinding(actor, input) { calls.push({ actor, input }); return { durability: 'committed', inserted: true, ackCleared: false }; } };
  const mesh = createEnvoyMesh({ pool, guardStoreImpl: guardStore, publishImpl: async () => {}, nameLookup: async () => 'Troy' });
  const chat = createEnvoyStore(pool);
  try {
    const { channel } = await chat.createChannel(owner, { slug: 'build', title: 'build', kind: 'team' });
    await mesh.changeConfig(owner, { action: 'add-agent', channelId: channel.id, provider: 'claude' });
    const total = SITE_GUARD_RATE_STOP_THRESHOLD + 5;
    const bodies = [];
    for (let i = 1; i <= total; i += 1) {
      const body = `Status ping number ${i} — nothing urgent, just checking in.`;
      bodies.push(body);
      await chat.appendMessage(owner, { channelId: channel.id, body, idempotencyKey: randomUUID() });
    }

    const result = await mesh.agentWork(device, 'claude');
    const handedBodies = result.work.map((item) => item.message.body);
    for (let i = SITE_GUARD_RATE_STOP_THRESHOLD; i < total; i += 1) {
      assert.ok(!handedBodies.includes(bodies[i]), `message ${i + 1}, past the stop line, was handed to no seat`);
    }
    assert.ok(handedBodies.includes(bodies[0]), 'messages under the lines dispatched');

    const listed = await chat.listMessages(owner, channel.id);
    const refusals = listed.messages.filter((m) => String(m.body).startsWith('Helmian Site Guard stopped this message') && String(m.body).includes('intake rate limit'));
    assert.equal(refusals.length, total - SITE_GUARD_RATE_STOP_THRESHOLD + 1, 'one rate refusal per stopped message');
    assert.ok(refusals.every((m) => m.authorKind === 'agent'));

    const rate = calls.filter((c) => c.input.source === 'site-guard' && c.input.detail.class === 'intake-rate-limit');
    assert.equal(rate.length, 2, 'exactly the flag trip and the stop trip were witnessed — never one per message');
    assert.equal(rate[0].input.detail.level, 'flag');
    assert.equal(rate[0].input.severity, 'warning');
    assert.equal(rate[1].input.detail.level, 'stop');
    assert.equal(rate[1].input.severity, 'critical');
    assert.equal(rate[0].input.fingerprint, rate[1].input.fingerprint);
  } finally {
    await pool.end();
  }
});
