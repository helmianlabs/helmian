// The PC spoke connects OUTBOUND to this hub and long-polls for jobs, so nothing
// on the PC listens on a port. Presence (online + capabilities) comes from the
// polls and feeds compute routing.

import { randomUUID } from 'node:crypto';

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

  /** Hub side: hand a job to the PC and wait for its result. */
  function dispatch(job, { waitMs = resultWaitMs } = {}) {
    const full = { id: `hjob_${randomUUID()}`, createdAt: new Date().toISOString(), ...job };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        inflight.delete(full.id);
        const qi = queue.indexOf(full);
        if (qi >= 0) queue.splice(qi, 1);
        resolve({ ok: false, error: 'The PC did not answer in time. If it was picked up it may still finish; check the PC.' });
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
    fn({ ok: result?.ok === true, output: result?.output ?? null, error: result?.error ?? null });
    return true;
  }

  return { presence, nextJob, dispatch, complete, _queue: queue };
}
