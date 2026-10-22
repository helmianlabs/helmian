// The PC spoke connects OUTBOUND to this hub and long-polls for jobs, so nothing
// on the PC listens on a port. Presence (online + capabilities) comes from the
// polls and feeds compute routing.

import { randomUUID } from 'node:crypto';

const LATE_RESULT_MS = 10 * 60 * 1000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/** The PC's account of a mutating run: only these fields, only well-formed values. */
export function cleanExecution(e) {
  if (!e || typeof e !== 'object' || !['succeeded', 'failed', 'refused'].includes(e.status)) return null;
  const out = { status: e.status };
  if (typeof e.startedAt === 'string' && ISO.test(e.startedAt)) out.startedAt = e.startedAt;
  if (typeof e.finishedAt === 'string' && ISO.test(e.finishedAt)) out.finishedAt = e.finishedAt;
  if (typeof e.resultHash === 'string' && /^[0-9a-f]{64}$/.test(e.resultHash)) out.resultHash = e.resultHash;
  if (typeof e.error === 'string' && e.status !== 'succeeded') out.error = e.error.slice(0, 500);
  return out;
}

export function createSpokeHub({ pollWaitMs = 25000, resultWaitMs = 30000 } = {}) {
  const queue = [];
  const waiters = [];
  const inflight = new Map();
  let pc = null; // { deviceId, capabilities, lastSeenAt }

  function presence() {
    return pc ? { pc: { online: true, lastSeenAt: pc.lastSeenAt, capabilities: pc.capabilities } } : {};
  }

  function seen(deviceId, capabilities) {
    pc = { deviceId: String(deviceId || 'pc').slice(0, 64), capabilities: Array.isArray(capabilities) ? capabilities.map(String).slice(0, 20) : [], lastSeenAt: new Date().toISOString() };
  }

  /** Spoke side: wait for the next job (or null after pollWaitMs). */
  function nextJob({ deviceId, capabilities, signal } = {}) {
    seen(deviceId, capabilities);
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve) => {
      const w = { resolve };
      waiters.push(w);
      const done = (job) => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); clearTimeout(t); resolve(job); };
      w.resolve = done;
      const t = setTimeout(() => { seen(deviceId, capabilities); done(null); }, pollWaitMs);
      signal?.addEventListener?.('abort', () => done(null));
    });
  }

  /**
   * Hub side: hand a job to the PC and wait for its result.
   * On timeout: a job still queued never reached the PC (pickedUp=false). A job the PC already
   * took may still finish; its late result goes to onLate (used to report the Guard outcome).
   */
  function dispatch(job, { waitMs = resultWaitMs, onLate = null } = {}) {
    const full = { id: `hjob_${randomUUID()}`, createdAt: new Date().toISOString(), ...job };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const qi = queue.indexOf(full);
        const pickedUp = qi < 0;
        if (!pickedUp) queue.splice(qi, 1);
        if (pickedUp && onLate) {
          const lateTimer = setTimeout(() => inflight.delete(full.id), LATE_RESULT_MS);
          lateTimer.unref?.();
          inflight.set(full.id, (result) => { clearTimeout(lateTimer); inflight.delete(full.id); onLate(result); });
        } else inflight.delete(full.id);
        resolve({ ok: false, timedOut: true, pickedUp, error: pickedUp ? 'The PC did not answer in time. If it was picked up it may still finish; check the PC.' : 'The PC did not pick this up in time. Nothing ran.' });
      }, waitMs);
      inflight.set(full.id, (result) => { clearTimeout(timer); inflight.delete(full.id); resolve(result); });
      const w = waiters.shift();
      if (w) w.resolve(full); else queue.push(full);
    });
  }

  /** Spoke side: report a job's result. */
  function complete(jobId, result) {
    const fn = inflight.get(jobId);
    if (!fn) return false;
    fn({ ok: result?.ok === true, output: result?.output ?? null, error: result?.error ?? null, execution: cleanExecution(result?.execution) });
    return true;
  }

  return { presence, nextJob, dispatch, complete, _queue: queue };
}
