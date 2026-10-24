// Spokes connect OUTBOUND to this hub and long-poll for jobs, so nothing on a
// spoke machine listens on a port. Presence (online + capabilities) comes from
// the polls and feeds compute routing.
//
// Jobs are DEVICE-BOUND (agent-computer plan, bite 2). A job records the device
// it is for at creation; only that device can see it in a poll, claim it, or
// complete it. Before this, the hub kept one presence slot and one global
// queue — any authenticated spoke could claim any job, which made a second
// spoke (the box spoke joining Troy's PC spoke) unsafe.
//
// Binding at creation: the caller names the target device when it knows it
// (hands passes the device behind its legacy "pc" presence slot). A job created
// with no target binds to the announced PC-like device, or to the only device
// online, or — with nobody online — to the legacy default device id 'pc', so a
// spoke polling under the default identity still receives it exactly as before.

import { randomUUID } from 'node:crypto';

const LATE_RESULT_MS = 10 * 60 * 1000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// Capabilities only the PC spoke reports today; used to recognize the PC among
// several devices for the legacy `pc` presence slot when its name does not say so.
const PC_LIKE_CAPABILITIES = ['local-files', 'powershell', 'pc-browser', 'ollama'];
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

const cleanId = (id) => String(id || 'pc').slice(0, 64);
const isPcName = (id) => id === 'pc' || id.startsWith('pc-') || id.startsWith('pc.');

export function createSpokeHub({ pollWaitMs = 25000, resultWaitMs = 30000 } = {}) {
  const devices = new Map(); // deviceId -> { capabilities, lastSeenAt }
  const queues = new Map(); // deviceId -> [job] waiting for that device's next poll
  const waiters = new Map(); // deviceId -> [waiter] long-polls parked by that device
  const inflight = new Map(); // jobId -> { deviceId, deliver(result) }

  const listFor = (map, id) => { let l = map.get(id); if (!l) { l = []; map.set(id, l); } return l; };

  function seen(deviceId, capabilities) {
    const id = cleanId(deviceId);
    devices.set(id, {
      capabilities: Array.isArray(capabilities) ? capabilities.map(String).slice(0, 20) : [],
      lastSeenAt: new Date().toISOString(),
    });
    return id;
  }

  /**
   * The device the legacy `pc` presence slot describes: a device named like a
   * PC wins on name; otherwise a device reporting PC-only capabilities; the
   * most recently seen wins ties. A box spoke named box-* never takes the slot
   * from a pc-* device.
   */
  function pcDeviceId() {
    let byName = null;
    let byCaps = null;
    for (const [id, d] of devices) {
      if (isPcName(id)) { if (!byName || d.lastSeenAt > devices.get(byName).lastSeenAt) byName = id; }
      else if (d.capabilities.some((c) => PC_LIKE_CAPABILITIES.includes(c))) { if (!byCaps || d.lastSeenAt > devices.get(byCaps).lastSeenAt) byCaps = id; }
    }
    return byName || byCaps;
  }

  /** Default binding for a job created without an explicit target. */
  function defaultTargetId() {
    return pcDeviceId() || (devices.size === 1 ? [...devices.keys()][0] : null) || 'pc';
  }

  function presence() {
    const out = { devices: {} };
    for (const [id, d] of devices) out.devices[id] = { online: true, lastSeenAt: d.lastSeenAt, capabilities: d.capabilities };
    const pcId = pcDeviceId();
    if (pcId) { const d = devices.get(pcId); out.pc = { online: true, lastSeenAt: d.lastSeenAt, capabilities: d.capabilities, deviceId: pcId }; }
    return out;
  }

  /** Spoke side: wait for the next job bound to THIS device (or null after pollWaitMs). */
  function nextJob({ deviceId, capabilities, signal } = {}) {
    const id = seen(deviceId, capabilities);
    const q = listFor(queues, id);
    if (q.length) return Promise.resolve(q.shift());
    return new Promise((resolve) => {
      const ws = listFor(waiters, id);
      const w = { resolve: null };
      const done = (job) => { const i = ws.indexOf(w); if (i >= 0) ws.splice(i, 1); clearTimeout(t); resolve(job); };
      w.resolve = done;
      ws.push(w);
      const t = setTimeout(() => { seen(id, capabilities); done(null); }, pollWaitMs);
      signal?.addEventListener?.('abort', () => done(null));
    });
  }

  /**
   * Hub side: hand a job to its bound device and wait for the result.
   * On timeout: a job still queued never reached the device (pickedUp=false). A job the
   * device already took may still finish; its late result goes to onLate (used to
   * report the Guard outcome) — and only the bound device can deliver it.
   */
  function dispatch(job, { waitMs = resultWaitMs, onLate = null } = {}) {
    const { targetDeviceId: _ignored, ...rest } = job || {};
    const target = job?.targetDeviceId ? cleanId(job.targetDeviceId) : defaultTargetId();
    const full = { id: `hjob_${randomUUID()}`, createdAt: new Date().toISOString(), ...rest, targetDeviceId: target };
    return new Promise((resolve) => {
      const finish = (result) => { inflight.delete(full.id); resolve({ ...result, targetDeviceId: target }); };
      const timer = setTimeout(() => {
        const q = listFor(queues, target);
        const qi = q.indexOf(full);
        const pickedUp = qi < 0;
        if (!pickedUp) q.splice(qi, 1);
        if (pickedUp && onLate) {
          const lateTimer = setTimeout(() => inflight.delete(full.id), LATE_RESULT_MS);
          lateTimer.unref?.();
          inflight.set(full.id, { deviceId: target, deliver: (result) => { clearTimeout(lateTimer); finish(result); onLate({ ...result, targetDeviceId: target }); } });
        } else inflight.delete(full.id);
        resolve({ ok: false, timedOut: true, pickedUp, targetDeviceId: target, error: pickedUp ? `Device ${target} did not answer in time. If it picked the job up it may still finish; check the device.` : `Device ${target} did not pick this up in time. Nothing ran.` });
      }, waitMs);
      inflight.set(full.id, { deviceId: target, deliver: (result) => { clearTimeout(timer); finish(result); } });
      const w = listFor(waiters, target).shift();
      if (w) w.resolve(full); else listFor(queues, target).push(full);
    });
  }

  /**
   * Spoke side: report a job's result. When the caller's device identity is
   * known it must match the device the job was bound to — a result from any
   * other device is refused (returns false), never delivered.
   */
  function complete(jobId, result, { deviceId } = {}) {
    const entry = inflight.get(String(jobId || ''));
    if (!entry) return false;
    if (deviceId !== undefined && entry.deviceId !== cleanId(deviceId)) return false;
    entry.deliver({ ok: result?.ok === true, output: result?.output ?? null, error: result?.error ?? null, execution: cleanExecution(result?.execution) });
    return true;
  }

  /**
   * A poll handed this job out but its HTTP response died before the spoke saw
   * it: put the job back at the front of its OWN device's queue. The job stays
   * inflight; only the bound device can pick it up again or complete it.
   */
  function requeue(job) {
    if (!job?.id || !job?.targetDeviceId) return false;
    const q = listFor(queues, job.targetDeviceId);
    if (q.includes(job)) return false;
    q.unshift(job);
    return true;
  }

  return { presence, nextJob, dispatch, complete, requeue, _queues: queues };
}
