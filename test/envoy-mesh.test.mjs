// Runs against a real Postgres when HELMIAN_TEST_PG_URL points at a scratch
// database with sql/001, 004 and 009 applied; skipped otherwise.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createEnvoyMesh, handleEnvoyMeshRoute, bridgeTokenOk, stampAgentAnswered, resolveDispatchSkills } from '../src/cloud/envoy-mesh.mjs';
import { createRunnerPresenceStore } from '../src/cloud/runner-presence.mjs';
import { createEnvoyStore } from '../src/cloud/envoy-chat.mjs';
import { emptyConfig, serializeConfig } from '../src/cloud/envoy-agents.mjs';

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
    // An ordinary shared channel (kind 'team'): the Bite 2 routing
    // matrix applies here. (This test used kind 'agent' before rooms
    // gave that kind its one-agent meaning.)
    const { channel } = await chat.createChannel(owner, { slug: 'build', title: 'build', kind: 'team' });
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
    // Bite 2 matrix, ordinary channel: the unnamed message earns NO
    // agent turn — not even with 'maestro' on the roster and asking.
    let work = (await mesh.agentWork(device, 'maestro,claude,gemini')).work.filter((w) => w.channel.id === channel.id);
    assert.equal(work.length, 0, 'unnamed message in an ordinary channel is silence');
    // A named agent answers.
    const named = (await chat.appendMessage(owner, { channelId: channel.id, body: '@Claude plan the launch page', idempotencyKey: randomUUID() })).receipt.message;
    work = (await mesh.agentWork(device, 'maestro,claude,gemini')).work.filter((w) => w.channel.id === channel.id);
    assert.equal(work.length, 1);
    assert.equal(work[0].message.id, named.id);
    assert.deepEqual(work[0].agents, ['claude'], "'maestro' is never among the answerers");
    assert.ok(work[0].context.some((m) => m.body === 'Plan the launch page'));
    // No reply is ever authored by Maestro, even where a roster still
    // lists it: the post is refused outright.
    await assert.rejects(mesh.postAsAgent(device, { channelId: channel.id, provider: 'maestro', replyTo: named.id, body: '@Claude: layout. @Gemini: copy.' }), /NOT_AN_AGENT/);
    // An agent's own post dispatches nobody (no Maestro hop, no relay).
    await mesh.postAsAgent(device, { channelId: channel.id, provider: 'claude', replyTo: named.id, body: 'Claim: layout. @Gemini: copy is yours.' });
    work = (await mesh.agentWork(device, 'maestro,claude,gemini')).work.filter((w) => w.channel.id === channel.id);
    assert.equal(work.length, 0, 'the named message is answered and the agent post routes nobody');
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
    assert.ok(outbound.some((m) => m.displayName === 'Claude'), 'the agent reply rides outbound under its own name');
    assert.ok(!outbound.some((m) => m.displayName === 'Maestro'), 'nothing rides outbound under the Maestro name');
    assert.ok(outbound.some((m) => m.displayName === 'Troy' && m.authorKind === 'human'));
    // Unlink.
    await mesh.changeConfig(owner, { action: 'unlink-discord', channelId: channel.id });
    assert.equal((await mesh.bridgeLinks()).links.filter((l) => l.tenantId === tenantId).length, 0);
    // Members cannot link Discord.
    await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantId, 'user_member000000001', 'member']);
    await assert.rejects(mesh.changeConfig({ tenantId, subject: 'user_member000000001', role: 'member' }, { action: 'link-discord', channelId: channel.id }), /ADMIN_REQUIRED/);

    // Slack link: start, confirm from the bridge, inbound with the badge, outbound.
    const sStart = await mesh.changeConfig(owner, { action: 'link-slack', channelId: channel.id });
    assert.match(sStart.linkCode, /^[A-Z2-9]{8}$/);
    await assert.rejects(mesh.bridgeConfirmLink({ provider: 'slack', code: 'ZZZZZZZZ', teamId: 'T0BP40EFJ1W', channelId: 'C0BN7LCK946' }), /UNKNOWN/);
    await assert.rejects(mesh.bridgeConfirmLink({ provider: 'slack', code: sStart.linkCode, teamId: 'nope', channelId: 'C0BN7LCK946' }), /SLACK_IDS_INVALID/);
    const sLinked = await mesh.bridgeConfirmLink({ provider: 'slack', code: sStart.linkCode, teamId: 'T0BP40EFJ1W', channelId: 'C0BN7LCK946', channelName: 'all-helmian', teamName: 'HELMIAN' });
    assert.equal(sLinked.envoyChannelId, channel.id);
    await assert.rejects(mesh.bridgeConfirmLink({ provider: 'slack', code: sStart.linkCode, teamId: 'T0BP40EFJ1W', channelId: 'C0BN7LCK946' }), /UNKNOWN/, 'code is single use');
    const sLinks = (await mesh.bridgeLinks()).slackLinks.filter((l) => l.tenantId === tenantId);
    assert.deepEqual(sLinks.map((l) => l.slackChannelId), ['C0BN7LCK946']);
    assert.equal(sLinks[0].teamId, 'T0BP40EFJ1W');
    const sInbound = await mesh.bridgeInbound({ provider: 'slack', tenantId, envoyChannelId: channel.id, slackChannelId: 'C0BN7LCK946', slackMessageId: '1729900000.000100', authorId: 'U0ABC12345', authorName: 'Paul', body: '@gemini what about pricing?' });
    assert.equal(sInbound.receipt.message.authorName, 'Paul');
    assert.equal(sInbound.receipt.message.source, 'slack');
    assert.equal(sInbound.receipt.message.metadata.source.provider, 'slack');
    assert.equal(sInbound.receipt.message.metadata.source.channelName, 'all-helmian');
    assert.equal((await mesh.bridgeInbound({ provider: 'slack', tenantId, envoyChannelId: channel.id, slackChannelId: 'C0BN7LCK946', slackMessageId: '1729900000.000100', authorId: 'U0ABC12345', authorName: 'Paul', body: 'x' })).receipt.replayed, true, 'Slack redelivery replays, never dupes');
    await assert.rejects(mesh.bridgeInbound({ provider: 'slack', tenantId, envoyChannelId: channel.id, slackChannelId: 'C999999999', slackMessageId: '1729900001.000200', authorId: 'U0ABC12345', authorName: 'Paul', body: 'x' }), /SLACK_CHANNEL_NOT_LINKED/);
    await assert.rejects(mesh.bridgeInbound({ provider: 'slack', tenantId, envoyChannelId: channel.id, slackChannelId: 'C0BN7LCK946', slackMessageId: '999999', authorId: 'U0ABC12345', authorName: 'Paul', body: 'x' }), /SLACK_MESSAGE_ID_INVALID/);
    // Slack humans trigger agents too.
    work = (await mesh.agentWork(device, 'gemini')).work;
    assert.ok(work.some((w) => w.message.id === sInbound.receipt.message.id && w.agents.includes('gemini')));
    assert.ok(work.find((w) => w.message.id === sInbound.receipt.message.id).channel.linkedToSlack);
    const sOutbound = (await mesh.bridgeOutbound(since)).messages.filter((m) => m.tenantId === tenantId && m.slackChannelId === 'C0BN7LCK946');
    assert.ok(sOutbound.length >= 1);
    assert.ok(sOutbound.every((m) => m.source !== 'slack'), 'Slack-born messages are not echoed back');
    assert.ok(!sOutbound.some((m) => m.id === sInbound.receipt.message.id));
    // Unlink.
    await mesh.changeConfig(owner, { action: 'unlink-slack', channelId: channel.id });
    assert.equal((await mesh.bridgeLinks()).slackLinks.filter((l) => l.tenantId === tenantId).length, 0);
    // Members cannot link Slack.
    await assert.rejects(mesh.changeConfig({ tenantId, subject: 'user_member000000001', role: 'member' }, { action: 'link-slack', channelId: channel.id }), /ADMIN_REQUIRED/);
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

test('maestro always-on wiring: agentWork dispatches desk-style unconditionally, and the retired follow action is gone', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/cloud/envoy-mesh.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('desk: true,'), 'agentWork passes the desk switch unconditionally — every channel dispatches');
  assert.ok(!src.includes('config.maestroFollow'), 'routing never consults the stored maestroFollow flag, so a stored false cannot restore silence');
  assert.ok(!src.includes("action === 'set-maestro-follow'"), 'the set-maestro-follow config action is removed');
  assert.ok(!src.includes('Maestro now follows you'), 'no follow notice remains to post');
  assert.ok(!src.includes('Maestro no longer follows you'), 'no unfollow notice remains to post');
});

test('messageOut carries stored attachments metadata to the bridge work queue', async () => {
  const { messageOut } = await import('../src/cloud/envoy-mesh.mjs');
  const row = { id: 'm1', channel_id: 'c1', author_subject: 'user-1', author_kind: 'human', body: 'hi', idempotency_key: 'k-00000001', created_at: 'now', metadata: { attachments: [{ kind: 'plugin', name: 'calcplug' }] } };
  assert.deepEqual(messageOut(row).metadata, { attachments: [{ kind: 'plugin', name: 'calcplug' }] });
  const bare = { ...row, metadata: null };
  assert.equal('metadata' in messageOut(bare), false);
});

test('mesh rooms: an agent room seats exactly its agent and routes its own work', { skip }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const tenantId = `t-${randomUUID()}`;
  const owner = { tenantId, subject: 'user:owner', role: 'owner' };
  const device = { tenantId, subject: 'user:owner', role: 'owner', viaDeviceToken: true };
  const chat = createEnvoyStore(pool);
  const mesh = createEnvoyMesh({ pool });
  try {
    await pool.query('insert into helmion.tenants (tenant_id, owner_subject) values ($1,$2)', [tenantId, owner.subject]);
    const { channel } = await chat.createChannel(owner, { slug: 'agent-claude', title: 'Claude', kind: 'agent' });
    assert.equal(channel.kind, 'agent');

    const seeded = await mesh.seedRoomAgent(owner, channel.id, 'claude');
    assert.deepEqual(seeded, { seeded: true, configured: true });
    const again = await mesh.seedRoomAgent(owner, channel.id, 'claude');
    assert.equal(again.seeded, false, 'seeding never rewrites an existing roster');
    const other = await mesh.seedRoomAgent(owner, channel.id, 'gemini');
    assert.equal(other.seeded, false, 'a second agent cannot take over the room');
    const cfg = await mesh.getConfig(owner, channel.id);
    assert.deepEqual(cfg.config.agents.map((a) => a.provider), ['claude'], 'the room seats exactly its agent');

    const { channel: team } = await chat.createChannel(owner, { slug: 'team-x', title: 'Team X', kind: 'team' });
    await assert.rejects(mesh.seedRoomAgent(owner, team.id, 'claude'), /ENVOY_ROOM_KIND_INVALID/, 'a shared channel is not a room');

    const human = (await chat.appendMessage(owner, { channelId: channel.id, body: 'just between us', idempotencyKey: randomUUID() })).receipt.message;
    let work = (await mesh.agentWork(device, 'claude,gemini')).work.filter((w) => w.channel.id === channel.id);
    assert.equal(work.length, 1, 'a prompt in the room is work for the room agent');
    assert.deepEqual(work[0].agents, ['claude'], 'unaddressed room work routes to the room agent alone');
    await mesh.postAsAgent(device, { channelId: channel.id, provider: 'claude', replyTo: human.id, body: 'Claim: on it.' });
    await assert.rejects(
      mesh.postAsAgent(device, { channelId: channel.id, provider: 'gemini', replyTo: human.id, body: 'me too' }),
      /NOT_MEMBER/, 'another agent cannot post in the room');
    work = (await mesh.agentWork(device, 'claude')).work.filter((w) => w.channel.id === channel.id);
    assert.equal(work.length, 0, 'answered room work clears');
  } finally {
    await pool.query('delete from helmion.tenants where tenant_id = $1', [tenantId]).catch(() => {});
    await pool.end();
  }
});

test('mesh desk: the seat seeds its roster once, refuses other channels, and dispatches sends', { skip }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const tenantId = `t-${randomUUID()}`;
  const owner = { tenantId, subject: 'user:owner', role: 'owner' };
  const device = { tenantId, subject: 'user:owner', role: 'owner', viaDeviceToken: true };
  const chat = createEnvoyStore(pool);
  const mesh = createEnvoyMesh({ pool });
  try {
    await pool.query('insert into helmion.tenants (tenant_id, owner_subject) values ($1,$2)', [tenantId, owner.subject]);
    // A shared channel seats Claude, Maestro and Gemini.
    const { channel: build } = await chat.createChannel(owner, { slug: 'build', title: 'Build', kind: 'team' });
    await mesh.changeConfig(owner, { action: 'add-agent', channelId: build.id, provider: 'claude' });
    await mesh.changeConfig(owner, { action: 'add-agent', channelId: build.id, provider: 'maestro' });
    await mesh.changeConfig(owner, { action: 'add-agent', channelId: build.id, provider: 'gemini' });

    const { channel: desk } = await chat.createChannel(owner, { slug: 'maestro-desk', title: 'Maestro', kind: 'team' });
    const seeded = await mesh.seedDesk(owner, desk.id);
    assert.equal(seeded.seeded, true);
    assert.deepEqual(seeded.agents, ['claude', 'gemini'], 'the desk roster is the tenant union, and Maestro is never on it');
    const again = await mesh.seedDesk(owner, desk.id);
    assert.equal(again.seeded, false, 'seeding never rewrites an existing desk config');
    assert.deepEqual(again.agents, ['claude', 'gemini']);
    await assert.rejects(mesh.seedDesk(owner, build.id), /ENVOY_DESK_INVALID/, 'only the reserved channel can be a desk');
    const cfg = await mesh.getConfig(owner, desk.id);
    assert.equal(cfg.config.desk, true, 'the stored config carries the desk flag the routing reads');
    assert.deepEqual(cfg.config.agents.map((a) => a.provider), ['claude', 'gemini']);

    // An unnamed send in the desk is a dispatch to everyone on it.
    const all = (await chat.appendMessage(owner, { channelId: desk.id, body: 'status, everyone', idempotencyKey: randomUUID() })).receipt.message;
    let work = (await mesh.agentWork(device, 'maestro,claude,gemini,grok')).work.filter((w) => w.channel.id === desk.id);
    assert.equal(work.length, 1);
    assert.deepEqual(work[0].agents, ['claude', 'gemini'], 'unnamed dispatch reaches the whole desk, never Maestro');
    // A named send dispatches to that agent alone.
    const one = (await chat.appendMessage(owner, { channelId: desk.id, body: '@claude the numbers please', idempotencyKey: randomUUID() })).receipt.message;
    work = (await mesh.agentWork(device, 'claude,gemini')).work.filter((w) => w.channel.id === desk.id && w.message.id === one.id);
    assert.equal(work.length, 1);
    assert.deepEqual(work[0].agents, ['claude']);
    // The reply lands in the desk under the agent's own name and clears its work.
    const receipt = await mesh.postAsAgent(device, { channelId: desk.id, provider: 'claude', replyTo: one.id, body: 'Claim: the numbers.' });
    assert.equal(receipt.receipt.message.authorName, 'Claude');
    assert.equal(receipt.receipt.message.agentProvider, 'claude');
    work = (await mesh.agentWork(device, 'claude,gemini')).work.filter((w) => w.channel.id === desk.id && w.message.id === one.id);
    assert.equal(work.length, 0, 'answered desk work clears');
    // The unnamed dispatch is still waiting on Gemini alone.
    work = (await mesh.agentWork(device, 'claude,gemini')).work.filter((w) => w.channel.id === desk.id && w.message.id === all.id);
    assert.equal(work.length, 1);
    assert.deepEqual(work[0].agents, ['gemini']);
  } finally {
    await pool.query('delete from helmion.tenants where tenant_id = $1', [tenantId]).catch(() => {});
    await pool.end();
  }
});

test('mesh maestro always-on: unnamed sends dispatch with no flag set, and the retired action is unsupported', { skip }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const tenantId = `t-${randomUUID()}`;
  const owner = { tenantId, subject: 'user:owner', role: 'owner' };
  const device = { tenantId, subject: 'user:owner', role: 'owner', viaDeviceToken: true };
  const chat = createEnvoyStore(pool);
  const mesh = createEnvoyMesh({ pool });
  try {
    await pool.query('insert into helmion.tenants (tenant_id, owner_subject) values ($1,$2)', [tenantId, owner.subject]);
    const { channel } = await chat.createChannel(owner, { slug: 'follow', title: 'Follow', kind: 'team' });
    await mesh.changeConfig(owner, { action: 'add-agent', channelId: channel.id, provider: 'claude' });
    await mesh.changeConfig(owner, { action: 'add-agent', channelId: channel.id, provider: 'gemini' });

    // No flag is ever set on this channel — its stored config parses
    // with the legacy maestroFollow field false — and still an
    // unnamed human send dispatches desk-style to the whole crew:
    // a stored false does not restore the old silence.
    const cfg = await mesh.getConfig(owner, channel.id);
    assert.equal(cfg.config.maestroFollow, false, 'the legacy field still parses false — and routing ignores it');
    const all = (await chat.appendMessage(owner, { channelId: channel.id, body: 'status, everyone', idempotencyKey: randomUUID() })).receipt.message;
    let work = (await mesh.agentWork(device, 'claude,gemini')).work.filter((w) => w.channel.id === channel.id && w.message.id === all.id);
    assert.equal(work.length, 1);
    assert.deepEqual(work[0].agents, ['claude', 'gemini'], 'unnamed send reaches the whole crew — Maestro is always on');
    const one = (await chat.appendMessage(owner, { channelId: channel.id, body: '@claude the numbers please', idempotencyKey: randomUUID() })).receipt.message;
    work = (await mesh.agentWork(device, 'claude,gemini')).work.filter((w) => w.channel.id === channel.id && w.message.id === one.id);
    assert.equal(work.length, 1);
    assert.deepEqual(work[0].agents, ['claude'], 'a named send still picks the named seat alone');

    // The retired switch action is gone: even the owner gets the
    // unsupported-action refusal, and no follow/unfollow notice ever
    // posts in the channel.
    await assert.rejects(
      mesh.changeConfig(owner, { action: 'set-maestro-follow', channelId: channel.id, maestroFollow: false }),
      /ENVOY_CONFIG_ACTION_UNSUPPORTED/,
    );
    const listed = await chat.listMessages(owner, channel.id);
    assert.ok(!listed.messages.some((m) => m.body.includes('Maestro now follows you') || m.body.includes('Maestro no longer follows you')), 'no follow notices post — there is no switch event to announce');
  } finally {
    await pool.query('delete from helmion.tenants where tenant_id = $1', [tenantId]).catch(() => {});
    await pool.end();
  }
});

// ---------- last answered (honest-connection fix, 2026-11-01) ----------
// postAsAgent calls stampAgentAnswered after a fresh reply commits: the
// provider's presence row gains its answer time. The stamp is
// update-only — an answer never creates a presence row — and
// best-effort: nothing about the reply path may fail because of it.
function makePresenceFakePool() {
  const rows = new Map(); // provider -> { connected, updated_at, last_answered_at }
  const client = {
    query: async (sql, params = []) => {
      const text = String(sql);
      if (text.includes('set_config')) return { rows: [] };
      if (text.startsWith('select provider_name')) {
        return { rows: [...rows.entries()].map(([provider_name, v]) => ({ provider_name, ...v })) };
      }
      if (text.includes('insert into helmion.runner_provider_presence')) {
        const prev = rows.get(params[0]) ?? { connected: false, updated_at: null, last_answered_at: null };
        const next = { ...prev, updated_at: new Date() };
        if (text.includes('connected = excluded.connected')) next.connected = params[1] === true;
        rows.set(params[0], next);
        return { rowCount: 1 };
      }
      if (text.includes('update helmion.runner_provider_presence')) {
        const row = rows.get(params[0]);
        if (!row) return { rows: [], rowCount: 0 };
        row.last_answered_at = new Date();
        return { rows: [], rowCount: 1 };
      }
      if (text === 'begin' || text === 'commit' || text === 'rollback') return {};
      throw new Error(`unexpected query: ${text}`);
    },
    release: () => {},
  };
  return {
    connect: async () => client,
    query: async (sql) => (String(sql).includes('last_answered_at') ? { rows: [] } : client.query(sql)),
    _rows: rows,
  };
}

test('stampAgentAnswered stamps an existing presence row and never creates one', async () => {
  const pool = makePresenceFakePool();
  const store = createRunnerPresenceStore(pool);
  assert.equal(await stampAgentAnswered(pool, 'tenant-mesh', 'gemini'), false, 'no row yet — nothing to stamp');
  assert.deepEqual(await store.list('tenant-mesh'), [], 'the failed stamp created no row');
  await store.report('tenant-mesh', 'gemini', true);
  assert.equal(await stampAgentAnswered(pool, 'tenant-mesh', 'gemini'), true);
  const rows = await store.list('tenant-mesh');
  assert.equal(rows.length, 1);
  assert.ok(rows[0].lastAnsweredAt instanceof Date, 'the answer time is on the row the cards read');
  // Best-effort contract: bad inputs resolve false, never throw.
  assert.equal(await stampAgentAnswered(null, 'tenant-mesh', 'gemini'), false);
  assert.equal(await stampAgentAnswered(pool, 'tenant-mesh', 'not-a-provider'), false);
  assert.equal(await stampAgentAnswered(pool, 'tenant-mesh', null), false);
});

test('mesh on Postgres: set-channel-avatar stores the channel face on its config', { skip }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const tenantId = `t-${randomUUID().slice(0, 8)}`;
  const owner = { tenantId, subject: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`, role: 'owner', get sessionId() { return randomUUID(); }, get requestId() { return randomUUID(); } };
  const memberActor = { tenantId, subject: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`, role: 'member', get sessionId() { return randomUUID(); }, get requestId() { return randomUUID(); } };
  const auditorActor = { tenantId, subject: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`, role: 'auditor', get sessionId() { return randomUUID(); }, get requestId() { return randomUUID(); } };
  await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantId, 'Mesh avatar test']);
  for (const [actor, role] of [[owner, 'owner'], [memberActor, 'member'], [auditorActor, 'auditor']]) {
    await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantId, actor.subject, role]);
  }
  const mesh = createEnvoyMesh({ pool, publishImpl: async () => {}, nameLookup: async () => 'Troy' });
  const chat = createEnvoyStore(pool);
  try {
    const { channel } = await chat.createChannel(owner, { slug: 'look', title: 'look', kind: 'team' });
    let cfg = await mesh.getConfig(owner, channel.id);
    assert.equal(cfg.config.avatar, null, 'a new channel has no face yet');
    // Any non-auditor member may set it; the config answer carries it.
    const set = await mesh.changeConfig(memberActor, { action: 'set-channel-avatar', channelId: channel.id, avatar: { k: 'char', id: 'fox' } });
    assert.deepEqual(set.config.avatar, { k: 'char', id: 'fox' });
    // The channel list payload carries it too (the desk renders from it).
    const listed = await chat.listChannels(owner);
    assert.deepEqual(listed.channels.find((c) => c.id === channel.id)?.avatar, { k: 'char', id: 'fox' });
    // A junk choice sanitizes to none; an auditor may not write at all.
    const junk = await mesh.changeConfig(owner, { action: 'set-channel-avatar', channelId: channel.id, avatar: { k: 'char', id: 'dragon' } });
    assert.equal(junk.config.avatar, null);
    await assert.rejects(
      mesh.changeConfig(auditorActor, { action: 'set-channel-avatar', channelId: channel.id, avatar: { k: 'char', id: 'fox' } }),
      /ENVOY_ROLE_FORBIDDEN/,
    );
    cfg = await mesh.getConfig(owner, channel.id);
    assert.equal(cfg.config.avatar, null, 'the refused write changed nothing');
  } finally {
    await pool.query('delete from helmion.tenants where tenant_id=$1', [tenantId]).catch(() => {});
    await pool.end();
  }
});

test('mesh on Postgres: set-armed-connectors stores the channel standing set on its config (bite A2)', { skip }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const tenantId = `t-${randomUUID().slice(0, 8)}`;
  const owner = { tenantId, subject: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`, role: 'owner', get sessionId() { return randomUUID(); }, get requestId() { return randomUUID(); } };
  const memberActor = { tenantId, subject: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`, role: 'member', get sessionId() { return randomUUID(); }, get requestId() { return randomUUID(); } };
  const auditorActor = { tenantId, subject: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`, role: 'auditor', get sessionId() { return randomUUID(); }, get requestId() { return randomUUID(); } };
  await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantId, 'Mesh armed-set test']);
  for (const [actor, role] of [[owner, 'owner'], [memberActor, 'member'], [auditorActor, 'auditor']]) {
    await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantId, actor.subject, role]);
  }
  const mesh = createEnvoyMesh({ pool, publishImpl: async () => {}, nameLookup: async () => 'Troy' });
  const chat = createEnvoyStore(pool);
  try {
    const { channel } = await chat.createChannel(owner, { slug: 'armed', title: 'armed', kind: 'team' });
    let cfg = await mesh.getConfig(owner, channel.id);
    assert.deepEqual(cfg.config.armedConnectors, [], 'a new channel has nothing armed');
    // Any non-auditor member may set it; the config answer carries it.
    const set = await mesh.changeConfig(memberActor, { action: 'set-armed-connectors', channelId: channel.id, armedConnectors: [{ seatId: 'claude', entryId: 'helmian-github' }] });
    assert.deepEqual(set.config.armedConnectors, [{ seatId: 'claude', entryId: 'helmian-github' }]);
    // Junk pairs sanitize away per-entry; a non-array refuses.
    const dirty = await mesh.changeConfig(owner, { action: 'set-armed-connectors', channelId: channel.id, armedConnectors: [{ seatId: 'Bad Seat', entryId: 'x' }, { seatId: 'grok', entryId: 'helmian-github' }, { seatId: 'grok', entryId: 'helmian-github' }] });
    assert.deepEqual(dirty.config.armedConnectors, [{ seatId: 'grok', entryId: 'helmian-github' }]);
    await assert.rejects(
      mesh.changeConfig(owner, { action: 'set-armed-connectors', channelId: channel.id, armedConnectors: 'github' }),
      /ENVOY_ARMED_CONNECTORS_INVALID/,
    );
    // An auditor may not write at all, and the refused write changed nothing.
    await assert.rejects(
      mesh.changeConfig(auditorActor, { action: 'set-armed-connectors', channelId: channel.id, armedConnectors: [] }),
      /ENVOY_ROLE_FORBIDDEN/,
    );
    cfg = await mesh.getConfig(owner, channel.id);
    assert.deepEqual(cfg.config.armedConnectors, [{ seatId: 'grok', entryId: 'helmian-github' }]);
    // Clearing is a write of the empty set.
    const cleared = await mesh.changeConfig(owner, { action: 'set-armed-connectors', channelId: channel.id, armedConnectors: [] });
    assert.deepEqual(cleared.config.armedConnectors, []);
  } finally {
    await pool.query('delete from helmion.tenants where tenant_id=$1', [tenantId]).catch(() => {});
    await pool.end();
  }
});

// ---------- Helmian skills at dispatch (slash-skills bite S1) ----------
// resolveDispatchSkills is the pure half of the dispatch resolution:
// message toggles × store records × the due seats → the work item's
// skill entries, clamped to each record's own scope. The end-to-end
// half rides the Postgres suite below.

const skillRecord = (over = {}) => ({
  id: 'deep-research', name: 'Deep Research', body: 'Check three sources.',
  scope: 'blanket', seatIds: [], state: 'available', ...over,
});
const recordsOf = (...records) => new Map(records.map((r) => [r.id, r]));

test('dispatch skills: a blanket record takes the message target, for due seats only', () => {
  const records = recordsOf(skillRecord());
  assert.deepEqual(
    resolveDispatchSkills([{ skillId: 'deep-research', seatId: 'all' }], records, ['claude', 'gemini']),
    [{ id: 'deep-research', name: 'Deep Research', body: 'Check three sources.', seatId: 'all' }],
  );
  assert.deepEqual(
    resolveDispatchSkills([{ skillId: 'deep-research', seatId: 'claude' }], records, ['claude']),
    [{ id: 'deep-research', name: 'Deep Research', body: 'Check three sources.', seatId: 'claude' }],
    'a blanket skill can be narrowed to one seat for one message',
  );
  assert.deepEqual(
    resolveDispatchSkills([{ skillId: 'deep-research', seatId: 'grok' }], records, ['claude']),
    [],
    'a target that is not due does not ride the work item',
  );
  assert.deepEqual(
    resolveDispatchSkills([{ skillId: 'deep-research', seatId: 'all' }], records, []),
    [],
    "'all' rides only when someone is due — and Maestro is never due",
  );
});

test('dispatch skills: a seat-scoped record clamps the message, never the other way', () => {
  const records = recordsOf(skillRecord({ id: 'wash-check', scope: 'seats', seatIds: ['claude', 'grok'] }));
  assert.deepEqual(
    resolveDispatchSkills([{ skillId: 'wash-check', seatId: 'all' }], records, ['claude', 'gemini']),
    [{ id: 'wash-check', name: 'Deep Research', body: 'Check three sources.', seatId: 'claude' }],
    "'all' becomes the record's own seats, intersected with who is due",
  );
  assert.deepEqual(
    resolveDispatchSkills([{ skillId: 'wash-check', seatId: 'grok' }], records, ['grok']),
    [{ id: 'wash-check', name: 'Deep Research', body: 'Check three sources.', seatId: 'grok' }],
  );
  assert.deepEqual(
    resolveDispatchSkills([{ skillId: 'wash-check', seatId: 'gemini' }], records, ['gemini']),
    [],
    'a message cannot retarget a seat-scoped skill to a seat outside its record',
  );
});

test('dispatch skills: missing and disabled records ride as missing, for their targets among the due', () => {
  const empty = new Map();
  assert.deepEqual(
    resolveDispatchSkills([{ skillId: 'gone', seatId: 'all' }], empty, ['claude']),
    [{ id: 'gone', missing: true, seatId: 'all' }],
  );
  assert.deepEqual(
    resolveDispatchSkills([{ skillId: 'gone', seatId: 'claude' }], empty, ['claude']),
    [{ id: 'gone', missing: true, seatId: 'claude' }],
  );
  assert.deepEqual(
    resolveDispatchSkills([{ skillId: 'gone', seatId: 'grok' }], empty, ['claude']),
    [],
    'a missing skill for a seat that is not due is not this item’s business',
  );
  const disabled = recordsOf(skillRecord({ id: 'paused', state: 'disabled-by-owner' }));
  assert.deepEqual(
    resolveDispatchSkills([{ skillId: 'paused', seatId: 'all' }], disabled, ['claude']),
    [{ id: 'paused', missing: true, seatId: 'all' }],
    'an owner-disabled skill is not available to the turn, and the turn is told, not left silent',
  );
});

test('mesh on Postgres: agentWork rides resolved skills; a failed read changes nothing', { skip }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const tenantId = `t-${randomUUID()}`;
  const owner = { tenantId, subject: 'user:owner', role: 'owner' };
  const device = { tenantId, subject: 'user:owner', role: 'owner', viaDeviceToken: true };
  const chat = createEnvoyStore(pool);
  const canned = new Map([
    ['blanket-skill', { id: 'blanket-skill', name: 'Blanket', body: 'For everyone.', scope: 'blanket', seatIds: [], state: 'available' }],
    ['seated-skill', { id: 'seated-skill', name: 'Seated', body: 'For Claude only.', scope: 'seats', seatIds: ['claude'], state: 'available' }],
  ]);
  const mesh = createEnvoyMesh({ pool, skillReadImpl: async (_p, _t, ids) => new Map(ids.filter((id) => canned.has(id)).map((id) => [id, canned.get(id)])) });
  try {
    await pool.query('insert into helmion.tenants (tenant_id, owner_subject) values ($1,$2)', [tenantId, owner.subject]);
    const { channel } = await chat.createChannel(owner, { slug: 'skills', title: 'Skills', kind: 'agent' });
    await mesh.seedRoomAgent(owner, channel.id, 'claude');

    // A message with no skills metadata: the work item is exactly
    // what it has always been — no skills field.
    const plain = (await chat.appendMessage(owner, { channelId: channel.id, body: 'plain hello', idempotencyKey: randomUUID() })).receipt.message;
    let work = (await mesh.agentWork(device, 'claude')).work.filter((w) => w.channel.id === channel.id && w.message.id === plain.id);
    assert.equal(work.length, 1);
    assert.equal('skills' in work[0], false);
    await mesh.postAsAgent(device, { channelId: channel.id, provider: 'claude', replyTo: plain.id, body: 'Claim: noted.' });

    const skilled = (await chat.appendMessage(owner, {
      channelId: channel.id,
      body: 'with skills attached',
      idempotencyKey: randomUUID(),
      metadata: {
        skills: [
          { skillId: 'blanket-skill', seatId: 'all' },
          { skillId: 'seated-skill', seatId: 'all' },
          { skillId: 'gone-skill', seatId: 'all' },
        ],
      },
    })).receipt.message;
    work = (await mesh.agentWork(device, 'claude')).work.filter((w) => w.channel.id === channel.id && w.message.id === skilled.id);
    assert.equal(work.length, 1);
    assert.deepEqual(work[0].skills, [
      { id: 'blanket-skill', name: 'Blanket', body: 'For everyone.', seatId: 'all' },
      { id: 'seated-skill', name: 'Seated', body: 'For Claude only.', seatId: 'claude' },
      { id: 'gone-skill', missing: true, seatId: 'all' },
    ], 'blanket rides as all; the seat-scoped record clamps all → its own seats; the unknown id rides as missing');

    // Read failure: dispatch is unchanged and carries no skills.
    const failing = createEnvoyMesh({ pool, skillReadImpl: async () => { throw new Error('store is down'); }, skillLogImpl: () => {} });
    work = (await failing.agentWork(device, 'claude')).work.filter((w) => w.channel.id === channel.id && w.message.id === skilled.id);
    assert.equal(work.length, 1, 'the work is still handed out');
    assert.equal('skills' in work[0], false, 'a failed skill read leaves the item skill-less, never half-resolved');
  } finally {
    await pool.query('delete from helmion.tenants where tenant_id = $1', [tenantId]).catch(() => {});
    await pool.end();
  }
});

// ---------- Channel tool-access setting (Mirror M3, bite G6) ----------
// The write action and the dispatch consultation, driven through
// fake pools (the envoy-pool-bounds harness shape): an in-memory
// message log answers the config road's SQL, and the poll fake
// answers the dispatch reads. The Postgres-gated end-to-end — a
// real channel turn at keep-loaded — is §7's live acceptance and
// is NOT exercised here.

const G6_CHANNEL_ID = '11111111-2222-4333-8444-555555555555';
const G6_TENANT = 'tenant-g6';

function fakeConfigPool() {
  const messages = [];
  let seq = 0;
  const channel = { id: G6_CHANNEL_ID, slug: 'build', title: 'Build', kind: 'team' };
  const client = {
    async query(text, vals = []) {
      const sql = String(text);
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('helmion.tenant_id'")) return { rows: [{}], rowCount: 1 };
      if (sql.includes('tenant_memberships')) {
        // The membership check matches the row's role against the
        // actor's declared role: answer with each subject's own.
        const role = vals[1] === 'user_auditor' ? 'auditor' : vals[1] === 'user_member' ? 'member' : 'owner';
        return { rows: [{ role }], rowCount: 1 };
      }
      if (sql.includes('from helmion.envoy_channels')) return { rows: [channel], rowCount: 1 };
      if (sql.includes('select body from helmion.envoy_messages')) {
        const newest = messages.filter((m) => m.channel_id === vals[1] && m.author_subject === vals[2]).at(-1);
        return newest ? { rows: [{ body: newest.body }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.startsWith('insert into helmion.envoy_messages')) {
        const row = {
          id: `msg-${++seq}`, tenant_id: vals[0], channel_id: vals[1], author_subject: vals[2],
          author_kind: vals[3], body: vals[4], idempotency_key: vals[5], created_at: new Date(), metadata: null,
        };
        messages.push(row);
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { pool: { async connect() { return client; } }, channel };
}

test('mesh on fakes: set-tool-access writes the channel tool-loading setting (bite G6)', async () => {
  const { pool, channel } = fakeConfigPool();
  const mesh = createEnvoyMesh({ pool, publishImpl: async () => {} });
  const member = { tenantId: G6_TENANT, subject: 'user_member', role: 'member' };
  const auditor = { tenantId: G6_TENANT, subject: 'user_auditor', role: 'auditor' };

  let cfg = await mesh.getConfig(member, channel.id);
  assert.equal(cfg.config.toolAccess, 'when-used', 'a channel with no config reads the default');

  // Any non-auditor member may set it (the set-armed-connectors
  // gate); the config answer and the stored round trip carry it.
  const set = await mesh.changeConfig(member, { action: 'set-tool-access', channelId: channel.id, toolAccess: 'keep-loaded' });
  assert.equal(set.config.toolAccess, 'keep-loaded');
  cfg = await mesh.getConfig(member, channel.id);
  assert.equal(cfg.config.toolAccess, 'keep-loaded', 'the setting survives the store round trip');

  // A bad value coerces to the default — the set-debate-mode rule
  // for enum settings, and parseConfig's own coercion.
  const bad = await mesh.changeConfig(member, { action: 'set-tool-access', channelId: channel.id, toolAccess: 'sometimes' });
  assert.equal(bad.config.toolAccess, 'when-used');
  cfg = await mesh.getConfig(member, channel.id);
  assert.equal(cfg.config.toolAccess, 'when-used');

  // Setting it back explicitly works too.
  await mesh.changeConfig(member, { action: 'set-tool-access', channelId: channel.id, toolAccess: 'keep-loaded' });
  const back = await mesh.changeConfig(member, { action: 'set-tool-access', channelId: channel.id, toolAccess: 'when-used' });
  assert.equal(back.config.toolAccess, 'when-used');

  // An auditor may not write at all, and the refused write
  // changed nothing.
  await assert.rejects(
    mesh.changeConfig(auditor, { action: 'set-tool-access', channelId: channel.id, toolAccess: 'keep-loaded' }),
    /ENVOY_ROLE_FORBIDDEN/,
  );
  cfg = await mesh.getConfig(member, channel.id);
  assert.equal(cfg.config.toolAccess, 'when-used', 'the refused write changed nothing');

  // Unknown actions still refuse.
  await assert.rejects(
    mesh.changeConfig(member, { action: 'set-tool-access-please', channelId: channel.id }),
    /ENVOY_CONFIG_ACTION_UNSUPPORTED/,
  );
});

// One channel, one unanswered human ask that arms nothing. The
// poll answers come from the config body the case supplies.
function fakeWorkPool({ configBody }) {
  const ask = {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', channel_id: G6_CHANNEL_ID, author_subject: 'user_author',
    author_kind: 'human', body: 'What is the capital of Norway?', idempotency_key: 'g6-ask-1',
    created_at: new Date(), metadata: null,
  };
  const client = {
    async query(text, vals = []) {
      const sql = String(text);
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('helmion.tenant_id'")) return { rows: [{}], rowCount: 1 };
      if (sql.includes('tenant_memberships')) return { rows: [{ role: 'owner' }], rowCount: 1 };
      if (sql.includes('from helmion.desktop_links')) return { rows: [{ n: 0 }], rowCount: 1 };
      if (sql.includes('runner_provider_presence')) return { rows: [], rowCount: 0 };
      if (sql.includes('provider_connections')) return { rows: [], rowCount: 0 };
      if (sql.includes('distinct on (channel_id)')) return { rows: [{ channel_id: G6_CHANNEL_ID, body: configBody }], rowCount: 1 };
      if (sql.includes('lateral')) {
        return { rows: [{ ch_id: G6_CHANNEL_ID, ch_slug: 'build', ch_title: 'Build', ch_kind: 'team', ...ask }], rowCount: 1 };
      }
      if (sql.includes('from helmion.envoy_channels')) return { rows: [{ id: G6_CHANNEL_ID, slug: 'build', title: 'Build', kind: 'team' }], rowCount: 1 };
      if (sql.includes('limit 40')) return { rows: [ask], rowCount: 1 };
      if (sql.startsWith('insert into helmion.envoy_messages')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { pool: { async connect() { return client; } } };
}

function g6Mesh(pool, extra = {}) {
  return createEnvoyMesh({
    pool,
    publishImpl: async () => {},
    notebookImpl: async () => null,
    kbImpl: async () => null,
    librarianImpl: {
      async fileAsk() { return { filed: true }; },
      async renameChannelIfGeneric() { return true; },
      async fileIncident() { return { filed: true }; },
    },
    armingLogImpl: () => {},
    ...extra,
  });
}

const G6_DEVICE = { tenantId: G6_TENANT, subject: 'user_author', role: 'owner', viaDeviceToken: true };
const echoArming = (calls) => async (input) => {
  calls.push(input);
  return input.pairs.map((p) => ({ ...p, state: 'connected' }));
};

test("mesh on fakes: keep-loaded dispatch loads the author's connected GitHub record for a message that arms nothing (bite G6)", async () => {
  const config = emptyConfig();
  config.agents = ['claude'];
  config.toolAccess = 'keep-loaded';
  const { pool } = fakeWorkPool({ configBody: serializeConfig(config) });
  const keepLoadedCalls = [];
  const armingCalls = [];
  const mesh = g6Mesh(pool, {
    keepLoadedReadImpl: async (input) => { keepLoadedCalls.push(input); return [{ seatId: 'claude', entryId: 'helmian-github' }]; },
    armingReadImpl: echoArming(armingCalls),
  });
  const result = await mesh.agentWork(G6_DEVICE, 'claude');
  await mesh.drainFilingTail();
  assert.equal(result.work.length, 1);
  assert.equal(keepLoadedCalls.length, 1, 'the enumeration ran once for the poll');
  assert.equal(keepLoadedCalls[0].personId, 'user_author', "the enumeration is keyed to the message author's own subject");
  assert.equal(keepLoadedCalls[0].tenantId, G6_TENANT);
  assert.deepEqual(armingCalls.map((c) => c.pairs), [[{ seatId: 'claude', entryId: 'helmian-github' }]],
    'the resolver received exactly the keep-loaded pair — the message itself armed nothing');
  assert.deepEqual(result.work[0].connectorConnections, [{ seatId: 'claude', entryId: 'helmian-github', state: 'connected' }],
    "the author's GitHub arming record rides the work item");
});

test('mesh on fakes: when-used and unconfigured channels never enumerate (bite G6)', async () => {
  const explicit = emptyConfig();
  explicit.agents = ['claude'];
  explicit.toolAccess = 'when-used';
  const cases = [
    ['explicit when-used', serializeConfig(explicit)],
    ['no key stored', JSON.stringify({ format: 'helmian.envoy.channel-config.v1', agents: ['claude'], joined: {}, discord: null, pendingLink: null })],
  ];
  for (const [label, body] of cases) {
    const { pool } = fakeWorkPool({ configBody: body });
    let keepLoadedCalls = 0;
    let armingCalls = 0;
    const mesh = g6Mesh(pool, {
      keepLoadedReadImpl: async () => { keepLoadedCalls += 1; return [{ seatId: 'claude', entryId: 'helmian-github' }]; },
      armingReadImpl: async () => { armingCalls += 1; return []; },
    });
    const result = await mesh.agentWork(G6_DEVICE, 'claude');
    await mesh.drainFilingTail();
    assert.equal(result.work.length, 1, label);
    assert.equal(keepLoadedCalls, 0, `${label}: no enumeration runs`);
    assert.equal(armingCalls, 0, `${label}: no pairs, so the resolver never runs`);
    assert.ok(!('connectorConnections' in result.work[0]), `${label}: no arming field on the work item`);
  }
});

test('mesh on fakes: a failed keep-loaded enumeration drops only the extra pairs (bite G6)', async () => {
  const config = emptyConfig();
  config.agents = ['claude'];
  config.toolAccess = 'keep-loaded';
  config.armedConnectors = [{ seatId: 'claude', entryId: 'helmian-github' }];
  const { pool } = fakeWorkPool({ configBody: serializeConfig(config) });
  const armingCalls = [];
  const mesh = g6Mesh(pool, {
    keepLoadedReadImpl: async () => { throw new Error('library read exploded'); },
    armingReadImpl: echoArming(armingCalls),
  });
  const result = await mesh.agentWork(G6_DEVICE, 'claude');
  await mesh.drainFilingTail();
  assert.equal(result.work.length, 1, 'the turn still dispatches');
  assert.deepEqual(armingCalls.map((c) => c.pairs), [[{ seatId: 'claude', entryId: 'helmian-github' }]],
    'the standing armed set still resolves — the failure was in the expansion, not the arming');
  assert.deepEqual(result.work[0].connectorConnections, [{ seatId: 'claude', entryId: 'helmian-github', state: 'connected' }]);
});
