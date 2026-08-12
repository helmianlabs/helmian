import { randomUUID } from 'node:crypto';
import {
  TenantAuthorizationError,
  applyTenantContext,
  requireActiveTenantMembership,
  withTenantTransaction,
} from '../core/tenant-context.mjs';
import {
  AIMFORGE_BOARD_TOOL_NAME,
  AIMFORGE_DEPARTMENT_HANDOFF_TOOL_NAME,
  AIMFORGE_PREPARE_DRIVER_MESSAGE_TOOL_NAME,
  AIMFORGE_EQUIPMENT_SAFETY_STATUS_TOOL_NAME,
  AIMFORGE_EQUIPMENT_SAFETY_CHECK_TOOL_NAME,
  AIMFORGE_EQUIPMENT_SAFETY_ESCALATION_TOOL_NAME,
  AIMFORGE_CONSOLE_NAVIGATION_TOOL_NAME,
} from '../cora/aimforge-board-action.mjs';

export const HELMIAN_ACTION_TOOL_NAMES = Object.freeze([
  AIMFORGE_BOARD_TOOL_NAME,
  AIMFORGE_PREPARE_DRIVER_MESSAGE_TOOL_NAME,
  AIMFORGE_DEPARTMENT_HANDOFF_TOOL_NAME,
  AIMFORGE_EQUIPMENT_SAFETY_STATUS_TOOL_NAME,
  AIMFORGE_EQUIPMENT_SAFETY_CHECK_TOOL_NAME,
  AIMFORGE_EQUIPMENT_SAFETY_ESCALATION_TOOL_NAME,
  AIMFORGE_CONSOLE_NAVIGATION_TOOL_NAME,
]);
export const HELMIAN_PLATFORM_TENANT_ID = 'helmian-platform';
const PLATFORM_POLICY_KEY = 'signed_aimforge_actions';

const TOOL_COLUMNS = Object.freeze({
  [AIMFORGE_BOARD_TOOL_NAME]: 'dispatch_board_summary_enabled',
  [AIMFORGE_PREPARE_DRIVER_MESSAGE_TOOL_NAME]: 'prepare_driver_message_enabled',
  [AIMFORGE_DEPARTMENT_HANDOFF_TOOL_NAME]: 'department_handoff_enabled',
  [AIMFORGE_EQUIPMENT_SAFETY_STATUS_TOOL_NAME]: 'equipment_safety_status_enabled',
  [AIMFORGE_EQUIPMENT_SAFETY_CHECK_TOOL_NAME]: 'equipment_safety_check_enabled',
  [AIMFORGE_EQUIPMENT_SAFETY_ESCALATION_TOOL_NAME]: 'equipment_safety_escalation_enabled',
  [AIMFORGE_CONSOLE_NAVIGATION_TOOL_NAME]: 'console_navigation_intent_enabled',
});

export class ActionPolicyConflictError extends Error {
  constructor(currentVersion) {
    super('Action policy changed after it was previewed');
    this.name = 'ActionPolicyConflictError';
    this.currentVersion = currentVersion;
  }
}

export function normalizeEnabledActionNames(value) {
  if (!Array.isArray(value)) throw new TypeError('enabledActions must be an array');
  if (value.length > HELMIAN_ACTION_TOOL_NAMES.length) throw new TypeError('enabledActions contains too many entries');
  const unique = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !Object.hasOwn(TOOL_COLUMNS, item)) {
      throw new TypeError('enabledActions contains an unknown action');
    }
    if (unique.has(item)) throw new TypeError('enabledActions cannot contain duplicates');
    unique.add(item);
  }
  return Object.freeze(HELMIAN_ACTION_TOOL_NAMES.filter((name) => unique.has(name)));
}

function normalizeVersion(value) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) throw new TypeError('policy version is invalid');
  return version;
}

function publicPolicy(row) {
  if (!row) {
    return Object.freeze({
      version: 0,
      enabledActions: HELMIAN_ACTION_TOOL_NAMES,
      source: 'global_release_default',
      effect: 'next_signed_session',
      scope: 'all_signed_aimforge_tenants',
    });
  }
  return Object.freeze({
    version: normalizeVersion(row.version),
    enabledActions: Object.freeze(HELMIAN_ACTION_TOOL_NAMES.filter((name) => Boolean(row[TOOL_COLUMNS[name]]))),
    source: 'platform_global_policy',
    effect: 'next_signed_session',
    scope: 'all_signed_aimforge_tenants',
  });
}

async function selectPolicy(client, suffix = '') {
  const result = await client.query(
    `select version, dispatch_board_summary_enabled, prepare_driver_message_enabled,
            department_handoff_enabled, equipment_safety_status_enabled,
            equipment_safety_check_enabled, equipment_safety_escalation_enabled,
            console_navigation_intent_enabled
       from helmion.platform_action_policy
      where policy_key=$1${suffix}`,
    [PLATFORM_POLICY_KEY],
  );
  return publicPolicy(result.rowCount === 1 ? result.rows[0] : null);
}

/** Global release filter applied after a signed bridge establishes customer scope. */
export async function resolvePlatformActionPolicy(pool) {
  const context = {
    tenantId: HELMIAN_PLATFORM_TENANT_ID,
    actorSubject: 'helmion:signed-session-policy',
    actorRole: 'member',
    sessionId: randomUUID(),
    requestId: randomUUID(),
  };
  const client = await pool.connect();
  try {
    await client.query('begin read only');
    await applyTenantContext(client, context);
    const policy = await selectPolicy(client);
    await client.query('commit');
    return policy;
  } catch (error) {
    try { await client.query('rollback'); } catch { /* preserve the original failure */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function readAdminActionPolicy(pool, context) {
  if (context?.tenantId !== HELMIAN_PLATFORM_TENANT_ID) {
    throw new TenantAuthorizationError('Platform action policy requires the helmian-platform tenant');
  }
  const result = await withTenantTransaction(pool, context, async (client, activeContext) => {
    await requireActiveTenantMembership(client, activeContext);
    return { policy: await selectPolicy(client) };
  });
  return result.policy;
}

async function appendPolicyAudit(client, context, {
  decision,
  actionType,
  beforePolicy,
  afterPolicy,
  reason,
}) {
  await client.query(
    `insert into helmion.audit_events
       (tenant_id, actor_subject, actor_role, session_id, request_id, action_type,
        canonical_target, policy_version, decision, before_ref, after_ref,
        privacy_summary, result)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,'tenant-action-policy.v1',$8,$9::jsonb,$10::jsonb,$11,$12::jsonb)`,
    [
      context.tenantId,
      context.actorSubject,
      context.actorRole,
      context.sessionId,
      context.requestId,
      actionType,
      JSON.stringify({ resource: 'platform_action_policy', scope: 'all_signed_aimforge_tenants' }),
      decision,
      beforePolicy == null ? null : JSON.stringify({ version: beforePolicy.version, enabledActions: beforePolicy.enabledActions }),
      afterPolicy == null ? null : JSON.stringify({ version: afterPolicy.version, enabledActions: afterPolicy.enabledActions }),
      'Bounded non-secret platform-global Helmian action kill switches',
      JSON.stringify({ reason }),
    ],
  );
}

export async function auditActionPolicyAttempt(pool, context, {
  decision,
  actionType,
  beforePolicy = null,
  afterPolicy = null,
  reason,
}) {
  if (context?.tenantId !== HELMIAN_PLATFORM_TENANT_ID) {
    throw new TenantAuthorizationError('Platform action policy requires the helmian-platform tenant');
  }
  await withTenantTransaction(pool, context, async (client, activeContext) => {
    await requireActiveTenantMembership(client, activeContext);
    await appendPolicyAudit(client, activeContext, { decision, actionType, beforePolicy, afterPolicy, reason });
    return {};
  });
}

export async function updateAdminActionPolicy(pool, context, { expectedVersion, enabledActions }) {
  if (context?.tenantId !== HELMIAN_PLATFORM_TENANT_ID) {
    throw new TenantAuthorizationError('Platform action policy requires the helmian-platform tenant');
  }
  const wanted = normalizeEnabledActionNames(enabledActions);
  const version = normalizeVersion(expectedVersion);
  const result = await withTenantTransaction(pool, context, async (client, activeContext) => {
    await requireActiveTenantMembership(client, activeContext);
    const beforePolicy = await selectPolicy(client, ' for update');
    if (beforePolicy.version !== version) {
      await appendPolicyAudit(client, activeContext, {
        decision: 'DENY',
        actionType: 'admin.action_policy.confirm',
        beforePolicy,
        afterPolicy: null,
        reason: 'optimistic_version_conflict',
      });
      return { conflictVersion: beforePolicy.version };
    }
    const flags = HELMIAN_ACTION_TOOL_NAMES.map((name) => wanted.includes(name));
    let written;
    if (version === 0) {
      written = await client.query(
        `insert into helmion.platform_action_policy
           (policy_key, managing_tenant_id, version, dispatch_board_summary_enabled,
            prepare_driver_message_enabled, department_handoff_enabled,
            equipment_safety_status_enabled, equipment_safety_check_enabled,
            equipment_safety_escalation_enabled, console_navigation_intent_enabled, updated_by)
         values ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (policy_key) do nothing
         returning version, dispatch_board_summary_enabled,
                   prepare_driver_message_enabled, department_handoff_enabled,
                   equipment_safety_status_enabled, equipment_safety_check_enabled,
                   equipment_safety_escalation_enabled, console_navigation_intent_enabled`,
        [PLATFORM_POLICY_KEY, HELMIAN_PLATFORM_TENANT_ID, ...flags, activeContext.actorSubject],
      );
    } else {
      written = await client.query(
        `update helmion.platform_action_policy
            set version=version+1,
                dispatch_board_summary_enabled=$3,
                prepare_driver_message_enabled=$4,
                department_handoff_enabled=$5,
                equipment_safety_status_enabled=$6,
                equipment_safety_check_enabled=$7,
                equipment_safety_escalation_enabled=$8,
                console_navigation_intent_enabled=$9,
                updated_by=$10,
                updated_at=clock_timestamp()
          where policy_key=$1 and version=$2
         returning version, dispatch_board_summary_enabled,
                   prepare_driver_message_enabled, department_handoff_enabled,
                   equipment_safety_status_enabled, equipment_safety_check_enabled,
                   equipment_safety_escalation_enabled, console_navigation_intent_enabled`,
        [PLATFORM_POLICY_KEY, version, ...flags, activeContext.actorSubject],
      );
    }
    if (written.rowCount !== 1) {
      const current = await selectPolicy(client, ' for update');
      await appendPolicyAudit(client, activeContext, {
        decision: 'DENY',
        actionType: 'admin.action_policy.confirm',
        beforePolicy: current,
        afterPolicy: null,
        reason: 'optimistic_version_conflict',
      });
      return { conflictVersion: current.version };
    }
    const afterPolicy = publicPolicy(written.rows[0]);
    await appendPolicyAudit(client, activeContext, {
      decision: 'ALLOW',
      actionType: 'admin.action_policy.confirm',
      beforePolicy,
      afterPolicy,
      reason: 'confirmed_by_current_admin',
    });
    return { policy: afterPolicy };
  });
  if (result.conflictVersion != null) throw new ActionPolicyConflictError(result.conflictVersion);
  return result.policy;
}
