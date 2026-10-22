// The Executive Guard interface the hands MCP connector calls
// (helmianlabs/helmian PR #52, docs/hands/HANDS_MCP_CONNECTOR_DESIGN.md §5).
//
//   GET  /guard/v1/keys                       public key (same key as /v1/keys)
//   POST /guard/v1/decide          service    decide one tool call
//   GET  /guard/v1/approvals/:id   service    approval state (?waitMs= long-poll, max 25 s)
//   POST /guard/v1/audit           service    append an execution outcome
//
// A human decides pending approvals through the existing approver endpoints
// (GET /v1/approvals, POST /v1/approvals/:id/decide); Herald, /app and Envoy are
// not wired here.
//
// Signature (PR #52 §5.1 lists the fields, not the encoding; this is the
// encoding used): Ed25519 over the UTF-8 bytes of
//   decisionId \n requestId \n argumentsDigest \n decision \n expiresAt
// sent as "ed25519:" + base64url(signature), with the signing key's keyId in
// the response. argumentsDigest is "sha256:" + lowercase hex of SHA-256 over
// the canonical JSON of `arguments` (canonical.mjs). Guard recomputes it and
// refuses a request whose digest does not match its arguments.

import { createHash, randomBytes, sign, verify } from 'node:crypto';
import { canonicalJson, base64url, fromBase64url } from './canonical.mjs';

export const HANDS_DECISION_TTL_SECONDS = 300;
export const HANDS_APPROVAL_TTL_SECONDS = 15 * 60;
export const MAX_WAIT_MS = 25000;
export const REQUEST_SKEW_SECONDS = 300;
export const IDEMPOTENCY_SECONDS = 60 * 60;
export const DEFAULT_CONSTRAINTS = Object.freeze({ maxRuntimeMs: 30000, maxOutputBytes: 65536 });

export const HANDS_TOOLS = Object.freeze({
  'hands.list_files': { scope: 'hands.read', spokes: ['pc', 'runner'] },
  'hands.read_file': { scope: 'hands.read', spokes: ['pc', 'runner'] },
  'hands.ollama_generate': { scope: 'hands.read', spokes: ['pc'] },
  'hands.run_powershell': { scope: 'hands.act', spokes: ['pc'] },
  'hands.open_url': { scope: 'hands.act', spokes: ['pc'] },
  'hands.write_file': { scope: 'hands.act', spokes: ['pc', 'runner'] },
});

const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMAND_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class HandsError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

export function argumentsDigest(args) {
  return `sha256:${createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex')}`;
}

export function signingString({ decisionId, requestId, argumentsDigest: digest, decision, expiresAt }) {
  return [decisionId, requestId, digest, decision, expiresAt].join('\n');
}

export function signHands(key, fields) {
  return `ed25519:${base64url(sign(null, Buffer.from(signingString(fields), 'utf8'), key.privateKey))}`;
}

/** Reference verifier for the hands server and the spoke (PR #52 §5.4 rule 2). */
export function verifyHands(publicKey, fields, signature) {
  if (typeof signature !== 'string' || !signature.startsWith('ed25519:')) return false;
  try {
    return verify(null, Buffer.from(signingString(fields), 'utf8'), publicKey, fromBase64url(signature.slice(8)));
  } catch { return false; }
}

const newId = (prefix) => `${prefix}_${randomBytes(12).toString('base64url')}`;
const iso = (seconds) => new Date(seconds * 1000).toISOString();

// ─── policy (PR #52 §4 default postures) ───────────────────────────────────

const SECRET_PATH = [
  /(^|\/)\.env(\.[^/]*)?$/i,
  /\.(pem|key|pfx|p12)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /(^|\/)appdata\/roaming\/helmian(\/|$)/i,
  /%appdata%\/helmian(\/|$)/i,
];

function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function insideRoots(path, roots, { caseless }) {
  if (typeof path !== 'string' || !path || path.length > 1024) return false;
  const p = normalizePath(path);
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) return false;
  const cmp = (s) => (caseless ? s.toLowerCase() : s);
  return roots.some((root) => {
    const r = normalizePath(root).replace(/\/$/, '');
    return cmp(p) === cmp(r) || cmp(p).startsWith(`${cmp(r)}/`);
  });
}

export function evaluateHands(request, config) {
  const tool = HANDS_TOOLS[request.tool];
  const deny = (ruleId, reason) => ({ decision: 'deny', ruleId, reason });
  const ask = (ruleId, reason) => ({ decision: 'pending_approval', ruleId, reason });
  const allow = (ruleId, reason) => ({ decision: 'allow', ruleId, reason });
  if (!tool) return deny('unknown-tool', `Guard does not know the tool ${request.tool}.`);
  if (!request.actor.scopes.includes(tool.scope)) return deny('missing-scope', `The AI client's token lacks ${tool.scope}.`);
  const spoke = request.target.spoke;
  if (!tool.spokes.includes(spoke)) return deny('wrong-spoke', `${request.tool} runs only on ${tool.spokes.join(' or ')}.`);
  const args = request.arguments;
  const roots = (config.roots && config.roots[spoke]) || [];
  const caseless = spoke === 'pc';
  const pathOk = (p) => insideRoots(p, roots, { caseless });
  const secret = (p) => SECRET_PATH.some((re) => re.test(normalizePath(p)));

  switch (request.tool) {
    case 'hands.list_files':
    case 'hands.read_file':
      if (!roots.length) return deny('no-roots', `No workspace roots are configured for the ${spoke}.`);
      if (!pathOk(args.path)) return deny('outside-roots', 'That path is outside the workspace roots.');
      if (request.tool === 'hands.read_file' && secret(args.path)) return deny('secret-path', 'That file holds secrets.');
      return allow('read-in-roots', 'Read inside the workspace roots.');
    case 'hands.ollama_generate':
      return allow('local-model', 'Local model on the PC.');
    case 'hands.run_powershell': {
      if (typeof args.commandId !== 'string' || !COMMAND_ID.test(args.commandId)) return deny('free-text-command', 'Only allow-listed command ids run, never free text.');
      if (!(config.commands || []).includes(args.commandId)) return deny('command-not-allowed', `${args.commandId} is not on the command allow-list.`);
      const a = args.args ?? {};
      const flat = a && typeof a === 'object' && !Array.isArray(a)
        && Object.values(a).every((v) => ['number', 'boolean'].includes(typeof v) || (typeof v === 'string' && v.length <= 300 && !/[\r\n`;|&<>$]/.test(v)));
      if (!flat) return deny('unsafe-args', 'Command arguments must be short plain values.');
      return ask('powershell-needs-approval', `Run the allow-listed command ${args.commandId} on the PC.`);
    }
    case 'hands.open_url': {
      let url;
      try { url = new URL(String(args.url)); } catch { return deny('bad-url', 'Not a URL.'); }
      if (url.protocol !== 'https:' || url.username || url.password) return deny('bad-url', 'Only plain https:// URLs open.');
      if ((config.allowHosts || []).includes(url.hostname.toLowerCase())) return allow('allowed-host', `${url.hostname} is on the allow-list.`);
      return ask('url-needs-approval', `Open ${url.origin} on the PC browser.`);
    }
    case 'hands.write_file':
      if (!roots.length) return deny('no-roots', `No workspace roots are configured for the ${spoke}.`);
      if (!pathOk(args.path)) return deny('outside-roots', 'That path is outside the workspace roots.');
      if (secret(args.path)) return deny('secret-path', 'That file holds secrets.');
      return ask('write-needs-approval', `Write ${String(args.path).slice(0, 200)}.`);
    default:
      return deny('unknown-tool', 'Unknown tool.');
  }
}

// What an approver sees. File contents are not copied into approvals or the audit.
function summarizeArguments(tool, args) {
  if (tool === 'hands.write_file' && typeof args.content === 'string') {
    return { ...args, content: { bytes: Buffer.byteLength(args.content), sha256: createHash('sha256').update(args.content).digest('hex') } };
  }
  if (tool === 'hands.ollama_generate' && typeof args.prompt === 'string') {
    return { ...args, prompt: { chars: args.prompt.length } };
  }
  return args;
}

function cleanContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return {};
  const text = JSON.stringify(context);
  return text.length <= 2000 ? JSON.parse(text) : { truncated: true };
}

function validateRequest(body, nowSeconds) {
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.requestId !== 'string' || !REQUEST_ID.test(b.requestId)) throw new HandsError(400, 'invalid-request-id', 'requestId must be 8-128 url-safe characters');
  const actor = b.actor && typeof b.actor === 'object' ? b.actor : null;
  if (!actor || typeof actor.kind !== 'string' || !Array.isArray(actor.scopes)) throw new HandsError(400, 'invalid-actor', 'actor needs kind and scopes');
  if (typeof b.tool !== 'string' || b.tool.length > 80) throw new HandsError(400, 'invalid-tool');
  const target = b.target && typeof b.target === 'object' ? b.target : null;
  if (!target || !['pc', 'runner'].includes(target.spoke)) throw new HandsError(400, 'invalid-target', 'target.spoke must be pc or runner');
  if (!b.arguments || typeof b.arguments !== 'object' || Array.isArray(b.arguments)) throw new HandsError(400, 'invalid-arguments');
  if (typeof b.argumentsDigest !== 'string' || !DIGEST.test(b.argumentsDigest)) throw new HandsError(400, 'invalid-arguments-digest', 'argumentsDigest must be sha256:<64 hex>');
  if (argumentsDigest(b.arguments) !== b.argumentsDigest) throw new HandsError(400, 'arguments-digest-mismatch', 'argumentsDigest does not match the canonical JSON of arguments');
  const at = Date.parse(String(b.requestedAt || ''));
  if (Number.isNaN(at)) throw new HandsError(400, 'invalid-requested-at');
  if (Math.abs(at / 1000 - nowSeconds) > REQUEST_SKEW_SECONDS) throw new HandsError(400, 'stale-request', 'requestedAt is more than 5 minutes from Guard\'s clock');
  return {
    requestId: b.requestId,
    actor: {
      kind: actor.kind.slice(0, 40),
      clientId: String(actor.clientId ?? '').slice(0, 200),
      subject: String(actor.subject ?? '').slice(0, 200),
      scopes: actor.scopes.map(String).slice(0, 16),
    },
    tool: b.tool,
    target: { spoke: target.spoke, deviceId: String(target.deviceId ?? '').slice(0, 120) },
    arguments: b.arguments,
    argumentsDigest: b.argumentsDigest,
    context: cleanContext(b.context),
    requestedAt: new Date(at).toISOString(),
  };
}

export function createHandsApi({ key, audit, approvals, findService, config = {}, now = Date.now }) {
  const nowSeconds = () => Math.floor(now() / 1000);
  const requests = new Map(); // requestId -> { serviceId, argumentsDigest, body, at }
  const decisions = new Map(); // decisionId -> { requestId, argumentsDigest, decision, serviceId, executed }

  function prune() {
    const t = nowSeconds();
    for (const [id, r] of requests) if (t - r.at > IDEMPOTENCY_SECONDS) requests.delete(id);
  }

  function record(decisionId, request, decision, serviceId) {
    decisions.set(decisionId, { requestId: request.requestId, argumentsDigest: request.argumentsDigest, decision, serviceId, executed: false });
  }

  function decideBody(request, serviceId) {
    const result = evaluateHands(request, config);
    const decisionId = newId('gdec');
    const t = nowSeconds();
    const readOnly = HANDS_TOOLS[request.tool]?.scope !== 'hands.act';
    const constraints = { ...DEFAULT_CONSTRAINTS, readOnly };
    const base = { decisionId, requestId: request.requestId, argumentsDigest: request.argumentsDigest };
    let expiresAt;
    let approval;
    if (result.decision === 'pending_approval') {
      const approvalId = newId('gapr');
      const exp = t + HANDS_APPROVAL_TTL_SECONDS;
      approvals.set(approvalId, {
        id: approvalId,
        profile: 'hands',
        status: 'pending',
        createdAt: t,
        expiresAt: exp,
        deviceId: `service:${serviceId}`,
        actionHash: request.argumentsDigest,
        requestId: request.requestId,
        argumentsDigest: request.argumentsDigest,
        tool: request.tool,
        target: request.target,
        actor: request.actor,
        arguments: summarizeArguments(request.tool, request.arguments),
        context: request.context,
        constraints,
        ruleId: result.ruleId,
        reason: result.reason,
      });
      expiresAt = iso(exp);
      approval = { approvalId, expiresAt, channel: 'app' };
      audit.append({ event: 'hands.approval.requested', approvalId, decisionId, serviceId, requestId: request.requestId, tool: request.tool, spoke: request.target.spoke, argumentsDigest: request.argumentsDigest, ruleId: result.ruleId });
    } else {
      expiresAt = iso(t + HANDS_DECISION_TTL_SECONDS);
      audit.append({ event: 'hands.decision.issued', decisionId, serviceId, requestId: request.requestId, tool: request.tool, spoke: request.target.spoke, argumentsDigest: request.argumentsDigest, decision: result.decision, ruleId: result.ruleId });
    }
    record(decisionId, request, result.decision, serviceId);
    return {
      decision: result.decision,
      ...base,
      reason: result.reason,
      ...(approval ? { approval } : {}),
      constraints,
      expiresAt,
      keyId: key.keyId,
      signature: signHands(key, { ...base, decision: result.decision, expiresAt }),
    };
  }

  function decide(body, serviceId) {
    prune();
    const request = validateRequest(body, nowSeconds());
    const seen = requests.get(request.requestId);
    if (seen) {
      // requestId is the idempotency key: the same call gets the same answer.
      if (seen.serviceId !== serviceId || seen.argumentsDigest !== request.argumentsDigest) throw new HandsError(409, 'request-id-reused', 'that requestId was already used for different arguments');
      return seen.body;
    }
    const out = decideBody(request, serviceId);
    requests.set(request.requestId, { serviceId, argumentsDigest: request.argumentsDigest, body: out, at: nowSeconds() });
    return out;
  }

  function expire(approval) {
    if (approval.status === 'pending' && approval.expiresAt <= nowSeconds()) {
      approval.status = 'expired';
      audit.append({ event: 'approval.expired', approvalId: approval.id, actionHash: approval.actionHash, deviceId: approval.deviceId });
    }
  }

  function approvalView(approval, serviceId) {
    const view = {
      approvalId: approval.id,
      requestId: approval.requestId,
      argumentsDigest: approval.argumentsDigest,
      state: approval.status,
      decidedBy: approval.decidedBy || null,
      decidedAt: approval.decidedAt ? iso(approval.decidedAt) : null,
      expiresAt: iso(approval.expiresAt),
      keyId: key.keyId,
      signature: null,
    };
    if (approval.status === 'approved' || approval.status === 'denied') {
      // One decision per approval, made once: re-polling returns the same
      // decisionId, so the spoke can enforce single use (PR #52 §5.4 rule 3).
      if (!approval.handsDecision) {
        const decision = approval.status === 'approved' ? 'allow' : 'deny';
        const decisionId = newId('gdec');
        const expiresAt = iso((approval.decidedAt || nowSeconds()) + HANDS_DECISION_TTL_SECONDS);
        approval.handsDecision = { decisionId, decision, expiresAt };
        decisions.set(decisionId, { requestId: approval.requestId, argumentsDigest: approval.argumentsDigest, decision, serviceId, executed: false, approvalId: approval.id });
        audit.append({ event: 'hands.decision.issued', decisionId, approvalId: approval.id, serviceId, requestId: approval.requestId, argumentsDigest: approval.argumentsDigest, decision, decidedBy: approval.decidedBy });
      }
      const d = approval.handsDecision;
      Object.assign(view, d, {
        constraints: approval.constraints,
        signature: signHands(key, { decisionId: d.decisionId, requestId: approval.requestId, argumentsDigest: approval.argumentsDigest, decision: d.decision, expiresAt: d.expiresAt }),
      });
    }
    return view;
  }

  async function approvalStatus(id, serviceId, waitMs) {
    const approval = approvals.get(id);
    if (!approval || approval.profile !== 'hands' || approval.deviceId !== `service:${serviceId}`) throw new HandsError(404, 'not-found');
    const deadline = Date.now() + Math.min(Math.max(Number(waitMs) || 0, 0), MAX_WAIT_MS);
    expire(approval);
    while (approval.status === 'pending' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      expire(approval);
    }
    return approvalView(approval, serviceId);
  }

  const OUTCOMES = ['executed', 'failed', 'refused_by_spoke'];
  function appendAudit(body, serviceId) {
    const b = body && typeof body === 'object' ? body : {};
    const d = decisions.get(String(b.decisionId || ''));
    if (!d || d.serviceId !== serviceId) throw new HandsError(404, 'unknown-decision');
    if (b.requestId !== d.requestId) throw new HandsError(400, 'request-id-mismatch');
    if (!OUTCOMES.includes(b.outcome)) throw new HandsError(400, 'invalid-outcome', `outcome must be ${OUTCOMES.join('|')}`);
    if (!['pc', 'runner'].includes(b.spoke)) throw new HandsError(400, 'invalid-spoke');
    for (const f of ['startedAt', 'finishedAt']) if (b[f] !== undefined && Number.isNaN(Date.parse(String(b[f])))) throw new HandsError(400, `invalid-${f}`);
    if (b.outputDigest !== undefined && b.outputDigest !== null && !DIGEST.test(String(b.outputDigest))) throw new HandsError(400, 'invalid-output-digest');
    const entry = {
      event: `hands.${b.outcome}`, decisionId: b.decisionId, requestId: d.requestId, serviceId, spoke: b.spoke,
      decision: d.decision, argumentsDigest: d.argumentsDigest,
      startedAt: b.startedAt ?? null, finishedAt: b.finishedAt ?? null, outputDigest: b.outputDigest ?? null,
      ...(b.error ? { error: String(b.error).slice(0, 500) } : {}),
    };
    if (b.outcome === 'executed' || b.outcome === 'failed') {
      if (d.decision !== 'allow') {
        audit.append({ ...entry, event: 'hands.violation', note: `reported ${b.outcome} on a ${d.decision} decision` });
        throw new HandsError(409, 'not-allowed', `decision ${b.decisionId} was ${d.decision}`);
      }
      if (d.executed) {
        audit.append({ ...entry, event: 'hands.violation', note: 'second execution of a single-use decision' });
        throw new HandsError(409, 'already-executed');
      }
      d.executed = true;
    }
    const written = audit.append(entry);
    return { seq: written.seq, hash: written.hash };
  }

  return {
    decisions,
    requests,
    async handle({ req, path, url, token, readJson, send }) {
      if (!path.startsWith('/guard/v1/')) return false;
      try {
        if (req.method === 'GET' && path === '/guard/v1/keys') {
          send(200, { keyId: key.keyId, alg: 'Ed25519', publicKeyJwk: key.publicJwk, signatureFormat: 'ed25519:<base64url>', signedFields: ['decisionId', 'requestId', 'argumentsDigest', 'decision', 'expiresAt'], joiner: '\n' });
          return true;
        }
        const serviceId = findService(token);
        if (!serviceId) throw new HandsError(401, 'unauthorized');
        if (req.method === 'POST' && path === '/guard/v1/decide') { send(200, decide(await readJson(req), serviceId)); return true; }
        const m = /^\/guard\/v1\/approvals\/([^/]+)$/.exec(path);
        if (req.method === 'GET' && m) { send(200, await approvalStatus(decodeURIComponent(m[1]), serviceId, url.searchParams.get('waitMs'))); return true; }
        if (req.method === 'POST' && path === '/guard/v1/audit') { send(201, appendAudit(await readJson(req), serviceId)); return true; }
        throw new HandsError(404, 'not-found');
      } catch (error) {
        if (error instanceof HandsError) { send(error.status, { error: error.code, message: error.message }); return true; }
        throw error;
      }
    },
  };
}
