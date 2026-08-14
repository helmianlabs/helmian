import { resolvePublishedCoraSessionConfig } from './session-config-resolver.mjs';
import { resolveServerHumeBinding } from './hume-server-binding.mjs';

export const CORA_HUME_SESSION_DESCRIPTOR_FORMAT = 'cora.hume-session-descriptor.v1';
export const CORA_HUME_SESSION_DESCRIPTOR_STATES = Object.freeze(['ready', 'unavailable']);
const MAX_PROMPT_CHARS = 1_024;
const MAX_CONFIG_ID_CHARS = 128;

function boundedText(value, name, max) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function optionalText(value, name, max) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  return boundedText(value, name, max);
}

function requireHash(value, name) {
  const result = boundedText(value, name, 64);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function buildPrompt(behavior, voiceProfile) {
  const prompt = [
    'You are Cora, Helmian Cloud’s professional and concise maestro.',
    `Use the approved ${voiceProfile} voice profile reference.`,
    `Keep spoken responses within ${behavior.maxSpokenChars} characters.`,
    `Use ${behavior.turnMode} turn behavior and ${behavior.interruptMode} interruption behavior.`,
    'Do not claim provider, tool, external, or irreversible work without a verified receipt.',
  ].join(' ');
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error('Cora Hume prompt is too long');
  return prompt;
}

/**
 * Compile only an already-resolved, server-owned published session config.
 * This function never contacts or mutates Hume and never accepts a client
 * provider/model/config selector. `serverCredentialReady` is deliberately an
 * injected boolean because the current CLM source has no Hume credential
 * consumer; a caller must not smuggle a secret into this descriptor.
 */
export function compileCoraHumeSessionDescriptor({
  sessionConfig,
  humeConfigId = null,
  serverCredentialReady,
  serverBinding,
} = {}) {
  if (!sessionConfig || typeof sessionConfig !== 'object' || Array.isArray(sessionConfig)) throw new Error('resolved Cora session config is required');
  if (sessionConfig.format !== 'cora.published-session-config.v1') throw new Error('resolved Cora session config format is invalid');
  if (!sessionConfig.tenantId || !sessionConfig.sessionId || !sessionConfig.receiptId) throw new Error('resolved Cora Organization session context is incomplete');
  if (!Number.isSafeInteger(sessionConfig.configVersion) || sessionConfig.configVersion < 1) throw new Error('published Cora config version is invalid');
  const configId = boundedText(sessionConfig.configId, 'published Cora config id', MAX_CONFIG_ID_CHARS);
  const voiceProfile = boundedText(sessionConfig.voiceProfile, 'Cora voice profile', 128);
  const behavior = sessionConfig.professionalBehavior;
  if (!behavior || behavior.style !== 'professional_brief' || !Number.isSafeInteger(behavior.maxSpokenChars) || behavior.maxSpokenChars < 240 || behavior.maxSpokenChars > 1_200) throw new Error('published Cora professional behavior is invalid');
  const interruptMode = boundedText(behavior.interruptMode, 'Cora interrupt mode', 32);
  const turnMode = boundedText(behavior.turnMode, 'Cora turn mode', 32);
  const binding = serverBinding === undefined
    ? (typeof serverCredentialReady !== 'boolean' ? (() => { throw new Error('server Hume credential readiness must be explicit'); })() : resolveServerHumeBinding({ source: 'injected_test', configured: Boolean(humeConfigId), configId: humeConfigId, credentialReady: serverCredentialReady }))
    : resolveServerHumeBinding(serverBinding);
  const humeId = optionalText(binding.configId, 'server Hume config id', MAX_CONFIG_ID_CHARS);
  const descriptor = Object.freeze({
    format: CORA_HUME_SESSION_DESCRIPTOR_FORMAT,
    state: binding.state,
    organizationConfig: Object.freeze({ id: configId, version: sessionConfig.configVersion }),
    hume: Object.freeze({ configId: humeId, credentialReady: binding.credentialReady, acceptance: 'not_verified' }),
    voiceProfile,
    prompt: buildPrompt({ style: behavior.style, maxSpokenChars: behavior.maxSpokenChars, interruptMode, turnMode }, voiceProfile),
    turn: Object.freeze({ style: behavior.style, maxSpokenChars: behavior.maxSpokenChars, interruptMode, turnMode }),
    hashes: Object.freeze({ config: requireHash(sessionConfig.configHash, 'Cora config hash'), toolManifest: requireHash(sessionConfig.toolManifestHash, 'Cora tool manifest hash'), routingPolicy: requireHash(sessionConfig.routingPolicyHash, 'Cora routing policy hash') }),
    providerInvocation: 'not_performed',
    humeMutation: 'not_performed',
  });
  return descriptor;
}

/** Resolve the verified Organization config and compile the server preflight. */
export async function buildCoraHumeSessionPreflight({ repository, signedContext, sessionToolManifest, humeConfigId = null, serverCredentialReady, serverBinding } = {}) {
  const sessionConfig = await resolvePublishedCoraSessionConfig({ repository, signedContext, sessionToolManifest });
  return compileCoraHumeSessionDescriptor({ sessionConfig, humeConfigId, serverCredentialReady, serverBinding });
}
