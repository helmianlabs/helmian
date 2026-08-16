import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';
import { createCloudProviderConnectionIntent } from './oauth-connection-contract.mjs';
import { assertEncryptedVaultAdapter, createUnavailableEncryptedVaultAdapter } from './encrypted-vault-adapter.mjs';
import { createProviderConnectionAuditIntent } from './provider-connection-audit-intent.mjs';
import { exchangeCloudOAuthCode } from './provider-oauth-flow.mjs';
import { hashOAuthState } from './provider-oauth-config.mjs';

function context(actor) {
  if (!actor?.tenantId || !actor.subject || !actor.role || !actor.sessionId || !actor.requestId) throw new Error('verified Organization membership is required');
  return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId, requestId: actor.requestId };
}

function row(item) {
  return {
    providerId: item.provider_id,
    authMode: item.auth_mode,
    credentialReference: item.credential_reference,
    lifecycle: item.lifecycle,
    adapter: item.adapter,
    tools: 'not_granted',
    invocation: 'not_performed',
    vaultStatus: 'external_encrypted_vault_required',
    updatedAt: item.updated_at,
  };
}

const SELECT = 'provider_id, auth_mode, credential_reference, lifecycle, adapter, updated_at';
const OAUTH_TRANSACTION_SELECT = 'id, provider_id, state_hash, client_id, redirect_uri, code_challenge, credential_reference, status, error_code, created_by_subject, created_at, expires_at, completed_at';

function oauthTransaction(item) {
  return {
    id: String(item.id), providerId: item.provider_id, stateHash: item.state_hash, clientId: item.client_id,
    redirectUri: item.redirect_uri, codeChallenge: item.code_challenge, credentialReference: item.credential_reference,
    status: item.status, errorCode: item.error_code, createdBySubject: item.created_by_subject,
    createdAt: item.created_at, expiresAt: item.expires_at, completedAt: item.completed_at,
  };
}

export function createProviderConnectionRepository(pool, { vaultAdapter = createUnavailableEncryptedVaultAdapter(), fetchImpl = globalThis.fetch } = {}) {
  assertEncryptedVaultAdapter(vaultAdapter);
  return Object.freeze({
    async list(actor) {
      const active = context(actor);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const result = await client.query(`select ${SELECT} from helmion.provider_connections where tenant_id=$1 order by provider_id`, [active.tenantId]);
        return { connections: result.rows.map(row), source: 'tenant_provider_connection_metadata', invocation: 'not_performed', tools: 'not_granted' };
      });
    },
    async save(actor, input) {
      if (!['owner', 'admin'].includes(String(actor?.role ?? '').toLowerCase())) throw Object.assign(new Error('provider connection requires owner or admin membership'), { status: 403 });
      const active = context(actor);
      if (Object.keys(input ?? {}).some((key) => !['providerId', 'authMode', 'credentialReference', 'state', 'codeChallenge', 'codeChallengeMethod'].includes(key))) throw Object.assign(new Error('provider connection metadata contains a forbidden field'), { status: 400 });
      const intent = createCloudProviderConnectionIntent({
        tenant_id: active.tenantId,
        actor_role: active.actorRole,
        provider_id: input?.providerId,
        auth_mode: input?.authMode,
        credential_reference: input?.credentialReference,
        state: input?.state,
        code_challenge: input?.codeChallenge,
        code_challenge_method: input?.codeChallengeMethod,
      });
      if (!intent.valid) throw Object.assign(new Error('provider connection metadata is invalid'), { status: 400 });
      const vault = await vaultAdapter.prepareReference({ tenantId: active.tenantId, providerId: intent.result.provider_id, credentialReference: intent.result.credential_reference });
      const auditIntent = createProviderConnectionAuditIntent({ actor: active, intent: intent.result, vaultStatus: vault.status });
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const result = await client.query(`insert into helmion.provider_connections (tenant_id, provider_id, auth_mode, credential_reference, lifecycle, adapter, updated_by_subject) values ($1,$2,$3,$4,'pending',$5,$6) on conflict (tenant_id,provider_id) do update set auth_mode=excluded.auth_mode, credential_reference=excluded.credential_reference, lifecycle='pending', adapter=excluded.adapter, updated_by_subject=excluded.updated_by_subject, updated_at=clock_timestamp() returning ${SELECT}`, [active.tenantId, intent.result.provider_id, intent.result.auth_mode, intent.result.credential_reference, intent.result.adapter, active.actorSubject]);
        return { durable: true, connection: row(result.rows[0]), source: 'tenant_provider_connection_metadata', vaultStatus: vault.status, auditIntent, invocation: 'not_performed', tools: 'not_granted' };
      });
    },
    async exchangeOAuth(actor, input) {
      if (!['owner', 'admin'].includes(String(actor?.role ?? '').toLowerCase())) throw Object.assign(new Error('provider OAuth requires owner or admin membership'), { status: 403 });
      const active = context(actor);
      const allowed = ['providerId', 'clientId', 'code', 'codeVerifier', 'codeChallenge', 'redirectUri', 'credentialReference'];
      if (Object.keys(input ?? {}).some((key) => !allowed.includes(key))) throw Object.assign(new Error('provider OAuth input contains a forbidden field'), { status: 400 });
      const exchange = await exchangeCloudOAuthCode({ tenantId: active.tenantId, ...input }, { fetchImpl, vaultAdapter, vaultContext: active });
      if (!exchange.valid) return { durable: false, exchange, invocation: 'not_performed', tools: 'not_granted' };
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const result = await client.query(`insert into helmion.provider_connections (tenant_id, provider_id, auth_mode, credential_reference, lifecycle, adapter, updated_by_subject) values ($1,$2,'oauth_subscription',$3,'pending','not_configured',$4) on conflict (tenant_id,provider_id) do update set auth_mode=excluded.auth_mode, credential_reference=excluded.credential_reference, lifecycle='pending', adapter='not_configured', updated_by_subject=excluded.updated_by_subject, updated_at=clock_timestamp() returning ${SELECT}`, [active.tenantId, exchange.providerId, exchange.credentialReference, active.actorSubject]);
        return { durable: true, exchange, connection: row(result.rows[0]), source: 'tenant_provider_connection_metadata', invocation: 'not_performed', tools: 'not_granted' };
      });
    },
    async createOAuthTransaction(actor, input) {
      if (!['owner', 'admin'].includes(String(actor?.role ?? '').toLowerCase())) throw Object.assign(new Error('provider OAuth requires owner or admin membership'), { status: 403 });
      const active = context(actor);
      const allowed = ['providerId', 'state', 'clientId', 'redirectUri', 'codeChallenge', 'credentialReference'];
      if (Object.keys(input ?? {}).some((key) => !allowed.includes(key))) throw Object.assign(new Error('provider OAuth transaction contains a forbidden field'), { status: 400 });
      const redirect = new URL(String(input.redirectUri));
      if (!input.providerId || !input.clientId || !input.codeChallenge || redirect.protocol !== 'https:' || !input.credentialReference) throw Object.assign(new Error('provider OAuth transaction is invalid'), { status: 400 });
      const stateHash = hashOAuthState(input.state);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const result = await client.query(`insert into helmion.provider_oauth_transactions (tenant_id, provider_id, state_hash, client_id, redirect_uri, code_challenge, credential_reference, status, created_by_subject, expires_at) values ($1,$2,$3,$4,$5,$6,$7,'pending',$8,clock_timestamp() + interval '10 minutes') returning ${OAUTH_TRANSACTION_SELECT}`, [active.tenantId, input.providerId, stateHash, input.clientId, redirect.toString(), input.codeChallenge, input.credentialReference, active.actorSubject]);
        if (result.rowCount !== 1) throw new Error('OAuth transaction was not durable');
        return { durable: true, transaction: oauthTransaction(result.rows[0]), source: 'tenant_provider_oauth_transaction' };
      });
    },
    async claimOAuthTransaction(actor, input) {
      const active = context(actor);
      const stateHash = hashOAuthState(input?.state);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const found = await client.query(`select ${OAUTH_TRANSACTION_SELECT} from helmion.provider_oauth_transactions where tenant_id=$1 and provider_id=$2 and state_hash=$3 and status='pending' and expires_at > clock_timestamp() for update`, [active.tenantId, input.providerId, stateHash]);
        if (found.rowCount !== 1) return { durable: false, code: 'OAUTH_TRANSACTION_NOT_PENDING' };
        const result = await client.query(`update helmion.provider_oauth_transactions set status='processing' where id=$1 and status='pending' returning ${OAUTH_TRANSACTION_SELECT}`, [found.rows[0].id]);
        if (result.rowCount !== 1) return { durable: false, code: 'OAUTH_TRANSACTION_ALREADY_CLAIMED' };
        return { durable: true, transaction: oauthTransaction(result.rows[0]), source: 'tenant_provider_oauth_transaction' };
      });
    },
    async finishOAuthTransaction(actor, input) {
      const active = context(actor);
      if (!['completed', 'failed'].includes(input?.status)) throw new TypeError('OAuth transaction completion status is invalid');
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const result = await client.query(`update helmion.provider_oauth_transactions set status=$2, error_code=$3, completed_at=clock_timestamp() where tenant_id=$1 and id=$4 and status='processing' returning ${OAUTH_TRANSACTION_SELECT}`, [active.tenantId, input.status, input.errorCode ?? null, input.transactionId]);
        if (result.rowCount !== 1) return { durable: false, code: 'OAUTH_TRANSACTION_NOT_PROCESSING' };
        return { durable: true, transaction: oauthTransaction(result.rows[0]), source: 'tenant_provider_oauth_transaction' };
      });
    },
  });
}
