// Maestro task watchdog tests: headless, fake timers, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTaskWatchdog,
  reassignTask,
  snapshotCheckpoint,
  WATCHDOG_DEFAULT_TIMEOUT_MS,
  WATCHDOG_MIN_TIMEOUT_MS,
  WATCHDOG_MAX_TIMEOUT_MS,
  PENDING_LEASE_TOKEN,
} from '../src/core/maestro-watchdog.mjs';

// Fake timer: capture callbacks, fire manually.
function makeFakeTimers() {
  const scheduled = new Map();
  let nextId = 1;
  return {
    scheduled,
    setTimeoutFn: (cb, ms) => {
      const id = nextId++;
      scheduled.set(id, { cb, ms });
      return id;
    },
    clearTimeoutFn: (id) => {
      scheduled.delete(id);
    },
    fireAll: async () => {
      const pending = [...scheduled.entries()];
      scheduled.clear();
      for (const [, { cb }] of pending) await cb();
    },
  };
}

function makeWatchdog(extra = {}) {
  const timers = makeFakeTimers();
  const calls = { timeouts: [], logs: [] };
  const wd = createTaskWatchdog({
    onTimeout: async (info) => {
      calls.timeouts.push(info);
    },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    log: (...args) => calls.logs.push(args),
    ...extra,
  });
  return { wd, timers, calls };
}

test('watchdog fires at timeout: abort + checkpoint + onTimeout', async () => {
  const { wd, timers, calls } = makeWatchdog();
  let aborted = false;
  const release = wd.watch({
    taskId: 'task-1',
    agentId: 'agent-a',
    providerId: 'gemini',
    timeoutMs: 60_000,
    abort: () => { aborted = true; },
    getCheckpoint: () => ({ messages: [{ role: 'user', content: 'hi' }], totalMessages: 1, truncated: false }),
  });
  assert.equal(typeof release, 'function');
  assert.equal(timers.scheduled.size, 1);
  await timers.fireAll();
  // Let the promise chain in fire() settle.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(aborted, true);
  assert.equal(calls.timeouts.length, 1);
  const info = calls.timeouts[0];
  assert.equal(info.taskId, 'task-1');
  assert.equal(info.agentId, 'agent-a');
  assert.equal(info.providerId, 'gemini');
  assert.deepEqual(info.checkpoint.messages, [{ role: 'user', content: 'hi' }]);
  assert.ok(typeof info.elapsedMs === 'number');
});

test('no fire when the task completes in time', async () => {
  const { wd, timers, calls } = makeWatchdog();
  let aborted = false;
  wd.watch({
    taskId: 'task-2',
    agentId: 'agent-a',
    timeoutMs: 60_000,
    abort: () => { aborted = true; },
  });
  assert.equal(wd.complete('task-2'), true);
  assert.equal(wd.complete('task-2'), false); // already disarmed
  await timers.fireAll();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(aborted, false);
  assert.equal(calls.timeouts.length, 0);
});

test('timeoutMs is clamped to the lease range (1s..1hr)', () => {
  const { wd } = makeWatchdog();
  const noop = () => {};
  wd.watch({ taskId: 't-min', agentId: 'a', timeoutMs: 10, abort: noop });
  wd.watch({ taskId: 't-max', agentId: 'a', timeoutMs: 99_999_999, abort: noop });
  wd.watch({ taskId: 't-nan', agentId: 'a', timeoutMs: NaN, abort: noop });
  const pending = wd.pending();
  assert.equal(pending.find((p) => p.taskId === 't-min').timeoutMs, WATCHDOG_MIN_TIMEOUT_MS);
  assert.equal(pending.find((p) => p.taskId === 't-max').timeoutMs, WATCHDOG_MAX_TIMEOUT_MS);
  assert.equal(pending.find((p) => p.taskId === 't-nan').timeoutMs, WATCHDOG_DEFAULT_TIMEOUT_MS);
  wd.unwatchAll();
  assert.equal(wd.pending().length, 0);
});

test('a throwing abort does not stop the timeout handling', async () => {
  const { wd, timers, calls } = makeWatchdog();
  wd.watch({
    taskId: 'task-3',
    agentId: 'agent-a',
    abort: () => { throw new Error('boom'); },
    getCheckpoint: () => { throw new Error('nope'); },
  });
  await timers.fireAll();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.timeouts.length, 1);
  assert.equal(calls.timeouts[0].checkpoint, null);
  assert.ok(calls.logs.length >= 2, 'abort and checkpoint failures are logged');
});

test('a throwing onTimeout never rejects into the timer', async () => {
  const timers = makeFakeTimers();
  const wd = createTaskWatchdog({
    onTimeout: async () => { throw new Error('handler exploded'); },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    log: () => {},
  });
  wd.watch({ taskId: 'task-4', agentId: 'agent-a', abort: () => {} });
  await timers.fireAll(); // must not throw
  await new Promise((r) => setTimeout(r, 10));
});

test('watch rejects invalid input up front', () => {
  const { wd } = makeWatchdog();
  assert.throws(() => wd.watch({ agentId: 'a', abort: () => {} }), TypeError);
  assert.throws(() => wd.watch({ taskId: 'x', abort: () => {} }), TypeError);
  assert.throws(() => wd.watch({ taskId: 'x', agentId: 'a' }), TypeError);
  assert.throws(() => wd.watch({ taskId: 'x', agentId: 'a', abort: () => {}, getCheckpoint: 42 }), TypeError);
  wd.watch({ taskId: 'dup', agentId: 'a', abort: () => {} });
  assert.throws(() => wd.watch({ taskId: 'dup', agentId: 'a', abort: () => {} }), TypeError);
  wd.unwatchAll();
});

test('snapshotCheckpoint keeps the tail and marks truncation', () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  const snap = snapshotCheckpoint(messages);
  assert.equal(snap.totalMessages, 30);
  assert.equal(snap.truncated, true);
  assert.equal(snap.messages.length, 20);
  assert.equal(snap.messages[0].content, 'm10');
  const short = snapshotCheckpoint([{ role: 'user', content: 'hi' }]);
  assert.equal(short.truncated, false);
  assert.deepEqual(snapshotCheckpoint(null).messages, []);
  assert.deepEqual(snapshotCheckpoint('nope').messages, []);
});

// ---------- reassignTask ----------

function makeReassignDeps(overrides = {}) {
  const calls = { audits: [], releases: [], nextAgentCalls: 0 };
  return {
    calls,
    deps: {
      getNextAgent: async ({ excludeAgentId }) => {
        calls.nextAgentCalls++;
        return excludeAgentId === 'agent-a'
          ? { agentId: 'agent-b', coordinatorId: 'agent-b', providerId: 'claude' }
          : { agentId: 'agent-a', coordinatorId: 'agent-a', providerId: 'gemini' };
      },
      releaseLease: async ({ leaseToken }) => {
        calls.releases.push(leaseToken);
        return { released: true, reason: '' };
      },
      auditEvent: async (event) => {
        calls.audits.push(event);
      },
      ...overrides,
    },
  };
}

const baseTask = {
  taskId: 'task-9',
  projectSlug: 'demo',
  agentId: 'agent-a',
  providerId: 'gemini',
  coordinatorId: 'agent-a',
  leaseToken: 'tok-123',
  checkpoint: {
    messages: [{ role: 'user', content: 'do the thing' }, { role: 'assistant', content: 'half done' }],
    totalMessages: 2,
    truncated: false,
  },
};

test('reassignTask picks a different agent and builds a COMPLETE handoff', async () => {
  const { deps, calls } = makeReassignDeps();
  const out = await reassignTask({ task: baseTask, elapsedMs: 60_042, ...deps });
  assert.equal(out.reassigned, true);
  assert.equal(out.nextAgent.agentId, 'agent-b');
  assert.equal(calls.nextAgentCalls, 1);
  // The timed-out agent was excluded from candidacy.
  // Lease terminated with the task's own token.
  assert.deepEqual(calls.releases, ['tok-123']);
  assert.equal(out.leaseReleased, true);
  // Handoff built through the existing mechanism, checkpoint -> COMPLETE.
  assert.equal(out.handoff.status, 'COMPLETE');
  assert.equal(out.handoff.requires_human_confirmation, false);
  assert.equal(out.handoff.switched_by, 'maestro');
  assert.equal(out.handoff.from.coordinator_id, 'agent-a');
  assert.equal(out.handoff.to.coordinator_id, 'agent-b');
  assert.equal(out.handoff.to.lease_token, PENDING_LEASE_TOKEN);
  // Audit trail follows the lease module's event shape.
  const types = calls.audits.map((a) => a.actionType);
  assert.ok(types.includes('maestro.task.timed_out'));
  assert.ok(types.includes('maestro.task.lease_terminated'));
  assert.ok(types.includes('maestro.handoff.built'));
  assert.ok(types.includes('maestro.task.reassigned'));
  for (const event of calls.audits) {
    assert.equal(event.policyVersion, 'maestro-watchdog.v1');
    assert.ok(event.canonicalTarget.taskId, 'task-9');
  }
});

test('reassignTask without a checkpoint builds an INCOMPLETE handoff', async () => {
  const { deps } = makeReassignDeps();
  const out = await reassignTask({
    task: { ...baseTask, checkpoint: null },
    elapsedMs: 61_000,
    ...deps,
  });
  assert.equal(out.reassigned, true);
  assert.equal(out.handoff.status, 'INCOMPLETE');
  assert.equal(out.handoff.requires_human_confirmation, true);
  assert.match(out.handoff.warning, /no durable checkpoint was available/);
});

test('reassignTask keeps the task when no agent is available', async () => {
  const { deps, calls } = makeReassignDeps({ getNextAgent: async () => null });
  const out = await reassignTask({ task: baseTask, elapsedMs: 60_000, ...deps });
  assert.equal(out.reassigned, false);
  assert.equal(out.reason, 'no agent available');
  assert.equal(out.handoff, null);
  assert.deepEqual(out.checkpoint, baseTask.checkpoint);
  const types = calls.audits.map((a) => a.actionType);
  assert.ok(types.includes('maestro.task.reassign_failed'));
  // The lease was still terminated: the next human pickup starts clean.
  assert.equal(out.leaseReleased, true);
});

test('reassignTask survives a throwing lease release', async () => {
  const { deps } = makeReassignDeps({
    releaseLease: async () => { throw new Error('store down'); },
  });
  const out = await reassignTask({ task: baseTask, elapsedMs: 60_000, ...deps });
  assert.equal(out.reassigned, true);
  assert.equal(out.leaseReleased, false);
  assert.match(out.leaseReleaseReason, /store down/);
});

test('reassignTask survives a throwing audit writer', async () => {
  const { deps } = makeReassignDeps({
    auditEvent: async () => { throw new Error('audit down'); },
  });
  const out = await reassignTask({ task: baseTask, elapsedMs: 60_000, ...deps });
  assert.equal(out.reassigned, true);
  assert.equal(out.nextAgent.agentId, 'agent-b');
});

test('reassignTask validates its inputs', async () => {
  const { deps } = makeReassignDeps();
  await assert.rejects(() => reassignTask({ ...deps }), TypeError);
  await assert.rejects(() => reassignTask({ task: {}, ...deps }), TypeError);
  await assert.rejects(() => reassignTask({ task: baseTask }), TypeError);
});
