const PROVIDER_IDS = Object.freeze({
  openai: 'openai_codex',
  anthropic: 'claude',
  gemini: 'gemini',
  xai: 'grok',
});

/**
 * Internal-only bridge from a tenant vault adapter to chatWithTools.
 * The credential is returned to the caller's provider stack, never to a UI
 * response, event, connection row, or provenance entry.
 */
export function createProviderCredentialResolver({ vaultAdapter, tenantContext } = {}) {
  if (!vaultAdapter || typeof vaultAdapter.resolveCredential !== 'function') return null;
  if (!tenantContext?.tenantId || !tenantContext.subject || !tenantContext.role || !tenantContext.sessionId || !tenantContext.requestId) return null;
  return async ({ providerId, credentialReference } = {}) => {
    const cloudProviderId = PROVIDER_IDS[String(providerId ?? '')];
    if (!cloudProviderId || !credentialReference) throw new Error(`No vault credential configured for provider ${providerId}`);
    const result = await vaultAdapter.resolveCredential({
      tenantId: tenantContext.tenantId,
      providerId: cloudProviderId,
      credentialReference,
      actorSubject: tenantContext.subject,
      actorRole: tenantContext.role,
      sessionId: tenantContext.sessionId,
      requestId: tenantContext.requestId,
    });
    if (!result?.accepted || typeof result.credential !== 'string' || result.credential.length === 0) {
      throw new Error(`Vault credential unavailable for provider ${providerId}`);
    }
    return { credential: result.credential, tokenType: result.tokenType ?? 'Bearer' };
  };
}
