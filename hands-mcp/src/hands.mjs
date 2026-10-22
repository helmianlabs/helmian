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

import { randomUUID } from 'node:crypto';
import { decideComputeRoute } from '../../src/core/compute-routing.mjs';
import { ArgError, TOOLS, validateArgs } from './shared/protocol.mjs';

const PENDING_TTL_MS = 15 * 60 * 1000;

export function createHands({ config, guard, hub, audit }) {
  const pending = new Map(); // requestId -> { tool, args, nonce, approvalId, clientId, createdAt }

  const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

  function sweep() {
    const t = Date.now();
    for (const [k, v] of pending) if (t - v.createdAt > PENDING_TTL_MS) pending.delete(k);
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

  async function runOnPc({ requestId, tool, args, nonce, envelope, claims, clientId }) {
    const hubStartedAt = new Date().toISOString();
    const decisionId = claims?.decisionId || null;
    const onLate = decisionId ? (late) => { void reportOutcome({ requestId, tool, decisionId, nonce, outcome: outcomeFromPc(late, hubStartedAt) }); } : null;
    const result = await hub.dispatch({ requestId, tool, args, nonce: nonce ?? null, guardDecision: envelope ?? null, guardDeviceId: config.guard.deviceId }, { onLate });
    audit.append({ event: result.ok ? 'executed' : 'failed', requestId, tool, clientId, error: result.error || undefined });
    if (decisionId) {
      if (result.timedOut && !result.pickedUp) await reportRefused({ requestId, tool, decisionId, nonce, reason: 'the PC did not pick the job up in time' });
      else if (!result.timedOut) await reportOutcome({ requestId, tool, decisionId, nonce, outcome: outcomeFromPc(result, hubStartedAt) });
      // picked up but no answer yet: onLate reports when (if) the PC answers.
    }
    if (!result.ok) return text(`Nothing confirmed: ${result.error || 'the PC refused or failed.'}`, true);
    const out = typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2);
    return text(out);
  }

  async function call(tool, rawArgs, auth = {}) {
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

    const route = decideComputeRoute({ job: { needs: spec.needs, toolsMode: spec.mutating ? 'write' : 'read-only', pinned: 'pc' }, presence: hub.presence() });
    if (route.outcome !== 'route' || route.target !== 'pc') {
      return refuse('refused.route', `${route.reason} Nothing ran and nothing was queued (hands calls are live-only).`);
    }

    if (!spec.mutating && !route.requiresGuardApproval) {
      audit.append({ event: 'allowed.read-only', requestId, tool, clientId });
      return runOnPc({ requestId, tool, args, clientId });
    }

    const decision = await guard.authorize({ tool, args });
    if (decision.outcome === 'pending') {
      pending.set(requestId, { tool, args, nonce: decision.nonce, approvalId: decision.approvalId, clientId, createdAt: Date.now() });
      audit.append({ event: 'pending.guard', requestId, tool, clientId, approvalId: decision.approvalId });
      return text(`Waiting for a human approval in Executive Guard (approval ${decision.approvalId}). Nothing has run. After it is approved, call resume_action with requestId "${requestId}" (valid 15 minutes).`);
    }
    if (decision.outcome !== 'allow') {
      await reportRefused({ requestId, tool, decisionId: decision.unusedDecisionId, nonce: decision.nonce, reason: decision.reason });
      return refuse('denied.guard', `Denied: ${decision.reason} Nothing ran.`);
    }
    audit.append({ event: 'allowed.guard', requestId, tool, clientId, approvalId: decision.claims?.approvalId, decidedBy: decision.claims?.decidedBy });
    return runOnPc({ requestId, tool, args, nonce: decision.nonce, envelope: decision.envelope, claims: decision.claims, clientId });
  }

  async function resume(requestId, auth = {}) {
    sweep();
    const clientId = auth.clientId || 'unknown';
    const p = pending.get(String(requestId || ''));
    if (!config.handsEnabled) return text('Hands are off on this server (HANDS_ENABLED=false). Nothing ran.', true);
    if (!p) return text('No pending action with that requestId (it may have expired or already run).', true);
    if (p.clientId !== clientId) return text('That pending action belongs to a different connection.', true);
    if (!(auth.scopes || []).includes('hands.act')) return text('This connection was not granted hands.act.', true);
    const decision = await guard.awaitApproval({ approvalId: p.approvalId, tool: p.tool, args: p.args, nonce: p.nonce, waitMs: 20000 });
    if (decision.outcome === 'pending') return text(`Still waiting for approval ${p.approvalId}. Nothing has run.`);
    pending.delete(requestId);
    if (decision.outcome !== 'allow') {
      audit.append({ event: 'denied.guard', requestId, tool: p.tool, clientId, reason: decision.reason });
      await reportRefused({ requestId, tool: p.tool, decisionId: decision.unusedDecisionId, nonce: p.nonce, reason: decision.reason });
      return text(`Denied: ${decision.reason} Nothing ran.`, true);
    }
    const route = decideComputeRoute({ job: { needs: TOOLS[p.tool].needs, toolsMode: 'write', pinned: 'pc' }, presence: hub.presence() });
    if (route.outcome !== 'route') return text(`${route.reason} Approved, but nothing ran.`, true);
    audit.append({ event: 'allowed.guard', requestId, tool: p.tool, clientId, approvalId: decision.claims?.approvalId, decidedBy: decision.claims?.decidedBy });
    return runOnPc({ requestId, tool: p.tool, args: p.args, nonce: p.nonce, envelope: decision.envelope, claims: decision.claims, clientId });
  }

  function status() {
    const pres = hub.presence();
    return {
      handsEnabled: config.handsEnabled,
      guardLive: guard.live,
      mutatingTools: guard.live ? 'need a human Guard approval' : 'denied (Executive Guard not live)',
      pc: pres.pc ? { online: true, lastSeenAt: pres.pc.lastSeenAt, capabilities: pres.pc.capabilities } : { online: false },
    };
  }

  return { call, resume, status };
}
