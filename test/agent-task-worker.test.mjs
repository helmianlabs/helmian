import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentTaskWorker, AGENT_TASK_WORKER_FORMAT } from '../src/cora/agent-task-worker.mjs';

function fakePool(tasks) {
  const runs = [];
  const client = {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q)) return { rows: [] };
      if (q.includes('from helmion.cora_agent_task_intents i')) return { rows: tasks.filter((t) => !runs.some((r) => r.task_id === t.id)) };
      if (q.startsWith('insert into helmion.cora_agent_task_runs')) { runs.push({ tenant_id: params[0], task_id: params[1], outcome: params[4], result: JSON.parse(params[5]) }); return { rowCount: 1, rows: [] }; }
      throw new Error(`unexpected ${q}`);
    },
    release() {},
  };
  return { pool: { connect: async () => client }, runs };
}

test('worker triages prepared tasks to needs_desktop and refuses unknown types', async () => {
  const tasks = [
    { id: 1, tenant_id: 't-a', task_type: 'workspace_preview', receipt_id: 'task-receipt-0001' },
    { id: 2, tenant_id: 't-a', task_type: 'mystery_type', receipt_id: 'task-receipt-0002' },
  ];
  const { pool, runs } = fakePool(tasks);
  const worker = createAgentTaskWorker({ pool, workerId: 'worker:test-agent' });
  const done = await worker.runOnce();
  assert.deepEqual(done.map((d) => d.outcome), ['needs_desktop', 'refused']);
  assert.equal(runs[0].result.format, AGENT_TASK_WORKER_FORMAT);
  assert.match(runs[0].result.reason, /paired Helmian desktop/);
  assert.match(runs[1].result.error, /not executable by the cloud worker/);
  assert.equal((await worker.runOnce()).length, 0, 'each task runs once');
});

test('worker is a no-op when migration 045 is not applied', async () => {
  const pool = { connect: async () => ({ async query(sql) { const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase(); if (['begin', 'commit', 'rollback'].includes(q)) return { rows: [] }; const error = new Error('relation "helmion.cora_agent_task_runs" does not exist'); error.code = '42P01'; throw error; }, release() {} }) };
  const done = await createAgentTaskWorker({ pool }).runOnce();
  assert.deepEqual(done, []);
});

test('worker rejects invalid ids and missing pool', () => {
  assert.throws(() => createAgentTaskWorker({}));
  assert.throws(() => createAgentTaskWorker({ pool: { connect() {} }, workerId: 'bad' }));
});
