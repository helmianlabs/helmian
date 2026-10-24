// PC action approvals (hands connector -> Executive Guard on the Hetzner box).
//
//   GET  /api/admin/guard/pc-approvals          pending Guard approvals
//   GET  /api/admin/guard/pc-upcoming           pending + approved Guard queue, soonest expiry first
//   POST /api/admin/guard/pc-approvals/decide   { approvalId, approve: boolean, reason? }
//
// Used by /app (admin session cookie) and Herald (Clerk session Bearer), same origin.
// Only subjects listed in HELMIAN_GUARD_APPROVER_SUBJECTS may see or decide; that is
// Troy, not "any tenant owner" (a trial signup is the owner of its own tenant and
// must never approve actions on Troy's PC). Anything unset = 503, nothing decided.
//
// Env (server-side only; the approver token is a Guard credential, not a provider key):
//   HELMIAN_GUARD_URL               default https://guard.5-78-222-178.sslip.io
//   HELMIAN_GUARD_APPROVER_TOKEN    Guard approver bearer (approverId "troy")
//   HELMIAN_GUARD_APPROVER_SUBJECTS comma-separated Clerk user ids allowed to approve

import { createIdentityGateway } from './identity-gateway.mjs';
import { verifyClerkSessionBearer } from './signup.mjs';

export const PC_APPROVALS_PATH = '/api/admin/guard/pc-approvals';
export const PC_APPROVALS_DECIDE_PATH = '/api/admin/guard/pc-approvals/decide';
export const PC_UPCOMING_PATH = '/api/admin/guard/pc-upcoming';
const ID = /^[A-Za-z0-9-]{8,64}$/;

let _identity = null;
const defaultIdentity = () => (_identity ||= createIdentityGateway({ env: process.env, fetchImpl: fetch }));

function cookieValue(request, name) {
  const header = request.headers?.cookie || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let text = '';
  for await (const chunk of request) { text += chunk; if (text.length > 4096) throw Object.assign(new Error('too large'), { status: 413 }); }
  return JSON.parse(text || '{}');
}

/** Only the fields a human needs to decide. Never the raw action content. */
export function publicApproval(a = {}) {
  return {
    approvalId: String(a.id ?? a.approvalId ?? ''),
    status: String(a.status ?? ''),
    summary: String(a.action?.summary ?? a.summary ?? '').slice(0, 500),
    reason: String(a.reason ?? '').slice(0, 300),
    tool: (a.action?.riskSignals || []).find((s) => String(s).startsWith('tool:'))?.slice(5) || null,
    site: a.action?.site ?? null,
    deviceId: a.deviceId ?? null,
    createdAt: Number.isFinite(a.createdAt) ? new Date(a.createdAt * 1000).toISOString() : null,
    expiresAt: Number.isFinite(a.expiresAt) ? new Date(a.expiresAt * 1000).toISOString() : null,
  };
}

export function createPcApprovalsHandler({
  env = process.env,
  fetchImpl = fetch,
  identity = defaultIdentity,
  verifyBearer = verifyClerkSessionBearer,
} = {}) {
  const guardUrl = String(env.HELMIAN_GUARD_URL || 'https://guard.5-78-222-178.sslip.io').replace(/\/+$/, '');
  const token = String(env.HELMIAN_GUARD_APPROVER_TOKEN || '').trim();
  const allowed = new Set(String(env.HELMIAN_GUARD_APPROVER_SUBJECTS || '').split(',').map((s) => s.trim()).filter(Boolean));

  async function subjectOf(request) {
    try {
      const cookie = cookieValue(request, 'helmion_admin_session');
      const fromCookie = cookie ? identity().getSession(cookie)?.subject : null;
      if (fromCookie) return fromCookie;
      const auth = String(request.headers?.authorization || '');
      return auth.startsWith('Bearer ') ? (await verifyBearer(auth.slice(7), env))?.subject ?? null : null;
    } catch { return null; }
  }

  async function guard(path, init = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetchImpl(`${guardUrl}${path}`, { ...init, signal: ctrl.signal, headers: { ...(init.headers || {}), authorization: `Bearer ${token}` } });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    } finally { clearTimeout(t); }
  }

  return async function handle(request, response, pathname) {
    if (!token || !allowed.size) return sendJson(response, 503, { error: 'GUARD_APPROVER_NOT_CONFIGURED', message: 'PC approvals are not set up yet.' });
    const subject = await subjectOf(request);
    if (!subject) return sendJson(response, 401, { error: 'Not authenticated' });
    if (!allowed.has(subject)) return sendJson(response, 403, { error: 'GUARD_APPROVER_REQUIRED', message: 'Only the PC owner can approve PC actions.' });
    try {
      if (request.method === 'GET' && pathname === PC_APPROVALS_PATH) {
        const r = await guard('/v1/approvals?status=pending');
        if (r.status !== 200) return sendJson(response, 502, { error: 'GUARD_UNAVAILABLE', status: r.status });
        const list = Array.isArray(r.body?.approvals) ? r.body.approvals : Array.isArray(r.body) ? r.body : [];
        return sendJson(response, 200, { approvals: list.map(publicApproval).filter((a) => a.status === 'pending') });
      }
      if (request.method === 'GET' && pathname === PC_UPCOMING_PATH) {
        // The whole "what is waiting" queue in one call: pending approvals are
        // waiting on the human (waitingOn: 'you'); approved ones are waiting on
        // the PC to pick them up before their window closes (waitingOn: 'pc').
        // Soonest expiry first, so nothing dies invisibly at the bottom.
        const [pendingR, approvedR, expiredR] = await Promise.all([
          guard('/v1/approvals?status=pending'),
          guard('/v1/approvals?status=approved'),
          guard('/v1/approvals?status=expired'),
        ]);
        if (pendingR.status !== 200) return sendJson(response, 502, { error: 'GUARD_UNAVAILABLE', status: pendingR.status });
        if (approvedR.status !== 200) return sendJson(response, 502, { error: 'GUARD_UNAVAILABLE', status: approvedR.status });
        const pick = (r, status) => (Array.isArray(r.body?.approvals) ? r.body.approvals : Array.isArray(r.body) ? r.body : [])
          .map(publicApproval).filter((a) => a.status === status);
        const pending = pick(pendingR, 'pending').map((a) => ({ ...a, waitingOn: 'you' }));
        const approved = pick(approvedR, 'approved').map((a) => ({ ...a, waitingOn: 'pc' }));
        const queue = [...pending, ...approved].sort((a, b) => (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity));
        // Expired is best-effort context ("died while you were away"), never a
        // reason to fail the queue: a failed expired fetch just reports 0.
        const dayAgo = Date.now() - 24 * 3600 * 1000;
        const expiredRecent = expiredR.status === 200
          ? pick(expiredR, 'expired').filter((a) => a.expiresAt && Date.parse(a.expiresAt) >= dayAgo).length
          : 0;
        return sendJson(response, 200, { queue, counts: { pending: pending.length, approved: approved.length, total: queue.length, expiredRecent } });
      }
      if (request.method === 'POST' && pathname === PC_APPROVALS_DECIDE_PATH) {
        if (!String(request.headers?.['content-type'] || '').toLowerCase().startsWith('application/json')) return sendJson(response, 415, { error: 'json required' });
        const body = await readBody(request);
        if (!ID.test(String(body.approvalId || '')) || typeof body.approve !== 'boolean') return sendJson(response, 400, { error: 'approvalId and approve (boolean) are required' });
        const reason = `${body.approve ? 'approved' : 'denied'} by ${subject}${body.reason ? `: ${String(body.reason).slice(0, 200)}` : ''}`;
        const r = await guard(`/v1/approvals/${encodeURIComponent(body.approvalId)}/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve: body.approve, reason }) });
        if (r.status === 404) return sendJson(response, 404, { error: 'not found (expired or already gone)' });
        if (r.status === 409) return sendJson(response, 409, { error: 'already decided or expired' });
        if (r.status !== 200) return sendJson(response, 502, { error: 'GUARD_UNAVAILABLE', status: r.status });
        return sendJson(response, 200, { approval: publicApproval(r.body?.approval) });
      }
      return sendJson(response, 405, { error: 'Method not allowed' });
    } catch (e) {
      return sendJson(response, e?.status === 413 ? 413 : 502, { error: e?.name === 'AbortError' ? 'GUARD_TIMEOUT' : 'GUARD_UNAVAILABLE' });
    }
  };
}
