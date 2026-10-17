// Evidence reads: Maestro handoffs, project checkpoints, the unified run-receipt
// ledger, and lease posture. Read-only; nothing here mutates state.
//
// Tenant-scoping restriction (design decision, PARITY-007): the
// maestro_handoffs, project_checkpoints, and maestro_leases tables come from
// migration 002, the pre-tenant era. They are keyed by project_slug with no
// tenant_id column, and there is no mapping to tenant-scoped
// workspace_projects. These reads are therefore restricted to owner/admin
// roles until a follow-up migration adds tenant scoping or a slug mapping.
// Do NOT adopt a "slug == project_key" convention to fake the scoping.
// The run ledger (console_command_runs, cora_agent_task_runs,
// cora_artifact_execution_runs) and workspace_write_leases are tenant-scoped
// and filtered by the actor's tenant.
//
// Every read is 42P01-safe: a missing table contributes nothing instead of
// failing the request, so the surface degrades gracefully before the
// corresponding migration is applied.

import { withTenantTransaction, requireActiveTenantMembership } from '../core/tenant-context.mjs';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_TEXT = 2000;

function boundedLimit(value, fallback = DEFAULT_LIMIT) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_LIMIT);
}

function boundedText(value) {
  const text = String(value ?? '').trim();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

function requireOwnerOrAdmin(actor) {
  if (!['owner', 'admin'].includes(String(actor?.role ?? '').toLowerCase())) {
    throw Object.assign(new Error('Owner or admin membership required'), { status: 403 });
  }
}

function actorContext(actor) {
  return {
    tenantId: actor.tenantId,
    actorSubject: actor.subject,
    actorRole: actor.role,
    sessionId: actor.sessionId,
    requestId: actor.requestId,
  };
}

function handoffRow(row) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const from = String(row.from_coordinator_id ?? '');
  const to = String(row.to_coordinator_id ?? '');
  return Object.freeze({
    id: Number(row.id),
    projectSlug: String(row.project_slug ?? ''),
    direction: `${from} → ${to}`,
    status: String(row.status ?? ''),
    summary: boundedText(payload.summary),
    evidence: boundedText(payload.evidence),
    warning: row.warning == null ? null : boundedText(row.warning),
    requiresHumanConfirmation: row.requires_human_confirmation === true,
    confirmedBy: row.confirmed_by == null ? null : String(row.confirmed_by),
    confirmedAt: row.confirmed_at == null ? null : new Date(row.confirmed_at).toISOString(),
    checkpointId: row.checkpoint_id == null ? null : Number(row.checkpoint_id),
    switchedBy: String(row.switched_by ?? ''),
    createdAt: new Date(row.created_at).toISOString(),
  });
}

function checkpointRow(row) {
  const list = (value) => (Array.isArray(value) ? value.map((v) => boundedText(v)).slice(0, 50) : []);
  return Object.freeze({
    id: Number(row.id),
    projectSlug: String(row.project_slug ?? ''),
    coordinatorId: String(row.coordinator_id ?? ''),
    workCompleted: boundedText(row.work_completed),
    filesChanged: list(row.files_changed),
    testResults: list(row.test_results),
    openBlockers: list(row.open_blockers),
    unresolvedRisks: list(row.unresolved_risks),
    nextSafeAction: boundedText(row.next_safe_action),
    createdAt: new Date(row.created_at).toISOString(),
  });
}

function runRow(kind, row, receipt) {
  const result = row.result && typeof row.result === 'object' ? row.result : {};
  const summary = boundedText(
    result.reason ?? result.error ?? result.summary ?? result.note ?? row.outcome ?? '',
  );
  return Object.freeze({
    kind,
    id: Number(row.id),
    receipt: String(receipt ?? ''),
    outcome: String(row.outcome ?? ''),
    summary,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

export function createEvidenceStore(pool) {
  if (!pool?.connect) throw new Error('evidence store needs a Postgres pool');

  async function readGlobal(actor, sql) {
    // Pre-tenant tables: no tenant filter is possible. Membership is still
    // verified against the actor's tenant, and only owners/admins may read.
    requireOwnerOrAdmin(actor);
    const context = actorContext(actor);
    try {
      return await withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query(sql.text, sql.params);
        return { rows: result.rows, migrationPending: false };
      });
    } catch (error) {
      if (error?.code === '42P01') return { rows: [], migrationPending: true };
      throw error;
    }
  }

  async function readTenantTable(actor, sql) {
    const context = actorContext(actor);
    try {
      return await withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query(sql.text, sql.params);
        return { rows: result.rows, migrationPending: false };
      });
    } catch (error) {
      if (error?.code === '42P01') return { rows: [], migrationPending: true };
      throw error;
    }
  }

  return Object.freeze({
    async listHandoffs(actor, limit = DEFAULT_LIMIT) {
      const n = boundedLimit(limit);
      const { rows, migrationPending } = await readGlobal(actor, {
        text: `select id, project_slug, from_coordinator_id, to_coordinator_id, status,
                      warning, requires_human_confirmation, confirmed_by, confirmed_at,
                      checkpoint_id, payload, switched_by, created_at
               from helmion.maestro_handoffs
               order by created_at desc, id desc
               limit $1`,
        params: [n],
      });
      return { handoffs: rows.map(handoffRow), migrationPending };
    },

    async listCheckpoints(actor, limit = DEFAULT_LIMIT) {
      const n = boundedLimit(limit);
      const { rows, migrationPending } = await readGlobal(actor, {
        text: `select id, project_slug, coordinator_id, work_completed, files_changed,
                      test_results, open_blockers, unresolved_risks, next_safe_action, created_at
               from helmion.project_checkpoints
               order by created_at desc, id desc
               limit $1`,
        params: [n],
      });
      return { checkpoints: rows.map(checkpointRow), migrationPending };
    },

    async listRunLedger(actor, limit = DEFAULT_LIMIT) {
      requireOwnerOrAdmin(actor);
      const n = boundedLimit(limit);
      const perTable = Math.max(n, 10);
      const [consoleRuns, agentRuns, artifactRuns] = await Promise.all([
        readTenantTable(actor, {
          text: `select id, receipt_id, outcome, result, created_at
                 from helmion.console_command_runs
                 where tenant_id = $1
                 order by created_at desc, id desc
                 limit $2`,
          params: [actor.tenantId, perTable],
        }),
        readTenantTable(actor, {
          text: `select id, task_receipt_id, outcome, result, created_at
                 from helmion.cora_agent_task_runs
                 where tenant_id = $1
                 order by created_at desc, id desc
                 limit $2`,
          params: [actor.tenantId, perTable],
        }),
        readTenantTable(actor, {
          text: `select id, request_receipt_id, outcome, result, created_at
                 from helmion.cora_artifact_execution_runs
                 where tenant_id = $1
                 order by created_at desc, id desc
                 limit $2`,
          params: [actor.tenantId, perTable],
        }),
      ]);
      const runs = [
        ...consoleRuns.rows.map((row) => runRow('console_command', row, row.receipt_id)),
        ...agentRuns.rows.map((row) => runRow('agent_task', row, row.task_receipt_id)),
        ...artifactRuns.rows.map((row) => runRow('artifact_execution', row, row.request_receipt_id)),
      ];
      runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id));
      return {
        runs: runs.slice(0, n),
        migrationPending: consoleRuns.migrationPending || agentRuns.migrationPending || artifactRuns.migrationPending,
      };
    },

    async listLeasePosture(actor) {
      requireOwnerOrAdmin(actor);
      const [workspaceLeases, maestroLeases] = await Promise.all([
        readTenantTable(actor, {
          text: `select coalesce(project_key, '(tenant)') as scope, holder, expires_at,
                        extract(epoch from (expires_at - clock_timestamp())) as seconds_remaining
                 from helmion.workspace_write_leases
                 where tenant_id = $1 and status = 'ACTIVE'
                 order by expires_at asc`,
          params: [actor.tenantId],
        }),
        readGlobal(actor, {
          text: `select ('maestro:' || project_slug) as scope, coordinator_id as holder, expires_at,
                        extract(epoch from (expires_at - clock_timestamp())) as seconds_remaining
                 from helmion.maestro_leases
                 where status = 'ACTIVE'
                 order by expires_at asc`,
          params: [],
        }),
      ]);
      const leases = [...workspaceLeases.rows, ...maestroLeases.rows].map((row) => Object.freeze({
        scope: String(row.scope ?? ''),
        holder: String(row.holder ?? ''),
        expiresAt: new Date(row.expires_at).toISOString(),
        secondsRemaining: Math.round(Number(row.seconds_remaining)),
      }));
      return {
        leases,
        migrationPending: workspaceLeases.migrationPending || maestroLeases.migrationPending,
      };
    },
  });
}
