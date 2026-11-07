// Provider registry tests: the four provider-catalog seats (groq,
// nvidia, cloudflare, openrouter) exist as registry rows in the
// DESIGN.md §1 shape (id = vault slot = seat name, checked_at +
// source_url mandatory), the channel vocabulary accepts them like the
// seats that shipped before them, the runner vault knows their slots,
// and the credential connect route stores their credentials — a single
// key verbatim for three of them, and Cloudflare's two fields composed
// at store time into the one bundle record its runner reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_REGISTRY,
  PROVIDER_REGISTRY_IDS,
  composeRegistryCredential,
  providerRegistryRow,
} from '../src/cloud/provider-registry.mjs';
import {
  AGENT_NAMES,
  AGENT_PROVIDERS,
  CUSTOM_AGENT_ENGINES,
  normalizeEngine,
  normalizeProvider,
} from '../src/cloud/envoy-agents.mjs';
import { PROVIDER_KEY_ENV } from '../src/runner/vault.mjs';
import {
  CREDENTIAL_CONNECT_PATH,
  createProviderConnectionWriter,
  handleCredentialConnectRoute,
} from '../src/cloud/credential-connect.mjs';
import { TenantAuthorizationError } from '../src/core/tenant-context.mjs';

const FIVE = ['groq', 'nvidia', 'cloudflare', 'openrouter', 'muse'];

// ---------- the rows ----------

test('registry: exactly the five catalog seats, in order, no credential material in any row', () => {
  assert.deepEqual([...PROVIDER_REGISTRY_IDS], FIVE);
  assert.equal(PROVIDER_REGISTRY.length, 5);
  for (const r of PROVIDER_REGISTRY) {
    assert.ok(!JSON.stringify(r).match(/sk-[A-Za-z0-9]|api[_-]?key["']?\s*:\s*["'][A-Za-z0-9]{16,}/i), `${r.id}: a row never holds a key`);
  }
});

test('registry: every row carries the mandatory check date and source, one pinned model, and slot = id', () => {
  for (const id of FIVE) {
    const r = providerRegistryRow(id);
    assert.ok(r, `${id} has a row`);
    assert.equal(r.id, id);
    assert.equal(r.auth.vault_slot, id, `${id}: vault slot is the seat name`);
    assert.match(r.checked_at, /^\d{4}-\d{2}-\d{2}$/, `${id}: checked_at is a date`);
    assert.match(r.source_url, /^https:\/\//, `${id}: source_url is a real page`);
    assert.ok(typeof r.runner.pinned_model === 'string' && r.runner.pinned_model.length > 0, `${id}: exactly one pinned model`);
    assert.equal(r.runner.file, `run-${id}.mjs`, `${id}: the runner that already runs on the server`);
    assert.equal(r.kind, 'api-key');
    assert.equal(r.multi_account, true);
  }
  assert.equal(providerRegistryRow('nope'), null);
  assert.equal(providerRegistryRow(''), null);
  assert.equal(providerRegistryRow(' GROQ '), providerRegistryRow('groq'), 'lookup trims and lowercases');
});

test('registry: auth field shapes — one key for three seats, two pieces for cloudflare', () => {
  assert.deepEqual(providerRegistryRow('groq').auth.fields, ['api_key']);
  assert.deepEqual(providerRegistryRow('nvidia').auth.fields, ['api_key']);
  assert.deepEqual(providerRegistryRow('openrouter').auth.fields, ['api_key']);
  assert.deepEqual(providerRegistryRow('cloudflare').auth.fields, ['account_id', 'api_token']);
});

// ---------- composition ----------

test('compose: a single-field row stores its one value verbatim', () => {
  assert.equal(composeRegistryCredential('groq', { api_key: 'gsk_test' }), 'gsk_test');
  assert.equal(composeRegistryCredential(providerRegistryRow('openrouter'), { api_key: 'sk-or-test' }), 'sk-or-test');
  assert.equal(composeRegistryCredential('groq', { api_key: '' }), null);
  assert.equal(composeRegistryCredential('groq', {}), null);
});

test('compose: cloudflare composes the one bundle record the runner reads; a half credential is null', () => {
  const bundle = composeRegistryCredential('cloudflare', { account_id: 'acct-1', api_token: 'tok-1' });
  assert.deepEqual(JSON.parse(bundle), { account_id: 'acct-1', api_token: 'tok-1' });
  assert.equal(composeRegistryCredential('cloudflare', { account_id: 'acct-1' }), null);
  assert.equal(composeRegistryCredential('cloudflare', { api_token: 'tok-1' }), null);
  assert.equal(composeRegistryCredential('cloudflare', { account_id: 'acct-1', api_token: '' }), null);
  assert.equal(composeRegistryCredential('nope', { api_key: 'x' }), null);
});

// ---------- channel vocabulary ----------

test('vocabulary: the five normalize as providers and engines, with their aliases', () => {
  for (const id of FIVE) {
    assert.equal(normalizeProvider(id), id);
    assert.equal(normalizeProvider(`@${id}`), id);
    assert.equal(normalizeEngine(id), id);
    assert.ok(AGENT_PROVIDERS.includes(id), `${id} is a channel agent provider`);
    assert.ok(CUSTOM_AGENT_ENGINES.includes(id), `${id} is a custom-agent engine`);
  }
  assert.equal(normalizeProvider('nim'), 'nvidia');
  assert.equal(normalizeEngine('nim'), 'nvidia');
  assert.equal(normalizeProvider('workersai'), 'cloudflare');
  assert.equal(normalizeEngine('workersai'), 'cloudflare');
  assert.equal(AGENT_NAMES.groq, 'Groq');
  assert.equal(AGENT_NAMES.nvidia, 'NVIDIA');
  assert.equal(AGENT_NAMES.cloudflare, 'Cloudflare');
  assert.equal(AGENT_NAMES.openrouter, 'OpenRouter');
});

// ---------- runner vault slots ----------

test('vault: the runner key map names the four slots and their env vars', () => {
  assert.equal(PROVIDER_KEY_ENV.groq, 'GROQ_API_KEY');
  assert.equal(PROVIDER_KEY_ENV.nvidia, 'NVIDIA_API_KEY');
  assert.equal(PROVIDER_KEY_ENV.cloudflare, 'CLOUDFLARE_API_TOKEN');
  assert.equal(PROVIDER_KEY_ENV.openrouter, 'OPENROUTER_API_KEY');
});

// ---------- the connect route ----------

const ownerActor = { tenantId: 'tenant-a', subject: 'user-a', role: 'owner', sessionId: 'sess-a', requestId: 'req-a' };

function makeFakePool() {
  const inserts = [];
  const client = {
    query: async (sql, params = []) => {
      const text = String(sql);
      if (['begin', 'commit', 'rollback'].includes(text)) return { rowCount: 0, rows: [] };
      if (text.includes('set_config')) return { rowCount: 1, rows: [] };
      if (text.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ role: 'owner' }] };
      if (text.includes('insert into helmion.provider_connections')) {
        inserts.push(params);
        return { rowCount: 1, rows: [{ provider_id: params[1], auth_mode: 'api_key', credential_reference: params[2], lifecycle: 'pending', adapter: 'credential_service', updated_at: new Date().toISOString() }] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    release: () => {},
  };
  return { pool: { connect: async () => client }, inserts };
}

function harness(body) {
  const sent = [];
  const storeCalls = [];
  const { pool, inserts } = makeFakePool();
  const deps = {
    request: { method: 'POST' },
    response: {},
    requestUrl: new URL(`http://x${CREDENTIAL_CONNECT_PATH}`),
    activeTenantActor: async () => ownerActor,
    send: (response, status, raw) => { sent.push({ status, body: JSON.parse(raw) }); },
    TenantAuthorizationError,
    readJson: async () => body,
    client: { storeCredential: async (input) => { storeCalls.push(input); return { accepted: true, status: 'stored_in_credential_vault' }; } },
    connectionWriter: createProviderConnectionWriter(pool),
  };
  return { deps, sent, storeCalls, inserts };
}

test('connect: a groq key stores verbatim under the groq slot and records a groq row', async () => {
  const h = harness({ provider: 'groq', apiKey: 'gsk_TESTKEY-do-not-leak' });
  assert.equal(await handleCredentialConnectRoute(h.deps), true);
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.storeCalls.length, 1);
  assert.equal(h.storeCalls[0].credentialKind, 'api_key');
  assert.equal(h.storeCalls[0].providerId, 'groq');
  assert.equal(h.storeCalls[0].apiKey, 'gsk_TESTKEY-do-not-leak');
  assert.equal(h.storeCalls[0].credentialReference, 'vault://tenant/tenant-a/groq/api-key');
  assert.equal(h.inserts[0][1], 'groq');
  assert.ok(!JSON.stringify(h.sent[0].body).includes('gsk_TESTKEY-do-not-leak'), 'the key never appears in the response');
});

test('connect: cloudflare fields compose into the one bundle record at store time', async () => {
  const h = harness({ provider: 'cloudflare', fields: { account_id: 'acct-TEST-1', api_token: 'tok-TEST-1' } });
  assert.equal(await handleCredentialConnectRoute(h.deps), true);
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.storeCalls.length, 1);
  assert.equal(h.storeCalls[0].providerId, 'cloudflare');
  assert.deepEqual(JSON.parse(h.storeCalls[0].apiKey), { account_id: 'acct-TEST-1', api_token: 'tok-TEST-1' });
  assert.equal(h.storeCalls[0].credentialReference, 'vault://tenant/tenant-a/cloudflare/api-key');
  assert.ok(!JSON.stringify(h.sent[0].body).includes('tok-TEST-1'), 'the token never appears in the response');
  assert.ok(!JSON.stringify(h.sent[0].body).includes('acct-TEST-1'), 'the account id never appears in the response');
});

test('connect: cloudflare refuses a bare key, a missing piece, and an unnamed field — nothing stores', async () => {
  for (const body of [
    { provider: 'cloudflare', apiKey: 'tok-only' },
    { provider: 'cloudflare', fields: { account_id: 'acct-1' } },
    { provider: 'cloudflare', fields: { account_id: 'acct-1', api_token: 'tok-1', extra: 'x' } },
    { provider: 'cloudflare' },
  ]) {
    const h = harness(body);
    await handleCredentialConnectRoute(h.deps);
    assert.equal(h.sent[0].status, 400, JSON.stringify(body));
    assert.equal(h.storeCalls.length, 0);
    assert.equal(h.inserts.length, 0);
  }
});

test('connect: fields sent for a single-key seat are refused — the shapes never blur', async () => {
  const h = harness({ provider: 'groq', fields: { api_key: 'gsk_x' } });
  await handleCredentialConnectRoute(h.deps);
  assert.equal(h.sent[0].status, 400);
  assert.equal(h.storeCalls.length, 0);
});
