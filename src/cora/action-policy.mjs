// Cora's front-door policy posture. The signed human session and server-side
// resource checks remain authoritative; this module only makes the normal
// allow versus high-risk step-up distinction explicit and deterministic.
const HIGH_RISK_FLAGS = Object.freeze([
  'external_write', 'irreversible', 'credential_access', 'money', 'delete',
  'publish', 'permission_change', 'identity_change', 'safety_release',
]);

const NORMAL_ACTIONS = new Set(['navigate', 'read', 'draft', 'prepare']);

function frozen(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

export const CORA_ACTION_POLICY_FORMAT = 'cora.action-policy.v1';

export function evaluateCoraActionPolicy(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return frozen({ format: CORA_ACTION_POLICY_FORMAT, decision: 'deny', code: 'CORA_POLICY_INPUT_INVALID' });
  }
  const action = typeof input.action === 'string' ? input.action.trim().toLowerCase() : '';
  const inScope = input.in_scope === true;
  const roleVerified = input.role_verified === true;
  const highRisk = HIGH_RISK_FLAGS.filter((flag) => input[flag] === true);
  if (!roleVerified || !inScope) {
    return frozen({ format: CORA_ACTION_POLICY_FORMAT, decision: 'deny', approval_required: false, reason: 'verified role and resource scope are required' });
  }
  if (!NORMAL_ACTIONS.has(action) && highRisk.length === 0) {
    return frozen({ format: CORA_ACTION_POLICY_FORMAT, decision: 'deny', approval_required: false, reason: 'unknown action class' });
  }
  if (highRisk.length > 0) {
    return frozen({ format: CORA_ACTION_POLICY_FORMAT, decision: 'step-up', approval_required: true, confirmation_required: true, reasons: highRisk });
  }
  return frozen({ format: CORA_ACTION_POLICY_FORMAT, decision: 'allow', approval_required: false, confirmation_required: false, reason: 'normal in-scope action for verified role' });
}

