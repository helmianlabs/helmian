// Envoy message reactions (emoji bite 2): the attributed data layer.
// Toggle round-trips for two members and for agents on the device road,
// attribution, pack recording, the pre-migration (42P01) posture, and
// the route contract the desk will call in bite 3.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MESSAGE_REACTIONS_PATH,
  REACTION_EMOJI_SLUGS,
  createEnvoyReactionsStore,
  handleEnvoyReactionsRoute,
  normalizeReactionAction,
  normalizeReactionEmoji,
  normalizeReactionPack,
  publishEnvoyReaction,
} from '../src/cloud/envoy-reactions.mjs';
import { TenantAuthorizationError } from '../src/core/tenant-context.mjs';
import { emptyConfig, sanitizeCustomAgent, serializeConfig } from '../src/cloud/envoy-agents.mjs';

const TENANT = 'tenant-1';
const CHANNEL = '11111111-1111-4111-8111-111111111111';
const MSG1 = '22222222-2222-4222-8222-222222222222';
const MSG2 = '33333333-3333-4333-8333-333333333333';

const memberA = { tenantId: TENANT, subject: 'user-ana', role: 'member' };
const memberB = { tenantId: TENANT, subject: 'user-ben', role: 'member' };
const device = { tenantId: TENANT, subject: 'device-1', role: 'owner', viaDeviceToken: true };
const outsider = { tenantId: TENANT, subject: 'user-out', role: 'member' };

function makeFakePool({ missingTable = false } = {}) {
  const memberships = new Map([
    [`${TENANT}|user-ana`, 'member'],
    [`${TENANT}|user-ben`, 'member'],
    [`${TENANT}|device-1`, 'owner'],
  ]);
  const channels = new Map([[`${TENANT}|${CHANNEL}`, { id: CHANNEL, slug: 'maestro-desk', title: 'Maestro', kind: 'team' }]]);
  const config = {
    ...emptyConfig(),
    agents: ['claude', 'qwen'],
    customAgents: [sanitizeCustomAgent({ handle: 'qwen', name: 'Qwen', emoji: '🦀', provider: 'ollama' })],
  };
  const configBody = serializeConfig(config);
  const messages = new Set([`${TENANT}|${CHANNEL}|${MSG1}`, `${TENANT}|${CHANNEL}|${MSG2}`]);
  const reactions = [];
  let tick = 0;
  const client = {
    query: async (sql, params) => {
      const text = String(sql);
      if (text === 'rollback') return {};
      if (missingTable) { const e = new Error('missing'); e.code = '42P01'; throw e; }
      if (text === 'begin' || text === 'commit') return {};
      if (text.includes('set_config')) return { rows: [], rowCount: 0 };
      if (text.includes('helmion.tenant_memberships')) {
        const role = memberships.get(`${params[0]}|${params[1]}`);
        return role ? { rows: [{ role }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes('from helmion.envoy_channels')) {
        const row = channels.get(`${params[0]}|${params[1]}`);
        return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes('from helmion.envoy_messages') && text.includes('author_subject <> $4')) {
        const hit = messages.has(`${params[0]}|${params[1]}|${params[2]}`);
        return hit ? { rows: [{ id: params[2] }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes('from helmion.envoy_messages')) {
        // The channel config read (newest config-subject row).
        return { rows: [{ body: configBody }], rowCount: 1 };
      }
      if (text.includes('insert into helmion.envoy_message_reactions')) {
        const [tenantId, channelId, messageId, emoji, pack, actorSubject, actorKind] = params;
        const dupe = reactions.some((r) => r.tenant_id === tenantId && r.message_id === messageId && r.emoji === emoji && r.actor_subject === actorSubject);
        if (dupe) return { rows: [], rowCount: 0 };
        reactions.push({
          tenant_id: tenantId, channel_id: channelId, message_id: messageId, emoji, pack,
          actor_subject: actorSubject, actor_kind: actorKind,
          created_at: new Date(Date.UTC(2026, 10, 5, 5, 0, tick++)).toISOString(),
        });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('delete from helmion.envoy_message_reactions')) {
        const [tenantId, messageId, emoji, actorSubject] = params;
        const i = reactions.findIndex((r) => r.tenant_id === tenantId && r.message_id === messageId && r.emoji === emoji && r.actor_subject === actorSubject);
        if (i < 0) return { rows: [], rowCount: 0 };
        reactions.splice(i, 1);
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('from helmion.envoy_message_reactions')) {
        const [tenantId, channelId, ids] = params;
        const rows = reactions
          .filter((r) => r.tenant_id === tenantId && r.channel_id === channelId && ids.includes(r.message_id))
          .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
        return { rows, rowCount: rows.length };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    release: () => {},
  };
  return { connect: async () => client, _reactions: reactions };
}

// ---------- vocabulary ----------

test('the slug vocabulary is bite 1\u2019s map, and the cheeky set is in it', () => {
  assert.ok(REACTION_EMOJI_SLUGS.includes('fire'));
  assert.ok(REACTION_EMOJI_SLUGS.includes('middle-finger'), 'Troy\u2019s 19:05 decision: the cheeky set ships in the default pack');
  assert.ok(REACTION_EMOJI_SLUGS.includes('shield'));
  assert.equal(new Set(REACTION_EMOJI_SLUGS).size, REACTION_EMOJI_SLUGS.length);
});

test('normalizeReactionEmoji accepts slugs and characters, refuses the rest', () => {
  assert.equal(normalizeReactionEmoji('fire'), 'fire');
  assert.equal(normalizeReactionEmoji('🔥'), 'fire');
  assert.equal(normalizeReactionEmoji('✌️'), 'victory', 'FE0F forms normalize like the renderer');
  assert.equal(normalizeReactionEmoji('❤️'), 'heart-red');
  assert.throws(() => normalizeReactionEmoji('🍕'), (e) => e?.code === 'ENVOY_REACTION_EMOJI_UNSUPPORTED');
  assert.throws(() => normalizeReactionEmoji('not-a-slug'), (e) => e?.code === 'ENVOY_REACTION_EMOJI_UNSUPPORTED');
  assert.throws(() => normalizeReactionEmoji('👨‍👩‍👧'), (e) => e?.code === 'ENVOY_REACTION_EMOJI_UNSUPPORTED', 'ZWJ sequences are never half-substituted');
  assert.throws(() => normalizeReactionEmoji(''), (e) => e?.code === 'ENVOY_REACTION_EMOJI_REQUIRED');
});

test('pack defaults to default and is shape-checked; action defaults to toggle', () => {
  assert.equal(normalizeReactionPack(undefined), 'default');
  assert.equal(normalizeReactionPack('Crew-Pack'), 'crew-pack');
  assert.throws(() => normalizeReactionPack('bad pack!'), (e) => e?.code === 'ENVOY_REACTION_PACK_INVALID');
  assert.equal(normalizeReactionAction(undefined), 'toggle');
  assert.equal(normalizeReactionAction('ADD'), 'add');
  assert.throws(() => normalizeReactionAction('explode'), (e) => e?.code === 'ENVOY_REACTION_ACTION_INVALID');
});

// ---------- the plan gate: two-user toggle round-trip ----------

test('two members toggle: counts and attribution track every step, and survive a fresh store', async () => {
  const pool = makeFakePool();
  const store = createEnvoyReactionsStore(pool);
  const first = await store.toggleReaction(memberA, { channelId: CHANNEL, messageId: MSG1, emoji: '🔥' });
  assert.equal(first.action, 'added');
  assert.equal(first.changed, true);
  assert.equal(first.reactions.length, 1);
  assert.equal(first.reactions[0].emoji, 'fire');
  assert.equal(first.reactions[0].count, 1);
  assert.deepEqual(first.reactions[0].actors.map((a) => a.subject), ['user-ana']);
  assert.equal(first.reactions[0].actors[0].kind, 'human');

  const second = await store.toggleReaction(memberB, { channelId: CHANNEL, messageId: MSG1, emoji: 'fire' });
  assert.equal(second.reactions[0].count, 2);
  assert.deepEqual(second.reactions[0].actors.map((a) => a.subject), ['user-ana', 'user-ben'], 'who reacted is stored and returnable, in order');

  // Reload: a new store over the same data answers identically.
  const fresh = createEnvoyReactionsStore(pool);
  const listed = await fresh.listForMessages(memberA, CHANNEL, [MSG1, MSG2]);
  assert.equal(listed.reactions[MSG1][0].count, 2, 'counts survive reload — they are the rows');
  assert.deepEqual(listed.reactions[MSG2], []);
  assert.deepEqual(listed.mine[MSG1], ['fire']);
  assert.deepEqual(listed.mine[MSG2], []);

  const off = await store.toggleReaction(memberA, { channelId: CHANNEL, messageId: MSG1, emoji: 'fire' });
  assert.equal(off.action, 'removed');
  assert.equal(off.reacted, false);
  assert.equal(off.reactions[0].count, 1);
  assert.deepEqual(off.reactions[0].actors.map((a) => a.subject), ['user-ben']);
});

test('explicit add is idempotent and remove of an absent reaction is a clean no-op', async () => {
  const store = createEnvoyReactionsStore(makeFakePool());
  await store.toggleReaction(memberA, { channelId: CHANNEL, messageId: MSG1, emoji: 'check', action: 'add' });
  const replay = await store.toggleReaction(memberA, { channelId: CHANNEL, messageId: MSG1, emoji: 'check', action: 'add' });
  assert.equal(replay.changed, false);
  assert.equal(replay.reacted, true);
  assert.equal(replay.reactions[0].count, 1);
  const absent = await store.toggleReaction(memberB, { channelId: CHANNEL, messageId: MSG1, emoji: 'check', action: 'remove' });
  assert.equal(absent.changed, false);
  assert.equal(absent.reacted, false);
  assert.equal(absent.reactions[0].count, 1);
});

test('the pack is recorded on the row and returned in the summary', async () => {
  const pool = makeFakePool();
  const store = createEnvoyReactionsStore(pool);
  const out = await store.toggleReaction(memberA, { channelId: CHANNEL, messageId: MSG1, emoji: 'rocket', pack: 'crew-pack' });
  assert.equal(out.pack, 'crew-pack');
  assert.equal(out.reactions[0].pack, 'crew-pack');
  assert.equal(pool._reactions[0].pack, 'crew-pack', 'the entitlement seam is in the stored model, not just the response');
});

test('unknown channel and message are 404s; a non-member is refused', async () => {
  const store = createEnvoyReactionsStore(makeFakePool());
  await assert.rejects(
    () => store.toggleReaction(memberA, { channelId: '99999999-9999-4999-8999-999999999999', messageId: MSG1, emoji: 'fire' }),
    (e) => e?.status === 404 && e?.code === 'ENVOY_CHANNEL_NOT_FOUND',
  );
  await assert.rejects(
    () => store.toggleReaction(memberA, { channelId: CHANNEL, messageId: '99999999-9999-4999-8999-999999999999', emoji: 'fire' }),
    (e) => e?.status === 404 && e?.code === 'ENVOY_MESSAGE_NOT_FOUND',
  );
  await assert.rejects(
    () => store.toggleReaction(outsider, { channelId: CHANNEL, messageId: MSG1, emoji: 'fire' }),
    (e) => e instanceof TenantAuthorizationError,
  );
});

// ---------- agents react on the same road ----------

test('an agent reacts through the device road, attributed as the agent', async () => {
  const store = createEnvoyReactionsStore(makeFakePool());
  const out = await store.toggleReaction(device, { channelId: CHANNEL, messageId: MSG1, emoji: '👍', provider: 'claude' });
  assert.equal(out.actorSubject, 'agent:claude');
  assert.equal(out.actorKind, 'agent');
  const entry = out.reactions.find((r) => r.emoji === 'thumbs-up');
  assert.equal(entry.count, 1);
  assert.equal(entry.actors[0].subject, 'agent:claude');
  assert.equal(entry.actors[0].name, 'Claude', 'the reactor is named through the same derivation as an author');
  assert.equal(entry.actors[0].provider, 'claude');
});

test('a custom agent reacts under its own handle and face name', async () => {
  const store = createEnvoyReactionsStore(makeFakePool());
  const out = await store.toggleReaction(device, { channelId: CHANNEL, messageId: MSG1, emoji: 'fire', provider: 'qwen' });
  assert.equal(out.actorSubject, 'agent:qwen');
  assert.equal(out.reactions[0].actors[0].name, '🦀 Qwen');
});

test('agent reactions enforce the roster, like postAsAgent', async () => {
  const store = createEnvoyReactionsStore(makeFakePool());
  await assert.rejects(
    () => store.toggleReaction(device, { channelId: CHANNEL, messageId: MSG1, emoji: 'fire', provider: 'gemini' }),
    (e) => e?.status === 403 && e?.code === 'ENVOY_AGENT_NOT_MEMBER',
    'gemini is a real provider but is not on this channel\u2019s roster',
  );
  await assert.rejects(
    () => store.toggleReaction(device, { channelId: CHANNEL, messageId: MSG1, emoji: 'fire', provider: 'maestro' }),
    (e) => e?.code === 'ENVOY_AGENT_NOT_AN_AGENT',
  );
  await assert.rejects(
    () => store.toggleReaction(device, { channelId: CHANNEL, messageId: MSG1, emoji: 'fire' }),
    (e) => e?.code === 'ENVOY_AGENT_UNSUPPORTED',
    'a device caller must name its provider',
  );
});

test('a member body naming a provider still reacts as the member', async () => {
  const store = createEnvoyReactionsStore(makeFakePool());
  const out = await store.toggleReaction(memberA, { channelId: CHANNEL, messageId: MSG1, emoji: 'fire', provider: 'claude' });
  assert.equal(out.actorSubject, 'user-ana', 'provider in a member body is ignored — no client-supplied actors');
  assert.equal(out.actorKind, 'human');
});

// ---------- room-event mirror ----------

test('a change publishes one reaction event; a replay publishes none', async () => {
  const events = [];
  const store = createEnvoyReactionsStore(makeFakePool(), { publishImpl: async (args) => { events.push(args); return { published: true }; } });
  await store.toggleReaction(memberA, { channelId: CHANNEL, messageId: MSG1, emoji: 'fire', action: 'add' });
  await store.toggleReaction(memberA, { channelId: CHANNEL, messageId: MSG1, emoji: 'fire', action: 'add' });
  await store.toggleReaction(memberA, { channelId: CHANNEL, messageId: MSG1, emoji: 'fire', action: 'remove' });
  assert.equal(events.length, 2);
  assert.equal(events[0].event.type, 'reaction');
  assert.equal(events[0].event.action, 'added');
  assert.equal(events[0].event.count, 1);
  assert.equal(events[0].event.emoji, 'fire');
  assert.equal(events[1].event.action, 'removed');
  assert.equal(events[1].event.count, 0);
});

test('publishEnvoyReaction no-ops unconfigured and posts a named reaction event when configured', async () => {
  const off = await publishEnvoyReaction({ tenantId: TENANT, channelId: CHANNEL, event: { type: 'reaction' }, ablyKey: '' });
  assert.deepEqual(off, { published: false, reason: 'ably_not_configured' });
  const seen = [];
  const on = await publishEnvoyReaction({
    tenantId: TENANT,
    channelId: CHANNEL,
    event: { type: 'reaction', action: 'added', emoji: 'fire' },
    ablyKey: 'app.key:0123456789abcdef0123456789abcdef',
    fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200 }; },
  });
  assert.equal(on.published, true);
  assert.equal(on.channel, `envoy:${TENANT}:${CHANNEL}`);
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.name, 'reaction');
  assert.equal(body.data.emoji, 'fire');
});

// ---------- pre-migration posture (sql/068 not applied yet) ----------

test('before sql/068: list answers empty and toggle reports 503', async () => {
  const store = createEnvoyReactionsStore(makeFakePool({ missingTable: true }));
  const listed = await store.listForMessages(memberA, CHANNEL, [MSG1]);
  assert.deepEqual(listed.reactions[MSG1], []);
  assert.deepEqual(listed.mine[MSG1], []);
  await assert.rejects(
    () => store.toggleReaction(memberA, { channelId: CHANNEL, messageId: MSG1, emoji: 'fire' }),
    (e) => e?.status === 503 && e?.code === 'ENVOY_REACTIONS_UNAVAILABLE',
  );
});

// ---------- route contract (what bite 3 calls) ----------

async function callRoute({ actor, method = 'POST', body = {}, query = '', store }) {
  const captured = {};
  const handled = await handleEnvoyReactionsRoute({
    request: { method },
    response: {},
    requestUrl: new URL(`http://reactions.test${MESSAGE_REACTIONS_PATH}${query}`),
    activeTenantActor: async () => actor,
    send: (_response, status, payload) => { captured.status = status; captured.body = JSON.parse(payload); },
    TenantAuthorizationError,
    readJson: async () => body,
    store,
  });
  return { handled, ...captured };
}

test('route returns false for other paths', async () => {
  const out = await handleEnvoyReactionsRoute({
    request: { method: 'GET' },
    requestUrl: new URL('http://x/api/admin/envoy/agent-messages'),
    activeTenantActor: async () => { throw new Error('should not be called'); },
    send: () => { throw new Error('should not send'); },
    TenantAuthorizationError,
    readJson: async () => ({}),
  });
  assert.equal(out, false);
});

test('route: POST toggles and GET lists, in the envelope the desk already reads', async () => {
  const store = createEnvoyReactionsStore(makeFakePool());
  const posted = await callRoute({ actor: memberA, body: { channelId: CHANNEL, messageId: MSG1, emoji: '🔥' }, store });
  assert.equal(posted.handled, true);
  assert.equal(posted.status, 200);
  assert.equal(posted.body.valid, true);
  assert.equal(posted.body.action, 'added');
  assert.equal(posted.body.reactions[0].count, 1);

  const listed = await callRoute({ actor: memberB, method: 'GET', query: `?channel_id=${CHANNEL}&message_ids=${MSG1},${MSG2}`, store });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.reactions[MSG1][0].emoji, 'fire');
  assert.equal(listed.body.reactions[MSG1][0].actors[0].subject, 'user-ana');
  assert.deepEqual(listed.body.mine[MSG1], [], 'the listing member has not reacted');
  assert.deepEqual(listed.body.reactions[MSG2], []);
});

test('route: a device-token POST reacts as the named agent; a bad emoji is a coded 400', async () => {
  const store = createEnvoyReactionsStore(makeFakePool());
  const agent = await callRoute({ actor: device, body: { channelId: CHANNEL, messageId: MSG1, emoji: 'fire', provider: 'claude' }, store });
  assert.equal(agent.status, 200);
  assert.equal(agent.body.actorSubject, 'agent:claude');
  const bad = await callRoute({ actor: memberA, body: { channelId: CHANNEL, messageId: MSG1, emoji: '🍕' }, store });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.valid, false);
  assert.equal(bad.body.code, 'ENVOY_REACTION_EMOJI_UNSUPPORTED');
});

test('reactions path constant lives under envoy for device auth', () => {
  assert.ok(MESSAGE_REACTIONS_PATH.startsWith('/api/admin/envoy/'));
});
