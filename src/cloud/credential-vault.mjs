// Credential vault v2 — the generalized custody core (cloud-connect design
// §5, build bite 1). One vault for every credential kind a cloud connection
// can hold — api_key, oauth_bundle, password, session — for any provider id,
// including the user's own name for a custom model.
//
// ENVELOPE, three layers, all AES-256-GCM with node:crypto:
//   master key   (credential service env only; never in this process's DB)
//     wraps -> tenant data key   (helmion.tenant_vault_keys, wrapped)
//       wraps -> per-record key  (stored wrapped beside each record)
//         encrypts -> the credential payload
// Rotating the master key re-wraps tenant keys only — payloads are never
// re-encrypted. Shredding a tenant destroys its wrapped data key, which
// kills every credential that tenant ever held; that is also the account-
// deletion behavior.
//
// DISCIPLINE (mirrors database-encrypted-vault-adapter.mjs):
//   - Every store/resolve/revoke requires the full actor context (tenant,
//     subject, role, session, request) and runs inside a tenant transaction
//     with an active-membership check.
//   - References are server-minted vault://tenant/<tenant>/<connection>
//     strings, validated strictly; a reference naming another tenant fails
//     before any lookup. AAD binds ciphertext to tenant + provider +
//     reference (+ kind), so a row transplanted to another tenant or kind
//     does not decrypt.
//   - Plaintext exists only in the memory of the resolving call. Audit
//     events (when a sink is wired) carry lifecycle facts and reason
//     CLASSES only — never any part of a key, password, token, cookie, or
//     code, and never a provider response body.
//
// GUARD GATING (design §5.5): two operations route through a Guard approval
// before they happen — replacing the credential on an existing connection,
// and any resolve of a password record. The gate is injected
// (guardGate); when none is configured those operations are REFUSED
// ('guard_gate_not_configured'), never silently allowed. The gate runs
// outside the write transaction: a human approval must never hold a
// database transaction open. (The replacement check therefore reads first
// and gates second; a record created in between is a new record, not a
// replacement, and is not gated — the gate's purpose is oversight of
// replacements, and the audit trail shows every store either way.)

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';

export const CREDENTIAL_KINDS = Object.freeze(['api_key', 'oauth_bundle', 'password', 'session']);
export const RESOLVE_REASON_CLASSES = Object.freeze(['provider_call', 'browser_sign_in', 'probe', 'oauth_refresh', 'desktop_handshake']);

const VAULT_REFERENCE = /^vault:\/\/tenant\/[a-z0-9][a-z0-9._:-]{0,127}\/[a-z0-9._:-]{1,96}(?:\/[a-z0-9._:-]{1,96})?$/u;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const TOKEN_TYPE = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/u;
const SCOPE = /^[A-Za-z0-9:./ _-]{1,2000}$/u;
const MAX_SECRET_CHARS = 8192;
const MAX_PAYLOAD_CHARS = 65536;

export function credentialKeyBytes(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  let decoded;
  try { decoded = Buffer.from(raw, 'base64url'); } catch { return null; }
  return decoded.length === 32 ? decoded : null;
}

function validateReference({ tenantId, providerId, credentialReference } = {}) {
  const reference = String(credentialReference ?? '');
  if (!tenantId || !PROVIDER_ID.test(String(providerId ?? '')) || !VAULT_REFERENCE.test(reference) || !reference.startsWith(`vault://tenant/${String(tenantId).toLowerCase()}/`)) throw new TypeError('credential vault reference is invalid');
}

function requireActor(input = {}) {
  if (!input.tenantId || !input.actorSubject || !input.actorRole || !input.sessionId || !input.requestId) throw new TypeError('credential vault actor context is required');
  return { tenantId: input.tenantId, actorSubject: input.actorSubject, actorRole: input.actorRole, sessionId: input.sessionId, requestId: input.requestId };
}

function tenantKeyAad(tenantId) { return Buffer.from(`helmion-tenant-key-v1\0${tenantId}`, 'utf8'); }
function recordAad({ tenantId, providerId, credentialReference, credentialKind }) {
  return Buffer.from(`${tenantId}\0${providerId}\0${credentialReference}\0${credentialKind}`, 'utf8');
}

function gcmEncrypt(key, aad, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function gcmDecrypt(key, aad, { ciphertext, iv, auth_tag: authTag }) {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function secretString(value, field, { max = MAX_SECRET_CHARS } = {}) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new TypeError(`${field} is invalid`);
  return value;
}

// Normalize a store input into the JSON payload that gets encrypted, plus
// the queryable non-secret columns. Throws TypeError on any shape problem;
// the payload is the ONLY place secret material exists.
function normalizePayload(input) {
  const kind = String(input.credentialKind ?? '');
  if (!CREDENTIAL_KINDS.includes(kind)) throw new TypeError('credential kind is invalid');
  if (kind === 'api_key') {
    return { kind, payload: { apiKey: secretString(input.apiKey, 'api key') }, tokenType: 'Bearer', scope: null, expiresAt: input.expiresAt ?? null };
  }
  if (kind === 'password') {
    const payload = { password: secretString(input.password, 'password') };
    if (input.username != null) payload.username = secretString(input.username, 'username', { max: 320 });
    return { kind, payload, tokenType: 'Password', scope: null, expiresAt: input.expiresAt ?? null };
  }
  if (kind === 'oauth_bundle') {
    const payload = { accessToken: secretString(input.accessToken, 'access token'), refreshToken: input.refreshToken ?? null };
    if (payload.refreshToken != null) secretString(payload.refreshToken, 'refresh token');
    if (input.tokenType != null && !TOKEN_TYPE.test(String(input.tokenType))) throw new TypeError('token type is invalid');
    if (input.scope != null && !SCOPE.test(String(input.scope))) throw new TypeError('scope is invalid');
    const expiresAt = input.expiresAt ?? (Number.isFinite(Number(input.expiresIn)) && Number(input.expiresIn) > 0 ? new Date(Date.now() + Number(input.expiresIn) * 1000).toISOString() : null);
    return { kind, payload, tokenType: input.tokenType ?? 'Bearer', scope: input.scope ?? null, expiresAt };
  }
  // session: an opaque JSON value (cookies / session tokens the service set).
  let serialized;
  try { serialized = JSON.stringify(input.session ?? null); } catch { throw new TypeError('session payload is invalid'); }
  if (typeof serialized !== 'string' || serialized.length < 2 || serialized.length > MAX_PAYLOAD_CHARS) throw new TypeError('session payload is invalid');
  return { kind, payload: { session: serialized }, tokenType: 'Session', scope: null, expiresAt: input.expiresAt ?? null };
}

function shapeResolved(kind, payload, row) {
  const base = { status: 'credential_resolved', accepted: true, credentialKind: kind, tokenType: row.token_type ?? 'Bearer', secretMaterial: 'adapter_only', providerInvocation: 'not_performed' };
  if (kind === 'api_key') return { ...base, credential: payload.apiKey };
  if (kind === 'password') return { ...base, credential: payload.password, username: payload.username ?? null };
  if (kind === 'oauth_bundle') return { ...base, credential: payload.accessToken, refreshToken: payload.refreshToken ?? null, scope: row.scope ?? null };
  return { ...base, session: JSON.parse(payload.session) };
}

export function createCredentialVault({ pool, masterKey, auditSink = null, guardGate = null } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('credential vault requires a pool');
  const master = credentialKeyBytes(masterKey);
  if (!master) throw new TypeError('credential vault master key must be a base64url-encoded 32-byte key');

  async function emitAudit(client, context, event) {
    if (typeof auditSink !== 'function') return 'sink_not_configured';
    await auditSink(client, context, Object.freeze({
      format: 'helmion.credential-vault-event.v1',
      secretMaterial: 'not_received',
      providerInvocation: 'not_performed',
      ...event,
      tenantId: context.tenantId,
      actorSubject: context.actorSubject,
      actorRole: context.actorRole,
      sessionId: context.sessionId,
      requestId: context.requestId,
    }));
    return 'recorded';
  }

  async function runGate(action, input, context) {
    if (typeof guardGate !== 'function') return { status: 'guard_gate_not_configured', accepted: false, secretMaterial: 'not_returned', providerInvocation: 'not_performed' };
    let decision;
    try {
      decision = await guardGate({ action, tenantId: input.tenantId, actorSubject: context.actorSubject, providerId: input.providerId, credentialKind: input.credentialKind ?? null, credentialReference: input.credentialReference });
    } catch {
      return { status: 'guard_gate_unavailable', accepted: false, secretMaterial: 'not_returned', providerInvocation: 'not_performed' };
    }
    if (decision?.approved !== true) return { status: 'guard_approval_required', accepted: false, secretMaterial: 'not_returned', providerInvocation: 'not_performed' };
    return null;
  }

  // Inside a tenant transaction: load (or create) the tenant data key.
  async function tenantKey(client, tenantId, { create = false } = {}) {
    const found = await client.query('select wrapped_data_key, wrap_iv, wrap_auth_tag, shredded_at from helmion.tenant_vault_keys where tenant_id=$1', [tenantId]);
    if (found.rowCount === 1) {
      if (found.rows[0].shredded_at) return { shredded: true };
      try {
        const row = found.rows[0];
        return { key: gcmDecrypt(master, tenantKeyAad(tenantId), { ciphertext: row.wrapped_data_key, iv: row.wrap_iv, auth_tag: row.wrap_auth_tag }) };
      } catch { return { undecryptable: true }; }
    }
    if (!create) return { missing: true };
    const dataKey = randomBytes(32);
    const wrapped = gcmEncrypt(master, tenantKeyAad(tenantId), dataKey);
    await client.query('insert into helmion.tenant_vault_keys (tenant_id, wrapped_data_key, wrap_iv, wrap_auth_tag) values ($1,$2,$3,$4) on conflict (tenant_id) do nothing', [tenantId, wrapped.ciphertext, wrapped.iv, wrapped.authTag]);
    const after = await client.query('select wrapped_data_key, wrap_iv, wrap_auth_tag, shredded_at from helmion.tenant_vault_keys where tenant_id=$1', [tenantId]);
    if (after.rows[0]?.shredded_at) return { shredded: true };
    try {
      const row = after.rows[0];
      return { key: gcmDecrypt(master, tenantKeyAad(tenantId), { ciphertext: row.wrapped_data_key, iv: row.wrap_iv, auth_tag: row.wrap_auth_tag }) };
    } catch { return { undecryptable: true }; }
  }

  async function peek(client, input) {
    const result = await client.query('select credential_kind, revoked_at, expires_at from helmion.provider_credentials where tenant_id=$1 and provider_id=$2 and credential_reference=$3', [input.tenantId, input.providerId, input.credentialReference]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  return Object.freeze({
    async storeCredential(input = {}) {
      const context = requireActor(input);
      validateReference(input);
      const normalized = normalizePayload(input);
      // Replacement = an active record already sits at this reference.
      // (withTenantTransaction wraps the callback result, so the peek
      // rides out under an explicit `found` key.)
      const peeked = await withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        return { found: await peek(client, input) };
      });
      const existing = peeked.found;
      const isReplacement = Boolean(existing && !existing.revoked_at);
      if (isReplacement) {
        const refused = await runGate('credential.replace', { ...input, credentialKind: normalized.kind }, context);
        if (refused) return refused;
      }
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const tk = await tenantKey(client, input.tenantId, { create: true });
        if (tk.shredded) return { status: 'tenant_vault_shredded', accepted: false, secretMaterial: 'not_persisted', providerInvocation: 'not_performed' };
        if (!tk.key) throw new Error('tenant vault key could not be established');
        const recordKey = randomBytes(32);
        const wrappedRecordKey = gcmEncrypt(tk.key, recordAad({ ...input, credentialKind: normalized.kind }), recordKey);
        const encrypted = gcmEncrypt(recordKey, recordAad({ ...input, credentialKind: normalized.kind }), Buffer.from(JSON.stringify(normalized.payload), 'utf8'));
        const result = await client.query(`insert into helmion.provider_credentials (tenant_id, provider_id, credential_reference, credential_kind, record_key_wrapped, record_key_iv, record_key_auth_tag, ciphertext, iv, auth_tag, token_type, scope, expires_at, updated_by_subject) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict (tenant_id,provider_id,credential_reference) do update set credential_kind=excluded.credential_kind, record_key_wrapped=excluded.record_key_wrapped, record_key_iv=excluded.record_key_iv, record_key_auth_tag=excluded.record_key_auth_tag, ciphertext=excluded.ciphertext, iv=excluded.iv, auth_tag=excluded.auth_tag, token_type=excluded.token_type, scope=excluded.scope, expires_at=excluded.expires_at, updated_by_subject=excluded.updated_by_subject, updated_at=clock_timestamp(), revoked_at=null returning id`, [input.tenantId, input.providerId, input.credentialReference, normalized.kind, wrappedRecordKey.ciphertext, wrappedRecordKey.iv, wrappedRecordKey.authTag, encrypted.ciphertext, encrypted.iv, encrypted.authTag, normalized.tokenType, normalized.scope, normalized.expiresAt, input.actorSubject]);
        if (result.rowCount !== 1) throw new Error('credential vault write was not durable');
        const audit = await emitAudit(client, context, { action: isReplacement ? 'credential.replaced' : 'credential.stored', providerId: input.providerId, credentialKind: normalized.kind, credentialReference: input.credentialReference, guardGate: isReplacement ? 'approved' : 'not_required' });
        return { status: isReplacement ? 'credential_replaced_in_vault' : 'stored_in_credential_vault', accepted: true, credentialReference: input.credentialReference, credentialKind: normalized.kind, vaultRecordId: String(result.rows[0].id), audit, secretMaterial: 'not_returned', providerInvocation: 'not_performed' };
      });
    },

    async resolveCredential(input = {}) {
      const context = requireActor(input);
      validateReference(input);
      const reasonClass = String(input.reasonClass ?? '');
      if (!RESOLVE_REASON_CLASSES.includes(reasonClass)) throw new TypeError('credential resolve reason class is required');
      const peeked = await withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        return { found: await peek(client, input) };
      });
      const head = peeked.found;
      if (!head || head.revoked_at) return { status: 'credential_not_available', accepted: false, secretMaterial: 'not_returned', providerInvocation: 'not_performed' };
      if (head.expires_at && new Date(head.expires_at).getTime() <= Date.now()) return { status: 'credential_not_available', accepted: false, secretMaterial: 'not_returned', providerInvocation: 'not_performed' };
      if (head.credential_kind === 'password') {
        const refused = await runGate('credential.password_resolve', { ...input, credentialKind: 'password' }, context);
        if (refused) return refused;
      }
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query('select credential_kind, record_key_wrapped, record_key_iv, record_key_auth_tag, ciphertext, iv, auth_tag, token_type, scope from helmion.provider_credentials where tenant_id=$1 and provider_id=$2 and credential_reference=$3 and revoked_at is null and (expires_at is null or expires_at > clock_timestamp())', [input.tenantId, input.providerId, input.credentialReference]);
        if (result.rowCount !== 1) return { status: 'credential_not_available', accepted: false, secretMaterial: 'not_returned', providerInvocation: 'not_performed' };
        const row = result.rows[0];
        const tk = await tenantKey(client, input.tenantId);
        if (!tk.key) return { status: 'credential_not_available', accepted: false, secretMaterial: 'not_returned', providerInvocation: 'not_performed' };
        let payload;
        try {
          const recordKey = gcmDecrypt(tk.key, recordAad({ ...input, credentialKind: row.credential_kind }), { ciphertext: row.record_key_wrapped, iv: row.record_key_iv, auth_tag: row.record_key_auth_tag });
          payload = JSON.parse(gcmDecrypt(recordKey, recordAad({ ...input, credentialKind: row.credential_kind }), row).toString('utf8'));
        } catch {
          throw new Error('credential vault record could not be decrypted');
        }
        const audit = await emitAudit(client, context, { action: 'credential.resolved', providerId: input.providerId, credentialKind: row.credential_kind, credentialReference: input.credentialReference, reasonClass, guardGate: row.credential_kind === 'password' ? 'approved' : 'not_required' });
        return { ...shapeResolved(row.credential_kind, payload, row), credentialReference: input.credentialReference, audit };
      });
    },

    async revokeCredential(input = {}) {
      const context = requireActor(input);
      validateReference(input);
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query('update helmion.provider_credentials set revoked_at=clock_timestamp(), updated_at=clock_timestamp(), updated_by_subject=$4 where tenant_id=$1 and provider_id=$2 and credential_reference=$3 and revoked_at is null returning credential_kind', [input.tenantId, input.providerId, input.credentialReference, input.actorSubject]);
        if (result.rowCount !== 1) return { status: 'credential_not_available', accepted: false, secretMaterial: 'not_returned', providerInvocation: 'not_performed' };
        const audit = await emitAudit(client, context, { action: 'credential.revoked', providerId: input.providerId, credentialKind: result.rows[0].credential_kind, credentialReference: input.credentialReference });
        return { status: 'credential_revoked', accepted: true, credentialReference: input.credentialReference, credentialKind: result.rows[0].credential_kind, audit, secretMaterial: 'not_returned', providerInvocation: 'not_performed' };
      });
    },

    // Account deletion for the vault: destroy the tenant's wrapped data
    // key. Every record the tenant ever held becomes undecryptable,
    // including rows copied elsewhere.
    async shredTenant(input = {}) {
      const context = requireActor(input);
      if (!['owner', 'admin'].includes(String(input.actorRole).toLowerCase())) throw new TypeError('tenant shred requires owner or admin');
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query('update helmion.tenant_vault_keys set wrapped_data_key=$2, shredded_at=clock_timestamp(), updated_at=clock_timestamp() where tenant_id=$1 and shredded_at is null returning tenant_id', [input.tenantId, randomBytes(32)]);
        const audit = await emitAudit(client, context, { action: 'credential.tenant_shredded', providerId: null, credentialKind: null, credentialReference: null });
        return { status: result.rowCount === 1 ? 'tenant_vault_shredded' : 'tenant_vault_already_shredded', accepted: true, audit, secretMaterial: 'not_returned', providerInvocation: 'not_performed' };
      });
    },

    // Master-key rotation (credential-service operation, run by the service
    // identity against its own pool — not a tenant call): re-wrap every
    // live tenant key under the next master key. Payloads and record keys
    // are untouched. Returns how many tenant keys were re-wrapped.
    async rewrapTenantKeys({ nextMasterKey } = {}) {
      const next = credentialKeyBytes(nextMasterKey);
      if (!next) throw new TypeError('next master key must be a base64url-encoded 32-byte key');
      const client = await pool.connect();
      try {
        const rows = await client.query('select tenant_id, wrapped_data_key, wrap_iv, wrap_auth_tag from helmion.tenant_vault_keys where shredded_at is null');
        let rewrapped = 0;
        for (const row of rows.rows) {
          const dataKey = gcmDecrypt(master, tenantKeyAad(row.tenant_id), { ciphertext: row.wrapped_data_key, iv: row.wrap_iv, auth_tag: row.wrap_auth_tag });
          const wrapped = gcmEncrypt(next, tenantKeyAad(row.tenant_id), dataKey);
          const result = await client.query('update helmion.tenant_vault_keys set wrapped_data_key=$2, wrap_iv=$3, wrap_auth_tag=$4, key_version=key_version+1, updated_at=clock_timestamp() where tenant_id=$1', [row.tenant_id, wrapped.ciphertext, wrapped.iv, wrapped.authTag]);
          if (result.rowCount === 1) rewrapped += 1;
        }
        return { status: 'tenant_keys_rewrapped', rewrapped };
      } finally {
        client.release();
      }
    },
  });
}
