// TENANT CLIENT PAIRS (Troy's ruling, 2026-11-10; REGISTRATION-
// PACK §§9–10). Box and Salesforce are the two providers on the
// whole list whose OAuth road runs on a client pair minted PER
// CUSTOMER: neither offers Helmian a registration of its own —
// Box publishes no dynamic registration for its MCP server (its
// own Support page says so) and Salesforce's Hosted MCP Servers
// accept only a per-org External Client App. So the road is:
//
//   1. The customer's own admin mints the pair in their provider
//      console — the Box Admin Console's MCP integration
//      credentials, or a Salesforce External Client App in the
//      org's Setup — carrying Helmian's production callback as
//      the redirect / callback URL.
//   2. The workspace owner or admin enters the pair in Helmian
//      (the panel's pair form; the write route's tenant-pair
//      action). The pair is stored in the credential vault as a
//      'client_pair' record, ONE per tenant per provider, under
//      the pair address below — the TENANT's pair, never a
//      person's: it names no seat and no person, and anyone in
//      the tenant connecting Box or Salesforce runs under it.
//   3. The fixed-factory road resolves the pair PER TENANT at
//      every step that needs a client — the connect start, the
//      callback exchange, and the arming dispatch's renewal leg —
//      instead of reading a project env pair. There IS no env
//      pair for these providers by design: createConnectorOAuth-
//      Client answers null for them, always.
//
// The pair form is the provider's ONLY road in: Helmian holds no
// registration for these providers that could substitute for it,
// which is why the shape was put to Troy and approved (flywheel
// R52: every other Connect opens the provider's own sign-in door,
// and Box / Salesforce connects still do — the pair only names
// WHICH client the door is opened for).

import { fixedProviderForEntry } from './connector-oauth-dcr.mjs';

/** Providers whose OAuth road runs on a per-tenant client pair. */
export const TENANT_PAIR_PROVIDERS = Object.freeze(['box', 'salesforce']);

export function isTenantPairProvider(provider) {
  return TENANT_PAIR_PROVIDERS.includes(String(provider ?? '').trim().toLowerCase());
}

/** The pair provider an entry's OAuth road runs under, or null. */
export function tenantPairProviderForEntry(entry) {
  const provider = fixedProviderForEntry(entry);
  return provider && isTenantPairProvider(provider) ? provider : null;
}

/** The vault provider id a tenant's pair for one provider lives under. */
export function tenantPairProviderId(provider) {
  return `connector-pair.${String(provider ?? '').trim().toLowerCase()}`;
}

/**
 * The vault reference of a tenant's pair for one provider: one
 * record per tenant per provider, named by tenant and provider
 * only — no seat, no person, because the pair is the tenant's.
 */
export function tenantPairReference(tenantId, provider) {
  const tenant = String(tenantId ?? '').trim().toLowerCase();
  return `vault://tenant/${tenant}/${tenantPairProviderId(provider)}/client-pair`;
}

/**
 * Resolve a tenant's stored pair through the credential client.
 * Returns { clientId, clientSecret, mcpEndpointUrl } when a pair
 * is stored and complete, null when none is (or the credential
 * service is not switched on). The caller supplies the actor
 * context and the reason class for ITS road — the write route's
 * member roads pass 'browser_sign_in'; the dispatch's renewal
 * road passes 'oauth_refresh' (the vault's arming qualification
 * covers exactly that class for this kind).
 */
export async function resolveTenantPair(credentials, { tenantId, actorContext, provider, reasonClass } = {}) {
  if (!credentials || typeof credentials.resolveVaultCredential !== 'function') return null;
  if (!isTenantPairProvider(provider)) return null;
  const resolved = await credentials.resolveVaultCredential({
    tenantId,
    ...(actorContext ?? {}),
    providerId: tenantPairProviderId(provider),
    credentialReference: tenantPairReference(tenantId, provider),
    reasonClass,
  }).catch(() => null);
  if (!resolved?.accepted) return null;
  const clientId = String(resolved.clientId ?? '').trim();
  const clientSecret = String(resolved.clientSecret ?? '').trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, mcpEndpointUrl: resolved.mcpEndpointUrl ?? null };
}

/**
 * Store (or replace) a tenant's pair through the credential
 * client. Returns the credential service's own answer untouched —
 * accepted, or the refusal (a replacement routes through the
 * vault's Guard replacement gate, and the caller's copy says so
 * when it refuses). Pair VALUES are never echoed back by this
 * module or its callers.
 */
export async function storeTenantPair(credentials, { tenantId, actorContext, provider, clientId, clientSecret, mcpEndpointUrl = null } = {}) {
  if (!credentials || typeof credentials.storeCredential !== 'function') return null;
  if (!isTenantPairProvider(provider)) return null;
  return credentials.storeCredential({
    tenantId,
    ...(actorContext ?? {}),
    providerId: tenantPairProviderId(provider),
    credentialReference: tenantPairReference(tenantId, provider),
    credentialKind: 'client_pair',
    clientId,
    clientSecret,
    ...(mcpEndpointUrl ? { mcpEndpointUrl } : {}),
  });
}
