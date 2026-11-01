// Credential service — the Hetzner-side custody service (cloud-connect
// design §5.1/§5.3, build bite 1). A small service beside the Executive
// Guard whose only jobs are store, resolve, revoke, shred, and master-key
// rewrap for the generalized vault (credential-vault.mjs). It is the ONLY
// process that holds the vault master key: the cloud app asks it over the
// internal network with a service token and never holds the key itself.
//
// STAGED, NOT DEPLOYED by this bite: bin/helmion-credential-service.mjs is
// the entrypoint; the fire steps live in the bite report.
//
// Rules enforced here:
//   - No service token, no answer (the cloud app's identity is the token;
//     an absent or wrong one is a 401 before any vault code runs).
//   - Every vault call still requires the full actor context and a reason
//     class — the service token identifies the CALLER, never the actor.
//   - The audit sink is this service's own append-only, hash-chained JSONL
//     (the Guard's pattern). Events carry lifecycle facts and reason
//     classes only; no secret material ever reaches a line — the tests grep
//     the produced lines for the test secrets. Caveat, named: the sink
//     appends when the vault emits, inside the vault's transaction; a
//     commit failure after an emit could leave one orphan line. The DB
//     adapter path (appendAuditEvent inside the transaction) does not
//     have that caveat.
//   - Password resolves and credential replacements are Guard-gated
//     (credential-vault.mjs enforces; the gate client below speaks the
//     Guard's decision protocol). No gate configured -> those operations
//     are refused by the vault, not waved through.

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import { createCredentialVault } from './credential-vault.mjs';

const MAX_BODY_CHARS = 128 * 1024;
const ZERO_HASH = '0'.repeat(64);

function chainHash(prevHash, line) {
  return createHash('sha256').update(`${prevHash}\n${line}`, 'utf8').digest('hex');
}

export function createCredentialServiceAuditLog({ path } = {}) {
  if (!path) throw new TypeError('credential service audit log requires a path');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let seq = 0;
  let prevHash = ZERO_HASH;
  if (existsSync(path)) {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    if (lines.length) {
      const last = JSON.parse(lines[lines.length - 1]);
      seq = Number(last.seq) || lines.length;
      prevHash = String(last.hash || ZERO_HASH);
    }
  }
  function append(event) {
    seq += 1;
    const body = { seq, at: new Date().toISOString(), event };
    const hash = chainHash(prevHash, JSON.stringify(body));
    appendFileSync(path, `${JSON.stringify({ ...body, prevHash, hash })}\n`, { mode: 0o600 });
    prevHash = hash;
    return hash;
  }
  return Object.freeze({
    path,
    append,
    // Vault auditSink signature: (client, context, event). The client is
    // the vault's transaction handle; this service's store of record is
    // the file, so it is deliberately unused.
    sink: async (_client, _context, event) => { append(event); },
  });
}

export function createMemoryAuditLog() {
  const events = [];
  return Object.freeze({
    events,
    sink: async (_client, _context, event) => { events.push(event); },
  });
}

// Guard approval gate: submits the gated credential action to the
// Executive Guard as a decision request and, when the Guard asks, waits
// for the human decision on the approval. Fail-closed throughout: deny,
// expiry, timeout, or an unreachable Guard all mean NOT approved.
export function createGuardApprovalGate({ guardUrl, deviceToken, fetchImpl = globalThis.fetch, pollIntervalMs = 2000, timeoutMs = 15 * 60 * 1000, now = Date.now } = {}) {
  if (!guardUrl || !deviceToken) throw new TypeError('guard gate requires guardUrl and deviceToken');
  const base = String(guardUrl).replace(/\/$/, '');
  const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
  return async function guardGate({ action, tenantId, actorSubject, providerId, credentialKind, credentialReference }) {
    const summary = action === 'credential.password_resolve'
      ? `Helmian sign-in needs the stored password for ${providerId} (tenant ${tenantId}, asked by ${actorSubject}).`
      : `Replace the stored ${credentialKind ?? 'credential'} for ${providerId} (tenant ${tenantId}, asked by ${actorSubject}).`;
    const riskSignals = [action === 'credential.password_resolve' ? 'credential:password_resolve' : 'credential:replace'];
    const body = {
      nonce: `credsvc-${sha256(`${action}:${credentialReference}:${now()}`).slice(0, 40)}`,
      action: { kind: 'agent.tool', site: 'helmian-credential-service', contentHash: sha256(summary + riskSignals.join(',')), riskSignals, summary },
    };
    const decided = await fetchImpl(`${base}/v1/decisions`, { method: 'POST', headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const decision = await decided.json().catch(() => ({}));
    if (decided.status === 200) return { approved: decision.verdict === 'allow' };
    if (decided.status !== 202 || !decision.approvalId) return { approved: false };
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const poll = await fetchImpl(`${base}/v1/approvals/${decision.approvalId}`, { headers: { authorization: `Bearer ${deviceToken}` } });
      if (!poll.ok) continue;
      const state = await poll.json().catch(() => ({}));
      if (state.status === 'approved') return { approved: true };
      if (state.status === 'denied' || state.status === 'expired') return { approved: false };
    }
    return { approved: false };
  };
}

function tokenMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

const ROUTES = Object.freeze({
  'POST /v1/credentials/store': 'storeCredential',
  'POST /v1/credentials/resolve': 'resolveCredential',
  'POST /v1/credentials/revoke': 'revokeCredential',
  'POST /v1/credentials/shred-tenant': 'shredTenant',
});

function refusalFor(result) {
  if (result?.accepted) return 200;
  if (typeof result?.status === 'string' && result.status.startsWith('guard_')) return 403;
  if (result?.status === 'credential_not_available') return 404;
  if (result?.status === 'tenant_vault_shredded') return 410;
  return 200;
}

function errorShape(error) {
  const message = String(error?.message ?? '');
  if (message.includes('actor context')) return { status: 400, body: { status: 'actor_context_required', accepted: false, secretMaterial: 'not_returned', providerInvocation: 'not_performed' } };
  if (message.includes('reason class')) return { status: 400, body: { status: 'reason_class_required', accepted: false, secretMaterial: 'not_returned', providerInvocation: 'not_performed' } };
  if (message.includes('reference is invalid')) return { status: 400, body: { status: 'reference_invalid', accepted: false, secretMaterial: 'not_returned', providerInvocation: 'not_performed' } };
  if (message.includes('could not be decrypted')) return { status: 422, body: { status: 'credential_undecryptable', accepted: false, secretMaterial: 'not_returned', providerInvocation: 'not_performed' } };
  return { status: 400, body: { status: 'credential_request_invalid', accepted: false, secretMaterial: 'not_returned', providerInvocation: 'not_performed' } };
}

export function createCredentialService({ vault, serviceToken, auditLog = null } = {}) {
  if (!vault || typeof vault.storeCredential !== 'function' || typeof vault.resolveCredential !== 'function') throw new TypeError('credential service requires a credential vault');
  if (!serviceToken) throw new TypeError('credential service requires a service token');
  async function handle({ method, path, headers = {}, body = '' } = {}) {
    if (method === 'GET' && path === '/healthz') return { status: 200, body: { ok: true, service: 'helmian-credential-service' } };
    const route = ROUTES[`${method} ${path}`];
    const isRewrap = method === 'POST' && path === '/v1/admin/rewrap-tenant-keys';
    if (!route && !isRewrap) return { status: 404, body: { status: 'not_found', accepted: false } };
    const authorization = String(headers.authorization ?? headers.Authorization ?? '');
    if (!tokenMatches(authorization.replace(/^Bearer\s+/i, ''), serviceToken)) {
      auditLog?.append?.({ action: 'credential.service_refused', reasonClass: 'unauthorized', route: `${method} ${path}`, secretMaterial: 'not_received' });
      return { status: 401, body: { status: 'service_unauthorized', accepted: false, secretMaterial: 'not_returned', providerInvocation: 'not_performed' } };
    }
    if (typeof body === 'string' && body.length > MAX_BODY_CHARS) return { status: 413, body: { status: 'request_too_large', accepted: false } };
    let input;
    try { input = typeof body === 'string' ? JSON.parse(body || '{}') : body; } catch { return { status: 400, body: { status: 'request_not_json', accepted: false } }; }
    try {
      if (isRewrap) {
        const result = await vault.rewrapTenantKeys({ nextMasterKey: input?.nextMasterKey });
        auditLog?.append?.({ action: 'credential.master_rewrapped', rewrapped: result.rewrapped, secretMaterial: 'not_received' });
        return { status: 200, body: result };
      }
      const result = await vault[route](input ?? {});
      return { status: refusalFor(result), body: result };
    } catch (error) {
      const shaped = errorShape(error);
      auditLog?.append?.({ action: 'credential.service_refused', reasonClass: shaped.body.status, route: `${method} ${path}`, secretMaterial: 'not_received' });
      return shaped;
    }
  }
  return Object.freeze({ handle });
}

// Production assembly: vault + chained audit log + optional Guard gate,
// all from explicit parts (the bin entrypoint supplies env-derived parts).
export function createCredentialServiceFromParts({ pool, masterKey, serviceToken, auditLog, guardGate = null } = {}) {
  if (!auditLog) throw new TypeError('credential service requires an audit log');
  const vault = createCredentialVault({ pool, masterKey, auditSink: auditLog.sink, guardGate });
  return createCredentialService({ vault, serviceToken, auditLog });
}
