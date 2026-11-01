// Credential service client — the cloud app's side of the custody split
// (cloud-connect design §5.1/§5.3, build bite 1). The app holds NO vault
// master key; it asks the credential service (Hetzner box, beside the
// Executive Guard) with a service token, a full actor context, and — for
// resolves — a reason class.
//
// INTERNAL ONLY, same rule as provider-credential-resolver.mjs: a resolved
// credential is returned to the calling runtime code and must never reach
// a UI response, an event, a connection row, or a log.

const PATHS = Object.freeze({
  storeCredential: '/v1/credentials/store',
  resolveCredential: '/v1/credentials/resolve',
  revokeCredential: '/v1/credentials/revoke',
  shredTenant: '/v1/credentials/shred-tenant',
});

export function createCredentialServiceClient({ baseUrl, serviceToken, fetchImpl = globalThis.fetch } = {}) {
  if (!baseUrl || !serviceToken) throw new TypeError('credential service client requires baseUrl and serviceToken');
  const base = String(baseUrl).replace(/\/$/, '');
  async function call(path, input) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' }, body: JSON.stringify(input ?? {}) });
    } catch {
      return { status: 'credential_service_unreachable', accepted: false, secretMaterial: 'not_returned', providerInvocation: 'not_performed' };
    }
    const body = await response.json().catch(() => ({}));
    return body && typeof body === 'object' ? body : { status: 'credential_service_bad_response', accepted: false, secretMaterial: 'not_returned', providerInvocation: 'not_performed' };
  }
  return Object.freeze({
    async storeCredential(input = {}) { return call(PATHS.storeCredential, input); },
    async resolveVaultCredential(input = {}) { return call(PATHS.resolveCredential, input); },
    async revokeVaultCredential(input = {}) { return call(PATHS.revokeCredential, input); },
    async shredTenantVault(input = {}) { return call(PATHS.shredTenant, input); },
  });
}

// Adapter-shaped wrapper over the client, so the service can stand where
// database-encrypted-vault-adapter.mjs stands today (live-admin wiring is
// a fire step, not this bite). The legacy OAuth pair maps onto the
// generalized store: OAuth bundles are stored as kind 'oauth_bundle' in
// helmion.provider_credentials (migration 063), and resolves run with
// reason class 'provider_call'. Bundles stored by the legacy adapter in
// helmion.provider_oauth_tokens are NOT visible through this wrapper —
// moving them is a later migration step, named here so nobody assumes it.
export function createCredentialServiceVaultAdapter({ client } = {}) {
  if (!client || typeof client.resolveVaultCredential !== 'function') throw new TypeError('credential service vault adapter requires a client');
  return Object.freeze({
    async prepareReference({ tenantId, providerId, credentialReference } = {}) {
      if (!tenantId || !providerId || !credentialReference) return { status: 'credential_service_input_invalid', accepted: false, secretMaterial: 'not_received', providerInvocation: 'not_performed' };
      return { status: 'credential_service_ready', accepted: true, tenantId, providerId, credentialReference, secretMaterial: 'not_received', providerInvocation: 'not_performed' };
    },
    async storeOAuthTokens(input = {}) {
      return client.storeCredential({ ...input, credentialKind: 'oauth_bundle' });
    },
    async storeCredential(input = {}) { return client.storeCredential(input); },
    async resolveVaultCredential(input = {}) { return client.resolveVaultCredential(input); },
    async revokeVaultCredential(input = {}) { return client.revokeVaultCredential(input); },
    async shredTenantVault(input = {}) { return client.shredTenantVault(input); },
    async resolveCredential(input = {}) {
      const result = await client.resolveVaultCredential({ ...input, reasonClass: input?.reasonClass ?? 'provider_call' });
      if (!result?.accepted) return { status: result?.status ?? 'credential_not_available', accepted: false, secretMaterial: 'not_returned', providerInvocation: 'not_performed' };
      return { status: 'credential_resolved_for_adapter', accepted: true, credential: result.credential, tokenType: result.tokenType ?? 'Bearer', credentialReference: input.credentialReference, secretMaterial: 'adapter_only', providerInvocation: 'not_performed' };
    },
  });
}
