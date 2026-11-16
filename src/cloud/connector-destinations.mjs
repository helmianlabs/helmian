// TENANT OUTBOUND DESTINATIONS (Bite F, per-tenant connector outbound
// routing). An outbound row (helmion.connector_outbound_messages)
// belongs to a tenant, but until this bite the drainer delivered every
// row to one server-wide webhook taken from the process environment,
// so a critical Guard finding raised inside a customer workspace was
// delivered to the operator's Discord or Slack. The sql/052 header
// says webhook URLs live only in server env; that rule named the
// OUTBOX TABLE, which still never stores one. A tenant's own webhook
// URL is a tenant secret, and the credential vault is the codebase's
// designated place for tenant secrets, so the destination lives there:
// one vault record per (tenant, provider), kind 'api_key', under the
// reserved provider ids below, written and resolved through the
// credential client exactly the way connector-tenant-pair.mjs writes
// and resolves a tenant's client pair. The URL is accepted once,
// stored, and never read back to any client; surfaces report only
// configured or not configured, per provider.
//
// THE OPERATOR EXCEPTION. The server-wide env webhooks
// (HELMION_DISCORD_WEBHOOK_URL / HELMION_SLACK_WEBHOOK_URL) remain the
// delivery road for ONE tenant only: the operator tenant named by
// HELMION_OPERATOR_TENANT_ID. Any other tenant with no stored
// destination has no destination at all; the worker fails its rows
// terminally with reason 'tenant_destination_not_configured' rather
// than falling back to the operator's webhook (the fallback WAS the
// defect). A tenant's stored destination wins over the env fallback
// even for the operator tenant: the resolver always tries the vault
// first.
//
// ACTOR DISCIPLINE. Every vault call carries the caller's full actor
// context, supplied by the caller, exactly as the tenant pair road
// does: the admin save surface passes the workspace owner's own
// context (a member road), and the drain-time resolve passes the
// outbound worker's context. This module never invents an actor.

import { allowedWebhookUrl } from './communication-connectors.mjs';

/** Providers an outbound destination can be stored for. */
export const OUTBOUND_DESTINATION_PROVIDERS = Object.freeze(['discord', 'slack']);

export function isOutboundDestinationProvider(provider) {
  return OUTBOUND_DESTINATION_PROVIDERS.includes(String(provider ?? '').trim().toLowerCase());
}

/** The vault provider id a tenant's outbound webhook for one provider lives under. */
export function outboundDestinationProviderId(provider) {
  return `${String(provider ?? '').trim().toLowerCase()}-outbound`;
}

/**
 * The vault reference of a tenant's outbound webhook for one
 * provider: one record per tenant per provider, named by tenant and
 * provider only, no seat and no person, because the destination is
 * the tenant's (the tenantPairReference shape).
 */
export function outboundDestinationReference(tenantId, provider) {
  const tenant = String(tenantId ?? '').trim().toLowerCase();
  return `vault://tenant/${tenant}/${outboundDestinationProviderId(provider)}/webhook`;
}

/** The server-wide env webhook URL for a provider, or ''. */
export function outboundEnvWebhookUrl(provider, env = process.env) {
  const key = provider === 'discord' ? 'HELMION_DISCORD_WEBHOOK_URL' : 'HELMION_SLACK_WEBHOOK_URL';
  return String(env?.[key] ?? '').trim();
}

/** The operator tenant id named by the environment, or ''. */
export function outboundOperatorTenantId(env = process.env) {
  return String(env?.HELMION_OPERATOR_TENANT_ID ?? '').trim();
}

/**
 * Resolve one tenant's outbound destination for one provider.
 * Returns one of:
 *   { kind: 'tenant', webhookUrl }       the tenant's stored webhook;
 *   { kind: 'operator-env', webhookUrl } the tenant is the operator
 *                                        tenant and the env URL is set;
 *   { kind: 'none' }                     no destination exists.
 * A missing record is a normal answer, never an error: a refused or
 * unreachable resolve falls through to the operator check, exactly
 * the way resolveTenantPair treats a pair that is not there. The
 * webhook URL exists only in this return value, in the resolving
 * process's memory; callers must never log it, store it, or hand it
 * to a client.
 */
export async function resolveOutboundDestination({ credentials, tenantId, provider, env = process.env, actorContext } = {}) {
  const normalizedProvider = String(provider ?? '').trim().toLowerCase();
  const tenant = String(tenantId ?? '').trim();
  if (!tenant || !isOutboundDestinationProvider(normalizedProvider)) return Object.freeze({ kind: 'none' });
  if (credentials && typeof credentials.resolveVaultCredential === 'function' && actorContext) {
    const resolved = await credentials.resolveVaultCredential({
      tenantId,
      ...actorContext,
      providerId: outboundDestinationProviderId(normalizedProvider),
      credentialReference: outboundDestinationReference(tenant, normalizedProvider),
      reasonClass: 'provider_call',
    }).catch(() => null);
    const webhookUrl = resolved?.accepted ? String(resolved.credential ?? '').trim() : '';
    if (webhookUrl) return Object.freeze({ kind: 'tenant', webhookUrl });
  }
  const operatorTenantId = outboundOperatorTenantId(env);
  if (operatorTenantId && tenant === operatorTenantId) {
    const webhookUrl = outboundEnvWebhookUrl(normalizedProvider, env);
    if (webhookUrl) return Object.freeze({ kind: 'operator-env', webhookUrl });
  }
  return Object.freeze({ kind: 'none' });
}

/**
 * Store (or replace) a tenant's outbound webhook through the
 * credential client. The URL is validated against the existing host
 * allowlist before it is stored; an off-allowlist URL throws and
 * nothing is stored. Returns the credential service's own answer
 * untouched: accepted, or the refusal (a replacement routes through
 * the vault's Guard replacement gate, and the caller's copy says so
 * when it refuses). Returns null when the credential service is not
 * switched on. The URL is never echoed back by this module.
 */
export async function storeOutboundDestination({ credentials, tenantId, actorContext, provider, webhookUrl } = {}) {
  if (!credentials || typeof credentials.storeCredential !== 'function') return null;
  const normalizedProvider = String(provider ?? '').trim().toLowerCase();
  if (!isOutboundDestinationProvider(normalizedProvider)) throw new Error('connector provider is unsupported');
  allowedWebhookUrl(webhookUrl, normalizedProvider === 'discord' ? 'Discord' : 'Slack');
  return credentials.storeCredential({
    tenantId,
    ...(actorContext ?? {}),
    providerId: outboundDestinationProviderId(normalizedProvider),
    credentialReference: outboundDestinationReference(tenantId, normalizedProvider),
    credentialKind: 'api_key',
    apiKey: String(webhookUrl).trim(),
  });
}

/**
 * Read whether a tenant has a destination stored, per provider,
 * WITHOUT returning any URL: each provider's record is resolved and
 * the value discarded in this process; only the configured fact
 * leaves the module. Returns null when the credential service is not
 * switched on.
 */
export async function readOutboundDestinationState({ credentials, tenantId, actorContext } = {}) {
  if (!credentials || typeof credentials.resolveVaultCredential !== 'function') return null;
  const state = {};
  for (const provider of OUTBOUND_DESTINATION_PROVIDERS) {
    const resolved = await credentials.resolveVaultCredential({
      tenantId,
      ...(actorContext ?? {}),
      providerId: outboundDestinationProviderId(provider),
      credentialReference: outboundDestinationReference(tenantId, provider),
      reasonClass: 'probe',
    }).catch(() => null);
    state[provider] = Object.freeze({ configured: Boolean(resolved?.accepted && String(resolved.credential ?? '').trim()) });
  }
  return Object.freeze(state);
}
