import { createHash } from 'node:crypto';

export const DEFAULT_SESSION_TOOL_MANIFEST = Object.freeze([
  'aimforge_get_dispatch_board_summary',
  'aimforge_prepare_driver_message',
  'aimforge_create_department_handoff',
  'aimforge_get_equipment_safety_status',
  'aimforge_record_equipment_safety_check',
  'aimforge_request_safety_supervisor_review',
]);
const SERVER_ROLE_BY_SIGNED_ROLE = Object.freeze({ owner: 'owner', admin: 'admin', member: 'member', auditor: 'auditor', driver: 'member' });

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function hash(value) { return createHash('sha256').update(stable(value), 'utf8').digest('hex'); }

function fail(code, message) { throw Object.assign(new Error(message), { code, status: 503 }); }

export async function resolvePublishedCoraSessionConfig({ repository, signedContext, sessionToolManifest = DEFAULT_SESSION_TOOL_MANIFEST } = {}) {
  if (!signedContext?.verified || !signedContext.tenantId || !signedContext.subjectId || !signedContext.role || !signedContext.sessionId || !signedContext.receiptId) {
    fail('CORA_SESSION_SIGNED_CONTEXT_INVALID', 'verified signed Organization context is required');
  }
  if (!repository || typeof repository.readPublishedConfig !== 'function') fail('CORA_SESSION_CONFIG_RESOLVER_UNAVAILABLE', 'published Cora config resolver is unavailable');
  const serverRole = SERVER_ROLE_BY_SIGNED_ROLE[String(signedContext.role).toLowerCase()];
  if (!serverRole) fail('CORA_SESSION_SIGNED_ROLE_INVALID', 'signed Cora role is not an allowed Organization role');
  const actor = { tenantId: signedContext.tenantId, subject: signedContext.subjectId, role: serverRole, sessionId: signedContext.sessionId, requestId: signedContext.receiptId };
  const result = await repository.readPublishedConfig(actor);
  if (result?.status === 'ambiguous') fail('CORA_SESSION_CONFIG_AMBIGUOUS', 'multiple current published Cora configs exist');
  if (result?.status !== 'published' || !result.config) fail('CORA_SESSION_CONFIG_UNPUBLISHED', 'a current published Cora config is required');
  const published = result.config;
  if (published.organizationId !== signedContext.tenantId || published.lifecycle !== 'published' || published.isCurrent !== true) fail('CORA_SESSION_CONFIG_MISMATCH', 'published Cora config does not match the signed Organization context');
  const config = published.config?.effective ?? published.config?.config ?? published.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('CORA_SESSION_CONFIG_INVALID', 'published Cora config is invalid');
  const voiceProfiles = Array.isArray(config.voiceProfiles) ? config.voiceProfiles : config.allowedUserPreferences?.voiceProfiles;
  const voiceProfile = Array.isArray(voiceProfiles) && voiceProfiles.length === 1 ? String(voiceProfiles[0]) : null;
  if (!voiceProfile) fail('CORA_SESSION_VOICE_PROFILE_INVALID', 'published Cora config must contain exactly one server-selected voice profile');
  const maxSpokenChars = Number(config.maxSpokenChars);
  const behavior = Object.freeze({ style: config.style === 'professional_brief' ? config.style : null, maxSpokenChars, interruptMode: String(config.interruptMode ?? ''), turnMode: String(config.turnMode ?? '') });
  if (!behavior.style || !Number.isInteger(maxSpokenChars) || maxSpokenChars < 100 || maxSpokenChars > 20_000 || !behavior.interruptMode || !behavior.turnMode) fail('CORA_SESSION_BEHAVIOR_INVALID', 'published Cora professional behavior is invalid');
  const routingPolicy = config.routingPolicy;
  if (!routingPolicy || typeof routingPolicy !== 'object' || Array.isArray(routingPolicy)) fail('CORA_SESSION_ROUTING_POLICY_MISSING', 'published Cora routing policy is required');
  const tools = [...new Set((Array.isArray(sessionToolManifest) ? sessionToolManifest : []).map((name) => String(name)).filter(Boolean))].sort();
  return Object.freeze({
    format: 'cora.published-session-config.v1',
    tenantId: signedContext.tenantId,
    subjectId: signedContext.subjectId,
    sessionId: signedContext.sessionId,
    receiptId: signedContext.receiptId,
    configId: published.id,
    configVersion: published.configVersion,
    voiceProfile,
    professionalBehavior: behavior,
    toolManifestHash: hash(tools),
    routingPolicyHash: hash(routingPolicy),
    configHash: hash(config),
    providerInvocation: 'not_performed',
    humeMutation: 'not_performed',
  });
}
