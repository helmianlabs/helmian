import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, webcrypto } from 'node:crypto';

// Stateless mode for serverless hosts (Vercel): login state and sessions are
// AES-256-GCM sealed with HELMION_ADMIN_SESSION_SECRET instead of held in memory,
// so any function instance can finish a login or read a session.
function sealer(secret) {
  if (!secret) return null;
  if (String(secret).length < 32) throw new Error('HELMION_ADMIN_SESSION_SECRET must be at least 32 characters');
  const key = createHash('sha256').update(`helmian-admin-session:${secret}`).digest();
  return {
    seal(kind, value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(kind));
      const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
    },
    open(kind, token) {
      try {
        const raw = Buffer.from(String(token ?? ''), 'base64url');
        if (raw.length < 29 || raw.length > 4096) return null;
        const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        decipher.setAAD(Buffer.from(kind));
        decipher.setAuthTag(raw.subarray(12, 28));
        const value = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
        return value && Number(value.expiresAt) > Date.now() ? value : null;
      } catch { return null; }
    },
  };
}

const OIDC_FETCH_TIMEOUT_MS = 10_000;
const OIDC_MAX_JSON_BYTES = 64 * 1024;
const MAX_IDENTITY_STATE_ENTRIES = 256;

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
  const sessions = new Map();
  const pending = new Map();
  const sealed = sealer(env.HELMION_ADMIN_SESSION_SECRET);
  let metadataPromise = null;
  const metadata = () => metadataPromise ?? (metadataPromise = discover(issuer, fetchImpl));
  const prune = () => {
    const now = Date.now();
    for (const [key, value] of pending) if (value.expiresAt < now) pending.delete(key);
    for (const [key, value] of sessions) if (value.expiresAt < now) sessions.delete(key);
  };

  async function beginLogin() {
    prune();
    if (pending.size >= MAX_IDENTITY_STATE_ENTRIES) throw new Error('OIDC login capacity reached');
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const loginState = sealed ? sealed.seal('login', { verifier, expiresAt: Date.now() + 10 * 60_000 }) : state;
    if (!sealed) pending.set(state, { verifier, expiresAt: Date.now() + 10 * 60_000 });
    const endpoints = await metadata();
    const url = new URL(endpoints.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', loginState);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { url: url.toString(), state: loginState };
  }

  async function finishLogin(code, state) {
    const attempt = sealed ? sealed.open('login', state) : pending.get(state);
    if (!sealed) pending.delete(state);
    if (!attempt || attempt.expiresAt < Date.now()) throw new Error('OIDC login state invalid or expired');
    const endpoints = await metadata();
    const tokenBody = await fetchJson(endpoints.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: attempt.verifier }),
    }, fetchImpl, 'OIDC token exchange');
    const claims = await verifyJwt(tokenBody.id_token, { issuer, audience: clientId, jwksUri: endpoints.jwksUri, fetchImpl });
    const tokenExpiry = Number(claims.exp) * 1_000;
    const session = { subject: claims.sub, email: typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null, emailVerified: claims.email_verified === true, expiresAt: Math.min(Date.now() + 8 * 60 * 60_000, tokenExpiry) };
    if (sealed) {
      // Sessions outlive the short ID token; cap at 8h from login.
      session.expiresAt = Date.now() + 8 * 60 * 60_000;
      return { sessionId: sealed.seal('session', session), identity: { subject: claims.sub } };
    }
    const sessionId = randomUUID();
    prune();
    if (sessions.size >= MAX_IDENTITY_STATE_ENTRIES) throw new Error('OIDC session capacity reached');
    sessions.set(sessionId, session);
    return { sessionId, identity: { subject: claims.sub } };
  }

  function getSession(sessionId) {
    if (sealed) return sealed.open('session', sessionId);
    const session = sessions.get(sessionId);
    if (!session || session.expiresAt < Date.now()) { if (session) sessions.delete(sessionId); return null; }
    return session;
  }

  return Object.freeze({
    issuer,
    clientId,
    redirectUri,
    beginLogin,
    finishLogin,
    getSession,
    revokeSession: (sessionId) => sessions.delete(sessionId),
    verifyAccessToken: (token) => metadata().then((endpoints) => verifyJwt(token, { issuer, audience: clientId, jwksUri: endpoints.jwksUri, fetchImpl })),
  });
}
