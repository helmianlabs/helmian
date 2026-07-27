import { classifyOperation } from './governance.mjs';

export const PILOT_DECISION = Object.freeze({
  AUTO_RUN: 'AUTO_RUN',
  PAUSE_FOR_OWNER: 'PAUSE_FOR_OWNER',
  BLOCK: 'BLOCK',
});

const HARD_BLOCKS = [
  ['guardBlocked', 'deterministic destructive-operation guard blocked the action'],
  ['blockingRuleMatched', 'an active block-severity autonomy rule matched'],
  ['activeBlockerMatched', 'an active scoped blocker matched'],
  ['leaseConflict', 'the caller does not hold the required write lease'],
  ['unverifiedSharedState', 'shared governance state could not be verified'],
];

const HIGH_RISK_FLAGS = [
  ['destructive', 'destructive or difficult-to-recover change'],
  ['externalWrite', 'write to an external or shared system'],
  ['productionDeploy', 'production deployment or release'],
  ['credentialAccess', 'credential or secret access'],
  ['permissionChange', 'permission or authorization change'],
  ['identityTrustChange', 'identity trust enrollment, rotation, or revocation'],
  ['securityControlChange', 'security-control change'],
  ['irreversible', 'irreversible operation'],
];

function result({ decision, tier, reasons }) {
  return Object.freeze({
    decision,
    tier,
    reasons: Object.freeze(reasons),
    auto_run: decision === PILOT_DECISION.AUTO_RUN,
    owner_confirmation_required: decision === PILOT_DECISION.PAUSE_FOR_OWNER,
    advisor_consensus_can_authorize: false,
  });
}

export function evaluatePilotAction(operation = {}, guardState = {}) {
  const hardBlocks = HARD_BLOCKS
    .filter(([flag]) => guardState[flag] === true)
    .map(([, reason]) => reason);
  if (hardBlocks.length) {
    return result({
      decision: PILOT_DECISION.BLOCK,
      tier: 'BLOCKED',
      reasons: hardBlocks,
    });
  }

  const existing = classifyOperation(operation);
  const highRisk = [
    ...(existing.tier === 'B' ? existing.reasons : []),
    ...HIGH_RISK_FLAGS
      .filter(([flag]) => operation[flag] === true)
      .map(([, reason]) => reason),
  ];
  const scope = String(operation.pilotScope ?? operation.scope ?? '').trim().toLowerCase();
  if (scope && scope !== 'local-workspace') {
    highRisk.push(`scope is ${scope}, not local-workspace`);
  }
  if (highRisk.length) {
    return result({
      decision: PILOT_DECISION.PAUSE_FOR_OWNER,
      tier: 'B',
      reasons: [...new Set(highRisk)],
    });
  }

  const lowRiskRequirements = [
    [scope === 'local-workspace', 'scope must be explicitly local-workspace'],
    [operation.wellBounded === true, 'action must be explicitly well bounded'],
    [operation.reversible === true, 'action must be explicitly reversible'],
    [operation.sensitiveData === false, 'sensitiveData must be explicitly false'],
  ];
  const missing = lowRiskRequirements
    .filter(([satisfied]) => !satisfied)
    .map(([, reason]) => reason);
  if (missing.length) {
    return result({
      decision: PILOT_DECISION.PAUSE_FOR_OWNER,
      tier: 'B',
      reasons: ['ambiguous action defaults to owner review', ...missing],
    });
  }

  return result({
    decision: PILOT_DECISION.AUTO_RUN,
    tier: 'A',
    reasons: [
      'explicitly local-workspace',
      'well bounded',
      'reversible',
      'no protected boundary or blocking guard matched',
    ],
  });
}
