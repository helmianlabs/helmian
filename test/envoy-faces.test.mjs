// Envoy seat faces (emoji bite 5): the built-in provider seats'
// per-workspace character faces. Defaults ship in the emoji map, the
// workspace's choices live in helmion.workspace_agent_faces
// (sql/069), owner/admin write, every member reads the EFFECTIVE map,
// and the pre-migration (42P01) posture mirrors reactions: reads
// answer the defaults, writes report 503.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_FACES_PATH,
  AGENT_FACE_DEFAULTS,
  AGENT_FACE_PROVIDERS,
  createEnvoyFacesStore,
  effectiveFaces,
  handleEnvoyFacesRoute,
  normalizeFaceEmoji,
  normalizeFaceProvider,
} from '../src/cloud/envoy-faces.mjs';
import { TenantAuthorizationError } from '../src/core/tenant-context.mjs';
import { emojiAssetSlug } from '../web/marketing/app/emoji-map.mjs';

const TENANT = 'tenant-1';
const TENANT2 = 'tenant-2';

const owner = { tenantId: TENANT, subject: 'user-owner', role: 'owner' };
const admin = { tenantId: TENANT, subject: 'user-admin', role: 'admin' };
const member = { tenantId: TENANT, subject: 'user-member', role: 'member' };
const auditor = { tenantId: TENANT, subject: 'user-auditor', role: 'auditor' };
const owner2 = { tenantId: TENANT2, subject: 'user-owner2', role: 'owner' };

function makeFakePool({ missingTable = false } = {}) {
  const memberships = new Map([
    [`${TENANT}|user-owner`, 'owner'],
    [`${TENANT}|user-admin`, 'admin'],
    [`${TENANT}|user-member`, 'member'],
    [`${TENANT}|user-auditor`, 'auditor'],
    [`${TENANT2}|user-owner2`, 'owner'],
  ]);
  const faces = [];
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
      if (text.includes('insert into helmion.workspace_agent_faces')) {
        const [tenantId, provider, emoji, subject] = params;
        const row = faces.find((r) => r.tenant_id === tenantId && r.provider === provider);
        if (row) { row.emoji = emoji; row.updated_by_subject = subject; } else faces.push({ tenant_id: tenantId, provider, emoji, updated_by_subject: subject });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('delete from helmion.workspace_agent_faces')) {
        const [tenantId, provider] = params;
        const i = faces.findIndex((r) => r.tenant_id === tenantId && r.provider === provider);
        if (i >= 0) faces.splice(i, 1);
        return { rows: [], rowCount: i >= 0 ? 1 : 0 };
      }
      if (text.includes('from helmion.workspace_agent_faces')) {
        const rows = faces.filter((r) => r.tenant_id === params[0]).map((r) => ({ provider: r.provider, emoji: r.emoji }));
        return { rows, rowCount: rows.length };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    release: () => {},
  };
  return { connect: async () => client, _faces: faces };
}

// ---------- the shipped defaults ----------

test('the five seats ship a drawn default face each, and only those five', () => {
  assert.deepEqual([...AGENT_FACE_PROVIDERS].sort(), ['claude', 'gemini', 'grok', 'mistral', 'openai']);
  assert.deepEqual(Object.keys(AGENT_FACE_DEFAULTS).sort(), [...AGENT_FACE_PROVIDERS].sort());
  for (const provider of AGENT_FACE_PROVIDERS) {
    assert.ok(emojiAssetSlug(AGENT_FACE_DEFAULTS[provider]), `${provider}'s default face has Helmian art`);
  }
  assert.equal(new Set(Object.values(AGENT_FACE_DEFAULTS)).size, 5, 'no two seats share a default face');
  assert.ok(!Object.values(AGENT_FACE_DEFAULTS).includes('🦀'), "Qwen's crab stays Qwen's");
});

test('effectiveFaces merges stored rows over the defaults and ignores junk rows', () => {
  assert.deepEqual(effectiveFaces([]), AGENT_FACE_DEFAULTS);
  const merged = effectiveFaces([
    { provider: 'claude', emoji: '🦊' },
    { provider: 'qwen', emoji: '🦀' },
    { provider: 'grok', emoji: '🍕' },
    { provider: 'gemini', emoji: '' },
  ]);
  assert.equal(merged.claude, '🦊');
  assert.equal(merged.grok, AGENT_FACE_DEFAULTS.grok, 'an undrawn stored face never reaches a client');
  assert.equal(merged.gemini, AGENT_FACE_DEFAULTS.gemini);
  assert.equal(merged.qwen, undefined, 'custom agents are not seats');
});

// ---------- write vocabulary ----------

test('normalizeFaceProvider resolves aliases and refuses non-seats', () => {
  assert.equal(normalizeFaceProvider('claude'), 'claude');
  assert.equal(normalizeFaceProvider('chatgpt'), 'openai');
  assert.equal(normalizeFaceProvider('@Gemini'), 'gemini');
  assert.equal(normalizeFaceProvider(' xai '), 'grok');
  assert.throws(() => normalizeFaceProvider('maestro'), (e) => e?.code === 'ENVOY_FACE_NOT_A_SEAT');
  assert.throws(() => normalizeFaceProvider('manager'), (e) => e?.code === 'ENVOY_FACE_NOT_A_SEAT');
  assert.throws(() => normalizeFaceProvider('qwen'), (e) => e?.code === 'ENVOY_FACE_PROVIDER_UNSUPPORTED');
  assert.throws(() => normalizeFaceProvider(''), (e) => e?.code === 'ENVOY_FACE_PROVIDER_UNSUPPORTED');
});

test('normalizeFaceEmoji takes one drawn token; empty is the clear', () => {
  assert.equal(normalizeFaceEmoji('🦊'), '🦊');
  assert.equal(normalizeFaceEmoji(' 🦀 '), '🦀');
  assert.equal(normalizeFaceEmoji(''), null);
  assert.equal(normalizeFaceEmoji(null), null);
  assert.equal(normalizeFaceEmoji(undefined), null);
  assert.throws(() => normalizeFaceEmoji('🍕'), (e) => e?.code === 'ENVOY_FACE_EMOJI_UNSUPPORTED', 'no art exists for it');
  assert.throws(() => normalizeFaceEmoji('🦀🦀'), (e) => e?.code === 'ENVOY_FACE_EMOJI_UNSUPPORTED', 'one token only');
  assert.throws(() => normalizeFaceEmoji('robot'), (e) => e?.code === 'ENVOY_FACE_EMOJI_UNSUPPORTED', 'slugs are reactions vocabulary, not faces');
});

// ---------- the store ----------

test('a fresh workspace reads the shipped defaults', async () => {
  const store = createEnvoyFacesStore(makeFakePool());
  assert.deepEqual((await store.facesFor(member)).faces, AGENT_FACE_DEFAULTS);
});

test('owner sets a face; every member reads it; clearing restores the default', async () => {
  const store = createEnvoyFacesStore(makeFakePool());
  const set = await store.setFace(owner, { provider: 'claude', emoji: '🦊' });
  assert.equal(set.provider, 'claude');
  assert.equal(set.emoji, '🦊');
  assert.equal(set.faces.claude, '🦊');
  assert.equal(set.faces.gemini, AGENT_FACE_DEFAULTS.gemini, 'other seats keep their faces');
  assert.equal((await store.facesFor(member)).faces.claude, '🦊', 'the whole room sees the same face');
  const cleared = await store.setFace(admin, { provider: 'claude', emoji: null });
  assert.equal(cleared.emoji, null);
  assert.equal(cleared.faces.claude, AGENT_FACE_DEFAULTS.claude);
});

test('the chatgpt alias writes the openai seat', async () => {
  const store = createEnvoyFacesStore(makeFakePool());
  const set = await store.setFace(owner, { provider: 'chatgpt', emoji: '🦉' });
  assert.equal(set.provider, 'openai');
  assert.equal((await store.facesFor(member)).faces.openai, '🦉');
});

test('members and auditors cannot write a seat face', async () => {
  const store = createEnvoyFacesStore(makeFakePool());
  await assert.rejects(() => store.setFace(member, { provider: 'claude', emoji: '🦊' }), (e) => e?.status === 403 && e?.code === 'ENVOY_FACE_FORBIDDEN');
  await assert.rejects(() => store.setFace(auditor, { provider: 'claude', emoji: '🦊' }), (e) => e?.status === 403 && e?.code === 'ENVOY_FACE_FORBIDDEN');
  assert.deepEqual((await store.facesFor(member)).faces, AGENT_FACE_DEFAULTS, 'a refused write changed nothing');
});

test('faces are per-workspace: another tenant never sees them', async () => {
  const store = createEnvoyFacesStore(makeFakePool());
  await store.setFace(owner, { provider: 'grok', emoji: '🔥' });
  assert.equal((await store.facesFor(owner)).faces.grok, '🔥');
  assert.equal((await store.facesFor(owner2)).faces.grok, AGENT_FACE_DEFAULTS.grok);
});

// ---------- pre-migration posture (sql/069 not applied yet) ----------

test('before sql/069: reads answer the defaults and writes report 503', async () => {
  const store = createEnvoyFacesStore(makeFakePool({ missingTable: true }));
  assert.deepEqual((await store.facesFor(owner)).faces, AGENT_FACE_DEFAULTS);
  await assert.rejects(
    () => store.setFace(owner, { provider: 'claude', emoji: '🦊' }),
    (e) => e?.status === 503 && e?.code === 'ENVOY_FACES_UNAVAILABLE',
  );
});

// ---------- route contract (what the desk calls) ----------

async function callRoute({ actor, method = 'GET', body = {}, store }) {
  const captured = {};
  const handled = await handleEnvoyFacesRoute({
    request: { method },
    response: {},
    requestUrl: new URL(`http://faces.test${AGENT_FACES_PATH}`),
    activeTenantActor: async () => actor,
    send: (_response, status, payload) => { captured.status = status; captured.body = JSON.parse(payload); },
    TenantAuthorizationError,
    readJson: async () => body,
    store,
  });
  return { handled, ...captured };
}

test('route returns false for other paths', async () => {
  const out = await handleEnvoyFacesRoute({
    request: { method: 'GET' },
    requestUrl: new URL('http://x/api/admin/envoy/message-reactions'),
    activeTenantActor: async () => { throw new Error('should not be called'); },
    send: () => { throw new Error('should not send'); },
    TenantAuthorizationError,
    readJson: async () => ({}),
  });
  assert.equal(out, false);
});

test('route: GET answers the effective faces; POST round-trips a change', async () => {
  const store = createEnvoyFacesStore(makeFakePool());
  const before = await callRoute({ actor: member, store });
  assert.equal(before.handled, true);
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.faces, AGENT_FACE_DEFAULTS);

  const posted = await callRoute({ actor: owner, method: 'POST', body: { provider: 'gemini', emoji: '🚀' }, store });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.valid, true);
  assert.equal(posted.body.faces.gemini, '🚀');

  const after = await callRoute({ actor: member, store });
  assert.equal(after.body.faces.gemini, '🚀');
});

test('route: member write is a coded 403; maestro and undrawn faces are coded 400s', async () => {
  const store = createEnvoyFacesStore(makeFakePool());
  const memberWrite = await callRoute({ actor: member, method: 'POST', body: { provider: 'claude', emoji: '🦊' }, store });
  assert.equal(memberWrite.status, 403);
  assert.equal(memberWrite.body.code, 'ENVOY_FACE_FORBIDDEN');
  const maestro = await callRoute({ actor: owner, method: 'POST', body: { provider: 'maestro', emoji: '🦊' }, store });
  assert.equal(maestro.status, 400);
  assert.equal(maestro.body.code, 'ENVOY_FACE_NOT_A_SEAT');
  const pizza = await callRoute({ actor: owner, method: 'POST', body: { provider: 'claude', emoji: '🍕' }, store });
  assert.equal(pizza.status, 400);
  assert.equal(pizza.body.code, 'ENVOY_FACE_EMOJI_UNSUPPORTED');
});

test('faces path constant lives under envoy for device auth', () => {
  assert.ok(AGENT_FACES_PATH.startsWith('/api/admin/envoy/'));
});
