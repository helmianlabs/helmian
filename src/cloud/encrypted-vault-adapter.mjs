const VAULT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;

export function createUnavailableEncryptedVaultAdapter() {
  return Object.freeze({
    async prepareReference({ tenantId, providerId, credentialReference } = {}) {
      if (!tenantId || !providerId || !VAULT_REFERENCE.test(String(credentialReference ?? ''))) {
        return { status: 'external_vault_input_invalid', accepted: false, providerInvocation: 'not_performed' };
      }
      return {
        status: 'external_vault_not_configured',
        accepted: false,
        tenantId,
        providerId,
        credentialReference,
        secretMaterial: 'not_received',
        providerInvocation: 'not_performed',
      };
    },
  });
}

export function assertEncryptedVaultAdapter(adapter) {
  if (!adapter || typeof adapter.prepareReference !== 'function') throw new TypeError('encrypted vault adapter must expose prepareReference');
  return adapter;
}
