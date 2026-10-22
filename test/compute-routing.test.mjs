import assert from 'node:assert/strict';
import test from 'node:test';
import { decideComputeRoute } from '../src/core/compute-routing.mjs';

const now = Date.parse('2026-10-22T09:00:00Z');
const fresh = '2026-10-22T08:59:30Z';
const stale = '2026-10-22T08:40:00Z';
const pcOn = { online: true, lastSeenAt: fresh, capabilities: ['local-files', 'powershell', 'ollama'] };
const runnerOn = { online: true, lastSeenAt: fresh, capabilities: ['always-on'] };

test('PC-only work goes to the PC when it is on', () => {
  const r = decideComputeRoute({ now, job: { needs: ['powershell'] }, presence: { pc: pcOn, runner: runnerOn } });
  assert.equal(r.outcome, 'route'); assert.equal(r.target, 'pc');
});
test('PC-only work never moves to the runner when the PC is off; it queues', () => {
  const r = decideComputeRoute({ now, job: { needs: ['local-files'] }, presence: { pc: { ...pcOn, online: false }, runner: runnerOn } });
  assert.equal(r.outcome, 'queue'); assert.equal(r.target, 'pc');
});
test('stale PC heartbeat counts as off', () => {
  const r = decideComputeRoute({ now, job: { needs: ['ollama'] }, presence: { pc: { ...pcOn, lastSeenAt: stale }, runner: runnerOn } });
  assert.equal(r.outcome, 'queue');
});
test('portable work runs on the runner when the PC is off', () => {
  const r = decideComputeRoute({ now, job: {}, presence: { runner: runnerOn } });
  assert.deepEqual([r.outcome, r.target], ['route', 'runner']);
});
test('cost-sensitive portable work prefers free local Ollama when the PC is on', () => {
  const r = decideComputeRoute({ now, job: { costSensitive: true }, presence: { pc: pcOn, runner: runnerOn } });
  assert.equal(r.target, 'pc');
});
test('runner-only work refuses when the runner is down', () => {
  const r = decideComputeRoute({ now, job: { needs: ['always-on'] }, presence: { pc: pcOn } });
  assert.equal(r.outcome, 'refuse');
});
test('conflicting needs and bad pins are refused, not guessed', () => {
  assert.equal(decideComputeRoute({ now, job: { needs: ['powershell', 'always-on'] }, presence: { pc: pcOn, runner: runnerOn } }).outcome, 'refuse');
  assert.equal(decideComputeRoute({ now, job: { needs: ['powershell'], pinned: 'runner' }, presence: { pc: pcOn, runner: runnerOn } }).outcome, 'refuse');
  assert.equal(decideComputeRoute({ now, job: { pinned: 'mars' }, presence: {} }).outcome, 'refuse');
});
test('side-effect tool modes always require an Executive Guard approval', () => {
  assert.equal(decideComputeRoute({ now, job: { toolsMode: 'full' }, presence: { runner: runnerOn } }).requiresGuardApproval, true);
  assert.equal(decideComputeRoute({ now, job: {}, presence: { runner: runnerOn } }).requiresGuardApproval, false);
});
test('nothing online queues with no target', () => {
  const r = decideComputeRoute({ now, job: {}, presence: {} });
  assert.deepEqual([r.outcome, r.target], ['queue', null]);
});
test('PC online but missing a reported capability is refused', () => {
  const r = decideComputeRoute({ now, job: { needs: ['unity'] }, presence: { pc: pcOn } });
  assert.equal(r.outcome, 'refuse');
});
