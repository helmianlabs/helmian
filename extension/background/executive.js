// The extension's side of the Executive Guard verification loop.
// OPT-IN and OFF BY DEFAULT, like background/upload.js: nothing here touches the
// network until the user enters a server URL and device token in the popup,
// grants the host permission, and pairs (which pins the server's signing key).
//
//   content script --helmion:decide--> worker --POST /v1/decisions--> server
//   worker verifies the Ed25519 decision against the PINNED key, the action
//   hash and the nonce it sent, then answers the content script.
//   'ask' -> worker polls GET /v1/approvals/:id until approved/denied/expired.
//
// Without a configured, paired server every decision comes from
// background/local-policy.js and is labelled source:'local', verified:false.
// A server that answers with a decision that does not verify is treated as a
// DENY, never as an allow: a forged allow is the one thing this must not take.

import { evaluateLocal } from './local-policy.js';
import { actionHash, randomNonce, verifyDecisionEnvelope } from './verify.js';

export const EXECUTIVE_SETTINGS_KEY = 'helmion.executive.settings';
const REQUEST_TIMEOUT_MS = 4000; // under the content script's 5 s worker timeout

export function isAllowedServerUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

function baseUrl(serverUrl) {
  return String(serverUrl).replace(/\/+$/, '');
}

export function originPattern(serverUrl) {
  const url = new URL(serverUrl);
  return `${url.protocol}//${url.hostname}/*`;
}

async function readSettings(storage) {
  const value = await storage.get(EXECUTIVE_SETTINGS_KEY);
  return value && typeof value === 'object' ? value : {};
}

export async function getExecutiveSettings(storage) {
  const s = await readSettings(storage);
  return {
    enabled: s.enabled === true,
    serverUrl: s.serverUrl || '',
    hasToken: Boolean(s.deviceToken),
    paired: Boolean(s.pinned && s.pinned.keyId),
    keyId: s.pinned ? s.pinned.keyId : null,
  };
}

export async function setExecutiveSettings(storage, { enabled, serverUrl, deviceToken } = {}) {
  const current = await readSettings(storage);
  const next = { ...current };
  if (typeof serverUrl === 'string') {
    const trimmed = serverUrl.trim();
    if (trimmed && !isAllowedServerUrl(trimmed)) {
      throw new Error('server URL must be https://, or http://localhost / http://127.0.0.1 for a local server');
    }
    if (baseUrl(trimmed) !== baseUrl(current.serverUrl || '')) delete next.pinned; // new server, new pin
    next.serverUrl = baseUrl(trimmed);
  }
  if (typeof deviceToken === 'string') next.deviceToken = deviceToken.trim();
  if (typeof enabled === 'boolean') next.enabled = enabled;
  await storage.set(EXECUTIVE_SETTINGS_KEY, next);
  return getExecutiveSettings(storage);
}

async function request(fetchImpl, url, init = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
  try {
    const response = await fetchImpl(url, { ...init, signal: controller ? controller.signal : undefined, credentials: 'omit', cache: 'no-store' });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    return { status: response.status, ok: response.ok, body };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Fetches /v1/keys and pins the key. The popup shows the key id so it can be compared with the server's. */
export async function pairExecutive(storage, { fetchImpl = (...args) => fetch(...args) } = {}) {
  const s = await readSettings(storage);
  if (!s.serverUrl) throw new Error('set a server URL first');
  const res = await request(fetchImpl, `${s.serverUrl}/v1/keys`);
  if (!res.ok || !res.body || res.body.alg !== 'Ed25519' || !res.body.publicKeyJwk || !res.body.keyId) {
    throw new Error(`pairing failed (status ${res.status})`);
  }
  const pinned = { keyId: String(res.body.keyId), publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: String(res.body.publicKeyJwk.x) } };
  await storage.set(EXECUTIVE_SETTINGS_KEY, { ...s, pinned });
  return { keyId: pinned.keyId };
}

function local(action, extra = {}) {
  return { ...evaluateLocal(action), source: 'local', verified: false, ...extra };
}

/**
 * Ask for a decision on one action. Always resolves; never throws.
 * Returns { verdict, reason, ruleId, source, verified, approvalId?, pending? }.
 */
export async function requestDecision(storage, action, { fetchImpl = (...args) => fetch(...args), pendingApprovals } = {}) {
  const s = await readSettings(storage);
  if (!s.enabled || !s.serverUrl || !s.deviceToken || !s.pinned) return local(action);

  const nonce = randomNonce();
  let hash;
  try { hash = await actionHash(action); } catch (error) { return local(action, { error: error.message }); }

  let res;
  try {
    res = await request(fetchImpl, `${s.serverUrl}/v1/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${s.deviceToken}` },
      body: JSON.stringify({ action, nonce }),
    });
  } catch (error) {
    return local(action, { serverUnavailable: true, error: error && error.message ? error.message : String(error) });
  }

  if (res.status === 401) return local(action, { serverUnavailable: true, error: 'the server refused the device token' });
  if (!res.body || !res.body.decision) {
    return local(action, { serverUnavailable: true, error: `server answered ${res.status}${res.body && res.body.error ? ` (${res.body.error})` : ''}` });
  }

  const check = await verifyDecisionEnvelope(res.body.decision, s.pinned, { actionHash: hash, nonce });
  if (!check.ok) {
    return { verdict: 'deny', reason: `Executive Guard answered with a decision that did not verify: ${check.error}`, ruleId: 'unverified-decision', source: 'executive-guard', verified: false };
  }
  const out = {
    verdict: check.claims.verdict,
    reason: res.body.reason || '',
    ruleId: check.claims.ruleId,
    decisionId: check.claims.decisionId,
    source: 'executive-guard',
    verified: true,
  };
  if (check.claims.verdict === 'ask' && check.claims.approvalId) {
    out.approvalId = check.claims.approvalId;
    out.pending = true;
    if (pendingApprovals) pendingApprovals.set(out.approvalId, { nonce, actionHash: hash });
  }
  return out;
}

/** Poll one approval. Resolves to { status, verdict?, verified, decidedBy?, reason }. */
export async function pollApproval(storage, approvalId, { fetchImpl = (...args) => fetch(...args), pendingApprovals } = {}) {
  const s = await readSettings(storage);
  const expect = pendingApprovals ? pendingApprovals.get(approvalId) : null;
  if (!expect) return { status: 'unknown', verified: false, reason: 'this approval was not requested by this browser session' };
  if (!s.serverUrl || !s.deviceToken || !s.pinned) return { status: 'unknown', verified: false, reason: 'Executive Guard is not configured' };
  let res;
  try {
    res = await request(fetchImpl, `${s.serverUrl}/v1/approvals/${encodeURIComponent(approvalId)}`, {
      headers: { authorization: `Bearer ${s.deviceToken}` },
    });
  } catch (error) {
    return { status: 'unreachable', verified: false, reason: error && error.message ? error.message : String(error) };
  }
  if (!res.ok || !res.body) return { status: 'unreachable', verified: false, reason: `server answered ${res.status}` };
  const { status } = res.body;
  if (status === 'pending' || status === 'expired') {
    if (status === 'expired') pendingApprovals.delete(approvalId);
    return { status, verified: false, reason: res.body.reason || '' };
  }
  const check = await verifyDecisionEnvelope(res.body.decision, s.pinned, expect);
  if (!check.ok || check.claims.approvalId !== approvalId) {
    return { status: 'denied', verdict: 'deny', verified: false, reason: `the approval did not verify: ${check.ok ? 'wrong approval id' : check.error}` };
  }
  pendingApprovals.delete(approvalId);
  return { status, verdict: check.claims.verdict, verified: true, decidedBy: check.claims.decidedBy || null, reason: res.body.reason || '' };
}
