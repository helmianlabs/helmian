import { EXACT_CANARY_SEQUENCE } from './release-canary-contract.mjs';

export const RELEASE_CANARY_OBSERVATION_FORMAT = 'helmian.cloud.release-canary-observation.v1';
const SECRET_KEY = /(secret|token|password|api[_-]?key|credential|private[_-]?key|database[_-]?url|connection[_-]?string)/iu;

function rejectSecrets(value, path = 'observation') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new Error(`${path}.${key} is secret-bearing and is not allowed`);
    rejectSecrets(child, `${path}.${key}`);
  }
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} is required`);
  return value;
}

/**
 * Validate evidence from a physical canary without contacting any external
 * system. It deliberately accepts only bounded, non-secret observations.
 */
export function validateReleaseCanaryObservation(observation = {}) {
  const errors = [];
  try {
    const input = requireObject(observation, 'canary observation');
    rejectSecrets(input);
    if (input.format !== RELEASE_CANARY_OBSERVATION_FORMAT) throw new Error('observation format is unsupported');
    if (!Array.isArray(input.steps) || input.steps.length !== EXACT_CANARY_SEQUENCE.length || input.steps.some((step, index) => step?.name !== EXACT_CANARY_SEQUENCE[index] || step.status !== 'pass')) throw new Error('canary steps are incomplete or out of order');
    const authority = requireObject(input.authority, 'authority observation');
    if (authority.organizationSource !== 'verified_active_membership') throw new Error('Organization authority was not verified from active membership');
    if (authority.clientTenantSelectorUsed !== false || authority.clientPlantSelectorUsed !== false) throw new Error('client tenant or Plant selector was used');
    if (authority.plantAuthority !== 'business_data_only') throw new Error('Plant authority boundary is invalid');
    if (authority.crossOrganizationAccess !== 'denied') throw new Error('cross-Organization access was not denied');
    if (input.normalWork?.readPrepare !== 'allowed_without_approval') throw new Error('normal read/prepare was not low-friction');
    const receipt = requireObject(input.providerSessionReceipt, 'provider session receipt observation');
    if (receipt.durable !== true || receipt.organizationConfigPinned !== true || receipt.usageUnknownAllowed !== true) throw new Error('provider session receipt evidence is incomplete');
    if (input.providerClaimWithoutReceipt !== false) throw new Error('provider claim without source receipt was observed');
  } catch (error) {
    errors.push(error?.message ?? String(error));
  }
  return Object.freeze({ format: RELEASE_CANARY_OBSERVATION_FORMAT, valid: errors.length === 0, errors: Object.freeze(errors) });
}
