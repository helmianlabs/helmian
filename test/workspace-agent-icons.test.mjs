import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_PROVIDERS,
  assertIconEmoji,
  assertProviderName,
  checkAgentIconRateLimit,
  clearAgentIconRateLimits,
  createAgentIconStore,
  handleAgentIconRoute,
  AGENT_ICONS_PATH,
} from '../src/cloud/workspace-agent-icons.mjs';

const ACTOR = { tenantId: 'tenant-a', subject: 'user-1', role: 'member', sessionId: 's', requestId: 'r' };
const ACTOR_B = { tenantId: 'tenant-a', subject: 'user-2', role: 'member', sessionId: 's', requestId: 'r' };

function missingTable() {
  const error = new Error('relation "helmion.workspace_agent_icons" does not exist');
  error.code = '42P01';
  return error;
}

// Fake pool with per-user icon rows. `missing` simulates migration 055
// not being applied.
function iconPool({ rows = [], missing = false } = {}) {
  const state = new Map(rows.map((r) => [`${r.tenant_id}|${r.user_subject}|${r.provider_name}`, r.icon_emoji]));
  const client = {
    async query(sql, params) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
      if (q.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ role: 'member' }] };
      if (q.includes('delete from helmion.workspace_agent_icons')) {
        if (missing) throw missingTable();
        state.delete(`${params[0]}|${params[1]}|${params[2]}`);
        return { rowCount: 1, rows: [] };
      }
      if (q.includes('from helmion.workspace_agent_icons')) {
        if (missing) throw missingTable();
        const [tenantId, userSubject] = params;
        const out = [];
        for (const [key, icon] of state) {
          const [t, u, p] = key.split('|');
          if (t === tenantId && u === userSubject) out.push({ provider_name: p, icon_emoji: icon });
        }
        return { rowCount: out.length, rows: out };
      }
      if (q.includes('insert into helmion.workspace_agent_icons')) {
        if (missing) throw missingTable();
        state.set(`${params[0]}|${params[1]}|${params[2]}`, params[3]);
        return { rowCount: 1, rows: [] };
      }
      if (q.includes('insert into helmion.audit_events')) return { rowCount: 1, rows: [{ id: 7 }] };
      throw new Error(`unexpected query ${q}`);
    },
    release() {},
  };
  return { connect: async () => client };
}

test('agent icon validation accepts single emoji and rejects the rest', () => {
  assert.equal(assertIconEmoji('🎩'), '🎩');
  assert.equal(assertIconEmoji('👨‍👩‍👧'), '👨‍👩‍👧'); // ZWJ sequence is one grapheme
  assert.equal(assertIconEmoji('👍🏽'), '👍🏽'); // skin tone is one grapheme
  assert.equal(assertIconEmoji(null), null);
  assert.throws(() => assertIconEmoji(''), /single emoji/iu);
  assert.throws(() => assertIconEmoji('  '), /single emoji/iu);
  assert.throws(() => assertIconEmoji('🎩🎩'), /single emoji/iu);
  assert.throws(() => assertIconEmoji('hi'), /single emoji/iu);
  assert.throws(() => assertIconEmoji('a\u0007'), /single emoji|unsupported/iu);
  assert.throws(() => assertIconEmoji('\u200B'), /single emoji|unsupported/iu); // zero-width space
  assert.throws(() => assertIconEmoji('🎩'.repeat(17)), /too long|single emoji/iu);
});

test('agent icon validation rejects unknown providers', () => {
  assert.equal(assertProviderName('Claude'), 'Claude');
  assert.throws(() => assertProviderName('Bing'), /invalid/iu);
  assert.throws(() => assertProviderName(''), /invalid/iu);
});

test('agent icon store lists empty icons for a new user', async () => {
  const store = createAgentIconStore(iconPool());
  const result = await store.list(ACTOR);
  assert.deepEqual(result.icons, { Maestro: null, Claude: null, ChatGPT: null, Grok: null, Gemini: null });
  assert.equal(result.iconsUnavailable, undefined);
});

test('agent icon store set/get round-trips and isolates users', async () => {
  const pool = iconPool();
  const store = createAgentIconStore(pool);
  await store.set(ACTOR, { providerName: 'Claude', iconEmoji: '🎩' });
  const mine = await store.list(ACTOR);
  assert.equal(mine.icons.Claude, '🎩');
  assert.equal(mine.icons.Grok, null);
  const theirs = await store.list(ACTOR_B);
  assert.equal(theirs.icons.Claude, null); // per-user scoping
  await store.set(ACTOR, { providerName: 'Claude', iconEmoji: null }); // clear
  const cleared = await store.list(ACTOR);
  assert.equal(cleared.icons.Claude, null);
});

test('agent icon store degrades when migration 055 is not applied', async () => {
  const store = createAgentIconStore(iconPool({ missing: true }));
  const result = await store.list(ACTOR);
  assert.equal(result.iconsUnavailable, true);
  assert.equal(result.icons.Claude, null);
  await assert.rejects(() => store.set(ACTOR, { providerName: 'Claude', iconEmoji: '🎩' }), /not available yet/iu);
});

test('agent icon rate limit allows 30 per minute per actor', () => {
  clearAgentIconRateLimits();
  const key = 'tenant-a:user-1';
  for (let i = 0; i < 30; i++) assert.equal(checkAgentIconRateLimit(key, 1000 + i), true);
  assert.equal(checkAgentIconRateLimit(key, 1030), false);
  assert.equal(checkAgentIconRateLimit(key, 61_031), true); // window slides
  clearAgentIconRateLimits();
});

function routeHarness({ method = 'GET', body = null, actor = ACTOR } = {}) {
  const sent = {};
  const request = { method, url: `http://local${AGENT_ICONS_PATH}`, headers: {} };
  const requestUrl = new URL(request.url);
  return {
    sent,
    args: {
      request,
      response: {},
      requestUrl,
      pool: iconPool(),
      agentIcons: null,
      activeTenantActor: async () => actor,
      send: (response, status, text) => { sent.status = status; sent.body = JSON.parse(text); },
      readJsonObject: async () => body ?? {},
      exactKeys: (obj, keys) => {
        const extra = Object.keys(obj).filter((k) => !keys.includes(k));
        if (extra.length) throw new Error(`unsupported fields: ${extra.join(',')}`);
      },
      TenantAuthorizationError: class extends Error {},
    },
  };
}

test('agent icon route GET returns the icon map', async () => {
  const h = routeHarness();
  assert.equal(await handleAgentIconRoute(h.args), true);
  assert.equal(h.sent.status, 200);
  assert.equal(h.sent.body.valid, true);
  assert.deepEqual(Object.keys(h.sent.body.icons), [...AGENT_PROVIDERS]);
});

test('agent icon route PUT validates and rejects bad input', async () => {
  const bad = routeHarness({ method: 'PUT', body: { providerName: 'Claude', iconEmoji: '🎩🎩' } });
  assert.equal(await handleAgentIconRoute(bad.args), true);
  assert.equal(bad.sent.status, 400);
  assert.equal(bad.sent.body.code, 'AGENT_ICONS_SAVE_INVALID');

  const unknown = routeHarness({ method: 'PUT', body: { providerName: 'Nope', iconEmoji: '🎩' } });
  assert.equal(await handleAgentIconRoute(unknown.args), true);
  assert.equal(unknown.sent.status, 400);
});

test('agent icon route ignores non-icon paths', async () => {
  const h = routeHarness();
  h.args.requestUrl = new URL('http://local/api/admin/workspace/other');
  assert.equal(await handleAgentIconRoute(h.args), false);
});
