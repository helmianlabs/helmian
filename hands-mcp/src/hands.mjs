// The decision pipeline for one hands tool call. Order matters and every exit is audited:
//   1. kill switch (HANDS_ENABLED)       -> "hands are off"
//   2. argument validation               -> refuse
//   3. OAuth scope                       -> hands.read for reads, hands.act for mutating
//   4. compute routing (PR #50 policy)   -> PC-only work goes to the PC or nowhere
//   5. Executive Guard (mutating only)   -> human-approved signed allow, else deny (fail closed)
//   6. dispatch to the PC spoke          -> the PC re-verifies the Guard signature itself
//
// Read-only tools skip step 5 per the routing policy (requiresGuardApproval is
// false for read-only work); the PC still enforces its workspace roots.
//
// Caller device targeting (bite 2b): a call may carry an optional `device`
// argument naming one connected spoke (see hands_status `devices`). Without
// it, everything below behaves exactly as before — the job binds to the
// device behind the legacy "pc" presence slot (PR #80). With it, the named
// device is validated against live presence and its reported capabilities
// BEFORE Guard is ever asked, and the job binds to that device instead.

import { randomUUID } from 'node:crypto';
import { decideComputeRoute } from '../../src/core/compute-routing.mjs';
import { ArgError, POWERSHELL_READ_CAPABILITY, TOOLS, isReadOnlyCall, validateArgs } from './shared/protocol.mjs';

const PENDING_TTL_MS = 15 * 60 * 1000;
// Hold-open: after Guard answers "ask", the SAME tool call waits for the human
// decision instead of returning immediately and making the caller relay a
// resume_action. Slices keep disconnect/deadline checks responsive; the
// guard client polls Guard every pollMs inside each slice.
const HOLD_OPEN_SLICE_MS = 30 * 1000;
const HOLD_OPEN_DEFAULT_MS = PENDING_TTL_MS - 60 * 1000;

export function createHands({ config, guard, hub, audit }, { holdOpenWaitMs } = {}) {
  // requestId -> { tool, args, nonce, approvalId, clientId, createdAt, state }
  // state: 'waiting' (undecided) -> 'claimed' (one completion path won) -> 'done' (tombstone)
  const pending = new Map();
  const holdOpenMs = holdOpenWaitMs ?? config.holdOpenWaitMs ?? HOLD_OPEN_DEFAULT_MS;

  const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

  function sweep() {
    const t = Date.now();
    for (const [k, v] of pending) if (t - v.createdAt > PENDING_TTL_MS) pending.delete(k);
  }

  // Single-winner claim on a pending entry. Synchronous check-and-set, so exactly
  // one completion path (the held-open call, or resume_action) ever dispatches:
  // a Guard decision consumed by one path can never be consumed by the other.
  function claim(entry) {
    if (entry.state !== 'waiting') return false;
    entry.state = 'claimed';
    return true;
  }

  /**
   * Wait for the human decision on an already-pending approval, from inside the
   * original tool call. Returns a guard decision ({ outcome: allow|deny, ... }),
   * { outcome: 'pending' } when the hold-open budget lapses undecided (the entry
   * stays pending; resume_action remains the fallback), or 'aborted' when the
   * caller went away (the entry also stays pending and resumable).
   */
  async function holdOpen(entry, signal) {
    const deadline = Math.min(entry.createdAt + PENDING_TTL_MS, Date.now() + holdOpenMs);
    for (;;) {
      if (signal?.aborted) return 'aborted';
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { outcome: 'pending', approvalId: entry.approvalId };
      const wait = guard.awaitApproval({ approvalId: entry.approvalId, tool: entry.tool, args: entry.args, nonce: entry.nonce, waitMs: Math.min(remaining, HOLD_OPEN_SLICE_MS) });
      let decision;
      if (signal) {
        let onAbort;
        const aborted = new Promise((r) => { onAbort = () => r('aborted'); signal.addEventListener('abort', onAbort, { once: true }); });
        decision = await Promise.race([wait, aborted]);
        signal.removeEventListener('abort', onAbort);
        // The abandoned poll is discarded unread: it mutates nothing, and the
        // claim in call()/resume() is the only gate to dispatch.
        if (decision === 'aborted') return 'aborted';
      } else {
        decision = await wait;
      }
      if (decision.outcome !== 'pending') return decision;
    }
  }

  // Tell Guard what happened to a decision (executive-guard/docs/OUTCOMES.md). Best effort, audited here too.
  async function reportOutcome({ requestId, tool, decisionId, nonce, outcome }) {
    if (!decisionId || !nonce || typeof guard.reportOutcome !== 'function') return;
    let r = await guard.reportOutcome({ decisionId, nonce, ...outcome });
    if (!r.recorded && r.error === 'invalid-time' && outcome.status !== 'refused') {
      // PC clock off: fall back to the hub's own timing of the run.
      r = await guard.reportOutcome({ decisionId, nonce, ...outcome, startedAt: outcome.hubStartedAt, finishedAt: outcome.hubFinishedAt });
    }
    audit.append({ event: r.recorded ? 'outcome.reported' : 'outcome.report-failed', requestId, tool, decisionId, status: outcome.status, auditSeq: r.auditSeq ?? undefined, error: r.recorded ? undefined : r.error });
  }

  // A Guard decision this hub will not act on (deny verdict, denied approval, auto-allow, bad signature).
  function reportRefused({ requestId, tool, decisionId, nonce, reason }) {
    if (!decisionId) return Promise.resolve();
    return reportOutcome({ requestId, tool, decisionId, nonce, outcome: { status: 'refused', finishedAt: new Date().toISOString(), error: reason } });
  }

  function outcomeFromPc(result, hubStartedAt) {
    const hubFinishedAt = new Date().toISOString();
    const e = result.execution;
    if (e) return { ...e, finishedAt: e.finishedAt || hubFinishedAt, hubStartedAt, hubFinishedAt };
    // An older PC without execution records: derive what we honestly can.
    if (result.ok) return { status: 'succeeded', startedAt: hubStartedAt, finishedAt: hubFinishedAt, hubStartedAt, hubFinishedAt };
    if (/^refused by the PC/.test(result.error || '')) return { status: 'refused', finishedAt: hubFinishedAt, error: result.error, hubStartedAt, hubFinishedAt };
    return { status: 'failed', startedAt: hubStartedAt, finishedAt: hubFinishedAt, error: result.error || 'failed', hubStartedAt, hubFinishedAt };
  }

  async function runOnPc({ requestId, tool, args, nonce, envelope, claims, clientId, targetDeviceId: namedTarget = null }) {
    const hubStartedAt = new Date().toISOString();
    const decisionId = claims?.decisionId || null;
    const onLate = decisionId ? (late) => { void reportOutcome({ requestId, tool, decisionId, nonce, outcome: outcomeFromPc(late, hubStartedAt) }); } : null;
    // Device binding (bite 2): the job is bound at creation to the device behind
    // the hub's legacy "pc" presence slot — the device the routing step just
    // approved. Only that device can claim the job or report its result.
    // Caller targeting (bite 2b): a validated `device` argument overrides the
    // slot with the exact device the caller named.
    const targetDeviceId = namedTarget || hub.presence().pc?.deviceId || null;
    const result = await hub.dispatch({ requestId, tool, args, nonce: nonce ?? null, guardDecision: envelope ?? null, guardDeviceId: config.guard.deviceId, targetDeviceId }, { onLate });
    audit.append({ event: result.ok ? 'executed' : 'failed', requestId, tool, clientId, deviceId: result.targetDeviceId || undefined, error: result.error || undefined });
    if (decisionId) {
      if (result.timedOut && !result.pickedUp) await reportRefused({ requestId, tool, decisionId, nonce, reason: 'the PC did not pick the job up in time' });
      else if (!result.timedOut) await reportOutcome({ requestId, tool, decisionId, nonce, outcome: outcomeFromPc(result, hubStartedAt) });
      // picked up but no answer yet: onLate reports when (if) the PC answers.
    }
    if (!result.ok) return text(`Nothing confirmed: ${result.error || 'the PC refused or failed.'}`, true);
    const out = typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2);
    return text(out);
  }

  async function call(tool, rawArgs, auth = {}, { signal } = {}) {
    const requestId = `hreq_${randomUUID()}`;
    const clientId = auth.clientId || 'unknown';
    const scopes = Array.isArray(auth.scopes) ? auth.scopes : [];
    const spec = TOOLS[tool];
    const refuse = (event, reason) => { audit.append({ event, requestId, tool, clientId, reason }); return text(reason, true); };

    if (!config.handsEnabled) return refuse('refused.disabled', 'Hands are off on this server (HANDS_ENABLED=false). Nothing ran.');
    if (!spec) return refuse('refused.unknown-tool', `Unknown tool ${tool}.`);
    let args;
    try { args = validateArgs(tool, rawArgs); }
    catch (e) { if (e instanceof ArgError) return refuse('refused.bad-args', `Bad arguments: ${e.message}`); throw e; }

    const needScope = spec.mutating ? 'hands.act' : 'hands.read';
    const hasScope = scopes.includes(needScope) || (needScope === 'hands.read' && scopes.includes('hands.act'));
    if (!hasScope) return refuse('refused.scope', `This connection was not granted ${needScope}. Reconnect and approve ${needScope} on the consent page.`);

    // Optional caller targeting: `device` names one connected spoke. It is
    // validated here — before routing and before Guard — so an unknown or
    // incapable target fails cleanly: no job created, no Guard ask.
    const namedDevice = typeof rawArgs?.device === 'string' && rawArgs.device.trim() ? rawArgs.device.trim().slice(0, 64) : null;
    let target = null;
    if (namedDevice) {
      const pres = hub.presence();
      const dev = pres.devices?.[namedDevice];
      if (!dev) {
        const known = Object.keys(pres.devices || {});
        return refuse('refused.device', `No device named "${namedDevice}" is connected. Connected devices: ${known.length ? known.join(', ') : 'none'}. Nothing ran, nothing was queued, and Guard was not asked.`);
      }
      const capabilities = Array.isArray(dev.capabilities) ? dev.capabilities : [];
      const missing = spec.needs.filter((n) => !capabilities.includes(n));
      if (missing.length) return refuse('refused.device-capability', `Device "${namedDevice}" does not report ${missing.join(', ')}, which ${tool} needs. The call was refused at routing: nothing ran, nothing was queued, and Guard was not asked.`);
      target = { deviceId: namedDevice, capabilities };
    }

    // Routing. Untargeted calls evaluate the policy against hub presence
    // exactly as before. A targeted call evaluates the SAME policy with the
    // named device as the addressed spoke, so PC-only needs can never drift
    // to a device that does not report them (the capability check above has
    // already refused those with a device-named reason).
    const route = target
      ? decideComputeRoute({ job: { needs: spec.needs, toolsMode: spec.mutating ? 'write' : 'read-only', pinned: 'pc' }, presence: { pc: { online: true, lastSeenAt: new Date().toISOString(), capabilities: target.capabilities } } })
      : decideComputeRoute({ job: { needs: spec.needs, toolsMode: spec.mutating ? 'write' : 'read-only', pinned: 'pc' }, presence: hub.presence() });
    if (route.outcome !== 'route' || route.target !== 'pc') {
      return refuse('refused.route', `${route.reason} Nothing ran and nothing was queued (hands calls are live-only).`);
    }

    if (!spec.mutating && !route.requiresGuardApproval) {
      audit.append({ event: 'allowed.read-only', requestId, tool, clientId });
      return runOnPc({ requestId, tool, args, clientId, targetDeviceId: target?.deviceId });
    }

    // Read-only allow-listed PowerShell (git-status, disk-free, ...): no click
    // needed, but only when the target spoke says it runs these without a
    // Guard decision; an older spoke falls through to the normal Guard ask.
    if (isReadOnlyCall(tool, args)) {
      const caps = target ? target.capabilities : (hub.presence().pc?.capabilities || []);
      if (Array.isArray(caps) && caps.includes(POWERSHELL_READ_CAPABILITY)) {
        audit.append({ event: 'allowed.read-only', requestId, tool, commandId: args.commandId, clientId, ...(target ? { deviceId: target.deviceId } : {}) });
        return runOnPc({ requestId, tool, args, clientId, targetDeviceId: target?.deviceId });
      }
      audit.append({ event: 'read-only.needs-guard', requestId, tool, commandId: args.commandId, reason: `spoke does not report ${POWERSHELL_READ_CAPABILITY} (old spoke still running?)`, capabilities: Array.isArray(caps) ? caps : [] });
    }

    const decision = await guard.authorize({ tool, args });
    if (decision.outcome === 'pending') {
      const entry = { tool, args, nonce: decision.nonce, approvalId: decision.approvalId, clientId, createdAt: Date.now(), state: 'waiting', targetDeviceId: target?.deviceId || null };
      pending.set(requestId, entry);
      audit.append({ event: 'pending.guard', requestId, tool, clientId, approvalId: decision.approvalId, ...(target ? { deviceId: target.deviceId } : {}) });
      // Hold the call open for the human's decision. Losing the hold (budget
      // lapsed, caller disconnected) degrades to exactly the old behaviour:
      // the pending text + requestId, with the entry kept for resume_action.
      const settled = await holdOpen(entry, signal);
      if (settled === 'aborted' || settled.outcome === 'pending') {
        return text(`Waiting for a human approval in Executive Guard (approval ${decision.approvalId}). Nothing has run. After it is approved, call resume_action with requestId "${requestId}" (valid 15 minutes).`);
      }
      if (settled.outcome !== 'allow') {
        pending.delete(requestId);
        audit.append({ event: 'denied.guard', requestId, tool, clientId, reason: settled.reason });
        await reportRefused({ requestId, tool, decisionId: settled.unusedDecisionId, nonce: decision.nonce, reason: settled.reason });
        return text(`Denied: ${settled.reason} Nothing ran.`, true);
      }
      if (!claim(entry)) return text('A resume_action call picked this action up while this call was waiting; it runs exactly once, there.');
      audit.append({ event: 'allowed.guard', requestId, tool, clientId, approvalId: settled.claims?.approvalId, decidedBy: settled.claims?.decidedBy });
      try {
        return await runOnPc({ requestId, tool, args, nonce: decision.nonce, envelope: settled.envelope, claims: settled.claims, clientId, targetDeviceId: entry.targetDeviceId });
      } finally {
        entry.state = 'done';
      }
    }
    if (decision.outcome !== 'allow') {
      await reportRefused({ requestId, tool, decisionId: decision.unusedDecisionId, nonce: decision.nonce, reason: decision.reason });
      return refuse('denied.guard', `Denied: ${decision.reason} Nothing ran.`);
    }
    audit.append({ event: 'allowed.guard', requestId, tool, clientId, approvalId: decision.claims?.approvalId, decidedBy: decision.claims?.decidedBy });
    return runOnPc({ requestId, tool, args, nonce: decision.nonce, envelope: decision.envelope, claims: decision.claims, clientId, targetDeviceId: target?.deviceId });
  }

  async function resume(requestId, auth = {}) {
    sweep();
    const clientId = auth.clientId || 'unknown';
    const p = pending.get(String(requestId || ''));
    if (!config.handsEnabled) return text('Hands are off on this server (HANDS_ENABLED=false). Nothing ran.', true);
    if (!p) return text('No pending action with that requestId (it may have expired or already run).', true);
    if (p.clientId !== clientId) return text('That pending action belongs to a different connection.', true);
    if (!(auth.scopes || []).includes('hands.act')) return text('This connection was not granted hands.act.', true);
    if (p.state === 'done') return text('No pending action with that requestId: it already ran. Nothing ran twice.', true);
    if (p.state === 'claimed') return text('That action is already being completed; nothing ran twice.', true);
    const decision = await guard.awaitApproval({ approvalId: p.approvalId, tool: p.tool, args: p.args, nonce: p.nonce, waitMs: 20000 });
    if (decision.outcome === 'pending') return text(`Still waiting for approval ${p.approvalId}. Nothing has run.`);
    // Terminal decision: exactly one completion path may consume it.
    if (!claim(p)) return text('That action was already picked up by the original call; it runs exactly once, there.', true);
    if (decision.outcome !== 'allow') {
      pending.delete(requestId);
      audit.append({ event: 'denied.guard', requestId, tool: p.tool, clientId, reason: decision.reason });
      await reportRefused({ requestId, tool: p.tool, decisionId: decision.unusedDecisionId, nonce: p.nonce, reason: decision.reason });
      return text(`Denied: ${decision.reason} Nothing ran.`, true);
    }
    // A targeted action resumes onto its named device: re-validate that device
    // against live presence (it may have gone away while awaiting approval)
    // and re-check routing with it as the addressed spoke, exactly as call did.
    let resumeTarget = null;
    if (p.targetDeviceId) {
      const dev = hub.presence().devices?.[p.targetDeviceId];
      if (!dev) { pending.delete(requestId); return text(`Device "${p.targetDeviceId}" is no longer connected. Approved, but nothing ran.`, true); }
      resumeTarget = { deviceId: p.targetDeviceId, capabilities: Array.isArray(dev.capabilities) ? dev.capabilities : [] };
    }
    const route = resumeTarget
      ? decideComputeRoute({ job: { needs: TOOLS[p.tool].needs, toolsMode: 'write', pinned: 'pc' }, presence: { pc: { online: true, lastSeenAt: new Date().toISOString(), capabilities: resumeTarget.capabilities } } })
      : decideComputeRoute({ job: { needs: TOOLS[p.tool].needs, toolsMode: 'write', pinned: 'pc' }, presence: hub.presence() });
    if (route.outcome !== 'route') { pending.delete(requestId); return text(`${route.reason} Approved, but nothing ran.`, true); }
    audit.append({ event: 'allowed.guard', requestId, tool: p.tool, clientId, approvalId: decision.claims?.approvalId, decidedBy: decision.claims?.decidedBy });
    try {
      return await runOnPc({ requestId, tool: p.tool, args: p.args, nonce: p.nonce, envelope: decision.envelope, claims: decision.claims, clientId, targetDeviceId: resumeTarget?.deviceId });
    } finally {
      p.state = 'done';
    }
  }

  function status() {
    const pres = hub.presence();
    // `pc` keeps its exact legacy shape for existing consumers (door, /app);
    // `devices` is the additive per-device view: every connected spoke, by id.
    const devices = {};
    for (const [id, d] of Object.entries(pres.devices || {})) devices[id] = { online: true, lastSeenAt: d.lastSeenAt, capabilities: d.capabilities };
    return {
      handsEnabled: config.handsEnabled,
      guardLive: guard.live,
      mutatingTools: guard.live ? 'need a human Guard approval' : 'denied (Executive Guard not live)',
      pc: pres.pc ? { online: true, lastSeenAt: pres.pc.lastSeenAt, capabilities: pres.pc.capabilities } : { online: false },
      devices,
    };
  }

  return { call, resume, status };
}
