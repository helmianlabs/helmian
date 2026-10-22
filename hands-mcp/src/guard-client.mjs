// Client for Executive Guard (executive-guard/, PR #53). FAILS CLOSED:
// not configured, unreachable, slow, malformed, unsigned or not a human approval
// => the mutating action is denied. Read-only tools never come here.

import { randomBytes } from 'node:crypto';
import { buildGuardAction, verifyApproval } from './shared/protocol.mjs';

/** decisionId from a signed decision envelope, WITHOUT trusting it (only used to report "refused"; Guard checks it). */
export function decisionIdOf(envelope) {
  try {
    const claims = JSON.parse(Buffer.from(String(envelope?.payload ?? ''), 'base64url').toString('utf8'));
    return typeof claims?.decisionId === 'string' && claims.verdict !== 'ask' ? claims.decisionId : null;
  } catch { return null; }
}

export function createGuardClient({ url, deviceToken, publicKeyX, deviceId, timeoutMs = 5000, approvalWaitMs = 45000, pollMs = 2000, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const live = Boolean(url && deviceToken && publicKeyX);

  async function call(path, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${url}${path}`, { ...init, signal: ctrl.signal, headers: { ...(init?.headers || {}), authorization: `Bearer ${deviceToken}` } });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      return { status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  const deny = (reason, extra = {}) => ({ outcome: 'deny', reason, ...extra });

  function check(envelope, tool, args, nonce) {
    const v = verifyApproval({ publicKeyX, envelope, tool, args, nonce, deviceId });
    return v.ok ? { outcome: 'allow', envelope, claims: v.claims } : deny(`Guard decision rejected: ${v.error}.`, { unusedDecisionId: decisionIdOf(envelope) });
  }

  /** Wait for a pending approval; returns allow | deny | pending. */
  async function awaitApproval({ approvalId, tool, args, nonce, waitMs = approvalWaitMs }) {
    if (!live) return deny('Executive Guard is not live yet, so mutating actions are denied.');
    const deadline = Date.now() + waitMs;
    for (;;) {
      let r;
      try { r = await call(`/v1/approvals/${encodeURIComponent(approvalId)}`, { method: 'GET' }); }
      catch (e) { return deny(`Executive Guard is unreachable (${e.name === 'AbortError' ? 'timeout' : e.message}); denied.`); }
      if (r.status !== 200 || !r.body) return deny(`Executive Guard answered ${r.status}; denied.`);
      const status = r.body.status;
      if (status === 'approved') return check(r.body.decision, tool, args, nonce);
      if (status === 'denied') return deny(`A human denied this in Guard${r.body.decidedBy ? ` (${r.body.decidedBy})` : ''}.`, { unusedDecisionId: decisionIdOf(r.body.decision) });
      if (status === 'expired') return deny('The Guard approval expired; ask again.');
      if (status !== 'pending') return deny(`Unknown Guard approval state "${status}"; denied.`);
      if (Date.now() + pollMs > deadline) return { outcome: 'pending', approvalId, reason: r.body.reason || 'Waiting for a human to approve in Guard.' };
      await sleep(pollMs);
    }
  }

  /** Ask Guard about tool(args). Returns { outcome: allow|deny|pending, ... , nonce }. */
  async function authorize({ tool, args, waitMs }) {
    const nonce = randomBytes(18).toString('base64url');
    if (!live) return { ...deny('Executive Guard is not live yet, so mutating actions are denied (fail closed).'), nonce };
    const action = buildGuardAction(tool, args);
    let r;
    try {
      r = await call('/v1/decisions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce, action }) });
    } catch (e) {
      return { ...deny(`Executive Guard is unreachable (${e.name === 'AbortError' ? 'timeout' : e.message}); denied.`), nonce };
    }
    if (!r.body || (r.status !== 200 && r.status !== 202)) return { ...deny(`Executive Guard answered ${r.status}; denied.`), nonce };
    if (r.body.verdict === 'ask' && r.body.approvalId) {
      return { ...(await awaitApproval({ approvalId: r.body.approvalId, tool, args, nonce, waitMs })), nonce, approvalId: r.body.approvalId };
    }
    if (r.body.verdict === 'allow') {
      // An automatic allow is not enough for a mutating hands call: it must be a human approval.
      return { ...deny('Guard allowed this without a human approval; hands requires one for every mutating action.', { unusedDecisionId: decisionIdOf(r.body.decision) }), nonce };
    }
    return { ...deny(`Guard denied: ${r.body.reason || 'policy'}.`, { unusedDecisionId: r.body.verdict === 'deny' ? decisionIdOf(r.body.decision) : null }), nonce };
  }

  /**
   * POST /v1/audit/outcomes (executive-guard/docs/OUTCOMES.md): what happened after a decision.
   * Best effort and never throws: an outcome that can't be recorded must not change the tool's answer.
   * Sends exactly the documented fields (Guard rejects unknown ones). Never the result itself.
   */
  async function reportOutcome({ decisionId, nonce, status, startedAt, finishedAt, resultHash, error }) {
    if (!live) return { recorded: false, error: 'guard-not-live' };
    if (!decisionId || !nonce) return { recorded: false, error: 'no-decision' };
    const body = { decisionId, nonce, status, finishedAt: finishedAt || new Date().toISOString() };
    if (status !== 'refused' || startedAt) body.startedAt = startedAt || body.finishedAt;
    if (resultHash && /^[0-9a-f]{64}$/.test(resultHash)) body.resultHash = resultHash;
    if (error && status !== 'succeeded') body.error = String(error).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
    try {
      const r = await call('/v1/audit/outcomes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status === 201) return { recorded: true, auditSeq: r.body?.auditSeq ?? null };
      return { recorded: false, status: r.status, error: r.body?.error || `http-${r.status}` };
    } catch (e) {
      return { recorded: false, error: e.name === 'AbortError' ? 'timeout' : 'unreachable' };
    }
  }

  return { live, authorize, awaitApproval, reportOutcome };
}
