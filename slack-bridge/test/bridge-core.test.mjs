import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridge, normalizeSlackEvent, LINK_RE, outboundMode, outboundParts } from '../bridge-core.mjs';

function fakeCloud({ outbound = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization });
    const ok = (body) => ({ ok: true, status: 200, json: async () => ({ valid: true, ...body }) });
    if (url.includes('/bridge/outbound')) return ok({ messages: outbound, links: 0, slackLinks: 1 });
    if (url.includes('/bridge/links')) return ok({ links: [], slackLinks: [{ tenantId: 't1', envoyChannelId: 'e1', teamId: 'T0BP40EFJ1W', slackChannelId: 'C0BN7LCK946', agents: ['claude'] }] });
    if (url.includes('/bridge/confirm-link')) return JSON.parse(init.body).code === 'GOODCODE' && JSON.parse(init.body).provider === 'slack'
      ? ok({ envoyChannelId: 'e1', envoyChannelTitle: 'team', agents: ['claude'] })
      : { ok: false, status: 404, json: async () => ({ valid: false, code: 'ENVOY_LINK_CODE_UNKNOWN' }) };
    if (url.includes('/bridge/inbound')) return ok({ receipt: { durable: true, replayed: false } });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { calls, fetchImpl };
}

const evt = (o = {}) => normalizeSlackEvent({ type: 'message', channel: 'C0BN7LCK946', ts: '1729900000.000100', user: 'U0ABC12345', text: 'hello @claude', ...o }, 'T0BP40EFJ1W');

test('helpers: raw event normalization and the link command', () => {
  const e = evt();
  assert.equal(e.channelId, 'C0BN7LCK946');
  assert.equal(e.teamId, 'T0BP40EFJ1W');
  assert.equal(e.ts, '1729900000.000100');
  assert.equal(e.userId, 'U0ABC12345');
  assert.equal(e.botId, null);
  assert.equal(e.subtype, null);
  assert.equal(normalizeSlackEvent({ type: 'reaction_added', user: 'U1' }, 'T1'), null);
  assert.equal(normalizeSlackEvent(null, 'T1'), null);
  assert.equal(LINK_RE.exec('helmian link AB3DEF7H')[1], 'AB3DEF7H');
  assert.equal(LINK_RE.exec('please helmian link AB3DEF7H now'), null);
});

test('Slack -> Envoy: a linked human message mirrors with the badge fields', async () => {
  const cloud = fakeCloud();
  const b = createBridge({ cloud: 'https://h', token: 't'.repeat(40), fetchImpl: cloud.fetchImpl });
  await b.refreshLinks();
  const e = evt();
  e.userName = 'Troy';
  assert.deepEqual(await b.onSlackMessage(e), { mirrored: true });
  const inbound = cloud.calls.find((c) => c.url.includes('/inbound'));
  assert.equal(inbound.method, 'POST');
  assert.equal(inbound.auth, `Bearer ${'t'.repeat(40)}`);
  // The exact shape the cloud turns into the /app badge: source 'slack'
  // comes from the slack: subject; authorName rides the subject; the
  // channel name is stamped into the message metadata cloud-side.
  assert.deepEqual(inbound.body, {
    provider: 'slack', tenantId: 't1', envoyChannelId: 'e1', slackChannelId: 'C0BN7LCK946',
    slackMessageId: '1729900000.000100', teamId: 'T0BP40EFJ1W', authorId: 'U0ABC12345', authorName: 'Troy', body: 'hello @claude',
  });
  assert.equal(b.stats.inbound, 1);
});

test('duplicate events do not repost (Slack redelivery + cloud idempotency backstop)', async () => {
  const cloud = fakeCloud();
  const b = createBridge({ cloud: 'https://h', token: 't'.repeat(40), fetchImpl: cloud.fetchImpl });
  await b.refreshLinks();
  assert.deepEqual(await b.onSlackMessage(evt()), { mirrored: true });
  assert.deepEqual(await b.onSlackMessage(evt()), { skipped: 'duplicate' });
  assert.equal(cloud.calls.filter((c) => c.url.includes('/inbound')).length, 1);
  // A different ts is a different message.
  assert.deepEqual(await b.onSlackMessage(evt({ ts: '1729900001.000200' })), { mirrored: true });
  assert.equal(cloud.calls.filter((c) => c.url.includes('/inbound')).length, 2);
});

test('bots, subtypes, unlinked channels and empty text never mirror', async () => {
  const cloud = fakeCloud();
  const b = createBridge({ cloud: 'https://h', token: 't'.repeat(40), fetchImpl: cloud.fetchImpl });
  await b.refreshLinks();
  assert.equal((await b.onSlackMessage(evt({ bot_id: 'B0123' }))).skipped, 'bot');
  assert.equal((await b.onSlackMessage(evt({ subtype: 'message_changed' }))).skipped, 'bot');
  assert.equal((await b.onSlackMessage(evt({ subtype: 'message_deleted' }))).skipped, 'bot');
  assert.equal((await b.onSlackMessage(evt({ user: undefined }))).skipped, 'bot');
  assert.equal((await b.onSlackMessage(evt({ channel: 'C999999999' }))).skipped, 'not_linked');
  assert.equal((await b.onSlackMessage(evt({ text: '   ' }))).skipped, 'empty');
  assert.equal(cloud.calls.filter((c) => c.url.includes('/inbound')).length, 0);
});

test('link command confirms with provider slack; a bad code gets the friendly reply', async () => {
  const cloud = fakeCloud();
  const b = createBridge({ cloud: 'https://h', token: 't'.repeat(40), fetchImpl: cloud.fetchImpl });
  const replies = [];
  const reply = async (t) => replies.push(t);
  // Link commands work in an unlinked channel (that is the point of them).
  const good = evt({ channel: 'C555555555', text: 'helmian link GOODCODE' });
  good.channelName = 'all-helmian';
  good.teamName = 'HELMIAN';
  assert.equal((await b.onSlackMessage(good, { reply })).linked, 'e1');
  const confirm = cloud.calls.find((c) => c.url.includes('confirm-link'));
  assert.deepEqual(confirm.body, { provider: 'slack', code: 'GOODCODE', teamId: 'T0BP40EFJ1W', channelId: 'C555555555', channelName: 'all-helmian', teamName: 'HELMIAN' });
  assert.match(replies.at(-1), /Linked to Helmian Envoy #team/);
  assert.equal((await b.onSlackMessage(evt({ channel: 'C555555555', text: 'helmian link BADCDE22' }), { reply })).error, 'ENVOY_LINK_CODE_UNKNOWN');
  assert.match(replies.at(-1), /wrong or expired/);
  // A bot typing the command never even reaches the cloud.
  assert.equal((await b.onSlackMessage(evt({ text: 'helmian link GOODCODE', bot_id: 'B0123' }), { reply })).skipped, 'bot');
});

// --- Outbound (Envoy -> Slack, named) ---

const NOW = Date.parse('2026-10-25T14:00:00.000Z');
const feedMsg = (o = {}) => ({
  id: 'm1', channelId: 'e1', slackChannelId: 'C0BN7LCK946', teamId: 'T0BP40EFJ1W',
  authorSubject: 'user_3L5HJWabcdef', authorKind: 'human', displayName: 'Troy', source: 'helmian',
  body: 'hello slack', createdAt: '2026-10-25T13:59:30.000Z', ...o,
});

test('Envoy -> Slack: posts are authored with the sender name, Discord-style', async () => {
  const cloud = fakeCloud({ outbound: [
    feedMsg(),
    feedMsg({ id: 'm2', authorSubject: 'agent:gemini', authorKind: 'agent', authorName: 'Gemini', displayName: undefined, body: 'answer here', createdAt: '2026-10-25T13:59:31.000Z' }),
  ] });
  const b = createBridge({ cloud: 'https://h', token: 't'.repeat(40), fetchImpl: cloud.fetchImpl, now: () => NOW });
  const posts = [];
  const sent = await b.pumpOutbound({ postMessage: async (p) => posts.push(p) });
  assert.equal(sent, 2);
  // Humans carry the " (Helmian)" suffix, agents their bare name — the
  // same authorship rule as the Discord bridge's webhook names, rendered
  // as a bold name line because Slack posts as the bot.
  assert.deepEqual(posts, [
    { channel: 'C0BN7LCK946', text: '**Troy (Helmian)**\nhello slack' },
    { channel: 'C0BN7LCK946', text: '**Gemini**\nanswer here' },
  ]);
  assert.equal(b.stats.outbound, 2);
});

test('Envoy -> Slack: rows resolve to their own linked channel; Discord rows are not ours', async () => {
  const cloud = fakeCloud({ outbound: [
    feedMsg({ id: 'd1', slackChannelId: undefined, discordChannelId: 'D123456789', body: 'for discord' }),
    feedMsg({ id: 'm9', slackChannelId: 'C555555555', body: 'other channel' }),
  ] });
  const b = createBridge({ cloud: 'https://h', token: 't'.repeat(40), fetchImpl: cloud.fetchImpl, now: () => NOW });
  const posts = [];
  assert.equal(await b.pumpOutbound({ postMessage: async (p) => posts.push(p) }), 1);
  assert.deepEqual(posts, [{ channel: 'C555555555', text: '**Troy (Helmian)**\nother channel' }]);
});

test('Envoy -> Slack: a Slack-born message is never posted back (origin exclusion)', async () => {
  const cloud = fakeCloud({ outbound: [
    feedMsg({ id: 's1', authorSubject: 'slack:U0ABC12345:Troy', source: 'slack', body: 'echo me' }),
    feedMsg({ id: 's2', authorSubject: 'slack:U0ABC12345:Troy', source: undefined, body: 'echo me too', createdAt: '2026-10-25T13:59:31.000Z' }),
  ] });
  const b = createBridge({ cloud: 'https://h', token: 't'.repeat(40), fetchImpl: cloud.fetchImpl, now: () => NOW });
  const posts = [];
  assert.equal(await b.pumpOutbound({ postMessage: async (p) => posts.push(p) }), 0);
  assert.equal(posts.length, 0);
  assert.equal(b.stats.outbound, 0);
});

test('Envoy -> Slack: the cursor advances and a repoll never reposts', async () => {
  const cloud = fakeCloud({ outbound: [feedMsg()] });
  const b = createBridge({ cloud: 'https://h', token: 't'.repeat(40), fetchImpl: cloud.fetchImpl, now: () => NOW });
  const posts = [];
  const postMessage = async (p) => posts.push(p);
  assert.equal(await b.pumpOutbound({ postMessage }), 1);
  assert.equal(await b.pumpOutbound({ postMessage }), 0);
  assert.equal(posts.length, 1);
  const sinceParams = cloud.calls.filter((c) => c.url.includes('/outbound')).map((c) => new URL(c.url).searchParams.get('since'));
  // First poll starts 60s back; after a 13:59:30 message the cursor sits
  // at newest-5s, so the overlap window is re-served but deduped.
  assert.deepEqual(sinceParams, ['2026-10-25T13:59:00.000Z', '2026-10-25T13:59:25.000Z']);
});

test('no bot token: named outbound is off, says so, and never calls out', async () => {
  assert.equal(outboundMode(true), 'named');
  assert.equal(outboundMode(false), 'webhook-only');
  const cloud = fakeCloud({ outbound: [feedMsg()] });
  const b = createBridge({ cloud: 'https://h', token: 't'.repeat(40), fetchImpl: cloud.fetchImpl, now: () => NOW });
  assert.deepEqual(await b.pumpOutbound(), { skipped: 'no_poster' });
  assert.deepEqual(await b.pumpOutbound({}), { skipped: 'no_poster' });
  assert.deepEqual(await b.pumpOutbound({ postMessage: null }), { skipped: 'no_poster' });
  assert.equal(cloud.calls.filter((c) => c.url.includes('/outbound')).length, 0);
  assert.equal(b.stats.outbound, 0);
});

test('outbound text: long bodies split under the cap, every part carrying the name line', async () => {
  const parts = outboundParts(feedMsg({ body: 'x'.repeat(5000) }));
  assert.equal(parts.length, 2);
  for (const p of parts) {
    assert.ok(p.length <= 3900, `part within cap (${p.length})`);
    assert.ok(p.startsWith('**Troy (Helmian)**\n'));
  }
  assert.equal(parts.map((p) => p.split('\n')[1]).join(''), 'x'.repeat(5000));
  assert.deepEqual(outboundParts(feedMsg({ body: '   ' })), []);
  assert.deepEqual(outboundParts(feedMsg({ body: 'short' })), ['**Troy (Helmian)**\nshort']);
});
