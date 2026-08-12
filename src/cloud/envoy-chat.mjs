const KINDS = new Set(['team', 'direct', 'agent']);
const AUTHORS = new Set(['human', 'agent', 'system']);

function text(value, name, max) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max) throw new Error(`${name} is missing or too long`);
  return result;
}

export function normalizeEnvoyChannel(input) {
  const slug = text(input?.slug, 'channel slug', 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) throw new Error('channel slug is invalid');
  const kind = text(input?.kind ?? 'team', 'channel kind', 16).toLowerCase();
  if (!KINDS.has(kind)) throw new Error('channel kind is unsupported');
  return Object.freeze({ slug, title: text(input?.title, 'channel title', 120), kind });
}

export function normalizeEnvoyMessage(input) {
  const authorKind = text(input?.authorKind, 'author kind', 16).toLowerCase();
  if (!AUTHORS.has(authorKind)) throw new Error('author kind is unsupported');
  return Object.freeze({
    channelId: text(input?.channelId, 'channel id', 64),
    authorSubject: text(input?.authorSubject, 'author subject', 256),
    authorKind,
    body: text(input?.body, 'message body', 4000),
  });
}

/**
 * Envoy is allowed to display/send a message only after the caller has
 * already established the same tenant membership used by the other surfaces.
 * This helper is a policy seam, not an authorization bypass or agent runner.
 */
export function assertEnvoyMembership({ tenantId, subject, role, canUseEnvoy }) {
  if (!text(tenantId, 'tenant id', 128) || !text(subject, 'subject', 256)) {
    throw new Error('Envoy identity is incomplete');
  }
  if (!['owner', 'admin', 'member', 'auditor'].includes(String(role ?? '').toLowerCase())) {
    throw new Error('Envoy role is unsupported');
  }
  if (canUseEnvoy !== true) throw new Error('Envoy access is not enabled for this identity');
  return true;
}
