import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';

const VAULT_REFERENCE = /^vault:\/\/tenant\/[a-z0-9][a-z0-9._:-]{0,127}\/[a-z0-9._:-]{1,96}(?:\/[a-z0-9._:-]{1,96})?$/u;
const TOKEN_TYPE = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/u;
const SCOPE = /^[A-Za-z0-9:./ _-]{1,2000}$/u;

function keyBytes(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  let decoded;
  try { decoded = Buffer.from(raw, 'base64url'); } catch { return null; }
  return decoded.length === 32 ? decoded : null;
}

function validateReference({ tenantId, providerId, credentialReference } = {}) {
  const reference = String(credentialReference ?? '');
  if (!tenantId || !['gemini', 'openai_codex', 'claude', 'grok'].includes(String(providerId)) || !VAULT_REFERENCE.test(reference) || !reference.startsWith(`vault://tenant/${String(tenantId).toLowerCase()}/`)) throw new TypeError('encrypted vault reference is invalid');
}

function aad({ tenantId, providerId, credentialReference }) {
  return Buffer.from(`${tenantId}\0${providerId}\0${credentialReference}`, 'utf8');
}

function encryptedTokenBundle(input, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(input));
  const plaintext = Buffer.from(JSON.stringify({ accessToken: input.accessToken, refreshToken: input.refreshToken ?? null }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function createDatabaseEncryptedVaultAdapter({ pool, key } = {}) {
  const masterKey = keyBytes(key);
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('database encrypted vault requires a pool');
  if (!masterKey) throw new TypeError('HELMION_OAUTH_VAULT_KEY must be a base64url-encoded 32-byte key');
  return Object.freeze({
    async prepareReference({ tenantId, providerId, credentialReference } = {}) {
      validateReference({ tenantId, providerId, credentialReference });
      return { status: 'database_encrypted_vault_ready', accepted: true, tenantId, providerId, credentialReference, secretMaterial: 'not_received', providerInvocation: 'not_performed' };
    },
    async storeOAuthTokens(input = {}) {
      validateReference(input);
      if (!input.actorSubject || !input.actorRole || !input.sessionId || !input.requestId) throw new TypeError('encrypted vault actor context is required');
      if (typeof input.accessToken !== 'string' || input.accessToken.length < 1 || input.accessToken.length > 8192) throw new TypeError('access token is invalid');
      if (input.refreshToken != null && (typeof input.refreshToken !== 'string' || input.refreshToken.length > 8192)) throw new TypeError('refresh token is invalid');
      if (input.tokenType != null && !TOKEN_TYPE.test(String(input.tokenType))) throw new TypeError('token type is invalid');
      if (input.scope != null && !SCOPE.test(String(input.scope))) throw new TypeError('scope is invalid');
      const encrypted = encryptedTokenBundle(input, masterKey);
      const expiresAt = Number.isFinite(Number(input.expiresIn)) && Number(input.expiresIn) > 0 ? new Date(Date.now() + Number(input.expiresIn) * 1000).toISOString() : null;
      const context = { tenantId: input.tenantId, actorSubject: input.actorSubject, actorRole: input.actorRole, sessionId: input.sessionId, requestId: input.requestId };
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query(`insert into helmion.provider_oauth_tokens (tenant_id, provider_id, credential_reference, ciphertext, iv, auth_tag, token_type, scope, expires_at, updated_by_subject) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (tenant_id,provider_id,credential_reference) do update set ciphertext=excluded.ciphertext, iv=excluded.iv, auth_tag=excluded.auth_tag, token_type=excluded.token_type, scope=excluded.scope, expires_at=excluded.expires_at, updated_by_subject=excluded.updated_by_subject, updated_at=clock_timestamp(), revoked_at=null returning id`, [input.tenantId, input.providerId, input.credentialReference, encrypted.ciphertext, encrypted.iv, encrypted.authTag, input.tokenType ?? 'Bearer', input.scope ?? null, expiresAt, input.actorSubject]);
        if (result.rowCount !== 1) throw new Error('encrypted vault write was not durable');
        return { status: 'stored_in_database_encrypted_vault', accepted: true, credentialReference: input.credentialReference, vaultRecordId: String(result.rows[0].id), secretMaterial: 'not_returned', providerInvocation: 'not_performed' };
      });
    },
  });
}

export function createEncryptedVaultAdapterFromEnv({ pool, env = process.env } = {}) {
  const key = String(env.HELMION_OAUTH_VAULT_KEY ?? '').trim();
  if (!key) return null;
  return createDatabaseEncryptedVaultAdapter({ pool, key });
}
