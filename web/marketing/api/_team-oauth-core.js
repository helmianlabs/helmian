import crypto from 'node:crypto';

const REQUEST_ID = /^team_[A-Za-z0-9_-]{20,80}$/;
const PROOF = /^[A-Za-z0-9_-]{43}$/;

export function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function hashProof(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('base64url');
}

export function safeEqualHash(actual, expected) {
  const left = Buffer.from(String(actual));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function validateRequestId(value) {
  const requestId = String(value ?? '');
  if (!REQUEST_ID.test(requestId)) throw httpError(400, 'invalid_request', 'The handoff request is invalid.');
  return requestId;
}

export function validateProof(value) {
  const proof = String(value ?? '');
  if (!PROOF.test(proof)) throw httpError(400, 'invalid_request', 'The handoff proof is invalid.');
  return proof;
}

export function parseProviderState(value) {
  const state = String(value ?? '');
  const separator = state.indexOf('.');
  if (separator <= 0 || separator !== state.lastIndexOf('.')) {
    throw httpError(400, 'invalid_callback', 'The authorization callback is invalid or expired.');
  }
  const requestId = validateRequestId(state.slice(0, separator));
  const secret = state.slice(separator + 1);
  if (!PROOF.test(secret)) throw httpError(400, 'invalid_callback', 'The authorization callback is invalid or expired.');
  return { requestId, state };
}

export function requireServiceAuthorization(request, environment = process.env) {
  const expected = String(environment.HELMION_TEAM_OAUTH_HANDOFF_TOKEN_HASH ?? '');
  if (!PROOF.test(expected)) {
    throw httpError(503, 'handoff_not_configured', 'The hosted handoff service is not configured.');
  }
  const header = String(request.headers?.authorization ?? request.headers?.Authorization ?? '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token.length < 32 || token.length > 256 || !safeEqualHash(hashProof(token), expected)) {
    throw httpError(401, 'handoff_denied', 'The hosted handoff request was denied.');
  }
}

export async function readJson(request) {
  if (request.body && typeof request.body === 'object' && !Buffer.isBuffer(request.body)) return request.body;
  let text = '';
  for await (const chunk of request) {
    text += chunk.toString('utf8');
    if (text.length > 16_384) throw httpError(413, 'request_too_large', 'The handoff request is too large.');
  }
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw httpError(400, 'invalid_json', 'The handoff request is invalid.');
  }
}

export function encryptionKey(environment = process.env) {
  const text = String(environment.HELMION_TEAM_OAUTH_ENCRYPTION_KEY ?? '');
  let key;
  try { key = Buffer.from(text, 'base64url'); } catch { key = Buffer.alloc(0); }
  if (key.length !== 32) throw httpError(503, 'handoff_not_configured', 'The hosted handoff service is not configured.');
  return key;
}

export function encryptAuthorizationCode(code, requestId, key = encryptionKey()) {
  const value = String(code ?? '');
  if (value.length < 1 || value.length > 4096) throw httpError(400, 'invalid_callback', 'The authorization callback is invalid.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(requestId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
}

export function decryptAuthorizationCode(encrypted, requestId, key = encryptionKey()) {
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64url'));
    decipher.setAAD(Buffer.from(requestId, 'utf8'));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw httpError(500, 'handoff_corrupt', 'The one-time handoff could not be decrypted.');
  }
}

export function sendJson(response, status, body, extraHeaders = {}) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store, max-age=0');
  response.setHeader('referrer-policy', 'no-referrer');
  for (const [name, value] of Object.entries(extraHeaders)) response.setHeader(name, value);
  response.end(JSON.stringify(body));
}

export function sendCallbackPage(response, status, connected, provider = 'Slack') {
  response.statusCode = status;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader('cache-control', 'no-store, max-age=0');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  const message = connected
    ? `${provider} returned to Helmian. Your authorization is waiting for your desktop; you can close this tab.`
    : `Helmian could not accept this ${provider} authorization. You can close this tab and try Connect again.`;
  response.end(`<!doctype html><meta charset="utf-8"><title>Helmian ${provider} connection</title><body style="font-family:system-ui;max-width:42rem;margin:10vh auto;padding:2rem"><h1>Helmian</h1><p>${message}</p></body>`);
}

export function failJson(response, error) {
  const status = Number(error?.status) || 500;
  sendJson(response, status, {
    error: status >= 500 ? 'handoff_unavailable' : String(error?.code ?? 'handoff_failed'),
    message: status >= 500 ? 'The hosted handoff service is unavailable.' : String(error?.message ?? 'The handoff failed.'),
  });
}
