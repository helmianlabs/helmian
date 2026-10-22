// Executive Guard verification server.
//
//   GET  /healthz                         liveness, no auth
//   GET  /v1/keys                         the Ed25519 public key decisions are signed with
//   POST /v1/decisions          device    ask for a decision on one action
//   GET  /v1/approvals/:id      device    poll a pending approval (own device only)
//   GET  /v1/approvals          approver  list approvals (?status=pending)
//   POST /v1/approvals/:id/decide approver approve or deny a pending approval
//   GET  /v1/audit              approver  the hash-chained audit trail
//   GET  /v1/audit/verify       approver  re-verify the chain end to end
//
// Every decision, approval request, approval and denial is written to the
// audit trail before the response goes out. Tokens are compared as SHA-256
// digests with timingSafeEqual. No CORS headers are sent, so an ordinary web
// page cannot read any response; the extension's background worker reaches
// this server through its host permission instead.

import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { ActionError, actionHash, normalizeAction } from './action.mjs';
import { DEFAULT_POLICY, evaluatePolicy, validatePolicy } from './policy.mjs';
import { DECISION_TTL_SECONDS, signDecision } from './signing.mjs';

export const MAX_BODY_BYTES = 32 * 1024;
export const APPROVAL_TTL_SECONDS = 15 * 60;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const ID_PATTERN = /^[a-z0-9-]{1,64}$/;

function digest(token) {
  return createHash('sha256').update(String(token)).digest();
}

// tokens: { [principalId]: token } -> lookup(bearer) -> principalId | null
export function tokenTable(tokens = {}) {
  const rows = Object.entries(tokens)
    .filter(([id, token]) => ID_PATTERN.test(id) && typeof token === 'string' && token.length >= 24)
    .map(([id, token]) => ({ id, hash: digest(token) }));
  return (bearer) => {
    if (!bearer) return null;
    const presented = digest(bearer);
    let found = null;
    for (const row of rows) {
      // Compare against every row so timing does not reveal which one matched.
      if (timingSafeEqual(row.hash, presented)) found = row.id;
    }
    return found;
  };
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '');
    if (!type.toLowerCase().startsWith('application/json')) {
      reject(new HttpError(415, 'unsupported-media-type', 'content-type must be application/json'));
      req.resume();
      return;
    }
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return; // keep draining so the 413 reaches the client
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) { reject(new HttpError(413, 'body-too-large')); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new HttpError(400, 'invalid-json')); }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}

export function createExecutiveGuard({
  key,
  audit,
  deviceTokens = {},
  approverTokens = {},
  policy = DEFAULT_POLICY,
  now = Date.now,
} = {}) {
  if (!key) throw new Error('createExecutiveGuard needs a signing key');
  if (!audit) throw new Error('createExecutiveGuard needs an audit store');
  validatePolicy(policy);
  const findDevice = tokenTable(deviceTokens);
  const findApprover = tokenTable(approverTokens);
  const approvals = new Map();
  const seenNonces = new Map(); // nonce -> expiry ms

  const nowSeconds = () => Math.floor(now() / 1000);

  function pruneNonces() {
    const t = now();
    for (const [nonce, expiry] of seenNonces) if (expiry < t) seenNonces.delete(nonce);
  }

  function issue({ verdict, ruleId, reason, hash, deviceId, nonce, approvalId, decidedBy }) {
    const iat = nowSeconds();
    const claims = {
      decisionId: randomUUID(),
      verdict,
      ruleId,
      actionHash: hash,
      deviceId,
      nonce,
      iat,
      exp: iat + DECISION_TTL_SECONDS,
      ...(approvalId ? { approvalId } : {}),
      ...(decidedBy ? { decidedBy } : {}),
    };
    return { claims, envelope: signDecision(key, claims), reason };
  }

  function expireApprovals() {
    const t = nowSeconds();
    for (const approval of approvals.values()) {
      if (approval.status === 'pending' && approval.expiresAt <= t) {
        approval.status = 'expired';
        audit.append({ event: 'approval.expired', approvalId: approval.id, actionHash: approval.actionHash, deviceId: approval.deviceId });
      }
    }
  }

  function publicApproval(approval) {
    const { nonce, issued, ...rest } = approval;
    return issued ? { ...rest, decisionId: issued.decisionId } : rest;
  }

  async function decide(req, deviceId) {
    const body = await readJson(req);
    const nonce = String(body.nonce ?? '');
    if (!NONCE_PATTERN.test(nonce)) throw new HttpError(400, 'invalid-nonce', 'nonce must be 16-128 url-safe characters');
    pruneNonces();
    if (seenNonces.has(nonce)) throw new HttpError(409, 'replayed-nonce');
    let action;
    try { action = normalizeAction(body.action); }
    catch (error) {
      if (error instanceof ActionError) {
        audit.append({ event: 'decision.rejected', deviceId, error: error.code, detail: error.message });
        throw new HttpError(400, error.code, error.message);
      }
      throw error;
    }
    seenNonces.set(nonce, now() + DECISION_TTL_SECONDS * 1000 * 2);
    const hash = actionHash(action);
    const result = evaluatePolicy(action, policy);

    if (result.verdict === 'ask') {
      const approval = {
        id: randomUUID(),
        status: 'pending',
        createdAt: nowSeconds(),
        expiresAt: nowSeconds() + APPROVAL_TTL_SECONDS,
        deviceId,
        nonce,
        actionHash: hash,
        action,
        ruleId: result.ruleId,
        reason: result.reason,
      };
      approvals.set(approval.id, approval);
      audit.append({ event: 'approval.requested', approvalId: approval.id, deviceId, actionHash: hash, kind: action.kind, site: action.site, riskSignals: action.riskSignals, summary: action.summary, ruleId: result.ruleId });
      const issued = issue({ verdict: 'ask', ruleId: result.ruleId, reason: result.reason, hash, deviceId, nonce, approvalId: approval.id });
      return { status: 202, body: { verdict: 'ask', reason: result.reason, approvalId: approval.id, decision: issued.envelope } };
    }

    const issued = issue({ verdict: result.verdict, ruleId: result.ruleId, reason: result.reason, hash, deviceId, nonce });
    audit.append({ event: 'decision.issued', decisionId: issued.claims.decisionId, deviceId, verdict: result.verdict, ruleId: result.ruleId, actionHash: hash, kind: action.kind, site: action.site, riskSignals: action.riskSignals, summary: action.summary });
    return { status: 200, body: { verdict: result.verdict, reason: result.reason, decision: issued.envelope } };
  }

  function approvalStatus(id, deviceId) {
    expireApprovals();
    const approval = approvals.get(id);
    if (!approval || approval.deviceId !== deviceId) throw new HttpError(404, 'not-found');
    const body = { approvalId: id, status: approval.status, reason: approval.reason };
    if (approval.status === 'approved' || approval.status === 'denied') {
      // ONE decision per approval, signed the first time it is fetched and
      // returned unchanged on every later poll: same decisionId, same exp, bound
      // to the ORIGINAL nonce and action hash. A client that executes (the hands
      // PC spoke) refuses a decisionId it has already used, so a re-poll must
      // not mint a new one. It expires DECISION_TTL_SECONDS after first fetch.
      if (!approval.issued) {
        const issued = issue({
          verdict: approval.status === 'approved' ? 'allow' : 'deny',
          ruleId: approval.ruleId,
          reason: approval.decisionReason || approval.reason,
          hash: approval.actionHash,
          deviceId,
          nonce: approval.nonce,
          approvalId: id,
          decidedBy: approval.decidedBy,
        });
        approval.issued = { decisionId: issued.claims.decisionId, envelope: issued.envelope };
        audit.append({ event: 'decision.issued', decisionId: issued.claims.decisionId, approvalId: id, deviceId, verdict: issued.claims.verdict, ruleId: approval.ruleId, actionHash: approval.actionHash, decidedBy: approval.decidedBy });
      }
      body.decision = approval.issued.envelope;
      body.decidedBy = approval.decidedBy;
    }
    return body;
  }

  async function resolveApproval(req, id, approverId) {
    const body = await readJson(req);
    expireApprovals();
    const approval = approvals.get(id);
    if (!approval) throw new HttpError(404, 'not-found');
    if (approval.status !== 'pending') throw new HttpError(409, 'not-pending', `approval is ${approval.status}`);
    if (typeof body.approve !== 'boolean') throw new HttpError(400, 'approve-must-be-boolean');
    approval.status = body.approve ? 'approved' : 'denied';
    approval.decidedBy = approverId;
    approval.decidedAt = nowSeconds();
    approval.decisionReason = String(body.reason ?? '').slice(0, 300) || undefined;
    audit.append({ event: body.approve ? 'approval.approved' : 'approval.denied', approvalId: id, approverId, deviceId: approval.deviceId, actionHash: approval.actionHash, reason: approval.decisionReason });
    return publicApproval(approval);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true, service: 'executive-guard' });
      if (req.method === 'GET' && path === '/v1/keys') {
        return send(res, 200, { keyId: key.keyId, alg: 'Ed25519', publicKeyJwk: key.publicJwk });
      }

      const token = bearer(req);
      if (path === '/v1/decisions' || /^\/v1\/approvals\/[^/]+$/.test(path) && req.method === 'GET') {
        const deviceId = findDevice(token);
        if (!deviceId) throw new HttpError(401, 'unauthorized');
        if (req.method === 'POST' && path === '/v1/decisions') {
          const out = await decide(req, deviceId);
          return send(res, out.status, out.body);
        }
        if (req.method === 'GET') return send(res, 200, approvalStatus(path.split('/')[3], deviceId));
        throw new HttpError(405, 'method-not-allowed');
      }

      if (path.startsWith('/v1/approvals') || path.startsWith('/v1/audit')) {
        const approverId = findApprover(token);
        if (!approverId) throw new HttpError(401, 'unauthorized');
        if (req.method === 'GET' && path === '/v1/approvals') {
          expireApprovals();
          const status = url.searchParams.get('status');
          const list = [...approvals.values()].filter((a) => !status || a.status === status).map(publicApproval);
          return send(res, 200, { approvals: list });
        }
        const decideMatch = /^\/v1\/approvals\/([^/]+)\/decide$/.exec(path);
        if (req.method === 'POST' && decideMatch) return send(res, 200, { approval: await resolveApproval(req, decideMatch[1], approverId) });
        if (req.method === 'GET' && path === '/v1/audit') {
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 1000);
          const sinceSeq = Number(url.searchParams.get('sinceSeq')) || 0;
          return send(res, 200, { entries: audit.list({ limit, sinceSeq }) });
        }
        if (req.method === 'GET' && path === '/v1/audit/verify') return send(res, 200, audit.verify());
      }
      throw new HttpError(404, 'not-found');
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { error: error.code, message: error.message });
      console.error('[executive-guard] unhandled error:', error);
      return send(res, 500, { error: 'internal' });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  return { server, approvals, handle };
}
