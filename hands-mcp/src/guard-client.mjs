// Client for Executive Guard (executive-guard/, PR #53). FAILS CLOSED:
// not configured, unreachable, slow, malformed, unsigned or not a human approval
// => the mutating action is denied. Read-only tools never come here.

import { randomBytes } from 'node:crypto';
import { buildGuardAction, verifyApproval } from './shared/protocol.mjs';

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
    return v.ok ? { outcome: 'allow', envelope, claims: v.claims } : deny(`Guard decision rejected: ${v.error}.`);
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
      if (status === 'denied') return deny(`A human denied this in Guard${r.body.decidedBy ? ` (${r.body.decidedBy})` : ''}.`);
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
      return { ...deny('Guard allowed this without a human approval; hands requires one for every mutating action.'), nonce };
    }
    return { ...deny(`Guard denied: ${r.body.reason || 'policy'}.`), nonce };
  }

  return { live, authorize, awaitApproval };
}
