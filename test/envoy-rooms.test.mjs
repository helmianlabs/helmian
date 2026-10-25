import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AGENT_ROOM_PATH, agentRoomChannel, agentRoomSlug, createAgentRooms, handleAgentRoomsRoute } from '../src/cloud/envoy-rooms.mjs';
import { handleEnvoyAblyRoute } from '../src/cloud/envoy-ably.mjs';

// Private agent rooms (Bite 7): one kind 'agent' channel per agent per
// tenant, created lazily, roster seeded with exactly that agent. The
// pure + orchestration tests run anywhere; the route tests inject a
// stub store; the delegation test runs the real Envoy hook with no
// database configured and expects the room route to answer 503 rather
// than fall through to another handler.

const ACTOR = { tenantId: 'tenant-rooms', subject: 'user:owner', role: 'owner' };

test('room definitions: every agent gets one room, named for the agent', () => {
  assert.deepEqual(agentRoomChannel('maestro'), { slug: 'agent-maestro', title: 'Maestro', kind: 'agent' });
  assert.deepEqual(agentRoomChannel('claude'), { slug: 'agent-claude', title: 'Claude', kind: 'agent' });
  assert.equal(agentRoomChannel('ChatGPT').slug, 'agent-openai', 'display-name aliases resolve to the provider room');
  assert.equal(agentRoomChannel('gpt').slug, 'agent-openai');
  assert.equal(agentRoomChannel('grok').title, 'Grok');
  assert.equal(agentRoomChannel('gemini').title, 'Gemini');
  assert.equal(agentRoomSlug('claude'), 'agent-claude');
});

test('room definitions: unsupported providers have no room', () => {
  assert.equal(agentRoomChannel('skynet'), null);
  assert.equal(agentRoomChannel(''), null);
  assert.equal(agentRoomChannel(null), null);
  assert.equal(agentRoomSlug(undefined), null);
});

function stubRooms() {
  const chatCalls = [];
  const meshCalls = [];
  const channel = { id: 'chan-room-1', tenantId: ACTOR.tenantId, createdBySubject: ACTOR.subject, createdAt: '2026-10-24T00:00:00.000Z' };
  const chat = {
    createChannel: async (actor, def) => {
      chatCalls.push(def);
      return { channel: { ...channel, ...def }, inserted: chatCalls.length === 1 };
    },
  };
  const mesh = {
    seedRoomAgent: async (actor, channelId, provider) => {
      meshCalls.push([channelId, provider]);
      return { seeded: meshCalls.length === 1, configured: true };
    },
  };
  return { rooms: createAgentRooms({ chat, mesh }), chatCalls, meshCalls };
}

test('ensureRoom: creates the channel then seeds its one-agent roster', async () => {
  const { rooms, chatCalls, meshCalls } = stubRooms();
  const out = await rooms.ensureRoom(ACTOR, 'ChatGPT');
  assert.equal(out.provider, 'openai');
  assert.equal(out.inserted, true);
  assert.equal(out.seeded, true);
  assert.deepEqual(out.channel, { id: 'chan-room-1', tenantId: ACTOR.tenantId, createdBySubject: ACTOR.subject, createdAt: '2026-10-24T00:00:00.000Z', slug: 'agent-openai', title: 'ChatGPT', kind: 'agent' });
  assert.deepEqual(chatCalls, [{ slug: 'agent-openai', title: 'ChatGPT', kind: 'agent' }]);
  assert.deepEqual(meshCalls, [['chan-room-1', 'openai']]);
  const again = await rooms.ensureRoom(ACTOR, 'openai');
  assert.equal(again.inserted, false, 'a second open reuses the room');
  assert.equal(again.seeded, false, 'a seeded roster is never rewritten');
});

test('ensureRoom: an unsupported provider is refused before anything is created', async () => {
  const { rooms, chatCalls, meshCalls } = stubRooms();
  await assert.rejects(rooms.ensureRoom(ACTOR, 'skynet'), (error) => error.code === 'ENVOY_AGENT_UNSUPPORTED' && error.status === 400);
  assert.equal(chatCalls.length, 0);
  assert.equal(meshCalls.length, 0);
});

// ---- route ----

class TenantAuthorizationError extends Error {}

function routeFixture(rooms, { method = 'POST', body = { provider: 'claude' }, actorImpl = null, path = AGENT_ROOM_PATH } = {}) {
  const sent = [];
  return {
    sent,
    args: {
      request: { method, headers: {} },
      response: {},
      requestUrl: new URL(`http://helmian.test${path}?x=${randomUUID()}`),
      activeTenantActor: actorImpl ?? (async () => ACTOR),
      send: (_response, status, raw) => sent.push([status, JSON.parse(raw)]),
      TenantAuthorizationError,
      readJson: async () => body,
      rooms,
    },
  };
}

test('route: POST returns the room, created and seeded on first open', async () => {
  const { rooms } = stubRooms();
  const fx = routeFixture(rooms);
  assert.equal(await handleAgentRoomsRoute(fx.args), true);
  const [status, body] = fx.sent[0];
  assert.equal(status, 200);
  assert.equal(body.valid, true);
  assert.equal(body.provider, 'claude');
  assert.equal(body.channel.slug, 'agent-claude');
  assert.equal(body.channel.kind, 'agent');
  assert.equal(body.seeded, true);
});

test('route: other paths are not this route', async () => {
  const fx = routeFixture(stubRooms().rooms, { path: '/api/admin/envoy/channels' });
  assert.equal(await handleAgentRoomsRoute(fx.args), false);
  assert.equal(fx.sent.length, 0);
});

test('route: GET is refused', async () => {
  const fx = routeFixture(stubRooms().rooms, { method: 'GET' });
  assert.equal(await handleAgentRoomsRoute(fx.args), true);
  assert.deepEqual(fx.sent[0], [405, { valid: false, code: 'METHOD_NOT_ALLOWED' }]);
});

test('route: tenant and authority selectors in the body are refused', async () => {
  const fx = routeFixture(stubRooms().rooms, { body: { provider: 'claude', tenant_id: 'someone-else' } });
  await handleAgentRoomsRoute(fx.args);
  assert.deepEqual(fx.sent[0], [400, { valid: false, code: 'ENVOY_ROOM_INPUT_INVALID' }]);
});

test('route: an unsupported provider surfaces its code', async () => {
  const fx = routeFixture(stubRooms().rooms, { body: { provider: 'skynet' } });
  await handleAgentRoomsRoute(fx.args);
  assert.deepEqual(fx.sent[0], [400, { valid: false, code: 'ENVOY_AGENT_UNSUPPORTED' }]);
});

test('route: an actor outside the tenant is refused with 403', async () => {
  const fx = routeFixture(stubRooms().rooms, { actorImpl: async () => { throw new TenantAuthorizationError('not a member'); } });
  await handleAgentRoomsRoute(fx.args);
  const [status, body] = fx.sent[0];
  assert.equal(status, 403);
  assert.equal(body.valid, false);
});

test('route: with no database configured the room route answers 503, not silence', async () => {
  const saved = process.env.HELMIAN_DATABASE_URL;
  delete process.env.HELMIAN_DATABASE_URL;
  try {
    const fx = routeFixture(null);
    assert.equal(await handleAgentRoomsRoute(fx.args), true);
    assert.deepEqual(fx.sent[0], [503, { valid: false, code: 'ENVOY_ROOM_UNAVAILABLE' }]);
  } finally {
    if (saved !== undefined) process.env.HELMIAN_DATABASE_URL = saved;
  }
});

test('delegation: the Envoy hook routes the room path to the room handler', async () => {
  const saved = process.env.HELMIAN_DATABASE_URL;
  delete process.env.HELMIAN_DATABASE_URL;
  try {
    const sent = [];
    const handled = await handleEnvoyAblyRoute({
      request: { method: 'POST', headers: {} },
      response: {},
      requestUrl: new URL(`http://helmian.test${AGENT_ROOM_PATH}`),
      activeTenantActor: async () => ACTOR,
      send: (_response, status, raw) => sent.push([status, JSON.parse(raw)]),
      TenantAuthorizationError,
      readJson: async () => ({ provider: 'claude' }),
    });
    assert.equal(handled, true);
    assert.deepEqual(sent[0], [503, { valid: false, code: 'ENVOY_ROOM_UNAVAILABLE' }]);
  } finally {
    if (saved !== undefined) process.env.HELMIAN_DATABASE_URL = saved;
  }
});
