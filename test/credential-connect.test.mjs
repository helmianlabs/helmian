// Credential connect route tests: the store path (kind 'password' into
// the credential service + a password_session provider_connections row),
// tenant scoping (the tenant comes from the verified actor; a body that
// tries to name one is refused), role/device gates, refusal mapping, and
// the guarantee that the password never appears in any response.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREDENTIAL_CONNECT_PATH,
  createCredentialConnectClient,
  createProviderConnectionWriter,
  credentialReferenceFor,
  handleCredentialConnectRoute,
} from '../src/cloud/credential-connect.mjs';
import { TenantAuthorizationError } from '../src/core/tenant-context.mjs';

const PASSWORD = 'TESTPASSWORD-do-not-leak-47e2';

const ownerActor = { tenantId: 'tenant-a', subject: 'user-a', role: 'owner', sessionId: 'sess-a', requestId: 'req-a' };

function makeFakePool({ membershipRole = 'owner' } = {}) {
  const inserts = [];
  const client = {
    query: async (sql, params = []) => {
      const text = String(sql);
      if (['begin', 'commit', 'rollback'].includes(text)) return { rowCount: 0, rows: [] };
      if (text.includes('set_config')) return { rowCount: 1, rows: [] };
      if (text.includes('from helmion.tenant_memberships')) {
        return { rowCount: 1, rows: [{ role: membershipRole }] };
      }
      if (text.includes('insert into helmion.provider_connections')) {
        inserts.push(params);
        return { rowCount: 1, rows: [{ provider_id: params[1], auth_mode: 'password_session', credential_reference: params[2], lifecycle: 'pending', adapter: 'credential_service', updated_at: new Date().toISOString() }] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    release: () => {},
  };
  return { pool: { connect: async () => client }, inserts };
}

function harness({ actor = ownerActor, storeResult = { accepted: true, status: 'stored_in_credential_vault' }, membershipRole = 'owner' } = {}) {
  const sent = [];
  const storeCalls = [];
  const { pool, inserts } = makeFakePool({ membershipRole });
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

test('non-POST is refused 405 and stores nothing', async () => {
  const { deps, sent, storeCalls } = harness();
  deps.request = { method: 'GET' };
  assert.equal(await handleCredentialConnectRoute(deps), true);
  assert.equal(sent[0].status, 405);
  assert.equal(storeCalls.length, 0);
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

test('device-token actors are refused: devices hold sessions, they do not enter passwords', async () => {
  const h = harness({ actor: { ...ownerActor, viaDeviceToken: true } });
  harness.body = { provider: 'mistral', username: 'troy@example.com', password: PASSWORD };
  await handleCredentialConnectRoute(h.deps);
  assert.equal(h.sent[0].status, 403);
  assert.equal(h.storeCalls.length, 0);
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
  assert.equal(createCredentialConnectClient({}), null);
  assert.equal(createCredentialConnectClient({ HELMION_CREDENTIAL_SERVICE_URL: 'https://creds.example' }), null);
  const client = createCredentialConnectClient({ HELMION_CREDENTIAL_SERVICE_URL: 'https://creds.example', HELMION_CREDENTIAL_SERVICE_TOKEN: 'tok' });
  assert.equal(typeof client.storeCredential, 'function');
});
