import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual, webcrypto } from 'node:crypto';

const OIDC_FETCH_TIMEOUT_MS = 10_000;
const OIDC_MAX_JSON_BYTES = 64 * 1024;
const MAX_IDENTITY_STATE_ENTRIES = 256;
const SESSION_VERSION = 1;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_SECRET_MIN_CHARS = 32;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeJson(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function required(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function requiredHttpsUrl(value, name, { callback = false } = {}) {
  const raw = required(value, name);
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${name} must be an HTTPS URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || (callback && (url.pathname !== '/admin/auth/callback' || url.search))) {
    throw new Error(`${name} must be an HTTPS URL${callback ? ' ending exactly /admin/auth/callback' : ''}`);
  }
  return url.toString().replace(/\/$/u, '');
}

function sessionSecret(env) {
  const configured = String(env.HELMION_ADMIN_SESSION_SECRET ?? '').trim();
  if (configured.length >= SESSION_SECRET_MIN_CHARS) return configured;
  if (String(env.HELMION_CLOUD_ENVIRONMENT ?? '').trim().toLowerCase() === 'production') {
    throw new Error(`HELMION_ADMIN_SESSION_SECRET must be at least ${SESSION_SECRET_MIN_CHARS} characters`);
  }
  return randomBytes(32).toString('base64url');
}

function signSession(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function issueSession(subject, expiresAt, secret) {
  const payload = Buffer.from(JSON.stringify({ v: SESSION_VERSION, sub: subject, exp: expiresAt, jti: randomUUID() })).toString('base64url');
  return `hs${SESSION_VERSION}.${payload}.${signSession(payload, secret)}`;
}

function readSession(token, secret) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3 || parts[0] !== `hs${SESSION_VERSION}`) return null;
  const [, payload, signature] = parts;
  const expected = signSession(payload, secret);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (!signature || actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
  try {
    const claims = decodeJson(payload);
    if (claims.v !== SESSION_VERSION || typeof claims.sub !== 'string' || !claims.sub || typeof claims.jti !== 'string' || !claims.jti
      || !Number.isSafeInteger(Number(claims.exp)) || Number(claims.exp) <= Date.now()) return null;
    return { subject: claims.sub, expiresAt: Number(claims.exp), jti: claims.jti };
  } catch { return null; }
}

async function boundedJson(response, label) {
  const declared = response.headers?.get?.('content-length');
  if (declared && (!Number.isSafeInteger(Number(declared)) || Number(declared) > OIDC_MAX_JSON_BYTES)) {
    await response.body?.cancel?.();
    throw new Error(`${label} response is too large`);
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error(`${label} response is unreadable`);
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > OIDC_MAX_JSON_BYTES) {
      await reader.cancel();
      throw new Error(`${label} response is too large`);
    }
    chunks.push(Buffer.from(value));
  }
  try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')); }
  catch { throw new Error(`${label} response is not JSON`); }
}

async function fetchJson(url, init, fetchImpl, label) {
  const response = await fetchImpl(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(OIDC_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${label} failed`);
  return boundedJson(response, label);
}

async function discover(issuer, fetchImpl) {
  const metadata = await fetchJson(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } }, fetchImpl, 'OIDC discovery');
  return {
    authorizationEndpoint: requiredHttpsUrl(metadata.authorization_endpoint, 'authorization_endpoint'),
    tokenEndpoint: requiredHttpsUrl(metadata.token_endpoint, 'token_endpoint'),
    jwksUri: requiredHttpsUrl(metadata.jwks_uri, 'jwks_uri'),
  };
}

async function verifyJwt(token, { issuer, audience, jwksUri, fetchImpl }) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('OIDC token shape invalid');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson(encodedHeader);
  const claims = decodeJson(encodedPayload);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('OIDC token algorithm invalid');
  const keys = await fetchJson(jwksUri, { headers: { accept: 'application/json' } }, fetchImpl, 'OIDC JWKS lookup');
  const jwk = Array.isArray(keys.keys) ? keys.keys.find((key) => key.kid === header.kid && key.kty === 'RSA') : null;
  if (!jwk) throw new Error('OIDC signing key unavailable');
  const cryptoKey = await webcrypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await webcrypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    cryptoKey,
    Buffer.from(encodedSignature, 'base64url'),
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid || claims.iss !== issuer || (Array.isArray(claims.aud) ? !claims.aud.includes(audience) : claims.aud !== audience)) throw new Error('OIDC token claims invalid');
  if (typeof claims.sub !== 'string' || !claims.sub
    || !Number.isFinite(Number(claims.exp)) || Number(claims.exp) <= Math.floor(Date.now() / 1000)) {
    throw new Error('OIDC token expired or missing subject');
  }
  return claims;
}

export function createIdentityGateway({ env = process.env, fetchImpl = fetch } = {}) {
  const issuer = requiredHttpsUrl(env.HELMION_ADMIN_ISSUER, 'HELMION_ADMIN_ISSUER');
  const clientId = required(env.HELMION_ADMIN_CLIENT_ID, 'HELMION_ADMIN_CLIENT_ID');
  const redirectUri = requiredHttpsUrl(env.HELMION_ADMIN_REDIRECT_URI, 'HELMION_ADMIN_REDIRECT_URI', { callback: true });
  const sessionSigningSecret = sessionSecret(env);
  const revokedSessions = new Map();
  const pending = new Map();
  let metadataPromise = null;
  const metadata = () => metadataPromise ?? (metadataPromise = discover(issuer, fetchImpl));
  const prune = () => {
    const now = Date.now();
    for (const [key, value] of pending) if (value.expiresAt < now) pending.delete(key);
    for (const [key, value] of revokedSessions) if (value < now) revokedSessions.delete(key);
  };

  async function beginLogin() {
    prune();
    if (pending.size >= MAX_IDENTITY_STATE_ENTRIES) throw new Error('OIDC login capacity reached');
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    pending.set(state, { verifier, expiresAt: Date.now() + 10 * 60_000 });
    const endpoints = await metadata();
    const url = new URL(endpoints.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { url: url.toString(), state };
  }

  async function finishLogin(code, state) {
    const attempt = pending.get(state);
    pending.delete(state);
    if (!attempt || attempt.expiresAt < Date.now()) throw new Error('OIDC login state invalid or expired');
    const endpoints = await metadata();
    const tokenBody = await fetchJson(endpoints.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: attempt.verifier }),
    }, fetchImpl, 'OIDC token exchange');
    const claims = await verifyJwt(tokenBody.id_token, { issuer, audience: clientId, jwksUri: endpoints.jwksUri, fetchImpl });
    const tokenExpiry = Number(claims.exp) * 1_000;
    const expiresAt = Math.min(Date.now() + SESSION_TTL_MS, tokenExpiry);
    const sessionId = issueSession(claims.sub, expiresAt, sessionSigningSecret);
    return { sessionId, identity: { subject: claims.sub }, expiresAt };
  }

  function getSession(sessionId) {
    prune();
    const session = readSession(sessionId, sessionSigningSecret);
    if (!session || revokedSessions.has(session.jti)) return null;
    return session;
  }

  return Object.freeze({
    issuer,
    clientId,
    redirectUri,
    beginLogin,
    finishLogin,
    getSession,
    revokeSession: (sessionId) => {
      const session = readSession(sessionId, sessionSigningSecret);
      if (!session) return false;
      revokedSessions.set(session.jti, session.expiresAt);
      return true;
    },
    verifyAccessToken: (token) => metadata().then((endpoints) => verifyJwt(token, { issuer, audience: clientId, jwksUri: endpoints.jwksUri, fetchImpl })),
  });
}
