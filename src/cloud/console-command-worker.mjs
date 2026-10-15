// Cloud console worker: claims prepared console command intents from Postgres
// (Neon) and executes the read-only, tenant-scoped ones. Commands that need a
// project filesystem or a provider session are recorded as 'needs_desktop' so
// the paired desktop (or a future VPS runner) can pick them up. Nothing here
// mutates files, runs shell commands, or invokes a model provider.

export const CONSOLE_WORKER_FORMAT = 'helmian.console-command-run.v1';
const WORKER_ID_PATTERN = /^worker:[a-z0-9][a-z0-9._:-]{0,95}$/;
const DESKTOP_COMMANDS = new Set(['run_project_task', 'start_project_preview', 'stop_project_preview']);

async function safeRows(client, sql, params) {
  try { return (await client.query(sql, params)).rows; } catch (error) { return { unavailable: error.code === '42P01' ? 'table_missing' : 'query_failed' }; }
}

export const CONSOLE_EXECUTORS = Object.freeze({
  async workspace_context(client, intent) {
    const [projects, members, tasks, providers] = await Promise.all([
      safeRows(client, "select count(*)::int as n from helmion.workspace_projects where tenant_id=$1 and lifecycle='active'", [intent.tenant_id]),
      safeRows(client, 'select count(*)::int as n from helmion.tenant_memberships where tenant_id=$1', [intent.tenant_id]),
      safeRows(client, 'select count(*)::int as n from helmion.cora_agent_task_intents where tenant_id=$1', [intent.tenant_id]),
      safeRows(client, "select count(*)::int as n from helmion.provider_connections where tenant_id=$1 and lifecycle='verified'", [intent.tenant_id]),
    ]);
    const n = (rows) => (Array.isArray(rows) ? rows[0]?.n ?? 0 : rows);
    return { outcome: 'completed', result: { activeProjects: n(projects), members: n(members), agentTasks: n(tasks), verifiedProviders: n(providers) } };
  },
  async list_agents(client, intent) {
    const rows = await safeRows(client, 'select provider_id, auth_mode, lifecycle, adapter, updated_at from helmion.provider_connections where tenant_id=$1 order by provider_id', [intent.tenant_id]);
    if (!Array.isArray(rows)) return { outcome: 'failed', result: { error: rows.unavailable } };
    return { outcome: 'completed', result: { agents: rows.map((r) => ({ provider: r.provider_id, authMode: r.auth_mode, lifecycle: r.lifecycle, adapter: r.adapter, updatedAt: r.updated_at })) } };
  },
  async open_project(client, intent) {
    const key = String(intent.arguments?.project ?? intent.arguments?.projectKey ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._:-]{0,95}$/.test(key)) return { outcome: 'refused', result: { error: 'arguments.project must be a registered project key' } };
    const rows = await safeRows(client, 'select project_key, display_name, source_kind, default_branch, lifecycle, updated_at from helmion.workspace_projects where tenant_id=$1 and project_key=$2', [intent.tenant_id, key]);
    if (!Array.isArray(rows)) return { outcome: 'failed', result: { error: rows.unavailable } };
    if (!rows.length) return { outcome: 'refused', result: { error: `project '${key}' is not registered for this Organization` } };
    const p = rows[0];
    return { outcome: 'completed', result: { project: { key: p.project_key, name: p.display_name, source: p.source_kind, branch: p.default_branch, lifecycle: p.lifecycle, updatedAt: p.updated_at } } };
  },
});

export function createConsoleCommandWorker({ pool, workerId = 'worker:cloud-console', batchSize = 10, executors = CONSOLE_EXECUTORS, log = () => {} } = {}) {
  if (!pool?.connect) throw new Error('console worker needs a Postgres pool');
  if (!WORKER_ID_PATTERN.test(workerId)) throw new Error('console worker id is invalid');
  const limit = Math.min(Math.max(Number(batchSize) || 10, 1), 50);

  async function runOnce() {
    const client = await pool.connect();
    const processed = [];
    try {
      await client.query('begin');
      const claimed = await client.query(
        `select i.id, i.tenant_id, i.command_name, i.arguments, i.receipt_id from helmion.console_command_intents i
         where not exists (select 1 from helmion.console_command_runs r where r.tenant_id=i.tenant_id and r.intent_id=i.id)
         order by i.created_at, i.id limit $1 for update of i skip locked`, [limit]);
      for (const intent of claimed.rows) {
        let run;
        if (DESKTOP_COMMANDS.has(intent.command_name)) run = { outcome: 'needs_desktop', result: { reason: 'This command needs a project workspace; it is waiting for the paired Helmian desktop or a VPS runner.' } };
        else if (executors[intent.command_name]) {
          try { run = await executors[intent.command_name](client, intent); } catch (error) { run = { outcome: 'failed', result: { error: String(error.message).slice(0, 300) } }; }
        } else run = { outcome: 'refused', result: { error: 'unknown command' } };
        await client.query('insert into helmion.console_command_runs (tenant_id, intent_id, receipt_id, worker_id, outcome, result) values ($1,$2,$3,$4,$5,$6::jsonb) on conflict (tenant_id, intent_id) do nothing',
          [intent.tenant_id, intent.id, intent.receipt_id, workerId, run.outcome, JSON.stringify({ format: CONSOLE_WORKER_FORMAT, ...run.result })]);
        processed.push({ receiptId: intent.receipt_id, commandName: intent.command_name, outcome: run.outcome });
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally { client.release(); }
    for (const p of processed) log(`console ${p.commandName} ${p.receiptId} -> ${p.outcome}`);
    return processed;
  }

  function start({ intervalMs = 5000 } = {}) {
    let timer = null; let stopped = false;
    const tick = async () => {
      try { await runOnce(); } catch (error) { log(`console worker error: ${error.message}`); }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, 0);
    return { stop() { stopped = true; clearTimeout(timer); } };
  }
  return Object.freeze({ runOnce, start });
}
