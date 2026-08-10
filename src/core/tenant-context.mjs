const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const ACTOR_ROLES = new Set(['owner', 'admin', 'member', 'auditor']);
const AUDIT_DECISIONS = new Set(['AUTO_RUN', 'ALLOW', 'PAUSE_FOR_OWNER', 'BLOCK', 'DENY']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const OUTBOX_OPERATION_TYPES = new Set(['ACK', 'RELEASE']);

export class TenantAuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TenantAuthorizationError';
  }
}

export class AuditOutboxClaimError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuditOutboxClaimError';
  }
}

function requiredText(value, field, maxLength = 200) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  if (normalized.length > maxLength) {
    throw new TypeError(`${field} must be ${maxLength} characters or fewer`);
  }
  return normalized;
}

export function normalizeTenantId(value) {
  const tenantId = requiredText(value, 'tenantId', 128).toLowerCase();
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new TypeError('tenantId must be a stable lowercase identifier');
  }
  return tenantId;
}

export function normalizeActorRole(value) {
  const role = requiredText(value, 'actorRole', 32).toLowerCase();
  if (!ACTOR_ROLES.has(role)) throw new TypeError(`Unknown actorRole: ${role}`);
  return role;
}

export function normalizeTenantContext(input = {}) {
  return Object.freeze({
    tenantId: normalizeTenantId(input.tenantId ?? input.tenant_id),
    actorSubject: requiredText(input.actorSubject ?? input.actor_subject, 'actorSubject'),
    actorRole: normalizeActorRole(input.actorRole ?? input.actor_role),
    sessionId: requiredText(input.sessionId ?? input.session_id, 'sessionId'),
    requestId: requiredText(input.requestId ?? input.request_id, 'requestId'),
  });
}

/**
 * Set request identity only for the current transaction. A missing context is
 * deliberately represented by PostgreSQL NULL, which matches no RLS policy.
 */
export async function applyTenantContext(client, input) {
  const context = normalizeTenantContext(input);
  await client.query(
    `select set_config('helmion.tenant_id', $1, true),
            set_config('helmion.actor_subject', $2, true),
            set_config('helmion.actor_role', $3, true),
            set_config('helmion.session_id', $4, true),
            set_config('helmion.request_id', $5, true)`,
    [
      context.tenantId,
      context.actorSubject,
      context.actorRole,
      context.sessionId,
      context.requestId,
    ],
  );
  return context;
}

/**
 * The request's role is only a claim until the tenant-owned membership row
 * confirms it. Enrollment is intentionally outside this module; a missing or
 * stale membership fails closed instead of auto-provisioning a boundary.
 */
export async function requireActiveTenantMembership(client, contextInput) {
  const context = normalizeTenantContext(contextInput);
  const result = await client.query(
    `select role
     from helmion.tenant_memberships
     where tenant_id=$1 and subject=$2 and active
     for share`,
    [context.tenantId, context.actorSubject],
  );
  if (result.rowCount !== 1) {
    throw new TenantAuthorizationError(
      `Actor ${context.actorSubject} is not an active member of tenant ${context.tenantId}`,
    );
  }
  if (result.rows[0].role !== context.actorRole) {
    throw new TenantAuthorizationError(
      `Actor ${context.actorSubject} does not hold the requested ${context.actorRole} role `
      + `in tenant ${context.tenantId}`,
    );
  }
  return result.rows[0];
}

export async function withTenantTransaction(pool, contextInput, work) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool is required');
  if (typeof work !== 'function') throw new TypeError('work must be a function');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const context = await applyTenantContext(client, contextInput);
    const result = await work(client, context);
    await client.query('commit');
    return { durability: 'committed', ...result };
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // Preserve the original error; pg will discard an unusable connection.
    }
    throw error;
  } finally {
    client.release();
  }
}

export function normalizeAuditEvent(input = {}) {
  const decision = requiredText(input.decision, 'decision', 32).toUpperCase();
  if (!AUDIT_DECISIONS.has(decision)) {
    throw new TypeError(`Unknown audit decision: ${decision}`);
  }
  const target = input.canonicalTarget ?? input.canonical_target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new TypeError('canonicalTarget must be an object');
  }
  const result = input.result ?? {};
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('result must be an object');
  }
  return Object.freeze({
    actionType: requiredText(input.actionType ?? input.action_type, 'actionType'),
    canonicalTarget: target,
    policyVersion: requiredText(input.policyVersion ?? input.policy_version, 'policyVersion'),
    decision,
    beforeRef: input.beforeRef ?? input.before_ref ?? null,
    afterRef: input.afterRef ?? input.after_ref ?? null,
    privacySummary: requiredText(
      input.privacySummary ?? input.privacy_summary,
      'privacySummary',
      2000,
    ),
    result,
  });
}

function boundedInteger(value, field, { defaultValue, min, max }) {
  const normalized = Number(value ?? defaultValue);
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
    throw new TypeError(`${field} must be an integer between ${min} and ${max}`);
  }
  return normalized;
}

export function normalizeAuditPage(input = {}) {
  const beforeId = input.beforeId ?? input.before_id ?? null;
  if (beforeId != null && !/^[1-9][0-9]*$/.test(String(beforeId).trim())) {
    throw new TypeError('beforeId must be a positive integer');
  }
  return Object.freeze({
    limit: boundedInteger(input.limit, 'limit', { defaultValue: 50, min: 1, max: 200 }),
    beforeId: beforeId == null ? null : String(beforeId).trim(),
  });
}

export function normalizeOutboxClaim(input = {}) {
  return Object.freeze({
    limit: boundedInteger(
      input.limit ?? input.claimLimit,
      'limit',
      { defaultValue: 20, min: 1, max: 100 },
    ),
    leaseSeconds: boundedInteger(
      input.leaseSeconds ?? input.lease_seconds,
      'leaseSeconds',
      { defaultValue: 60, min: 30, max: 900 },
    ),
  });
}

export function normalizeClaimToken(value) {
  const claimToken = requiredText(value, 'claimToken', 36).toLowerCase();
  if (!UUID_PATTERN.test(claimToken)) throw new TypeError('claimToken must be a UUID');
  return claimToken;
}

export function normalizeOutboxCommand(input = {}) {
  const idempotencyKey = requiredText(
    input.idempotencyKey ?? input.idempotency_key,
    'idempotencyKey',
    200,
  );
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new TypeError('idempotencyKey must be a stable 8-200 character identifier');
  }
  return Object.freeze({
    claimToken: normalizeClaimToken(input.claimToken ?? input.claim_token),
    idempotencyKey,
  });
}

export function normalizeOutboxInspection(input = {}) {
  const operationType = input.operationType ?? input.operation_type ?? null;
  const normalizedOperationType = operationType == null
    ? null
    : requiredText(operationType, 'operationType', 16).toUpperCase();
  if (normalizedOperationType != null && !OUTBOX_OPERATION_TYPES.has(normalizedOperationType)) {
    throw new TypeError(`Unknown operationType: ${normalizedOperationType}`);
  }
  const claimToken = input.claimToken ?? input.claim_token ?? null;
  return Object.freeze({
    limit: boundedInteger(input.limit, 'limit', { defaultValue: 50, min: 1, max: 200 }),
    operationType: normalizedOperationType,
    claimToken: claimToken == null ? null : normalizeClaimToken(claimToken),
  });
}
