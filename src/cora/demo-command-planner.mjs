// Strict, local-only demo command planner. It accepts typed requests only and
// returns previews; it does not navigate, authorize, persist, or call a provider.
export const CORA_DEMO_INTENT_IDS = Object.freeze([
  'switch-dashboard', 'locate-trucks', 'search-loads', 'prepare-payroll-work',
]);

export const CORA_DEMO_INTENT_CATALOG = Object.freeze({
  'switch-dashboard': Object.freeze({ coraAction: 'search' }),
  'locate-trucks': Object.freeze({ coraAction: 'search' }),
  'search-loads': Object.freeze({ coraAction: 'search' }),
  'prepare-payroll-work': Object.freeze({ coraAction: 'approval-required-execute' }),
});

const FIXED = Object.freeze({
  schemaVersion: 1,
  format: 'cora.demo-command-plan.v1',
  mode: 'local-mock-only',
  enabled: false,
  wired: false,
  execution: 'not-wired',
  authorization: 'not_evaluated',
  invocation: 'not_performed',
});

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function planCoraDemoCommand(input = {}) {
  const intent = input?.intent;
  if (!CORA_DEMO_INTENT_IDS.includes(intent)) {
    return freeze({ ...FIXED, valid: false, status: 'clarification-required', code: 'CORA_DEMO_INTENT_UNKNOWN', approval: null });
  }

  const gated = intent === 'prepare-payroll-work';
  return freeze({
    ...FIXED,
    valid: true,
    status: 'preview-ready',
    intent,
    request: intent === 'prepare-payroll-work'
      ? { period: input.period ?? 'current-week', group: input.group ?? 'drivers' }
      : null,
    preview: intent === 'switch-dashboard'
      ? { navigation: 'not_performed' }
      : { result: 'local-mock-only' },
    approval: gated ? {
      format: 'cora.helmion-approval-projection.v1',
      action: 'execute',
      decision: 'pending',
      confirmation_required: true,
      approval_required: true,
      enabled: false,
      wired: false,
      execution: 'not-wired',
      authorization: 'not_evaluated',
      invocation: 'not_performed',
    } : null,
  });
}

