// Credential vault v2 gates (cloud-connect design §7 bite 1):
// round-trips per credential kind, cross-tenant refusal, envelope
// rewrap/shred properties, audit events carrying no secret material,
// Guard-gate refusals, credential-service refusal paths, and the legacy
// OAuth adapter surface behaving exactly as before.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createCredentialVault } from '../src/cloud/credential-vault.mjs';
import { createDatabaseEncryptedVaultAdapter } from '../src/cloud/database-encrypted-vault-adapter.mjs';
import { createCredentialService, createCredentialServiceAuditLog, createGuardApprovalGate, createMemoryAuditLog } from '../src/cloud/credential-service.mjs';
import { createCredentialServiceClient, createCredentialServiceVaultAdapter } from '../src/cloud/credential-service-client.mjs';

const MASTER_1 = randomBytes(32).toString('base64url');
const MASTER_2 = randomBytes(32).toString('base64url');
const SECRET = 'TESTSECRET-do-not-leak-7f3a';
const PASSWORD = 'TESTPASSWORD-do-not-leak-91bc';

const actorA = { tenantId: 'tenant-a', actorSubject: 'user-a', actorRole: 'owner', sessionId: 'sess-a', requestId: 'req-a' };
const actorB = { tenantId: 'tenant-b', actorSubject: 'user-b', actorRole: 'owner', sessionId: 'sess-b', requestId: 'req-b' };
const ref = (tenant, name) => `vault://tenant/${tenant}/${name}`;

function fakePool() {
  const members = new Set(['tenant-a:user-a', 'tenant-b:user-b']);
  const tenantKeys = new Map();
  const credentials = new Map();
  const oauthTokens = new Map();
  let nextId = 1;
  const key3 = (t, p, r) => `${t}|${p}|${r}`;
  const client = {
    async query(sql, values = []) {
      const text = String(sql);
      if (['begin', 'commit', 'rollback'].includes(text)) return { rowCount: 0, rows: [] };
      if (text.includes('set_config')) return { rowCount: 1, rows: [] };
      if (text.includes('from helmion.tenant_memberships')) {
        return members.has(`${values[0]}:${values[1]}`) ? { rowCount: 1, rows: [{ role: 'owner' }] } : { rowCount: 0, rows: [] };
      }
      if (text.includes('from helmion.tenant_vault_keys') && text.includes('shredded_at is null')) {
        const rows = [...tenantKeys.entries()].filter(([, row]) => !row.shredded_at).map(([tenant_id, row]) => ({ tenant_id, ...row }));
        return { rowCount: rows.length, rows };
      }
      if (text.includes('select wrapped_data_key') && text.includes('helmion.tenant_vault_keys')) {
        const row = tenantKeys.get(values[0]);
        return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
      }
      if (text.includes('insert into helmion.tenant_vault_keys')) {
        if (tenantKeys.has(values[0])) return { rowCount: 0, rows: [] };
        tenantKeys.set(values[0], { wrapped_data_key: values[1], wrap_iv: values[2], wrap_auth_tag: values[3], key_version: 1, shredded_at: null });
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('update helmion.tenant_vault_keys') && text.includes('shredded_at=clock_timestamp()')) {
        const row = tenantKeys.get(values[0]);
        if (!row || row.shredded_at) return { rowCount: 0, rows: [] };
        row.wrapped_data_key = values[1]; row.shredded_at = new Date();
        return { rowCount: 1, rows: [{ tenant_id: values[0] }] };
      }
      if (text.includes('update helmion.tenant_vault_keys') && text.includes('key_version=key_version+1')) {
        const row = tenantKeys.get(values[0]);
        if (!row) return { rowCount: 0, rows: [] };
        row.wrapped_data_key = values[1]; row.wrap_iv = values[2]; row.wrap_auth_tag = values[3]; row.key_version += 1;
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('select credential_kind, revoked_at, expires_at from helmion.provider_credentials')) {
        const row = credentials.get(key3(values[0], values[1], values[2]));
        return row ? { rowCount: 1, rows: [{ credential_kind: row.credential_kind, revoked_at: row.revoked_at, expires_at: row.expires_at }] } : { rowCount: 0, rows: [] };
      }
      if (text.includes('insert into helmion.provider_credentials')) {
        const [tenant_id, provider_id, credential_reference, credential_kind, rk, rkIv, rkTag, ct, iv, tag, tokenType, scope, expiresAt, subject] = values;
        const k = key3(tenant_id, provider_id, credential_reference);
        const prior = credentials.get(k);
        const row = { id: prior?.id ?? nextId++, tenant_id, provider_id, credential_reference, credential_kind, record_key_wrapped: rk, record_key_iv: rkIv, record_key_auth_tag: rkTag, ciphertext: ct, iv, auth_tag: tag, token_type: tokenType, scope, expires_at: expiresAt, updated_by_subject: subject, revoked_at: null };
        credentials.set(k, row);
        return { rowCount: 1, rows: [{ id: row.id }] };
      }
      if (text.includes('select credential_kind, record_key_wrapped')) {
        const row = credentials.get(key3(values[0], values[1], values[2]));
        if (!row || row.revoked_at || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [row] };
      }
      if (text.includes('update helmion.provider_credentials set revoked_at')) {
        const row = credentials.get(key3(values[0], values[1], values[2]));
        if (!row || row.revoked_at) return { rowCount: 0, rows: [] };
        row.revoked_at = new Date();
        return { rowCount: 1, rows: [{ credential_kind: row.credential_kind }] };
      }
      if (text.includes('insert into helmion.provider_oauth_tokens')) {
        oauthTokens.set(key3(values[0], values[1], values[2]), { ciphertext: values[3], iv: values[4], auth_tag: values[5], token_type: values[6] });
        return { rowCount: 1, rows: [{ id: 17 }] };
      }
      if (text.includes('from helmion.provider_oauth_tokens')) {
        const row = oauthTokens.get(key3(values[0], values[1], values[2]));
        return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
    release() {},
  };
  return { pool: { async connect() { return client; } }, tenantKeys, credentials };
}

function makeVault(pool, { master = MASTER_1, auditSink = null, guardGate = null } = {}) {
  return createCredentialVault({ pool, masterKey: master, auditSink, guardGate });
}

test('round-trip: api_key for a custom provider id only the user named', async () => {
  const { pool } = fakePool();
  const vault = makeVault(pool);
  const input = { ...actorA, providerId: 'my-custom-model', credentialReference: ref('tenant-a', 'my-custom-model'), credentialKind: 'api_key', apiKey: SECRET };
  const stored = await vault.storeCredential(input);
  assert.equal(stored.accepted, true);
  assert.equal(stored.status, 'stored_in_credential_vault');
  const resolved = await vault.resolveCredential({ ...input, reasonClass: 'provider_call' });
  assert.equal(resolved.accepted, true);
  assert.equal(resolved.credential, SECRET);
  assert.equal(resolved.credentialKind, 'api_key');
});

test('round-trip: oauth_bundle returns access and refresh tokens', async () => {
  const { pool } = fakePool();
  const vault = makeVault(pool);
  const input = { ...actorA, providerId: 'gemini', credentialReference: ref('tenant-a', 'gemini-oauth'), credentialKind: 'oauth_bundle', accessToken: SECRET, refreshToken: 'refresh-1', expiresIn: 3600 };
  await vault.storeCredential(input);
  const resolved = await vault.resolveCredential({ ...input, reasonClass: 'oauth_refresh' });
  assert.equal(resolved.credential, SECRET);
  assert.equal(resolved.refreshToken, 'refresh-1');
});

test('round-trip: password (gate approving) returns password and username', async () => {
  const { pool } = fakePool();
  const vault = makeVault(pool, { guardGate: async () => ({ approved: true }) });
  const input = { ...actorA, providerId: 'claude', credentialReference: ref('tenant-a', 'claude-web'), credentialKind: 'password', username: 'troy@example.com', password: PASSWORD };
  await vault.storeCredential(input);
  const resolved = await vault.resolveCredential({ ...input, reasonClass: 'browser_sign_in' });
  assert.equal(resolved.credential, PASSWORD);
  assert.equal(resolved.username, 'troy@example.com');
});

test('round-trip: session payload returns the stored JSON value', async () => {
  const { pool } = fakePool();
  const vault = makeVault(pool);
  const session = { cookies: [{ name: 'sid', value: 'abc' }], origin: 'https://chat.example' };
  const input = { ...actorA, providerId: 'grok', credentialReference: ref('tenant-a', 'grok-web'), credentialKind: 'session', session };
  await vault.storeCredential(input);
  const resolved = await vault.resolveCredential({ ...input, reasonClass: 'browser_sign_in' });
  assert.deepEqual(resolved.session, session);
});

test('wrong tenant: cross-tenant reference is refused before any lookup', async () => {
  const { pool } = fakePool();
  const vault = makeVault(pool);
  await vault.storeCredential({ ...actorA, providerId: 'claude', credentialReference: ref('tenant-a', 'claude-main'), credentialKind: 'api_key', apiKey: SECRET });
  await assert.rejects(() => vault.resolveCredential({ ...actorB, providerId: 'claude', credentialReference: ref('tenant-a', 'claude-main'), reasonClass: 'provider_call' }), /reference is invalid/);
  const own = await vault.resolveCredential({ ...actorB, providerId: 'claude', credentialReference: ref('tenant-b', 'claude-main'), reasonClass: 'provider_call' });
  assert.equal(own.accepted, false);
  assert.equal(own.status, 'credential_not_available');
});

test('wrong tenant: a row transplanted under another tenant does not decrypt', async () => {
  const { pool, credentials } = fakePool();
  const vault = makeVault(pool);
  const inputA = { ...actorA, providerId: 'claude', credentialReference: ref('tenant-a', 'shared-name'), credentialKind: 'api_key', apiKey: SECRET };
  await vault.storeCredential(inputA);
  await vault.storeCredential({ ...actorB, providerId: 'claude', credentialReference: ref('tenant-b', 'shared-name'), credentialKind: 'api_key', apiKey: 'tenant-b-key' });
  const rowA = credentials.get('tenant-a|claude|' + ref('tenant-a', 'shared-name'));
  const rowB = credentials.get('tenant-b|claude|' + ref('tenant-b', 'shared-name'));
  rowB.record_key_wrapped = rowA.record_key_wrapped; rowB.record_key_iv = rowA.record_key_iv; rowB.record_key_auth_tag = rowA.record_key_auth_tag;
  rowB.ciphertext = rowA.ciphertext; rowB.iv = rowA.iv; rowB.auth_tag = rowA.auth_tag;
  await assert.rejects(() => vault.resolveCredential({ ...actorB, providerId: 'claude', credentialReference: ref('tenant-b', 'shared-name'), reasonClass: 'provider_call' }), /could not be decrypted/);
});

test('refusals: missing actor context and missing reason class throw before storage', async () => {
  const { pool } = fakePool();
  const vault = makeVault(pool);
  const base = { providerId: 'claude', credentialReference: ref('tenant-a', 'x'), credentialKind: 'api_key', apiKey: SECRET };
  await assert.rejects(() => vault.storeCredential({ ...base, tenantId: 'tenant-a' }), /actor context is required/);
  await assert.rejects(() => vault.resolveCredential({ ...actorA, ...base }), /reason class is required/);
  await assert.rejects(() => vault.resolveCredential({ ...actorA, ...base, reasonClass: 'whenever' }), /reason class is required/);
});

test('envelope: master rewrap preserves payloads; the old master then fails', async () => {
  const { pool } = fakePool();
  const vault1 = makeVault(pool);
  const input = { ...actorA, providerId: 'openai_codex', credentialReference: ref('tenant-a', 'codex-key'), credentialKind: 'api_key', apiKey: SECRET };
  await vault1.storeCredential(input);
  const vault2 = makeVault(pool, { master: MASTER_2 });
  const before = await vault2.resolveCredential({ ...input, reasonClass: 'provider_call' });
  assert.equal(before.accepted, false);
  const rewrapped = await vault1.rewrapTenantKeys({ nextMasterKey: MASTER_2 });
  assert.equal(rewrapped.rewrapped, 1);
  const after = await vault2.resolveCredential({ ...input, reasonClass: 'provider_call' });
  assert.equal(after.accepted, true);
  assert.equal(after.credential, SECRET);
  const stale = await vault1.resolveCredential({ ...input, reasonClass: 'provider_call' });
  assert.equal(stale.accepted, false);
});

test('envelope: tenant shred makes every record unrecoverable and blocks new stores', async () => {
  const { pool } = fakePool();
  const vault = makeVault(pool);
  const input = { ...actorA, providerId: 'claude', credentialReference: ref('tenant-a', 'to-shred'), credentialKind: 'api_key', apiKey: SECRET };
  await vault.storeCredential(input);
  await vault.storeCredential({ ...actorB, providerId: 'claude', credentialReference: ref('tenant-b', 'keep'), credentialKind: 'api_key', apiKey: 'b-key' });
  const shredded = await vault.shredTenant({ ...actorA });
  assert.equal(shredded.status, 'tenant_vault_shredded');
  const gone = await vault.resolveCredential({ ...input, reasonClass: 'provider_call' });
  assert.equal(gone.accepted, false);
  const blocked = await vault.storeCredential({ ...input, credentialReference: ref('tenant-a', 'after-shred'), apiKey: 'new' });
  assert.equal(blocked.status, 'tenant_vault_shredded');
  const survivor = await vault.resolveCredential({ ...actorB, providerId: 'claude', credentialReference: ref('tenant-b', 'keep'), reasonClass: 'provider_call' });
  assert.equal(survivor.credential, 'b-key');
});

test('audit: lifecycle events are recorded and contain no secret material', async () => {
  const { pool } = fakePool();
  const log = createMemoryAuditLog();
  const vault = makeVault(pool, { auditSink: log.sink, guardGate: async () => ({ approved: true }) });
  const input = { ...actorA, providerId: 'claude', credentialReference: ref('tenant-a', 'audited'), credentialKind: 'password', username: 'u@example', password: PASSWORD };
  await vault.storeCredential(input);
  await vault.resolveCredential({ ...input, reasonClass: 'browser_sign_in' });
  await vault.revokeCredential(input);
  const actions = log.events.map((event) => event.action);
  assert.deepEqual(actions, ['credential.stored', 'credential.resolved', 'credential.revoked']);
  assert.equal(log.events[1].reasonClass, 'browser_sign_in');
  const serialized = JSON.stringify(log.events);
  assert.equal(serialized.includes(PASSWORD), false);
  assert.equal(serialized.includes('u@example'), false);
  for (const event of log.events) assert.equal(event.secretMaterial, 'not_received');
});

test('gate: without a gate, password resolves and replacements are refused, never waved through', async () => {
  const { pool } = fakePool();
  const vault = makeVault(pool);
  const pw = { ...actorA, providerId: 'claude', credentialReference: ref('tenant-a', 'pw'), credentialKind: 'password', password: PASSWORD };
  const first = await vault.storeCredential(pw);
  assert.equal(first.accepted, true);
  const resolve = await vault.resolveCredential({ ...pw, reasonClass: 'browser_sign_in' });
  assert.equal(resolve.status, 'guard_gate_not_configured');
  const key = { ...actorA, providerId: 'gemini', credentialReference: ref('tenant-a', 'k'), credentialKind: 'api_key', apiKey: SECRET };
  await vault.storeCredential(key);
  const replacement = await vault.storeCredential({ ...key, apiKey: 'rotated' });
  assert.equal(replacement.status, 'guard_gate_not_configured');
  const stillOriginal = await vault.resolveCredential({ ...key, reasonClass: 'provider_call' });
  assert.equal(stillOriginal.credential, SECRET);
});

test('gate: a denying gate refuses; an approving gate lets the same operations through', async () => {
  const { pool } = fakePool();
  const denying = makeVault(pool, { guardGate: async () => ({ approved: false }) });
  const pw = { ...actorA, providerId: 'claude', credentialReference: ref('tenant-a', 'pw2'), credentialKind: 'password', password: PASSWORD };
  await denying.storeCredential(pw);
  const refused = await denying.resolveCredential({ ...pw, reasonClass: 'browser_sign_in' });
  assert.equal(refused.status, 'guard_approval_required');
  const approving = makeVault(pool, { guardGate: async () => ({ approved: true }) });
  const replaced = await approving.storeCredential({ ...pw, password: 'new-password' });
  assert.equal(replaced.status, 'credential_replaced_in_vault');
  const resolved = await approving.resolveCredential({ ...pw, reasonClass: 'browser_sign_in' });
  assert.equal(resolved.credential, 'new-password');
});

test('service: refusal paths — no identity, no actor context, no reason class', async () => {
  const { pool } = fakePool();
  const log = createMemoryAuditLog();
  const vault = makeVault(pool, { auditSink: log.sink });
  const service = createCredentialService({ vault, serviceToken: 'svc-token', auditLog: null });
  const health = await service.handle({ method: 'GET', path: '/healthz' });
  assert.equal(health.status, 200);
  const noToken = await service.handle({ method: 'POST', path: '/v1/credentials/resolve', headers: {}, body: '{}' });
  assert.equal(noToken.status, 401);
  assert.equal(noToken.body.status, 'service_unauthorized');
  const wrongToken = await service.handle({ method: 'POST', path: '/v1/credentials/resolve', headers: { authorization: 'Bearer nope' }, body: '{}' });
  assert.equal(wrongToken.status, 401);
  const auth = { authorization: 'Bearer svc-token' };
  const noActor = await service.handle({ method: 'POST', path: '/v1/credentials/store', headers: auth, body: JSON.stringify({ providerId: 'claude', credentialReference: ref('tenant-a', 'x'), credentialKind: 'api_key', apiKey: SECRET }) });
  assert.equal(noActor.status, 400);
  assert.equal(noActor.body.status, 'actor_context_required');
  const noReason = await service.handle({ method: 'POST', path: '/v1/credentials/resolve', headers: auth, body: JSON.stringify({ ...actorA, providerId: 'claude', credentialReference: ref('tenant-a', 'x') }) });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.status, 'reason_class_required');
});

test('service: store + resolve round-trip and the 403/404 refusal mapping', async () => {
  const { pool } = fakePool();
  const vault = makeVault(pool);
  const service = createCredentialService({ vault, serviceToken: 'svc-token', auditLog: null });
  const auth = { authorization: 'Bearer svc-token' };
  const input = { ...actorA, providerId: 'claude', credentialReference: ref('tenant-a', 'svc'), credentialKind: 'api_key', apiKey: SECRET };
  const stored = await service.handle({ method: 'POST', path: '/v1/credentials/store', headers: auth, body: JSON.stringify(input) });
  assert.equal(stored.status, 200);
  assert.equal(stored.body.accepted, true);
  const resolved = await service.handle({ method: 'POST', path: '/v1/credentials/resolve', headers: auth, body: JSON.stringify({ ...input, reasonClass: 'provider_call' }) });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.credential, SECRET);
  const missing = await service.handle({ method: 'POST', path: '/v1/credentials/resolve', headers: auth, body: JSON.stringify({ ...input, credentialReference: ref('tenant-a', 'absent'), reasonClass: 'provider_call' }) });
  assert.equal(missing.status, 404);
  const pw = { ...actorA, providerId: 'claude', credentialReference: ref('tenant-a', 'svc-pw'), credentialKind: 'password', password: PASSWORD };
  await service.handle({ method: 'POST', path: '/v1/credentials/store', headers: auth, body: JSON.stringify(pw) });
  const gated = await service.handle({ method: 'POST', path: '/v1/credentials/resolve', headers: auth, body: JSON.stringify({ ...pw, reasonClass: 'browser_sign_in' }) });
  assert.equal(gated.status, 403);
  assert.equal(gated.body.status, 'guard_gate_not_configured');
});

test('gate client: ask -> human approval approves; an immediate deny does not', async () => {
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    seen.push({ url, body: options.body ? JSON.parse(options.body) : null });
    if (url.endsWith('/v1/decisions')) return { status: 202, ok: true, json: async () => ({ approvalId: 'appr-1' }) };
    return { status: 200, ok: true, json: async () => ({ status: 'approved' }) };
  };
  const gate = createGuardApprovalGate({ guardUrl: 'http://guard.local', deviceToken: 'dev-token', fetchImpl, pollIntervalMs: 1, timeoutMs: 5000 });
  const decision = await gate({ action: 'credential.password_resolve', tenantId: 'tenant-a', actorSubject: 'user-a', providerId: 'claude', credentialKind: 'password', credentialReference: ref('tenant-a', 'pw') });
  assert.equal(decision.approved, true);
  assert.deepEqual(seen[0].body.action.riskSignals, ['credential:password_resolve']);
  assert.equal(JSON.stringify(seen).includes(PASSWORD), false);
  const denyGate = createGuardApprovalGate({ guardUrl: 'http://guard.local', deviceToken: 'dev-token', fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ verdict: 'deny' }) }) });
  const denied = await denyGate({ action: 'credential.replace', tenantId: 'tenant-a', actorSubject: 'user-a', providerId: 'claude', credentialKind: 'api_key', credentialReference: ref('tenant-a', 'k') });
  assert.equal(denied.approved, false);
});

test('client contract: the app-side client round-trips through the service handler', async () => {
  const { pool } = fakePool();
  const vault = makeVault(pool);
  const service = createCredentialService({ vault, serviceToken: 'svc-token', auditLog: null });
  const fetchImpl = async (url, options = {}) => {
    const { pathname } = new URL(url);
    const result = await service.handle({ method: options.method, path: pathname, headers: options.headers, body: options.body });
    return { status: result.status, ok: result.status < 400, json: async () => result.body };
  };
  const client = createCredentialServiceClient({ baseUrl: 'http://credsvc.local', serviceToken: 'svc-token', fetchImpl });
  const input = { ...actorA, providerId: 'gemini', credentialReference: ref('tenant-a', 'via-client'), credentialKind: 'api_key', apiKey: SECRET };
  const stored = await client.storeCredential(input);
  assert.equal(stored.accepted, true);
  const resolved = await client.resolveVaultCredential({ ...input, reasonClass: 'probe' });
  assert.equal(resolved.credential, SECRET);
  const adapter = createCredentialServiceVaultAdapter({ client });
  const legacy = await adapter.resolveCredential({ tenantId: 'tenant-a', providerId: 'gemini', credentialReference: ref('tenant-a', 'via-client'), actorSubject: 'user-a', actorRole: 'owner', sessionId: 'sess-a', requestId: 'req-a' });
  assert.equal(legacy.status, 'credential_resolved_for_adapter');
  assert.equal(legacy.credential, SECRET);
});

test('audit log file: hash chain links and no secret reaches a line', async () => {
  const dir = mkdtempSync(join(process.cwd(), 'test', '.tmp-cred-audit-'));
  try {
    const log = createCredentialServiceAuditLog({ path: join(dir, 'audit.jsonl') });
    await log.sink(null, actorA, { action: 'credential.resolved', providerId: 'claude', credentialKind: 'api_key', credentialReference: ref('tenant-a', 'x'), reasonClass: 'provider_call', secretMaterial: 'not_received' });
    await log.sink(null, actorA, { action: 'credential.stored', providerId: 'claude', credentialKind: 'api_key', credentialReference: ref('tenant-a', 'x'), secretMaterial: 'not_received' });
    const lines = readFileSync(join(dir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[1].prevHash, lines[0].hash);
    assert.equal(JSON.stringify(lines).includes(SECRET), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy adapter: OAuth surface unchanged; generalized surface rides the same adapter', async () => {
  const { pool } = fakePool();
  const adapter = createDatabaseEncryptedVaultAdapter({ pool, key: MASTER_1 });
  const oauth = { ...actorA, providerId: 'gemini', credentialReference: ref('tenant-a', 'gemini-oauth'), accessToken: SECRET, refreshToken: 'refresh-1' };
  const stored = await adapter.storeOAuthTokens(oauth);
  assert.equal(stored.status, 'stored_in_database_encrypted_vault');
  const resolved = await adapter.resolveCredential({ tenantId: 'tenant-a', providerId: 'gemini', credentialReference: ref('tenant-a', 'gemini-oauth'), actorSubject: 'user-a', actorRole: 'owner', sessionId: 'sess-a', requestId: 'req-a' });
  assert.equal(resolved.status, 'credential_resolved_for_adapter');
  assert.equal(resolved.credential, SECRET);
  await assert.rejects(() => adapter.prepareReference({ tenantId: 'tenant-a', providerId: 'some-custom-model', credentialReference: ref('tenant-a', 'x') }), /reference is invalid/);
  const generalized = await adapter.storeCredential({ ...actorA, providerId: 'some-custom-model', credentialReference: ref('tenant-a', 'x'), credentialKind: 'api_key', apiKey: SECRET });
  assert.equal(generalized.accepted, true);
  const back = await adapter.resolveVaultCredential({ ...actorA, providerId: 'some-custom-model', credentialReference: ref('tenant-a', 'x'), reasonClass: 'provider_call' });
  assert.equal(back.credential, SECRET);
});

test('migration 063: shape is additive, widens the store, keeps the repository conflict target', () => {
  const sql = readFileSync(new URL('../sql/063_helmion_credential_vault_v2.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table if not exists helmion\.tenant_vault_keys/);
  assert.match(sql, /create table if not exists helmion\.provider_credentials/);
  assert.match(sql, /'password_session','desktop_tool'/);
  assert.match(sql, /'needs_attention'/);
  assert.match(sql, /last_verified_at timestamptz/);
  assert.equal(sql.includes('drop constraint if exists provider_connections_tenant_id_provider_id_key'), false);
  assert.equal(sql.includes('unique (tenant_id, provider_id, auth_mode)'), false);
});
