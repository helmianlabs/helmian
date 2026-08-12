const CONNECTOR_ROLES = new Set(['owner', 'admin', 'member', 'auditor']);

function required(value, name, max = 256) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max) throw new Error(`${name} is missing or too long`);
  return text;
}

function exactlyOne(rows, name) {
  const values = Array.isArray(rows) ? rows : [];
  if (values.length !== 1) throw new Error(`${name} must resolve exactly one active binding`);
  return values[0];
}

/**
 * Bind a verified Discord/Slack envelope to a live Helmian identity and channel.
 * This is deliberately not a session issuer and never trusts tenant/role values
 * from the provider payload. Callers must supply DB-backed resolvers that apply
 * tenant membership, active-channel, and platform-policy checks.
 */
export async function bindConnectorMessage({ message, resolveUser, resolveChannel }) {
  if (!message || typeof message !== 'object') throw new Error('connector message is required');
  if (typeof resolveUser !== 'function' || typeof resolveChannel !== 'function') {
    throw new Error('connector identity resolvers are required');
  }
  const provider = required(message.provider, 'connector provider', 32).toLowerCase();
  if (!['discord', 'slack'].includes(provider)) throw new Error('connector provider is unsupported');
  const externalUserId = required(message.externalUserId, 'connector user id');
  const channelId = required(message.channelId, 'connector channel id');
  const user = exactlyOne(await resolveUser({ provider, externalUserId }), 'connector user');
  if (user.active !== true) throw new Error('connector user binding is inactive');
  const subject = required(user.subject, 'Helmian subject', 256);
  const tenantId = required(user.tenantId, 'Helmian tenant', 128);
  const role = required(user.role, 'Helmian role', 32).toLowerCase();
  if (!CONNECTOR_ROLES.has(role)) throw new Error('connector role is unsupported');
  const channel = exactlyOne(await resolveChannel({ provider, channelId, tenantId }), 'connector channel');
  if (channel.active !== true) throw new Error('connector channel binding is inactive');
  if (required(channel.tenantId, 'channel tenant', 128) !== tenantId) {
    throw new Error('connector channel tenant mismatch');
  }
  return Object.freeze({
    provider,
    eventId: required(message.eventId, 'connector event id'),
    externalUserId,
    channelId,
    subject,
    tenantId,
    role,
    text: required(message.text, 'connector message', 4_000),
    surface: `connector-${provider}`,
    sessionIssuer: 'signed-session-required',
  });
}

export function connectorCanRequestAgentTurn(binding) {
  return Boolean(binding && binding.sessionIssuer === 'signed-session-required'
    && binding.subject && binding.tenantId && binding.channelId);
}
