// Cloud artifact-execution worker: picks up approved artifact execution
// requests from Postgres (Neon) and records execution outcomes.
// Serverless-safe by design: the requests table is append-only (a trigger
// rejects UPDATE/DELETE) and external_execution is always true by CHECK
// constraint, so the provider call happens off-cloud. Approved requests are
// recorded as 'needs_desktop' for the paired Helmian desktop (or a future
// runner) to pick up. Never acts on reject decisions or undecided requests.
// Pre-approved requests (status 'queued', set at append time by an owner or
// admin via approvalRef) carry no decision row; the worker drains them too,
// recording needs_desktop with the approval_ref as the decision reference.
// decide() still refuses anything that is not approval_required.
// Idempotent: one run row per request, claimed with SELECT ... FOR UPDATE
// SKIP LOCKED like the console and agent-task workers.
//
// Mutual exclusion: before recording a run row, the worker acquires the
// workspace write lease for the request's scope. Artifact execution requests
// carry no project key, so the lease is tenant-scoped (projectKey null).
// If the lease cannot be acquired the item is skipped and left for the next
// drain — never forced. Fail-closed: without the lease table, nothing runs.

import { acquireWorkspaceLease, releaseWorkspaceLease } from './workspace-lease.mjs';
import { enqueueConnectorMessage } from './connector-outbound-worker.mjs';

export const ARTIFACT_EXECUTION_WORKER_FORMAT = 'helmian.artifact-execution-run.v1';
const WORKER_ID_PATTERN = /^worker:[a-z0-9][a-z0-9._:-]{0,95}$/;
const LEASE_TTL_MS = 120000;

export function createArtifactExecutionWorker({ pool, workerId = 'worker:cloud-artifact-executions', batchSize = 10, log = () => {} } = {}) {
  if (!pool?.connect) throw new Error('artifact execution worker needs a Postgres pool');
  if (!WORKER_ID_PATTERN.test(workerId)) throw new Error('artifact execution worker id is invalid');
  const limit = Math.min(Math.max(Number(batchSize) || 10, 1), 50);

  async function claimBatch() {
    const client = await pool.connect();
    try {
      await client.query('begin');
      let claimed;
      try {
        claimed = await client.query(
          `select r.id, r.tenant_id, r.receipt_id,
                  coalesce(d.receipt_id, 'approval_ref:' || r.approval_ref) as decision_receipt_id
           from helmion.cora_artifact_execution_requests r
           left join helmion.cora_approval_decisions d
             on d.tenant_id = r.tenant_id
            and d.request_kind = 'artifact_execution_request'
            and d.request_receipt_id = r.receipt_id
            and d.decision = 'approve'
           where ((r.status = 'approval_required' and d.receipt_id is not null)
               or (r.status = 'queued' and r.approval_ref is not null))
             and not exists (select 1 from helmion.cora_artifact_execution_runs e where e.tenant_id = r.tenant_id and e.execution_request_id = r.id)
           order by r.created_at, r.id limit $1 for update of r skip locked`,
          [limit],
        );
      } catch (error) {
        // Migration 046 not applied yet: nothing to drain.
        await client.query('rollback').catch(() => {});
        if (error?.code === '42P01') return [];
        throw error;
      }
      await client.query('commit');
      return claimed.rows;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function recordRuns(tenantId, rows) {
    const processed = [];
    const client = await pool.connect();
    try {
      await client.query('begin');
      for (const request of rows) {
        const run = { outcome: 'needs_desktop', result: { reason: 'Approved. The provider call runs on the paired Helmian desktop (external execution); this receipt queues the handoff.' } };
        const inserted = await client.query(
          `insert into helmion.cora_artifact_execution_runs (tenant_id, execution_request_id, request_receipt_id, decision_receipt_id, worker_id, outcome, result)
           values ($1,$2,$3,$4,$5,$6,$7::jsonb) on conflict (tenant_id, execution_request_id) do nothing`,
          [request.tenant_id, request.id, request.receipt_id, request.decision_receipt_id, workerId, run.outcome, JSON.stringify({ format: ARTIFACT_EXECUTION_WORKER_FORMAT, ...run.result })],
        );
        if (inserted.rowCount === 1) processed.push({ receiptId: request.receipt_id, decisionReceiptId: request.decision_receipt_id, outcome: run.outcome });
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return processed;
  }

  async function runOnce() {
    const claimed = await claimBatch();
    if (claimed.length === 0) return [];
    const byTenant = new Map();
    for (const request of claimed) {
      if (!byTenant.has(request.tenant_id)) byTenant.set(request.tenant_id, []);
      byTenant.get(request.tenant_id).push(request);
    }
    const processed = [];
    for (const [tenantId, rows] of byTenant) {
      // No project key on the request: lease at tenant scope. Skip on failure — never force.
      const lease = await acquireWorkspaceLease({ pool, tenantId, projectKey: null, holder: workerId, ttlMs: LEASE_TTL_MS });
      if (!lease.acquired) {
        log(`artifact execution write lease not acquired (${lease.reason}); leaving ${rows.length} request(s) for the next drain`);
        continue;
      }
      try {
        const done = await recordRuns(tenantId, rows);
        // Best-effort outbox notification per completed handoff. Never fails the run.
        for (const item of done) {
          for (const provider of ['discord', 'slack']) {
            await enqueueConnectorMessage({ pool, tenantId, provider, channelLabel: 'artifact-executions', text: `Artifact execution ${item.receiptId} -> ${item.outcome}.` }).catch(() => {});
          }
        }
        processed.push(...done);
      } finally {
        await releaseWorkspaceLease({ pool, tenantId, projectKey: null, leaseToken: lease.leaseToken })
          .catch((error) => log(`artifact execution lease release failed: ${error.message}`));
      }
    }
    for (const p of processed) log(`artifact execution ${p.receiptId} -> ${p.outcome}`);
    return processed;
  }

  function start({ intervalMs = 5000 } = {}) {
    let timer = null;
    let stopped = false;
    const tick = async () => {
      try { await runOnce(); } catch (error) { log(`artifact execution worker error: ${error.message}`); }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, 0);
    return { stop() { stopped = true; clearTimeout(timer); } };
  }

  return Object.freeze({ runOnce, start });
}
