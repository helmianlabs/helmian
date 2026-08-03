import { createHmac } from 'node:crypto';
import {
  httpError, parseCookies, randomToken, validId,
} from './_herald-core.js';

export const CONTROL_COOKIE = 'helmian_herald_control';
export const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
export const DESKTOP_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_PRESENCE_TTL_MS = 90 * 1000;
export const SESSION_STALE_AFTER_MS = 45 * 1000;
export const CONTROL_GRANT_TTL_MS = 15 * 60 * 1000;

const ENROLLMENT_ID = /^enroll_[A-Za-z0-9_-]{20,80}$/;
const PROOF_SECRET = /^[A-Za-z0-9_-]{43,128}$/;
const CONFIRMATION_CODE = /^\d{8}$/;

export function validateEnrollmentRequest(value) {
  const enrollmentId = String(value?.enrollmentId ?? '').trim();
  const proofSecret = String(value?.proofSecret ?? '').trim();
  const confirmationCode = String(value?.confirmationCode ?? '').replace(/\D/g, '');
  const displayName = cleanText(value?.displayName, 60) || 'Helmian Desktop';
  if (!ENROLLMENT_ID.test(enrollmentId) || !PROOF_SECRET.test(proofSecret)
    || !CONFIRMATION_CODE.test(confirmationCode)) {
    throw httpError(400, 'invalid_enrollment_request',
      'Desktop enrollment needs a fresh request ID, proof secret, and 8-digit confirmation code.');
  }
  return Object.freeze({ enrollmentId, proofSecret, confirmationCode, displayName });
}

export function validateEnrollmentRedemption(value) {
  const enrollmentId = String(value?.enrollmentId ?? '').trim();
  const proofSecret = String(value?.proofSecret ?? '').trim();
  if (!ENROLLMENT_ID.test(enrollmentId) || !PROOF_SECRET.test(proofSecret)) {
    throw httpError(400, 'invalid_enrollment_redemption',
      'Desktop enrollment proof is invalid.');
  }
  return Object.freeze({ enrollmentId, proofSecret });
}

export function normalizeConfirmationCode(value) {
  const code = String(value ?? '').replace(/\D/g, '');
  if (!CONFIRMATION_CODE.test(code)) {
    throw httpError(400, 'invalid_enrollment_code', 'Enter the 8-digit Desktop enrollment code.');
  }
  return code;
}

export function hashEnrollmentCode(code, pepper) {
  return createHmac('sha256', String(pepper))
    .update(`helmian-desktop-enrollment\n${normalizeConfirmationCode(code)}`, 'utf8')
    .digest('base64url');
}

export function normalizeDesktopPresence(value) {
  const sessionId = requiredId(value?.sessionId, 'session');
  const projectId = requiredId(value?.project?.id, 'project');
  const projectName = requiredText(value?.project?.name, 120, 'project name');
  const sessionName = requiredText(value?.sessionName, 120, 'session name');
  const sessionState = knownState(value?.state, ['ready', 'working', 'blocked', 'waiting']);
  const agent = value?.agent == null ? null : Object.freeze({
    id: requiredId(value.agent.id, 'agent'),
    name: requiredText(value.agent.name, 80, 'agent name'),
    state: knownState(value.agent.state, ['idle', 'working', 'blocked', 'unavailable']),
  });
  const guard = Object.freeze({
    state: knownState(value?.guard?.state, ['quiet', 'unknown', 'attention', 'blocked']),
    detail: cleanText(value?.guard?.detail, 240),
  });
  return Object.freeze({
    sessionId,
    project: Object.freeze({ id: projectId, name: projectName }),
    sessionName,
    state: sessionState,
    agent,
    guard,
  });
}

export function normalizeSessionReference(value) {
  const desktopId = requiredId(value?.desktopId, 'desktop');
  const sessionId = requiredId(value?.sessionId, 'session');
  return Object.freeze({ desktopId, sessionId });
}

export function controlCookie(grantId, token, maxAgeSeconds) {
  if (!/^control_[A-Za-z0-9_-]{20,80}$/.test(String(grantId ?? ''))
    || !PROOF_SECRET.test(String(token ?? ''))) {
    throw new TypeError('Control grant cookie identity is invalid.');
  }
  const value = encodeURIComponent(`${grantId}.${token}`);
  // Account Remote Control lives at /api/remote/v1.  Scope the cookie to the
  // API root so the selection made in /desktops reaches /control and
  // /control-token; /api/herald would silently omit it.
  return `${CONTROL_COOKIE}=${value}; Path=/api/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function clearControlCookie() {
  return `${CONTROL_COOKIE}=; Path=/api/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function parseControlCookie(request) {
  const value = parseCookies(request)[CONTROL_COOKIE] ?? '';
  const match = value.match(/^(control_[A-Za-z0-9_-]{20,80})\.([A-Za-z0-9_-]{43,128})$/);
  return match ? Object.freeze({ grantId: match[1], token: match[2] }) : null;
}

export function newControlGrantIdentity() {
  return Object.freeze({ grantId: `control_${randomToken(18)}`, token: randomToken() });
}

export function publicDesktopRegistry(rows) {
  const desktops = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const desktopId = validId(row?.desktop_id) ? row.desktop_id : null;
    if (!desktopId) continue;
    let desktop = desktops.get(desktopId);
    if (!desktop) {
      desktop = {
        desktopId,
        displayName: cleanText(row.display_name, 60) || 'Helmian Desktop',
        state: row.desktop_online === true ? 'online' : 'offline',
        lastSeenAt: safeDate(row.desktop_last_seen_at),
        credentialExpiresAt: safeDate(row.credential_expires_at),
        sessions: [],
      };
      desktops.set(desktopId, desktop);
    }
    if (validId(row.session_id)) {
      desktop.sessions.push({
        sessionId: row.session_id,
        name: cleanText(row.session_name, 120) || 'Unnamed session',
        state: cleanText(row.session_state, 24) || 'unknown',
        project: {
          id: validId(row.project_id) ? row.project_id : null,
          name: cleanText(row.project_name, 120) || 'Unknown project',
        },
        agent: validId(row.agent_id) ? {
          id: row.agent_id,
          name: cleanText(row.agent_name, 80) || 'Agent',
          state: cleanText(row.agent_state, 24) || 'unknown',
        } : null,
        guard: {
          state: cleanText(row.guard_state, 24) || 'unknown',
          detail: cleanText(row.guard_detail, 240),
        },
        lastSeenAt: safeDate(row.session_last_seen_at),
      });
    }
  }
  return [...desktops.values()].map((desktop) => Object.freeze({
    ...desktop,
    projectPath: undefined,
    sessions: Object.freeze(desktop.sessions.map((session) => Object.freeze(session))),
  }));
}

function requiredId(value, label) {
  if (!validId(value)) throw httpError(400, 'invalid_presence', `Desktop ${label} identity is invalid.`);
  return String(value);
}

function requiredText(value, maxLength, label) {
  const text = cleanText(value, maxLength);
  if (!text) throw httpError(400, 'invalid_presence', `Desktop ${label} is required.`);
  return text;
}

function knownState(value, allowed) {
  const state = String(value ?? '').trim().toLowerCase();
  if (!allowed.includes(state)) throw httpError(400, 'invalid_presence', 'Desktop state is invalid.');
  return state;
}

function cleanText(value, maxLength) {
  const text = typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  return text ? text.slice(0, maxLength) : null;
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
