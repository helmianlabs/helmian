// Credential connect route tests: the store path (kind 'password' into
// the credential service + a password_session provider_connections row),
// the API-key shape (kind 'api_key', backup semantics — the row is
// recorded only when none exists), the GET card-state list, tenant
// scoping (the tenant comes from the verified actor; a body that
// tries to name one is refused), the owner/admin role gate on both the
// session and desktop-link-token roads, refusal mapping, and the
// guarantee that no secret ever appears in any response.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREDENTIAL_CONNECT_PATH,
  createCredentialConnectClient,
  createProviderConnectionWriter,
  credentialApiKeyReferenceFor,
  credentialReferenceFor,
  handleCredentialConnectRoute,
} from '../src/cloud/credential-connect.mjs';
import { TenantAuthorizationError } from '../src/core/tenant-context.mjs';

const PASSWORD = 'TESTPASSWORD-do-not-leak-47e2';

const ownerActor = { tenantId: 'tenant-a', subject: 'user-a', role: 'owner', sessionId: 'sess-a', requestId: 'req-a' };

function makeFakePool({ membershipRole = 'owner', existingRow = null, listRows = [] } = {}) {
  const inserts = [];
  const client = {
    query: async (sql, params = []) => {
      const text = String(sql);
      if (['begin', 'commit', 'rollback'].includes(text)) return { rowCount: 0, rows: [] };
      if (text.includes('set_config')) return { rowCount: 1, rows: [] };
      if (text.includes('from helmion.tenant_memberships')) {
        return { rowCount: 1, rows: [{ role: membershipRole }] };
      }
      if (text.includes('insert into helmion.provider_connections') && text.includes('do nothing')) {
        // recordApiKey: a no-clobber insert.
        inserts.push(params);
        if (existingRow) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [{ provider_id: params[1], auth_mode: 'api_key', credential_reference: params[2], lifecycle: 'pending', adapter: 'credential_service', updated_at: new Date().toISOString() }] };
      }
      if (text.includes('insert into helmion.provider_connections')) {
        inserts.push(params);
        return { rowCount: 1, rows: [{ provider_id: params[1], auth_mode: 'password_session', credential_reference: params[2], lifecycle: 'pending', adapter: 'credential_service', updated_at: new Date().toISOString() }] };
      }
      if (text.includes('from helmion.provider_connections') && text.includes('order by provider_id')) {
        return { rowCount: listRows.length, rows: listRows };
      }
      if (text.includes('from helmion.provider_connections')) {
        return existingRow ? { rowCount: 1, rows: [existingRow] } : { rowCount: 0, rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    release: () => {},
  };
  return { pool: { connect: async () => client }, inserts };
}

function harness({ actor = ownerActor, storeResult = { accepted: true, status: 'stored_in_credential_vault' }, membershipRole = 'owner', existingRow = null, listRows = [] } = {}) {
  const sent = [];
  const storeCalls = [];
  const { pool, inserts } = makeFakePool({ membershipRole, existingRow, listRows });
  const deps = {
    request: { method: 'POST' },
    response: {},
    requestUrl: new URL(`http://x${CREDENTIAL_CONNECT_PATH}`),
    activeTenantActor: async () => actor,
    send: (response, status, body) => { sent.push({ status, body: JSON.parse(body) }); },
    TenantAuthorizationError,
    readJson: async () => harness.body,
    client: { storeCredential: async (input) => { storeCalls.push(input); return storeResult; } },
    connectionWriter: createProviderConnectionWriter(pool),
  };
  return { deps, sent, storeCalls, inserts };
}
harness.body = {};

test('route returns false for other paths', async () => {
  const { deps } = harness();
  deps.requestUrl = new URL('http://x/api/admin/envoy/runner/presence');
  assert.equal(await handleCredentialConnectRoute(deps), false);
});

test('non-POST/GET is refused 405 and stores nothing', async () => {
  const { deps, sent, storeCalls } = harness();
  deps.request = { method: 'PUT' };
  assert.equal(await handleCredentialConnectRoute(deps), true);
  assert.equal(sent[0].status, 405);
  assert.equal(storeCalls.length, 0);
});

test('GET lists the caller tenant connection rows and carries no secret material', async () => {
  const row = { provider_id: 'claude', auth_mode: 'password_session', credential_reference: 'vault://tenant/tenant-a/claude/password', lifecycle: 'pending', adapter: 'credential_service', updated_at: new Date().toISOString() };
  const h = harness({ listRows: [row] });
  h.deps.request = { method: 'GET' };
  assert.equal(await handleCredentialConnectRoute(h.deps), true);
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.sent[0].body.connections.length, 1);
  assert.equal(h.sent[0].body.connections[0].providerId, 'claude');
  assert.equal(h.sent[0].body.connections[0].authMode, 'password_session');
  assert.equal(h.storeCalls.length, 0);
});

test('store path: password stored for the actor tenant, password_session row written, password never in the response', async () => {
  const h = harness();
  harness.body = { provider: 'mistral', username: 'troy@example.com', password: PASSWORD };
  assert.equal(await handleCredentialConnectRoute(h.deps), true);
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.sent[0].body.stored, true);
  assert.equal(h.sent[0].body.connection.authMode, 'password_session');
  assert.equal(h.sent[0].body.connection.credentialReference, 'vault://tenant/tenant-a/mistral/password');
  assert.ok(!JSON.stringify(h.sent[0].body).includes(PASSWORD));
  assert.equal(h.storeCalls.length, 1);
  const call = h.storeCalls[0];
  assert.equal(call.tenantId, 'tenant-a');
  assert.equal(call.actorSubject, 'user-a');
  assert.equal(call.credentialKind, 'password');
  assert.equal(call.providerId, 'mistral');
  assert.equal(call.credentialReference, 'vault://tenant/tenant-a/mistral/password');
  assert.equal(call.username, 'troy@example.com');
  assert.equal(call.password, PASSWORD);
  assert.equal(h.inserts.length, 1);
  assert.equal(h.inserts[0][0], 'tenant-a');
});

test('tenant scoping: a body naming a tenant is refused before any store or write', async () => {
  const h = harness();
  harness.body = { provider: 'mistral', username: 'troy@example.com', password: PASSWORD, tenantId: 'tenant-b' };
  await handleCredentialConnectRoute(h.deps);
  assert.equal(h.sent[0].status, 400);
  assert.equal(h.storeCalls.length, 0);
  assert.equal(h.inserts.length, 0);
});

test('tenant scoping: a second tenant writes only its own reference and row', async () => {
  const h = harness({ actor: { tenantId: 'tenant-b', subject: 'user-b', role: 'owner', sessionId: 'sess-b', requestId: 'req-b' } });
  harness.body = { provider: 'claude', username: 'b@example.com', password: PASSWORD };
  await handleCredentialConnectRoute(h.deps);
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.storeCalls[0].tenantId, 'tenant-b');
  assert.equal(h.storeCalls[0].credentialReference, 'vault://tenant/tenant-b/claude/password');
  assert.equal(h.inserts[0][0], 'tenant-b');
});

test('member role is refused 403 and stores nothing', async () => {
  const h = harness({ actor: { ...ownerActor, role: 'member' } });
  harness.body = { provider: 'mistral', username: 'troy@example.com', password: PASSWORD };
  await handleCredentialConnectRoute(h.deps);
  assert.equal(h.sent[0].status, 403);
  assert.equal(h.storeCalls.length, 0);
});

test('desktop-link-token owner stores: the person enters credentials in their own desktop app (2026-11-04)', async () => {
  // The desktop link token is bound to the owner's subject at exchange;
  // with their real owner role it is the same person on the other
  // client, so the store proceeds exactly like the session road.
  const h = harness({ actor: { ...ownerActor, viaDeviceToken: true } });
  harness.body = { provider: 'mistral', username: 'troy@example.com', password: PASSWORD };
  await handleCredentialConnectRoute(h.deps);
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.storeCalls.length, 1);
  assert.equal(h.inserts.length, 1);
});

test('desktop-link-token member is still refused 403: the role gate holds on the device road', async () => {
  const h = harness({ actor: { ...ownerActor, role: 'member', viaDeviceToken: true } });
  harness.body = { provider: 'mistral', username: 'troy@example.com', password: PASSWORD };
  await handleCredentialConnectRoute(h.deps);
  assert.equal(h.sent[0].status, 403);
  assert.equal(h.storeCalls.length, 0);
});

const API_KEY = 'TESTAPIKEY-do-not-leak-91c4';

test('api key store: kind api_key lands in the vault, an api_key row is recorded, the key never appears in the response', async () => {
  const h = harness();
  harness.body = { provider: 'runway', apiKey: API_KEY };
  assert.equal(await handleCredentialConnectRoute(h.deps), true);
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.sent[0].body.stored, true);
  assert.equal(h.sent[0].body.connectionRecorded, true);
  assert.equal(h.sent[0].body.connection.authMode, 'api_key');
  assert.equal(h.sent[0].body.connection.credentialReference, 'vault://tenant/tenant-a/runway/api-key');
  assert.ok(!JSON.stringify(h.sent[0].body).includes(API_KEY));
  assert.equal(h.storeCalls.length, 1);
  const call = h.storeCalls[0];
  assert.equal(call.credentialKind, 'api_key');
  assert.equal(call.apiKey, API_KEY);
  assert.equal(call.credentialReference, 'vault://tenant/tenant-a/runway/api-key');
  assert.equal(h.inserts.length, 1);
});

test('api key store is a backup: with a connection row already present the vault stores and the row is untouched', async () => {
  const existing = { provider_id: 'claude', auth_mode: 'password_session', credential_reference: 'vault://tenant/tenant-a/claude/password', lifecycle: 'pending', adapter: 'credential_service', updated_at: new Date().toISOString() };
  const h = harness({ existingRow: existing });
  harness.body = { provider: 'claude', apiKey: API_KEY };
  await handleCredentialConnectRoute(h.deps);
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.sent[0].body.connectionRecorded, false);
  assert.equal(h.sent[0].body.connection.authMode, 'password_session', 'the primary record is not replaced by the backup key');
  assert.equal(h.storeCalls.length, 1);
  assert.equal(h.storeCalls[0].credentialKind, 'api_key');
});

test('an API key and a password pair in one body are refused 400, and heygen is an accepted API-key provider', async () => {
  const h1 = harness();
  harness.body = { provider: 'claude', username: 'troy@example.com', password: PASSWORD, apiKey: API_KEY };
  await handleCredentialConnectRoute(h1.deps);
  assert.equal(h1.sent[0].status, 400);
  assert.equal(h1.storeCalls.length, 0);
  const h2 = harness();
  harness.body = { provider: 'heygen', apiKey: API_KEY };
  await handleCredentialConnectRoute(h2.deps);
  assert.equal(h2.sent[0].status, 200);
  assert.equal(h2.storeCalls[0].providerId, 'heygen');
});

test('unknown provider and missing password are refused 400', async () => {
  const h1 = harness();
  harness.body = { provider: 'nope', username: 'troy@example.com', password: PASSWORD };
  await handleCredentialConnectRoute(h1.deps);
  assert.equal(h1.sent[0].status, 400);
  const h2 = harness();
  harness.body = { provider: 'mistral', username: 'troy@example.com' };
  await handleCredentialConnectRoute(h2.deps);
  assert.equal(h2.sent[0].status, 400);
  assert.equal(h2.storeCalls.length, 0);
});

test('a Guard-refused store maps to 403 and writes no connection row', async () => {
  const h = harness({ storeResult: { accepted: false, status: 'guard_approval_required', secretMaterial: 'not_returned', providerInvocation: 'not_performed' } });
  harness.body = { provider: 'mistral', username: 'troy@example.com', password: PASSWORD };
  await handleCredentialConnectRoute(h.deps);
  assert.equal(h.sent[0].status, 403);
  assert.equal(h.sent[0].body.code, 'CREDENTIAL_STORE_REFUSED');
  assert.equal(h.inserts.length, 0);
});

test('an unreachable credential service maps to 502 and writes no connection row', async () => {
  const h = harness({ storeResult: { accepted: false, status: 'credential_service_unreachable', secretMaterial: 'not_returned', providerInvocation: 'not_performed' } });
  harness.body = { provider: 'mistral', username: 'troy@example.com', password: PASSWORD };
  await handleCredentialConnectRoute(h.deps);
  assert.equal(h.sent[0].status, 502);
  assert.equal(h.inserts.length, 0);
});

test('writer refuses when the membership role does not match the claimed role', async () => {
  const { pool, inserts } = makeFakePool({ membershipRole: 'member' });
  const writer = createProviderConnectionWriter(pool);
  await assert.rejects(
    () => writer.recordPasswordSession(
      { tenantId: 'tenant-a', actorSubject: 'user-a', actorRole: 'owner', sessionId: 's', requestId: 'r' },
      { providerId: 'mistral', credentialReference: credentialReferenceFor('tenant-a', 'mistral') },
    ),
    (error) => error instanceof TenantAuthorizationError,
  );
  assert.equal(inserts.length, 0);
});

test('reference format and env client gating', () => {
  assert.equal(credentialReferenceFor('t-1', 'grok'), 'vault://tenant/t-1/grok/password');
  assert.equal(credentialApiKeyReferenceFor('t-1', 'grok'), 'vault://tenant/t-1/grok/api-key');
  assert.equal(createCredentialConnectClient({}), null);
  assert.equal(createCredentialConnectClient({ HELMION_CREDENTIAL_SERVICE_URL: 'https://creds.example' }), null);
  const client = createCredentialConnectClient({ HELMION_CREDENTIAL_SERVICE_URL: 'https://creds.example', HELMION_CREDENTIAL_SERVICE_TOKEN: 'tok' });
  assert.equal(typeof client.storeCredential, 'function');
});
