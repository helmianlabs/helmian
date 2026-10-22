// Executive Guard verification server.
//
//   GET  /healthz                         liveness, no auth
//   GET  /v1/keys                         the Ed25519 public key decisions are signed with
//   POST /v1/decisions          device    ask for a decision on one action
//   GET  /v1/approvals/:id      device    poll a pending approval (own device only)
//   GET  /v1/approvals          approver  list approvals (?status=pending)
//   POST /v1/approvals/:id/decide approver approve or deny a pending approval
//   GET  /v1/audit              approver  the hash-chained audit trail
//   (pending approvals + used nonces persist via src/state.mjs)
//   GET  /v1/audit/verify       approver  re-verify the chain end to end
//   POST /v1/audit/outcomes     device    report what happened after a decision
//                                         (docs/OUTCOMES.md has the exact contract)
//
// Pending approvals, the decision issued for each approval and used nonces are
// persisted through a state store (src/state.mjs) and rebuilt on start.
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
import { memoryState } from './state.mjs';

export const MAX_BODY_BYTES = 32 * 1024;
export const APPROVAL_TTL_SECONDS = 15 * 60;
// An outcome may be reported until this long after the decision expires
// (a long-running tool can finish after its decision's 300 s lifetime).
export const OUTCOME_WINDOW_SECONDS = 24 * 60 * 60;
export const OUTCOME_STATUSES = Object.freeze(['succeeded', 'failed', 'refused']);
const OUTCOME_FIELDS = new Set(['decisionId', 'nonce', 'status', 'startedAt', 'finishedAt', 'resultHash', 'error']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const ID_PATTERN = /^[a-z0-9-]{1,64}$/;

function digest(token) {
  return createHash('sha256').update(String(token)).digest();
}

const nonceHashOf = (nonce) => createHash('sha256').update(String(nonce)).digest('hex');

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
  state = memoryState(),
} = {}) {
  if (!key) throw new Error('createExecutiveGuard needs a signing key');
  if (!audit) throw new Error('createExecutiveGuard needs an audit store');
  validatePolicy(policy);
  const findDevice = tokenTable(deviceTokens);
  const findApprover = tokenTable(approverTokens);
  const approvals = new Map();
  const seenNonces = new Map(); // sha256(nonce) -> expiry ms
  // decisionId -> { deviceId, verdict, actionHash, nonceHash, exp, approvalId, outcome }
  // for every allow/deny decision this server signed. Rebuilt from the audit
  // trail on start, so a restart neither forgets decisions nor accepts a second
  // outcome for one. ('ask' decisions are not executable and are not indexed.)
  const issuedDecisions = new Map();
  for (const entry of audit.all ? audit.all() : []) {
    if (entry.event === 'decision.issued' && entry.decisionId && entry.nonceHash) {
      issuedDecisions.set(entry.decisionId, { deviceId: entry.deviceId, verdict: entry.verdict, actionHash: entry.actionHash, nonceHash: entry.nonceHash, exp: entry.exp, approvalId: entry.approvalId, outcome: null });
    } else if (entry.event === 'decision.outcome' && issuedDecisions.has(entry.decisionId)) {
      issuedDecisions.get(entry.decisionId).outcome = entry.seq;
    }
  }

  function remember(claims) {
    issuedDecisions.set(claims.decisionId, { deviceId: claims.deviceId, verdict: claims.verdict, actionHash: claims.actionHash, nonceHash: nonceHashOf(claims.nonce), exp: claims.exp, approvalId: claims.approvalId, outcome: null });
    const cutoff = nowSeconds() - OUTCOME_WINDOW_SECONDS;
    for (const [id, d] of issuedDecisions) if (d.exp < cutoff) issuedDecisions.delete(id);
  }

  const nowSeconds = () => Math.floor(now() / 1000);

  // Persist first, audit second: a crash in between leaves state the audit
  // does not confirm, and restore() below treats the audit as the truth.
  function saveApproval(approval) { state.append({ t: 'approval', approval }); }

  function keepApproval(approval) {
    if (approval.status === 'pending') return true;
    const finished = approval.decidedAt || approval.expiresAt;
    return finished + OUTCOME_WINDOW_SECONDS > nowSeconds();
  }

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
        saveApproval(approval);
        audit.append({ event: 'approval.expired', approvalId: approval.id, actionHash: approval.actionHash, deviceId: approval.deviceId });
      }
    }
  }

  function publicApproval(approval) {
    const { nonce, issued, decisionLost, ...rest } = approval;
    return issued ? { ...rest, decisionId: issued.decisionId } : rest;
  }

  // Rebuild pending approvals and the nonce replay cache after a restart.
  function restore() {
    const t = now();
    const latest = new Map();
    for (const record of state.load()) {
      if (record.t === 'nonce' && record.exp > t) seenNonces.set(record.h, Math.max(seenNonces.get(record.h) || 0, record.exp));
      if (record.t === 'approval' && record.approval?.id) latest.set(record.approval.id, record.approval);
    }
    // What the audit trail says about each approval.
    const requested = new Map();
    const settled = new Map();
    const issuedFor = new Set();
    for (const e of audit.all ? audit.all() : []) {
      if (e.event === 'approval.requested') requested.set(e.approvalId, e);
      else if (e.event === 'approval.approved' || e.event === 'approval.denied' || e.event === 'approval.expired') {
        if (!settled.has(e.approvalId)) settled.set(e.approvalId, e);
      } else if (e.event === 'decision.issued' && e.approvalId) issuedFor.add(e.approvalId);
    }
    for (const approval of latest.values()) {
      if (!requested.has(approval.id)) continue; // never acknowledged to the device
      const s = settled.get(approval.id);
      if (s) {
        approval.status = { 'approval.approved': 'approved', 'approval.denied': 'denied', 'approval.expired': 'expired' }[s.event];
        if (s.event !== 'approval.expired') {
          approval.decidedBy = s.approverId;
          approval.decidedAt = approval.decidedAt || Math.floor(Date.parse(s.at) / 1000);
          approval.decisionReason = s.reason;
        }
      } else {
        // Not confirmed by the audit: still pending, whatever the state file said.
        approval.status = 'pending';
        delete approval.decidedBy; delete approval.decidedAt; delete approval.decisionReason; delete approval.issued;
      }
      if (approval.issued && !issuedFor.has(approval.id) && approval.status !== 'pending') {
        audit.append({ event: 'decision.issued', decisionId: approval.issued.decisionId, approvalId: approval.id, deviceId: approval.deviceId, verdict: approval.status === 'approved' ? 'allow' : 'deny', ruleId: approval.ruleId, actionHash: approval.actionHash, decidedBy: approval.decidedBy, nonceHash: nonceHashOf(approval.nonce), exp: approval.issued.exp, recovered: true });
      }
      if (!approval.issued && issuedFor.has(approval.id)) approval.decisionLost = true;
      if (approval.issued) {
        const prior = issuedDecisions.get(approval.issued.decisionId);
        if (!prior) issuedDecisions.set(approval.issued.decisionId, { deviceId: approval.deviceId, verdict: approval.status === 'approved' ? 'allow' : 'deny', actionHash: approval.actionHash, nonceHash: nonceHashOf(approval.nonce), exp: approval.issued.exp, approvalId: approval.id, outcome: null });
      }
      if (keepApproval(approval)) approvals.set(approval.id, approval);
    }
    // Approvals the audit shows as still pending but whose state is gone cannot
    // be completed (their nonce is not in the audit). Close them in the record.
    for (const [id, e] of requested) {
      if (settled.has(id) || approvals.has(id)) continue;
      audit.append({ event: 'approval.expired', approvalId: id, actionHash: e.actionHash, deviceId: e.deviceId, reason: 'state-unavailable-after-restart' });
    }
    expireApprovals();
    state.compact([
      ...[...seenNonces].map(([h, exp]) => ({ t: 'nonce', h, exp })),
      ...[...approvals.values()].map((approval) => ({ t: 'approval', approval })),
    ]);
  }
  restore();

  async function decide(req, deviceId) {
    const body = await readJson(req);
    const nonce = String(body.nonce ?? '');
    if (!NONCE_PATTERN.test(nonce)) throw new HttpError(400, 'invalid-nonce', 'nonce must be 16-128 url-safe characters');
    pruneNonces();
    const nonceHash = nonceHashOf(nonce);
    if (seenNonces.has(nonceHash)) throw new HttpError(409, 'replayed-nonce');
    let action;
    try { action = normalizeAction(body.action); }
    catch (error) {
      if (error instanceof ActionError) {
        audit.append({ event: 'decision.rejected', deviceId, error: error.code, detail: error.message });
        throw new HttpError(400, error.code, error.message);
      }
      throw error;
    }
    const nonceExp = now() + Math.max(DECISION_TTL_SECONDS * 2, APPROVAL_TTL_SECONDS) * 1000;
    state.append({ t: 'nonce', h: nonceHash, exp: nonceExp });
    seenNonces.set(nonceHash, nonceExp);
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
      saveApproval(approval);
      audit.append({ event: 'approval.requested', approvalId: approval.id, deviceId, actionHash: hash, kind: action.kind, site: action.site, riskSignals: action.riskSignals, summary: action.summary, ruleId: result.ruleId });
      const issued = issue({ verdict: 'ask', ruleId: result.ruleId, reason: result.reason, hash, deviceId, nonce, approvalId: approval.id });
      return { status: 202, body: { verdict: 'ask', reason: result.reason, approvalId: approval.id, decision: issued.envelope } };
    }

    const issued = issue({ verdict: result.verdict, ruleId: result.ruleId, reason: result.reason, hash, deviceId, nonce });
    audit.append({ event: 'decision.issued', decisionId: issued.claims.decisionId, deviceId, verdict: result.verdict, ruleId: result.ruleId, actionHash: hash, kind: action.kind, site: action.site, riskSignals: action.riskSignals, summary: action.summary, nonceHash: nonceHashOf(nonce), exp: issued.claims.exp });
    remember(issued.claims);
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
      if (!approval.issued && approval.decisionLost) {
        // The audit shows a decision was signed but the state file that held it
        // is gone. Minting a second one would defeat single use, so fail closed.
        body.error = 'decision-unavailable';
        return body;
      }
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
        approval.issued = { decisionId: issued.claims.decisionId, envelope: issued.envelope, exp: issued.claims.exp };
        saveApproval(approval);
        audit.append({ event: 'decision.issued', decisionId: issued.claims.decisionId, approvalId: id, deviceId, verdict: issued.claims.verdict, ruleId: approval.ruleId, actionHash: approval.actionHash, decidedBy: approval.decidedBy, nonceHash: nonceHashOf(approval.nonce), exp: issued.claims.exp });
        remember(issued.claims);
      }
      body.decision = approval.issued.envelope;
      body.decidedBy = approval.decidedBy;
    }
    return body;
  }

  function parseTime(value, field, required) {
    if (value === undefined || value === null) {
      if (required) throw new HttpError(400, 'invalid-time', `${field} is required (ISO 8601 UTC, e.g. 2026-10-22T10:00:00.000Z)`);
      return null;
    }
    if (typeof value !== 'string' || !ISO_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
      throw new HttpError(400, 'invalid-time', `${field} must be ISO 8601 UTC, e.g. 2026-10-22T10:00:00.000Z`);
    }
    const ms = Date.parse(value);
    if (ms > now() + CLOCK_SKEW_MS) throw new HttpError(400, 'invalid-time', `${field} is in the future`);
    return ms;
  }

  async function recordOutcome(req, deviceId) {
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid-body');
    const extra = Object.keys(body).filter((k) => !OUTCOME_FIELDS.has(k));
    if (extra.length) throw new HttpError(400, 'unknown-field', `unknown field: ${extra.sort().join(', ')}`);
    const decisionId = String(body.decisionId ?? '');
    if (!UUID_PATTERN.test(decisionId)) throw new HttpError(400, 'invalid-decision-id', 'decisionId must be the UUID from the signed decision');
    const nonce = String(body.nonce ?? '');
    if (!NONCE_PATTERN.test(nonce)) throw new HttpError(400, 'invalid-nonce', 'nonce must be 16-128 url-safe characters');
    if (!OUTCOME_STATUSES.includes(body.status)) throw new HttpError(400, 'invalid-status', `status must be one of ${OUTCOME_STATUSES.join(', ')}`);
    const status = body.status;
    const startedMs = parseTime(body.startedAt, 'startedAt', status !== 'refused');
    const finishedMs = parseTime(body.finishedAt, 'finishedAt', true);
    if (startedMs !== null && finishedMs < startedMs) throw new HttpError(400, 'invalid-time', 'finishedAt is before startedAt');
    if (body.resultHash !== undefined && (typeof body.resultHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.resultHash))) {
      throw new HttpError(400, 'invalid-result-hash', 'resultHash must be 64 lowercase hex characters (SHA-256)');
    }
    if (body.error !== undefined) {
      if (status === 'succeeded') throw new HttpError(400, 'invalid-error', 'error is only allowed when status is failed or refused');
      if (typeof body.error !== 'string' || body.error.length > 500) throw new HttpError(400, 'invalid-error', 'error must be a string of at most 500 characters');
    }

    // Unknown and another device's decisionId get the same answer, so a device
    // cannot probe for decisions it was not given.
    const decision = issuedDecisions.get(decisionId);
    if (!decision || decision.deviceId !== deviceId) throw new HttpError(404, 'unknown-decision');
    const presented = Buffer.from(nonceHashOf(nonce), 'hex');
    if (!timingSafeEqual(presented, Buffer.from(decision.nonceHash, 'hex'))) throw new HttpError(403, 'nonce-mismatch', 'nonce does not match the decision');
    if (decision.outcome) throw new HttpError(409, 'duplicate-outcome', 'an outcome was already recorded for this decision');
    if (decision.verdict !== 'allow' && status !== 'refused') {
      throw new HttpError(409, 'verdict-mismatch', `the decision was ${decision.verdict}; only status refused can be reported for it`);
    }
    if (nowSeconds() > decision.exp + OUTCOME_WINDOW_SECONDS) throw new HttpError(410, 'outcome-window-closed');

    const entry = audit.append({
      event: 'decision.outcome',
      decisionId,
      deviceId,
      ...(decision.approvalId ? { approvalId: decision.approvalId } : {}),
      verdict: decision.verdict,
      actionHash: decision.actionHash,
      status,
      ...(startedMs !== null ? { startedAt: new Date(startedMs).toISOString(), durationMs: finishedMs - startedMs } : {}),
      finishedAt: new Date(finishedMs).toISOString(),
      ...(body.resultHash ? { resultHash: body.resultHash } : {}),
      // Control characters stripped; clients must not put secrets in error.
      ...(body.error !== undefined ? { error: body.error.replace(/[\u0000-\u001f\u007f]/g, ' ') } : {}),
    });
    decision.outcome = entry.seq;
    return { status: 201, body: { recorded: true, decisionId, status, auditSeq: entry.seq, auditHash: entry.hash } };
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
    saveApproval(approval);
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
      if (path === '/v1/audit/outcomes') {
        const deviceId = findDevice(token);
        if (!deviceId) throw new HttpError(401, 'unauthorized');
        if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed');
        const out = await recordOutcome(req, deviceId);
        return send(res, out.status, out.body);
      }
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
  return { server, approvals, handle, issuedDecisions };
}
