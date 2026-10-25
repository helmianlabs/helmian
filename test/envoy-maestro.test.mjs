import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MAESTRO_DESK_PATH, createMaestroDesk, handleMaestroDeskRoute, maestroDeskChannel } from '../src/cloud/envoy-maestro.mjs';
import { handleEnvoyAblyRoute } from '../src/cloud/envoy-ably.mjs';

// The Maestro desk (Bite 1 of the Maestro design spec): one channel per
// tenant that is the human's manager seat. The desk takes no input —
// entering it get-or-creates the channel and seeds its dispatch config
// (envoy-mesh.mjs seedDesk). The pure + orchestration tests run
// anywhere; the route tests inject a stub store; the delegation test
// runs the real Envoy hook with no database configured and expects the
// desk route to answer 503 rather than fall through to another handler.

const ACTOR = { tenantId: 'tenant-desk', subject: 'user:owner', role: 'owner' };

test('desk definition: one reserved channel, titled for the seat', () => {
  assert.deepEqual(maestroDeskChannel(), { slug: 'maestro-desk', title: 'Maestro', kind: 'team' });
});

function stubDesk() {
  const chatCalls = [];
  const meshCalls = [];
  const channel = { id: 'chan-desk-1', tenantId: ACTOR.tenantId, createdBySubject: ACTOR.subject, createdAt: '2026-10-25T00:00:00.000Z' };
  const chat = {
    createChannel: async (actor, def) => {
      chatCalls.push(def);
      return { channel: { ...channel, ...def }, inserted: chatCalls.length === 1 };
    },
  };
  const mesh = {
    seedDesk: async (actor, channelId) => {
      meshCalls.push([channelId]);
      return { seeded: meshCalls.length === 1, configured: true, agents: ['claude', 'gemini'] };
    },
  };
  return { desk: createMaestroDesk({ chat, mesh }), chatCalls, meshCalls };
}

test('ensureDesk: creates the channel then seeds its dispatch config', async () => {
  const { desk, chatCalls, meshCalls } = stubDesk();
  const out = await desk.ensureDesk(ACTOR);
  assert.equal(out.inserted, true);
  assert.equal(out.seeded, true);
  assert.deepEqual(out.agents, ['claude', 'gemini']);
  assert.deepEqual(out.channel, { id: 'chan-desk-1', tenantId: ACTOR.tenantId, createdBySubject: ACTOR.subject, createdAt: '2026-10-25T00:00:00.000Z', slug: 'maestro-desk', title: 'Maestro', kind: 'team' });
  assert.deepEqual(chatCalls, [{ slug: 'maestro-desk', title: 'Maestro', kind: 'team' }]);
  assert.deepEqual(meshCalls, [['chan-desk-1']]);
  const again = await desk.ensureDesk(ACTOR);
  assert.equal(again.inserted, false, 'a second entry reuses the desk');
  assert.equal(again.seeded, false, 'a seeded desk config is never rewritten');
});

// ---- route ----

class TenantAuthorizationError extends Error {}

function routeFixture(desk, { method = 'POST', body = {}, actorImpl = null, path = MAESTRO_DESK_PATH } = {}) {
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
      desk,
    },
  };
}

test('route: POST returns the desk, created and seeded on first entry', async () => {
  const { desk } = stubDesk();
  const fx = routeFixture(desk);
  assert.equal(await handleMaestroDeskRoute(fx.args), true);
  const [status, body] = fx.sent[0];
  assert.equal(status, 200);
  assert.equal(body.valid, true);
  assert.equal(body.channel.slug, 'maestro-desk');
  assert.equal(body.channel.kind, 'team');
  assert.equal(body.seeded, true);
  assert.deepEqual(body.agents, ['claude', 'gemini']);
});

test('route: other paths are not this route', async () => {
  const fx = routeFixture(stubDesk().desk, { path: '/api/admin/envoy/channels' });
  assert.equal(await handleMaestroDeskRoute(fx.args), false);
  assert.equal(fx.sent.length, 0);
});

test('route: GET is refused', async () => {
  const fx = routeFixture(stubDesk().desk, { method: 'GET' });
  assert.equal(await handleMaestroDeskRoute(fx.args), true);
  assert.deepEqual(fx.sent[0], [405, { valid: false, code: 'METHOD_NOT_ALLOWED' }]);
});

test('route: any input at all is refused — the desk takes no selectors', async () => {
  for (const body of [{ tenant_id: 'someone-else' }, { provider: 'claude' }, { channelId: 'x' }]) {
    const fx = routeFixture(stubDesk().desk, { body });
    await handleMaestroDeskRoute(fx.args);
    assert.deepEqual(fx.sent[0], [400, { valid: false, code: 'ENVOY_DESK_INPUT_INVALID' }]);
  }
});

test('route: an actor outside the tenant is refused with 403', async () => {
  const fx = routeFixture(stubDesk().desk, { actorImpl: async () => { throw new TenantAuthorizationError('not a member'); } });
  await handleMaestroDeskRoute(fx.args);
  const [status, body] = fx.sent[0];
  assert.equal(status, 403);
  assert.equal(body.valid, false);
});

test('route: with no database configured the desk route answers 503, not silence', async () => {
  const saved = process.env.HELMIAN_DATABASE_URL;
  delete process.env.HELMIAN_DATABASE_URL;
  try {
    const fx = routeFixture(null);
    assert.equal(await handleMaestroDeskRoute(fx.args), true);
    assert.deepEqual(fx.sent[0], [503, { valid: false, code: 'ENVOY_DESK_UNAVAILABLE' }]);
  } finally {
    if (saved !== undefined) process.env.HELMIAN_DATABASE_URL = saved;
  }
});

test('delegation: the Envoy hook routes the desk path to the desk handler', async () => {
  const saved = process.env.HELMIAN_DATABASE_URL;
  delete process.env.HELMIAN_DATABASE_URL;
  try {
    const sent = [];
    const handled = await handleEnvoyAblyRoute({
      request: { method: 'POST', headers: {} },
      response: {},
      requestUrl: new URL(`http://helmian.test${MAESTRO_DESK_PATH}`),
      activeTenantActor: async () => ACTOR,
      send: (_response, status, raw) => sent.push([status, JSON.parse(raw)]),
      TenantAuthorizationError,
      readJson: async () => ({}),
    });
    assert.equal(handled, true);
    assert.deepEqual(sent[0], [503, { valid: false, code: 'ENVOY_DESK_UNAVAILABLE' }]);
  } finally {
    if (saved !== undefined) process.env.HELMIAN_DATABASE_URL = saved;
  }
});
