import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const DEVICE_COOKIE = 'helmian_herald_device';
export const DEVICE_SCOPES = Object.freeze(['status:read', 'session:read', 'session:instruct', 'approval:decide']);
export const MAX_INSTRUCTION_LENGTH = 2800;
export const MAX_BODY_BYTES = 16 * 1024;

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const NONCE = /^[A-Za-z0-9._:-]{16,160}$/;

export function requiredSecret(name) {
  const value = String(process.env[name] ?? '').trim();
  if (value.length < 32) throw new Error(`${name} is not configured`);
  return value;
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function randomChannel() {
  return `herald_${randomBytes(18).toString('base64url')}`;
}

export function randomPairingCode() {
  return String(randomBytes(4).readUInt32BE() % 100_000_000).padStart(8, '0');
}

export function hashSecret(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('base64url');
}

export function hashPairingCode(channel, code, pepper) {
  return createHmac('sha256', pepper).update(`${channel}\n${code}`, 'utf8').digest('base64url');
}

export function safeEqualHash(actualHash, expectedHash) {
  const actual = Buffer.from(String(actualHash));
  const expected = Buffer.from(String(expectedHash));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function bearer(request) {
  const match = String(request.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

export function parseCookies(request) {
  return Object.fromEntries(String(request.headers.cookie ?? '').split(';').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

export function deviceCookie(channel, deviceId, token, maxAgeSeconds) {
  const value = encodeURIComponent(`${channel}.${deviceId}.${token}`);
  return `${DEVICE_COOKIE}=${value}; Path=/api/herald; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function clearDeviceCookie() {
  return `${DEVICE_COOKIE}=; Path=/api/herald; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function parseDeviceCookie(request) {
  const value = parseCookies(request)[DEVICE_COOKIE] ?? '';
  const match = value.match(/^(herald_[A-Za-z0-9_-]{20,80})\.([A-Za-z0-9_-]{12,128})\.([A-Za-z0-9_-]{32,128})$/);
  return match ? { channel: match[1], deviceId: match[2], token: match[3] } : null;
}

export function validId(value) {
  return ID.test(String(value ?? ''));
}

export function validateNonce(value) {
  const nonce = String(value ?? '');
  if (!NONCE.test(nonce)) throw httpError(400, 'invalid_nonce', 'A fresh request nonce is required.');
  return nonce;
}

export function validatePhoneAction(body, authenticatedDeviceId) {
  const action = String(body?.action ?? '');
  const requestId = validId(body?.requestId) ? body.requestId : randomUUID();
  const base = { v: 1, product: 'helmian-herald', kind: 'request', requestId, deviceId: authenticatedDeviceId, action };
  if (action === 'session.read') return { ...base, payload: {} };
  if (action === 'instruction.submit') {
    const text = String(body?.payload?.text ?? '').trim();
    if (body?.payload?.confirmed !== true || !validId(body?.payload?.projectId)
      || !validId(body?.payload?.sessionId) || text.length < 1 || text.length > MAX_INSTRUCTION_LENGTH) {
      throw httpError(400, 'invalid_instruction', 'Review and explicitly confirm a selected-session instruction.');
    }
    return { ...base, payload: { projectId: body.payload.projectId, sessionId: body.payload.sessionId, text, confirmed: true } };
  }
  if (action === 'approval.decide') {
    if (body?.payload?.confirmed !== true || !validId(body?.payload?.projectId)
      || !validId(body?.payload?.sessionId) || !validId(body?.payload?.approvalId)
      || !['allow-once', 'deny'].includes(body?.payload?.decision)) {
      throw httpError(400, 'invalid_decision', 'Review and confirm Allow once or Deny.');
    }
    return { ...base, payload: {
      projectId: body.payload.projectId, sessionId: body.payload.sessionId,
      approvalId: body.payload.approvalId, decision: body.payload.decision, confirmed: true,
    } };
  }
  throw httpError(404, 'action_not_available', 'That action is not available from Herald.');
}

export function validateDesktopResult(body) {
  if (body?.v !== 1 || body?.product !== 'helmian-herald' || body?.kind !== 'result'
    || !validId(body?.requestId) || !['ok', 'refused', 'error'].includes(body?.state)) {
    throw httpError(400, 'invalid_result', 'Desktop result envelope is invalid.');
  }
  const encoded = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (encoded > MAX_BODY_BYTES) throw httpError(413, 'result_too_large', 'Desktop result is too large.');
  return { v: 1, product: 'helmian-herald', kind: 'result', requestId: body.requestId, state: body.state, payload: body.payload ?? null };
}

export function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export function sendJson(response, status, body, headers = {}) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
  response.end(JSON.stringify(body));
}

export async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'body_too_large', 'Request body is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw httpError(400, 'invalid_json', 'Request body must be valid JSON.'); }
}

export function fail(response, error) {
  const status = Number(error?.status) || 500;
  sendJson(response, status, { error: error?.code ?? 'herald_unavailable', message: status >= 500 ? 'Herald relay is unavailable.' : error.message });
}
