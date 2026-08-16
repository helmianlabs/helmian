const TOGGLEABLE_INTEGRATIONS = Object.freeze([
  Object.freeze({
    integration_id: 'envoy',
    label: 'Envoy',
    description: 'Desktop-equivalent cloud execution shell',
    connection_mode: 'desktop_session_boundary',
  }),
  Object.freeze({
    integration_id: 'discord',
    label: 'Discord',
    description: 'Team conversation provider',
    connection_mode: 'oauth_handoff_boundary',
  }),
  Object.freeze({
    integration_id: 'slack',
    label: 'Slack',
    description: 'Team conversation provider',
    connection_mode: 'oauth_handoff_boundary',
  }),
  Object.freeze({
    integration_id: 'github',
    label: 'GitHub',
    description: 'Code and review provider',
    connection_mode: 'oauth_handoff_boundary',
  }),
]);

const DEFINITIONS = new Map(TOGGLEABLE_INTEGRATIONS.map((item) => [item.integration_id, item]));

export const HERALD_PHONE_COMPANION = Object.freeze({
  integration_id: 'herald',
  label: 'Herald',
  description: 'Phone companion for a paired Helmian Desktop session',
  state: 'phone_only',
  toggleable: false,
  connection_mode: 'paired_phone_boundary',
});

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function listToggleableCloudIntegrations(rows = []) {
  const state = new Map(
    (Array.isArray(rows) ? rows : [])
      .filter((row) => DEFINITIONS.has(String(row?.integration_id ?? '')))
      .map((row) => [String(row.integration_id), row]),
  );
  return freeze(TOGGLEABLE_INTEGRATIONS.map((definition) => {
    const row = state.get(definition.integration_id);
    const enabled = row?.enabled === true;
    return {
      ...definition,
      enabled,
      state: enabled ? 'enabled' : 'disabled',
      connection_state: 'not_connected',
      credential_storage: 'external_provider_or_vault',
      invocation: 'not_performed',
      updated_at: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
  }));
}

export function getToggleableCloudIntegration(integrationId) {
  return DEFINITIONS.get(String(integrationId ?? '').trim().toLowerCase()) ?? null;
}

export function normalizeIntegrationToggle(input = {}) {
  const integrationId = String(input.integration_id ?? input.integrationId ?? '').trim().toLowerCase();
  const definition = getToggleableCloudIntegration(integrationId);
  if (!definition) throw new TypeError('Unknown cloud integration');
  if (typeof input.enabled !== 'boolean') throw new TypeError('enabled must be boolean');
  return Object.freeze({ integration_id: definition.integration_id, enabled: input.enabled });
}

export function publicCloudIntegration(row) {
  const definition = getToggleableCloudIntegration(row?.integration_id);
  if (!definition) throw new TypeError('Unknown cloud integration');
  return freeze({
    ...definition,
    enabled: row.enabled === true,
    state: row.enabled === true ? 'enabled' : 'disabled',
    connection_state: 'not_connected',
    credential_storage: 'external_provider_or_vault',
    invocation: 'not_performed',
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  });
}

export const CLOUD_INTEGRATION_IDS = Object.freeze(
  TOGGLEABLE_INTEGRATIONS.map((item) => item.integration_id),
);
