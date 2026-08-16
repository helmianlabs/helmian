import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';
import { createCloudProviderConnectionIntent } from './oauth-connection-contract.mjs';
import { assertEncryptedVaultAdapter, createUnavailableEncryptedVaultAdapter } from './encrypted-vault-adapter.mjs';
import { createProviderConnectionAuditIntent } from './provider-connection-audit-intent.mjs';
import { exchangeCloudOAuthCode } from './provider-oauth-flow.mjs';

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
      const exchange = await exchangeCloudOAuthCode({ tenantId: active.tenantId, ...input }, { fetchImpl, vaultAdapter });
      if (!exchange.valid) return { durable: false, exchange, invocation: 'not_performed', tools: 'not_granted' };
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const result = await client.query(`insert into helmion.provider_connections (tenant_id, provider_id, auth_mode, credential_reference, lifecycle, adapter, updated_by_subject) values ($1,$2,'oauth_subscription',$3,'pending','not_configured',$4) on conflict (tenant_id,provider_id) do update set auth_mode=excluded.auth_mode, credential_reference=excluded.credential_reference, lifecycle='pending', adapter='not_configured', updated_by_subject=excluded.updated_by_subject, updated_at=clock_timestamp() returning ${SELECT}`, [active.tenantId, exchange.providerId, exchange.credentialReference, active.actorSubject]);
        return { durable: true, exchange, connection: row(result.rows[0]), source: 'tenant_provider_connection_metadata', invocation: 'not_performed', tools: 'not_granted' };
      });
    },
  });
}
