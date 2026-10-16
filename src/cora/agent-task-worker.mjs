// Cloud agent-task worker: claims prepared agent task intents from Postgres
// (Neon) and records execution outcomes. Serverless-safe by design: no task type
// can execute against a provider, agent runtime, or filesystem here, so tasks
// that need a project workspace are recorded as 'needs_desktop' for the paired
// Helmian desktop (or a future runner) to pick up. Idempotent: one run row per
// task, claimed with SELECT ... FOR UPDATE SKIP LOCKED like the console worker.

export const AGENT_TASK_WORKER_FORMAT = 'helmian.agent-task-run.v1';
const WORKER_ID_PATTERN = /^worker:[a-z0-9][a-z0-9._:-]{0,95}$/;
// Task types that need a project filesystem / desktop runner. Everything else
// the cloud worker does not know how to run.
const DESKTOP_TASK_TYPES = new Set(['workspace_preview']);

export function createAgentTaskWorker({ pool, workerId = 'worker:cloud-agent-tasks', batchSize = 10, log = () => {} } = {}) {
  if (!pool?.connect) throw new Error('agent task worker needs a Postgres pool');
  if (!WORKER_ID_PATTERN.test(workerId)) throw new Error('agent task worker id is invalid');
  const limit = Math.min(Math.max(Number(batchSize) || 10, 1), 50);

  async function runOnce() {
    const client = await pool.connect();
    const processed = [];
    try {
      await client.query('begin');
      let claimed;
      try {
        claimed = await client.query(
          `select i.id, i.tenant_id, i.task_type, i.receipt_id from helmion.cora_agent_task_intents i
           where i.status = 'prepared'
             and not exists (select 1 from helmion.cora_agent_task_runs r where r.tenant_id = i.tenant_id and r.task_id = i.id)
           order by i.created_at, i.id limit $1 for update of i skip locked`,
          [limit],
        );
      } catch (error) {
        // Migration 045 not applied yet: nothing to drain.
        if (error?.code === '42P01') { await client.query('rollback').catch(() => {}); return processed; }
        throw error;
      }
      for (const task of claimed.rows) {
        let run;
        if (DESKTOP_TASK_TYPES.has(task.task_type)) {
          run = { outcome: 'needs_desktop', result: { reason: 'This task needs a project workspace; it is waiting for the paired Helmian desktop or a future runner.' } };
        } else {
          run = { outcome: 'refused', result: { error: `task type '${task.task_type}' is not executable by the cloud worker` } };
        }
        await client.query(
          `insert into helmion.cora_agent_task_runs (tenant_id, task_id, task_receipt_id, worker_id, outcome, result)
           values ($1,$2,$3,$4,$5,$6::jsonb) on conflict (tenant_id, task_id) do nothing`,
          [task.tenant_id, task.id, task.receipt_id, workerId, run.outcome, JSON.stringify({ format: AGENT_TASK_WORKER_FORMAT, ...run.result })],
        );
        processed.push({ receiptId: task.receipt_id, taskType: task.task_type, outcome: run.outcome });
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    for (const p of processed) log(`agent task ${p.taskType} ${p.receiptId} -> ${p.outcome}`);
    return processed;
  }

  function start({ intervalMs = 5000 } = {}) {
    let timer = null;
    let stopped = false;
    const tick = async () => {
      try { await runOnce(); } catch (error) { log(`agent task worker error: ${error.message}`); }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, 0);
    return { stop() { stopped = true; clearTimeout(timer); } };
  }

  return Object.freeze({ runOnce, start });
}
