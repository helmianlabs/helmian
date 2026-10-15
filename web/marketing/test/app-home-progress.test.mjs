import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { progressModel, planFromText, usageModel, homeModel, viewFromHash, VIEWS, plainEvent } from '../app/app-model.mjs';

test('phones open on Home, wide screens on Console; explicit hashes win', () => {
  assert.ok(VIEWS.includes('home'));
  assert.equal(viewFromHash('', { phone: true }), 'home');
  assert.equal(viewFromHash(''), 'console');
  assert.equal(viewFromHash('#console', { phone: true }), 'console');
});

test('progress checklist model', () => {
  const m = progressModel({ steps: [{ position: 1, label: 'Write tests', status: 'running' }, { position: 0, label: 'Read code', status: 'done' }, { position: 2, label: 'Open PR', status: 'pending' }] });
  assert.deepEqual([m.total, m.done, m.pct, m.current], [3, 1, 33, 'Write tests']);
  assert.equal(m.summary, '1 of 3 done · now: Write tests');
  assert.deepEqual(m.items.map((i) => [i.label, i.icon, i.next]), [['Read code', '✓', 'pending'], ['Write tests', '◐', 'done'], ['Open PR', '○', 'running']]);
  assert.equal(progressModel({}).summary, 'No plan yet');
  assert.equal(progressModel({ steps: [{ position: 0, label: 'a', status: 'done' }, { position: 1, label: 'b', status: 'skipped' }] }).summary, 'All 2 steps done');
  assert.match(progressModel({ steps: [{ position: 0, label: 'a', status: 'failed' }] }).summary, /1 failed/);
  assert.equal(progressModel({ steps: [{ position: 0, label: 'x', status: 'weird' }] }).total, 0);
});

test('plan text: one step per line, bullets and numbers stripped, max 20', () => {
  assert.deepEqual(planFromText('1. Read\n- Test\n* Ship\n[ ] Tell Troy\n\n  '), ['Read', 'Test', 'Ship', 'Tell Troy']);
  assert.equal(planFromText(Array(30).fill('x').join('\n')).length, 20);
});

test('usage and limits', () => {
  assert.equal(usageModel({ totals: { estimatedCostMinor: 1234, eventCount: 7 } }).text, '$12.34 used · no limit set');
  const u = usageModel({ totals: { estimatedCostMinor: 4500, eventCount: 3 }, budget: { currency: 'USD', softLimitMinor: 4000, hardLimitMinor: 5000, period: 'month' } });
  assert.deepEqual([u.pct, u.level, u.text], [90, 'near', '$45.00 of $50.00 this month']);
  assert.equal(usageModel({ totals: { estimatedCostMinor: 6000 }, budget: { hardLimitMinor: 5000 } }).level, 'over');
});

test('home dashboard: what is running and what is waiting', () => {
  const m = homeModel({
    sessions: [{ id: 'a', name: 'Fix login', provider: 'Claude', progress: { total: 4, done: 1, failed: 0, current: 'Write tests' } }, { id: 'b', name: 'Done one', provider: 'Grok', progress: { total: 2, done: 2, failed: 0 } }, { id: 'c', name: 'Idle', provider: 'Gemini', progress: { total: 0, done: 0, failed: 0 } }],
    approvals: [{ summary: 'Deploy to staging', canDecide: true }, { summary: 'Old', decision: 'approve' }],
    overview: { counts: { activeProjects: 2, members: 3 } },
  });
  assert.deepEqual(m.running.map((r) => [r.name, r.pct, r.current]), [['Fix login', 25, 'Write tests']]);
  assert.equal(m.idleSessions, 2); assert.equal(m.pendingCount, 1); assert.equal(m.pending[0].title, 'Deploy to staging');
  assert.deepEqual(m.stats, [['Projects', 2], ['Members', 3], ['Sessions', 3]]);
  assert.equal(m.usage, null);
});

test('task events read plainly in the Guard Feed', () => {
  assert.deepEqual(plainEvent({ actionType: 'app.task.step_done', summary: 'Finished: Write tests (Fix login)' }), { title: 'Step finished', body: 'Finished: Write tests (Fix login)' });
});

test('page has Home and the progress checklist in console and Guard Feed', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  for (const id of ['view-home', 'home-usage', 'home-running', 'home-approvals', 'task-progress', 'tp-list', 'feed-progress']) assert.match(html, new RegExp(`id="${id}"`), id);
});
