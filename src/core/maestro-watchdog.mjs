// Maestro task watchdog: the automatic 60-second kill-and-reassign.
//
// The write lease (src/core/lease.mjs, src/cora/workspace-lease.mjs) expires
// PASSIVELY: a stale lease can be taken over, but nothing terminates the hung
// holder. This module is the ACTIVE half Troy described: arm a timer per task,
// and at T+timeout:
//
//   1. abort the turn (the AbortController whose signal the turn runs on),
//   2. snapshot the partial transcript as the checkpoint,
//   3. hand { taskId, agentId, providerId, checkpoint, elapsedMs } to onTimeout,
//      which terminates the task's write lease and reassigns the task.
//
// The watchdog never dispatches work itself. `reassignTask` below returns the
// decision (handoff + next agent); the Maestro loop dispatches it.
//
// Fail-closed throughout: a watchdog error never kills a healthy turn. Timer
// callbacks never throw; abort/checkpoint/handler failures are logged and the
// recovery continues. `complete(taskId)` on a finished task always wins the
// race against a timer that has already fired but not yet run.
//
// Timer choice: real setTimeout/clearTimeout, dependency-injected so tests run
// headless with fake timers. No polling loop, no `now()` comparisons.

import { buildMaestroHandoff } from './maestro.mjs';

export const WATCHDOG_DEFAULT_TIMEOUT_MS = 60_000;
export const WATCHDOG_MIN_TIMEOUT_MS = 1_000;
export const WATCHDOG_MAX_TIMEOUT_MS = 3_600_000;
// The to-side lease does not exist yet at reassign time: the next agent
// acquires its write lease when the Maestro loop dispatches the task. The
// handoff records this honestly; the dispatcher replaces it with the acquired
// token.
export const PENDING_LEASE_TOKEN = 'pending';

function clampTimeout(timeoutMs) {
  const n = Number(timeoutMs);
  const base = Number.isFinite(n) ? n : WATCHDOG_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(base), WATCHDOG_MIN_TIMEOUT_MS), WATCHDOG_MAX_TIMEOUT_MS);
}

function requiredText(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`maestro watchdog: ${name} is required`);
  return text;
}

// Partial-turn checkpoint: the last N messages of the (in-place mutated)
// transcript, so the receiving agent continues from real partial output
// instead of a blank slate. Never throws; worst case returns an empty list.
export function snapshotCheckpoint(messages, { maxMessages = 20 } = {}) {
  let list = [];
  try {
    list = Array.isArray(messages) ? messages : [];
  } catch {
    list = [];
  }
  const total = list.length;
  const kept = list.slice(Math.max(0, total - maxMessages)).map((m) => {
    if (m && typeof m === 'object') return { role: m.role ?? null, content: m.content ?? null, toolCalls: m.toolCalls ?? undefined, name: m.name ?? undefined };
    return { role: null, content: m };
  });
  return { messages: kept, totalMessages: total, truncated: total > kept.length };
}

export function createTaskWatchdog({
  onTimeout,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  log = () => {},
} = {}) {
  if (typeof onTimeout !== 'function') throw new TypeError('maestro watchdog: onTimeout is required');
  const timers = new Map(); // taskId -> { timer, startedAt, timeoutMs, meta }

  function fire(taskId) {
    const entry = timers.get(taskId);
    timers.delete(taskId);
    if (!entry) return; // completed (or unwatched) before the timer ran
    const elapsedMs = now() - entry.startedAt;
    const fail = (step, err) => log(`maestro watchdog: ${step} failed for task ${taskId}:`, err?.message ?? err);
    // 1. Kill the turn. Never throws into the timer.
    try {
      entry.abort();
    } catch (err) {
      fail('abort', err);
    }
    // 2. Snapshot whatever the turn produced so far. Never throws.
    let checkpoint = null;
    try {
      checkpoint = entry.getCheckpoint ? entry.getCheckpoint() : null;
    } catch (err) {
      fail('checkpoint snapshot', err);
      checkpoint = null;
    }
    // 3. Hand to the Maestro for lease termination + reassignment. Async and
    // never throws into the timer; a failed handler is logged, not retried
    // here (the task record keeps the checkpoint for a human to pick up).
    Promise.resolve()
      .then(() => onTimeout({
        taskId,
        agentId: entry.meta.agentId,
        providerId: entry.meta.providerId,
        checkpoint,
        elapsedMs,
      }))
      .catch((err) => fail('onTimeout', err));
  }

  return {
    // Arm the watchdog for one task. Returns a release() disarmer.
    // Throws TypeError immediately on invalid input (programmer error, before
    // the turn starts) rather than arming a broken timer.
    watch({ taskId, agentId, providerId = null, timeoutMs = WATCHDOG_DEFAULT_TIMEOUT_MS, abort, getCheckpoint = null }) {
      const id = requiredText(taskId, 'taskId');
      const who = requiredText(agentId, 'agentId');
      if (typeof abort !== 'function') throw new TypeError('maestro watchdog: abort is required');
      if (getCheckpoint !== null && typeof getCheckpoint !== 'function') {
        throw new TypeError('maestro watchdog: getCheckpoint must be a function or null');
      }
      if (timers.has(id)) throw new TypeError(`maestro watchdog: task ${id} is already watched`);
      const effectiveTimeoutMs = clampTimeout(timeoutMs);
      const startedAt = now();
      const release = () => {
        const entry = timers.get(id);
        if (!entry) return false;
        timers.delete(id);
        try {
          clearTimeoutFn(entry.timer);
        } catch (err) {
          log(`maestro watchdog: clearTimeout failed for task ${id}:`, err?.message ?? err);
        }
        return true;
      };
      const timer = setTimeoutFn(() => fire(id), effectiveTimeoutMs);
      timers.set(id, { timer, startedAt, timeoutMs: effectiveTimeoutMs, abort, getCheckpoint, meta: { agentId: who, providerId } });
      return release;
    },

    // Disarm after clean completion. Returns true when a timer was armed.
    // Always wins the race: if the timer callback already fired, fire() finds
    // no entry and does nothing.
    complete(taskId) {
      const id = String(taskId ?? '').trim();
      if (!id || !timers.has(id)) return false;
      const entry = timers.get(id);
      timers.delete(id);
      try {
        clearTimeoutFn(entry.timer);
      } catch (err) {
        log(`maestro watchdog: clearTimeout failed for task ${id}:`, err?.message ?? err);
      }
      return true;
    },

    unwatchAll() {
      for (const id of [...timers.keys()]) {
        try {
          const entry = timers.get(id);
          timers.delete(id);
          clearTimeoutFn(entry.timer);
        } catch (err) {
          log(`maestro watchdog: clearTimeout failed for task ${id}:`, err?.message ?? err);
        }
      }
    },

    pending() {
      return [...timers.entries()].map(([taskId, entry]) => ({
        taskId,
        agentId: entry.meta.agentId,
        providerId: entry.meta.providerId,
        timeoutMs: entry.timeoutMs,
        startedAt: entry.startedAt,
      }));
    },
  };
}

// Reassign a timed-out task to another agent.
//
// The watchdog calls this (via onTimeout) or the Maestro loop calls it
// directly. It does NOT dispatch: it terminates the old lease, picks the next
// agent, builds the handoff, audits every step, and returns the decision.
//
// Every external call (releaseLease, getNextAgent, auditEvent) is isolated in
// try/catch: a failure is recorded in the result and audited, never thrown.
// A task is never silently dropped: when no agent is available the result
// carries the checkpoint so a human can pick the task up.
export async function reassignTask({
  task,
  elapsedMs = null,
  getNextAgent,
  releaseLease,
  auditEvent = null,
  switchedAt = new Date(),
}) {
  if (!task || typeof task !== 'object') throw new TypeError('maestro reassign: task is required');
  const taskId = requiredText(task.taskId, 'task.taskId');
  const projectSlug = requiredText(task.projectSlug, 'task.projectSlug');
  const agentId = requiredText(task.agentId, 'task.agentId');
  if (typeof getNextAgent !== 'function') throw new TypeError('maestro reassign: getNextAgent is required');
  if (typeof releaseLease !== 'function') throw new TypeError('maestro reassign: releaseLease is required');

  const audit = async (actionType, result) => {
    if (typeof auditEvent !== 'function') return;
    try {
      await auditEvent({
        actionType,
        canonicalTarget: { resource: 'maestro_task', taskId, projectSlug },
        policyVersion: 'maestro-watchdog.v1',
        decision: 'ENFORCE',
        privacySummary: `Maestro watchdog ${actionType.replace('maestro.', '').replace(/\./g, ' ')} for task ${taskId}`,
        result: result ?? {},
      });
    } catch {
      // Audit is evidence, not a gate: a failed write must not lose the task.
    }
  };

  // 1. The task timed out. Record it before touching anything else.
  await audit('maestro.task.timed_out', {
    agentId,
    providerId: task.providerId ?? null,
    elapsedMs,
    hadCheckpoint: task.checkpoint != null,
  });

  // 2. Terminate the hung holder's write lease so the next agent can acquire
  // it. The watchdog acts as the Maestro here: it releases with the task's
  // own lease token, matching buildMaestroHandoff's switchedBy below.
  let leaseReleased = false;
  let leaseReleaseReason = '';
  try {
    const out = await releaseLease({ leaseToken: task.leaseToken, taskId });
    leaseReleased = out?.released === true;
    leaseReleaseReason = String(out?.reason ?? '');
  } catch (err) {
    leaseReleased = false;
    leaseReleaseReason = `release threw: ${err?.message ?? err}`;
  }
  await audit(leaseReleased ? 'maestro.task.lease_terminated' : 'maestro.task.lease_termination_failed', {
    agentId,
    leaseReleased,
    leaseReleaseReason,
  });

  // 3. Pick the next agent. v1 policy lives with the caller: a different
  // agent when one is available, else whoever can take it.
  let nextAgent = null;
  try {
    nextAgent = await getNextAgent({ excludeAgentId: agentId, providerId: task.providerId ?? null });
  } catch (err) {
    nextAgent = null;
  }
  if (!nextAgent || !nextAgent.agentId) {
    await audit('maestro.task.reassign_failed', {
      agentId,
      reason: 'no agent available',
      checkpointKept: task.checkpoint != null,
    });
    return {
      reassigned: false,
      reason: 'no agent available',
      handoff: null,
      nextAgent: null,
      leaseReleased,
      leaseReleaseReason,
      checkpoint: task.checkpoint ?? null,
    };
  }

  // 4. Build the handoff through the existing mechanism. A checkpoint makes
  // it COMPLETE (partial output preserved, next_safe_action carried); without
  // one it is INCOMPLETE and requires a human to confirm, by buildMaestroHandoff's
  // own contract.
  const checkpoint = task.checkpoint ?? null;
  const handoff = buildMaestroHandoff({
    projectSlug,
    fromLease: { coordinator_id: task.coordinatorId ?? agentId, lease_token: task.leaseToken },
    toLease: { coordinator_id: nextAgent.coordinatorId ?? nextAgent.agentId, lease_token: PENDING_LEASE_TOKEN },
    checkpoint,
    sharedState: task.sharedState ?? {},
    switchedBy: 'maestro',
    switchedAt,
    incompleteReason: checkpoint
      ? null
      : `agent ${agentId} timed out after ${elapsedMs ?? WATCHDOG_DEFAULT_TIMEOUT_MS}ms with no checkpoint; task state may be incomplete`,
  });
  await audit('maestro.handoff.built', {
    fromAgentId: agentId,
    toAgentId: nextAgent.agentId,
    handoffStatus: handoff.status,
    requiresHumanConfirmation: handoff.requires_human_confirmation,
  });
  await audit('maestro.task.reassigned', {
    fromAgentId: agentId,
    toAgentId: nextAgent.agentId,
    leaseReleased,
  });

  return {
    reassigned: true,
    handoff,
    nextAgent,
    leaseReleased,
    leaseReleaseReason,
    checkpoint,
  };
}
