import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, splitForDiscord, webhookName, LINK_RE, inboundText } from '../bridge-core.mjs';

function fakeCloud() {
  const calls = [];
  const outbound = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization });
    const ok = (body) => ({ ok: true, status: 200, json: async () => ({ valid: true, ...body }) });
    if (url.includes('/bridge/links')) return ok({ links: [{ tenantId: 't1', envoyChannelId: 'e1', guildId: '111111', discordChannelId: '222222', agents: ['claude'] }] });
    if (url.includes('/bridge/confirm-link')) return JSON.parse(init.body).code === 'GOODCODE' ? ok({ envoyChannelId: 'e1', envoyChannelTitle: 'build', agents: ['claude'] }) : { ok: false, status: 404, json: async () => ({ valid: false, code: 'ENVOY_LINK_CODE_UNKNOWN' }) };
    if (url.includes('/bridge/inbound')) return ok({ receipt: { durable: true } });
    if (url.includes('/bridge/outbound')) return ok({ messages: outbound });
    if (url.startsWith('https://discord.com/api/v10/webhooks/')) return { ok: true, status: 200, json: async () => ({}) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { calls, outbound, fetchImpl };
}

test('helpers: split, webhook names, link command, attachments', () => {
  assert.deepEqual(splitForDiscord(''), []);
  const parts = splitForDiscord('word '.repeat(900));
  assert.ok(parts.length >= 3 && parts.every((p) => p.length <= 1900));
  assert.equal(webhookName({ authorKind: 'agent', authorName: 'Claude' }), 'Claude');
  assert.equal(webhookName({ authorKind: 'human', displayName: 'Troy' }), 'Troy (Helmian)');
  assert.ok(!/discord/i.test(webhookName({ authorKind: 'human', displayName: 'discord fan' })));
  assert.equal(LINK_RE.exec('helmian link AB3DEF7H')[1], 'AB3DEF7H');
  assert.equal(LINK_RE.exec('/helmian link ab3def7h')[1], 'ab3def7h');
  assert.equal(LINK_RE.exec('please helmian link AB3DEF7H now'), null);
  assert.equal(inboundText({ content: 'see', attachments: [{ url: 'https://cdn/x.png' }] }), 'see\nhttps://cdn/x.png');
});

test('Discord -> Envoy: linked human messages mirror; bots, webhooks and unlinked channels do not', async () => {
  const cloud = fakeCloud();
  const b = createBridge({ cloud: 'https://h', token: 't'.repeat(40), fetchImpl: cloud.fetchImpl, stateDir: await mkdtemp(join(tmpdir(), 'db-')) });
  await b.refreshLinks();
  const msg = (o) => ({ id: '900001', channelId: '222222', guildId: '111111', content: 'hello @claude', author: { id: '333333', username: 'troy', bot: false }, member: { displayName: 'Troy' }, ...o });
  assert.deepEqual(await b.onDiscordMessage(msg({}), { canManage: async () => false }), { mirrored: true });
  const inbound = cloud.calls.find((c) => c.url.includes('/inbound'));
  assert.equal(inbound.body.authorName, 'Troy');
  assert.equal(inbound.body.envoyChannelId, 'e1');
  assert.equal(inbound.auth, `Bearer ${'t'.repeat(40)}`);
  assert.equal((await b.onDiscordMessage(msg({ author: { id: '1', bot: true } }), { canManage: async () => true })).skipped, 'bot');
  assert.equal((await b.onDiscordMessage(msg({ webhookId: '5' }), { canManage: async () => true })).skipped, 'bot');
  assert.equal((await b.onDiscordMessage(msg({ channelId: '777777' }), { canManage: async () => true })).skipped, 'not_linked');
});

test('link command needs Manage Channels and a good code', async () => {
  const cloud = fakeCloud();
  const b = createBridge({ cloud: 'https://h', token: 't'.repeat(40), fetchImpl: cloud.fetchImpl, stateDir: await mkdtemp(join(tmpdir(), 'db-')) });
  const replies = [];
  const msg = (content) => ({ id: '900002', channelId: '555555', guildId: '111111', content, channel: { name: 'general' }, guild: { name: 'Helmian' }, author: { id: '333333', bot: false }, reply: async (t) => replies.push(t) });
  assert.equal((await b.onDiscordMessage(msg('helmian link GOODCODE'), { canManage: async () => false })).skipped, 'no_permission');
  assert.equal((await b.onDiscordMessage(msg('helmian link BADCDE22'), { canManage: async () => true })).error, 'ENVOY_LINK_CODE_UNKNOWN');
  assert.match(replies.at(-1), /wrong or expired/);
  assert.equal((await b.onDiscordMessage(msg('helmian link GOODCODE'), { canManage: async () => true })).linked, 'e1');
  assert.match(replies.at(-1), /Linked to Helmian Envoy #build/);
  assert.equal(cloud.calls.find((c) => c.url.includes('confirm-link') && c.body.code === 'GOODCODE').body.channelName, 'general');
});

test('Envoy -> Discord: posts each message once through the webhook, no pings', async () => {
  const cloud = fakeCloud();
  const b = createBridge({ cloud: 'https://h', token: 't'.repeat(40), fetchImpl: cloud.fetchImpl, stateDir: await mkdtemp(join(tmpdir(), 'db-')) });
  await b.load();
  const now = new Date().toISOString();
  cloud.outbound.push({ id: 'm1', discordChannelId: '222222', authorKind: 'agent', authorName: 'Claude', displayName: 'Claude', body: 'Claim: layout @everyone', createdAt: now });
  cloud.outbound.push({ id: 'm2', discordChannelId: '222222', authorKind: 'human', displayName: 'Troy', body: 'thanks', createdAt: now });
  const getWebhook = async () => ({ id: 'w1', token: 'wt' });
  assert.equal(await b.pumpOutbound({ getWebhook }), 2);
  assert.equal(await b.pumpOutbound({ getWebhook }), 0, 'already posted');
  const posts = cloud.calls.filter((c) => c.url.startsWith('https://discord.com/'));
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.username, 'Claude');
  assert.deepEqual(posts[0].body.allowed_mentions, { parse: [] });
  assert.equal(posts[1].body.username, 'Troy (Helmian)');
  assert.ok(b.state.since);
});
