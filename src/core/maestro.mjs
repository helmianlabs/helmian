import { createHash } from 'node:crypto';
import { classifyOperation } from './governance.mjs';

export const ADAPTER_MODE = Object.freeze({
  READ_ONLY: 'read-only',
  READ_WRITE: 'read-write',
});

export class ReadOnlyAdapterError extends Error {
  constructor(coordinatorId) {
    super(`${coordinatorId} adapter is in read-only mode; shared governance writes are disabled`);
    this.name = 'ReadOnlyAdapterError';
    this.coordinatorId = coordinatorId;
  }
}

export class LeaseConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LeaseConflictError';
    this.details = details;
  }
}

export class LeaseAuthorizationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LeaseAuthorizationError';
    this.details = details;
  }
}

export class IdempotencyConflictError extends Error {
  constructor(idempotencyKey) {
    super(`Idempotency key ${idempotencyKey} was already used for a different request`);
    this.name = 'IdempotencyConflictError';
    this.idempotencyKey = idempotencyKey;
  }
}

function canonicalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function operationFingerprint(operationType, request) {
  return createHash('sha256')
    .update(canonicalJson({ operationType, request }))
    .digest('hex');
}

export function normalizeCoordinatorId(value) {
  const coordinatorId = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(coordinatorId)) {
    throw new TypeError('coordinatorId must be a stable lowercase identifier');
  }
  return coordinatorId;
}

export function normalizeInstanceId(value) {
  const instanceId = String(value ?? '').trim();
  if (!instanceId || instanceId.length > 200) {
    throw new TypeError('instanceId is required and must be 200 characters or fewer');
  }
  return instanceId;
}

export function requireIdempotencyKey(value) {
  const idempotencyKey = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(idempotencyKey)) {
    throw new TypeError('idempotencyKey must be a stable 8-200 character identifier');
  }
  return idempotencyKey;
}

function normalizeStringArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value.map((entry) => {
    const normalized = String(entry ?? '').trim();
    if (!normalized) throw new TypeError(`${field} cannot contain blank entries`);
    return normalized;
  });
}

export function normalizeCheckpoint(input = {}) {
  const workCompleted = String(input.work_completed ?? input.workCompleted ?? '').trim();
  const nextSafeAction = String(input.next_safe_action ?? input.nextSafeAction ?? '').trim();
  if (!workCompleted) throw new TypeError('checkpoint work_completed is required');
  if (!nextSafeAction) throw new TypeError('checkpoint next_safe_action is required');

  const normalized = {
    work_completed: workCompleted,
    files_changed: normalizeStringArray(
      input.files_changed ?? input.filesChanged,
      'checkpoint files_changed',
    ),
    test_results: normalizeStringArray(
      input.test_results ?? input.testResults,
      'checkpoint test_results',
    ),
    open_blockers: normalizeStringArray(
      input.open_blockers ?? input.openBlockers,
      'checkpoint open_blockers',
    ),
    unresolved_risks: normalizeStringArray(
      input.unresolved_risks ?? input.unresolvedRisks,
      'checkpoint unresolved_risks',
    ),
    next_safe_action: nextSafeAction,
  };
  if (normalized.test_results.length === 0) {
    throw new TypeError('checkpoint test_results must state a result or why tests were not run');
  }
  return normalized;
}

function stableRows(rows, keys) {
  return [...(rows ?? [])]
    .map((row) => canonicalize(row))
    .sort((left, right) => {
      for (const key of keys) {
        const comparison = String(left?.[key] ?? '').localeCompare(String(right?.[key] ?? ''));
        if (comparison !== 0) return comparison;
      }
      return canonicalJson(left).localeCompare(canonicalJson(right));
    });
}

export function buildMaestroHandoff({
  projectSlug,
  fromLease,
  toLease,
  checkpoint = null,
  sharedState = {},
  switchedBy,
  switchedAt,
  incompleteReason = null,
}) {
  const hasCheckpoint = checkpoint != null;
  const reason = String(incompleteReason ?? '').trim();
  if (!hasCheckpoint && !reason) {
    throw new TypeError('incompleteReason is required when a checkpoint is unavailable');
  }

  const warning = hasCheckpoint
    ? null
    : `INCOMPLETE HANDOFF: no durable checkpoint was available. ${reason}`;
  const handoff = {
    version: 1,
    project_slug: String(projectSlug),
    status: hasCheckpoint ? 'COMPLETE' : 'INCOMPLETE',
    from: {
      coordinator_id: normalizeCoordinatorId(fromLease.coordinator_id),
      lease_token: String(fromLease.lease_token),
    },
    to: {
      coordinator_id: normalizeCoordinatorId(toLease.coordinator_id),
      lease_token: String(toLease.lease_token),
    },
    checkpoint: hasCheckpoint ? canonicalize(checkpoint) : null,
    shared_state: {
      blockers: stableRows(sharedState.blockers, ['severity', 'id']),
      context: stableRows(sharedState.context, ['key']),
      rules: stableRows(sharedState.rules, ['severity', 'id']),
    },
    next_safe_action: hasCheckpoint ? checkpoint.next_safe_action : null,
    warning,
    requires_human_confirmation: !hasCheckpoint,
    switched_by: String(switchedBy ?? '').trim(),
    switched_at: canonicalize(switchedAt),
  };
  if (!handoff.switched_by) throw new TypeError('switchedBy is required');
  if (!handoff.switched_at) throw new TypeError('switchedAt is required');
  return handoff;
}

export function handoffOperationStatus({ handoff, operation }) {
  const classification = classifyOperation(operation);
  const incompleteHandoff = handoff?.requires_human_confirmation === true;
  if (classification.tier === 'B') {
    return {
      allowed: false,
      tier: classification.tier,
      reasons: [
        ...classification.reasons,
        incompleteHandoff
          ? 'latest Maestro handoff is incomplete and requires an identity-backed confirmation'
          : 'Tier B handoff action requires an identity-backed confirmation',
      ],
      warning: incompleteHandoff ? handoff.warning : null,
      requires_human_confirmation: true,
    };
  }
  return {
    allowed: true,
    tier: classification.tier,
    reasons: classification.reasons,
    warning: incompleteHandoff ? handoff.warning : null,
    requires_human_confirmation: false,
  };
}
