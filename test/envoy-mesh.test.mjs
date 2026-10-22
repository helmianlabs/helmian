// Runs against a real Postgres when HELMIAN_TEST_PG_URL points at a scratch
// database with sql/001, 004 and 009 applied; skipped otherwise.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createEnvoyMesh, handleEnvoyMeshRoute, bridgeTokenOk } from '../src/cloud/envoy-mesh.mjs';
import { createEnvoyStore } from '../src/cloud/envoy-chat.mjs';

const url = process.env.HELMIAN_TEST_PG_URL;
const skip = !url && 'HELMIAN_TEST_PG_URL not set';

test('bridge token check: unset, wrong, right', () => {
  const req = (t) => ({ headers: { authorization: `Bearer ${t}` } });
  assert.equal(bridgeTokenOk(req('x'), ''), null);
  assert.equal(bridgeTokenOk(req('x'.repeat(40)), 'y'.repeat(40)), false);
  assert.equal(bridgeTokenOk(req('y'.repeat(40)), 'y'.repeat(40)), true);
});

test('route: bridge paths refuse without the token, unknown paths pass through', async () => {
  const sent = [];
  const send = (_r, status, body) => sent.push([status, JSON.parse(body)]);
  const mesh = {};
  const prev = process.env.HELMIAN_ENVOY_BRIDGE_TOKEN;
  process.env.HELMIAN_ENVOY_BRIDGE_TOKEN = 'z'.repeat(40);
  try {
    assert.equal(await handleEnvoyMeshRoute({ request: { method: 'GET', headers: {} }, response: {}, requestUrl: new URL('http://x/api/admin/envoy/channels'), send, mesh }), false);
    assert.equal(await handleEnvoyMeshRoute({ request: { method: 'GET', headers: { authorization: 'Bearer nope' } }, response: {}, requestUrl: new URL('http://x/api/admin/envoy/bridge/links'), send, mesh }), true);
    assert.equal(sent[0][0], 401);
  } finally { if (prev === undefined) delete process.env.HELMIAN_ENVOY_BRIDGE_TOKEN; else process.env.HELMIAN_ENVOY_BRIDGE_TOKEN = prev; }
});

test('mesh end to end on Postgres: agents join, work is routed once, Discord link mirrors both ways', { skip }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const tenantId = `t-${randomUUID().slice(0, 8)}`;
  const owner = { tenantId, subject: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`, role: 'owner', get sessionId() { return randomUUID(); }, get requestId() { return randomUUID(); } };
  const device = { tenantId, subject: owner.subject, role: 'owner', viaDeviceToken: true };
  await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantId, 'Mesh test']);
  await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantId, owner.subject, 'owner']);
  const published = [];
  const mesh = createEnvoyMesh({ pool, publishImpl: async (x) => published.push(x), nameLookup: async () => 'Troy' });
  const chat = createEnvoyStore(pool);
  try {
    const { channel } = await chat.createChannel(owner, { slug: 'build', title: 'build', kind: 'agent' });
    // Unconfigured channel.
    let cfg = await mesh.getConfig(owner, channel.id);
    assert.equal(cfg.configured, false);
    assert.deepEqual(cfg.config.agents, []);
    // A message sent before an agent joins is never picked up.
    await chat.appendMessage(owner, { channelId: channel.id, body: 'old message', idempotencyKey: randomUUID() });
    await new Promise((r) => setTimeout(r, 20));
    for (const provider of ['maestro', 'claude', 'gemini']) await mesh.changeConfig(owner, { action: 'add-agent', channelId: channel.id, provider });
    cfg = await mesh.getConfig(owner, channel.id);
    assert.deepEqual(cfg.config.agents.map((a) => a.provider), ['maestro', 'claude', 'gemini']);
    // Config rows are hidden from chat reads; join notices are visible.
    const listed = await chat.listMessages(owner, channel.id);
    assert.ok(listed.messages.every((m) => m.authorSubject !== 'system:envoy-config'));
    assert.ok(listed.messages.some((m) => m.body === 'Claude joined #build.' && m.authorName === 'Helmian'));
    await new Promise((r) => setTimeout(r, 20));
    const human = (await chat.appendMessage(owner, { channelId: channel.id, body: 'Plan the launch page', idempotencyKey: randomUUID() })).receipt.message;
    // Session callers cannot pull agent work or post as agents.
    await assert.rejects(mesh.agentWork(owner, 'claude'), /DEVICE_TOKEN/);
    let work = (await mesh.agentWork(device, 'maestro,claude,gemini')).work;
    assert.equal(work.length, 1);
    assert.equal(work[0].message.id, human.id);
    assert.deepEqual(work[0].agents, ['maestro']);
    assert.ok(work[0].context.some((m) => m.body === 'Plan the launch page'));
    const maestro = await mesh.postAsAgent(device, { channelId: channel.id, provider: 'maestro', replyTo: human.id, body: '@Claude: layout. @Gemini: copy.' });
    assert.equal(maestro.receipt.message.authorName, 'Maestro');
    const again = await mesh.postAsAgent(device, { channelId: channel.id, provider: 'maestro', replyTo: human.id, body: 'dup' });
    assert.equal(again.receipt.replayed, true);
    work = (await mesh.agentWork(device, 'maestro,claude,gemini')).work;
    assert.equal(work.length, 1, 'human message answered; Maestro dispatch is pending');
    assert.deepEqual(work[0].agents, ['claude', 'gemini']);
    await mesh.postAsAgent(device, { channelId: channel.id, provider: 'claude', replyTo: work[0].message.id, body: 'Claim: layout.' });
    work = (await mesh.agentWork(device, 'claude,gemini')).work;
    assert.deepEqual(work.map((w) => w.agents), [['gemini']]);
    await assert.rejects(mesh.postAsAgent(device, { channelId: channel.id, provider: 'grok', replyTo: human.id, body: 'x' }), /NOT_MEMBER/);

    // Discord link: start, confirm from the bridge, inbound, outbound.
    const start = await mesh.changeConfig(owner, { action: 'link-discord', channelId: channel.id });
    assert.match(start.linkCode, /^[A-Z2-9]{8}$/);
    assert.ok(start.config.pendingLink);
    await assert.rejects(mesh.bridgeConfirmLink({ code: 'ZZZZZZZZ', guildId: '111111', channelId: '222222' }), /UNKNOWN/);
    const linked = await mesh.bridgeConfirmLink({ code: start.linkCode, guildId: '111111', channelId: '222222', channelName: 'general', guildName: 'Helmian' });
    assert.equal(linked.envoyChannelId, channel.id);
    await assert.rejects(mesh.bridgeConfirmLink({ code: start.linkCode, guildId: '111111', channelId: '222222' }), /UNKNOWN/, 'code is single use');
    const links = (await mesh.bridgeLinks()).links.filter((l) => l.tenantId === tenantId);
    assert.deepEqual(links.map((l) => l.discordChannelId), ['222222']);
    const since = new Date(Date.now() - 60_000).toISOString();
    const inbound = await mesh.bridgeInbound({ tenantId, envoyChannelId: channel.id, discordChannelId: '222222', discordMessageId: '999999', authorId: '333333', authorName: 'Paul', body: '@gemini what about pricing?' });
    assert.equal(inbound.receipt.message.authorName, 'Paul');
    assert.equal(inbound.receipt.message.source, 'discord');
    assert.equal((await mesh.bridgeInbound({ tenantId, envoyChannelId: channel.id, discordChannelId: '222222', discordMessageId: '999999', authorId: '333333', authorName: 'Paul', body: 'x' })).receipt.replayed, true);
    await assert.rejects(mesh.bridgeInbound({ tenantId, envoyChannelId: channel.id, discordChannelId: '444444', discordMessageId: '999998', authorId: '333333', authorName: 'Paul', body: 'x' }), /NOT_LINKED/);
    // Discord humans trigger agents too.
    work = (await mesh.agentWork(device, 'gemini')).work;
    assert.ok(work.some((w) => w.message.id === inbound.receipt.message.id && w.agents.includes('gemini')));
    const outbound = (await mesh.bridgeOutbound(since)).messages.filter((m) => m.tenantId === tenantId);
    assert.ok(outbound.length >= 3);
    assert.ok(outbound.every((m) => m.source !== 'discord'), 'Discord-born messages are not echoed back');
    assert.ok(outbound.some((m) => m.displayName === 'Maestro'));
    assert.ok(outbound.some((m) => m.displayName === 'Troy' && m.authorKind === 'human'));
    // Unlink.
    await mesh.changeConfig(owner, { action: 'unlink-discord', channelId: channel.id });
    assert.equal((await mesh.bridgeLinks()).links.filter((l) => l.tenantId === tenantId).length, 0);
    // Members cannot link Discord.
    await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantId, 'user_member000000001', 'member']);
    await assert.rejects(mesh.changeConfig({ tenantId, subject: 'user_member000000001', role: 'member' }, { action: 'link-discord', channelId: channel.id }), /ADMIN_REQUIRED/);
    // Other tenants cannot read this channel's config.
    const other = `t-${randomUUID().slice(0, 8)}`;
    await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [other, 'Other']);
    await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [other, 'user_other0000000001', 'owner']);
    await assert.rejects(mesh.getConfig({ tenantId: other, subject: 'user_other0000000001', role: 'owner' }, channel.id), /NOT_FOUND/);
    assert.ok(published.length > 0);
  } finally {
    await pool.query("delete from helmion.audit_events where tenant_id like 't-%'").catch(() => {});
    await pool.query("delete from helmion.tenants where tenant_id like 't-%'").catch(() => {});
    await pool.end();
  }
});
