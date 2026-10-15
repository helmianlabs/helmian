import assert from 'node:assert/strict';
import test from 'node:test';
import { createConsoleCommandWorker } from '../src/cloud/console-command-worker.mjs';

function fakePool(intents, projects = []) {
  const runs = []; const log = [];
  const client = {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase(); log.push(q);
      if (['begin', 'commit', 'rollback'].includes(q)) return { rows: [] };
      if (q.includes('from helmion.console_command_intents i')) return { rows: intents.filter((i) => !runs.some((r) => r.intent_id === i.id)) };
      if (q.startsWith('insert into helmion.console_command_runs')) { runs.push({ tenant_id: params[0], intent_id: params[1], outcome: params[4], result: JSON.parse(params[5]) }); return { rowCount: 1, rows: [] }; }
      if (q.includes('from helmion.workspace_projects where tenant_id=$1 and project_key')) return { rows: projects.filter((p) => p.tenant_id === params[0] && p.project_key === params[1]) };
      if (q.includes('count(*)')) return { rows: [{ n: 2 }] };
      if (q.includes('from helmion.provider_connections')) return { rows: [{ provider_id: 'claude', auth_mode: 'oauth_subscription', lifecycle: 'verified', adapter: 'x' }] };
      throw new Error(`unexpected ${q}`);
    },
    release() {},
  };
  return { pool: { connect: async () => client }, runs, log };
}

test('worker executes read-only commands and defers desktop work', async () => {
  const intents = [
    { id: 1, tenant_id: 't-a', command_name: 'workspace_context', arguments: {}, receipt_id: 'receipt-0001' },
    { id: 2, tenant_id: 't-a', command_name: 'list_agents', arguments: {}, receipt_id: 'receipt-0002' },
    { id: 3, tenant_id: 't-a', command_name: 'open_project', arguments: { project: 'aimforge' }, receipt_id: 'receipt-0003' },
    { id: 4, tenant_id: 't-b', command_name: 'open_project', arguments: { project: 'aimforge' }, receipt_id: 'receipt-0004' },
    { id: 5, tenant_id: 't-a', command_name: 'run_project_task', arguments: {}, receipt_id: 'receipt-0005' },
  ];
  const { pool, runs } = fakePool(intents, [{ tenant_id: 't-a', project_key: 'aimforge', display_name: 'AimForge', source_kind: 'cloud', default_branch: 'main', lifecycle: 'active' }]);
  const worker = createConsoleCommandWorker({ pool });
  const done = await worker.runOnce();
  assert.deepEqual(done.map((d) => d.outcome), ['completed', 'completed', 'completed', 'refused', 'needs_desktop']);
  assert.equal(runs[0].result.activeProjects, 2);
  assert.equal(runs[1].result.agents[0].provider, 'claude');
  assert.equal(runs[2].result.project.name, 'AimForge');
  assert.equal(runs[3].tenant_id, 't-b');
  assert.equal((await worker.runOnce()).length, 0, 'each intent runs once');
});

test('worker rejects invalid ids and missing pool', () => {
  assert.throws(() => createConsoleCommandWorker({}));
  assert.throws(() => createConsoleCommandWorker({ pool: { connect() {} }, workerId: 'bad' }));
});
