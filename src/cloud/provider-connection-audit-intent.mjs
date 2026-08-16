export function createProviderConnectionAuditIntent({ actor, intent, vaultStatus = 'external_vault_not_configured' } = {}) {
  const actorSubject = actor?.subject ?? actor?.actorSubject;
  if (!actor?.tenantId || !actorSubject || !intent?.provider_id || !intent.auth_mode || !intent.credential_reference) throw new TypeError('provider audit intent input');
  return Object.freeze({
    format: 'helmion.provider-connection-audit-intent.v1',
    action: 'provider_connection.save',
    tenantId: actor.tenantId,
    actorSubject,
    providerId: intent.provider_id,
    authMode: intent.auth_mode,
    credentialReference: intent.credential_reference,
    vaultStatus,
    durableReceiptRequired: true,
    persisted: false,
    tools: 'not_granted',
    providerInvocation: 'not_performed',
    secretMaterial: 'not_received',
  });
}
