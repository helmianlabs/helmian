const PROVIDERS = new Set(['slack', 'discord', 'github']);
const LIFECYCLES = new Set(['draft', 'testing', 'approved', 'enabled', 'disabled']);
const TRANSITIONS = new Map([
  ['draft', new Set(['draft', 'testing', 'disabled'])],
  ['testing', new Set(['testing', 'approved', 'disabled'])],
  ['approved', new Set(['approved', 'enabled', 'disabled'])],
  ['enabled', new Set(['enabled', 'disabled'])],
  ['disabled', new Set(['disabled', 'draft', 'testing'])],
]);
const AUTHORITY_KEYS = ['tenantId', 'tenant_id', 'organizationId', 'organization_id', 'plantId', 'plant_id', 'facilityId', 'facility_id'];

function text(value, name, max, optional = false) {
  if (value == null && optional) return null;
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function rejectAuthority(input) {
  if (input && AUTHORITY_KEYS.some((key) => Object.hasOwn(input, key))) throw new Error('connector registration cannot select tenant, Organization, Plant, or facility authority');
}

export function normalizeConnectorRegistration(input = {}, existing = null) {
  rejectAuthority(input);
  const keys = Object.keys(input ?? {});
  if (!input || typeof input !== 'object' || Array.isArray(input) || keys.some((key) => !['allowedInboundChannels', 'enabled', 'lifecycle', 'provider', 'publicEndpointReady', 'secretReferenceName'].includes(key))) throw new Error('connector registration contains unsupported fields');
  const provider = text(input.provider ?? existing?.provider, 'connector provider', 16).toLowerCase();
  const lifecycle = text(input.lifecycle ?? existing?.lifecycle ?? 'draft', 'connector lifecycle', 16).toLowerCase();
  if (!PROVIDERS.has(provider) || !LIFECYCLES.has(lifecycle)) throw new Error('connector provider or lifecycle is unsupported');
  const channels = input.allowedInboundChannels ?? existing?.allowedInboundChannels ?? [];
  if (!Array.isArray(channels) || channels.length > 64) throw new Error('connector channel mappings are invalid');
  const allowedInboundChannels = Object.freeze(channels.map((channel) => Object.freeze({
    externalChannelId: text(channel?.externalChannelId ?? channel?.channelId, 'external channel id', 256),
    label: text(channel?.label ?? channel?.name, 'channel label', 160),
    enabled: channel?.enabled !== false,
  })));
  const secretReferenceName = text(input.secretReferenceName ?? existing?.secretReferenceName, 'signing secret reference name', 160, true);
  if (secretReferenceName && /secret|token|key|value/iu.test(secretReferenceName)) throw new Error('signing secret reference name must be non-sensitive metadata');
  if (lifecycle === 'enabled' && (!secretReferenceName || !input.publicEndpointReady && existing?.publicEndpointReady !== true || allowedInboundChannels.every((channel) => !channel.enabled))) throw new Error('enabled connector requires readiness metadata, secret reference name, and an enabled channel');
  if (existing && existing.lifecycle !== lifecycle && !TRANSITIONS.get(existing.lifecycle)?.has(lifecycle)) throw new Error('connector lifecycle transition is invalid');
  return Object.freeze({ provider, lifecycle, enabled: input.enabled ?? existing?.enabled ?? lifecycle === 'enabled', publicEndpointReady: input.publicEndpointReady ?? existing?.publicEndpointReady ?? false, secretReferenceName, allowedInboundChannels });
}

export function connectorRegistrationView(row, { admin = false } = {}) {
  const channels = Array.isArray(row.allowedInboundChannels) ? row.allowedInboundChannels : [];
  return Object.freeze({ provider: row.provider, lifecycle: row.lifecycle, enabled: row.enabled === true, publicEndpointReady: row.publicEndpointReady === true, allowedInboundChannels: admin ? channels : channels.filter((channel) => channel.enabled).map(({ externalChannelId, label, enabled }) => ({ externalChannelId, label, enabled })), lastVerifiedStatus: row.lastVerifiedStatus ?? 'not_verified', lastVerifiedReceiptId: row.lastVerifiedReceiptId ?? null, lastVerifiedAt: row.lastVerifiedAt ?? null, secretReferenceName: admin ? row.secretReferenceName ?? null : null, source: 'organization_connector_registration', providerCalls: 'not_performed' });
}
