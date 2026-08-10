import { createHash, randomBytes, randomUUID, webcrypto } from 'node:crypto';

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

async function discover(issuer, fetchImpl) {
  const response = await fetchImpl(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error('OIDC discovery failed');
  const metadata = await response.json();
  return {
    authorizationEndpoint: required(metadata.authorization_endpoint, 'authorization_endpoint'),
    tokenEndpoint: required(metadata.token_endpoint, 'token_endpoint'),
    jwksUri: required(metadata.jwks_uri, 'jwks_uri'),
  };
}

async function verifyJwt(token, { issuer, audience, jwksUri, fetchImpl }) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('OIDC token shape invalid');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson(encodedHeader);
  const claims = decodeJson(encodedPayload);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('OIDC token algorithm invalid');
  const keysResponse = await fetchImpl(jwksUri, { headers: { accept: 'application/json' } });
  if (!keysResponse.ok) throw new Error('OIDC JWKS lookup failed');
  const keys = await keysResponse.json();
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
  if (typeof claims.sub !== 'string' || !claims.sub || (claims.exp != null && Number(claims.exp) <= Math.floor(Date.now() / 1000))) throw new Error('OIDC token expired or missing subject');
  return claims;
}

function claimValue(claims, name) {
  const value = claims[name];
  return typeof value === 'string' ? value.trim() : '';
}

export function createIdentityGateway({ env = process.env, fetchImpl = fetch } = {}) {
  const issuer = required(env.HELMION_ADMIN_ISSUER, 'HELMION_ADMIN_ISSUER').replace(/\/$/, '');
  const clientId = required(env.HELMION_ADMIN_CLIENT_ID, 'HELMION_ADMIN_CLIENT_ID');
  const redirectUri = required(env.HELMION_ADMIN_REDIRECT_URI, 'HELMION_ADMIN_REDIRECT_URI');
  const tenantClaim = String(env.HELMION_ADMIN_TENANT_CLAIM || 'tenant_id').trim();
  const roleClaim = String(env.HELMION_ADMIN_ROLE_CLAIM || 'role').trim();
  const sessions = new Map();
  const pending = new Map();
  let metadataPromise = null;
  const metadata = () => metadataPromise ?? (metadataPromise = discover(issuer, fetchImpl));

  async function beginLogin() {
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
    const tokenResponse = await fetchImpl(endpoints.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: attempt.verifier }),
    });
    if (!tokenResponse.ok) throw new Error('OIDC token exchange failed');
    const tokenBody = await tokenResponse.json();
    const claims = await verifyJwt(tokenBody.id_token, { issuer, audience: clientId, jwksUri: endpoints.jwksUri, fetchImpl });
    const sessionId = randomUUID();
    const tenantId = claimValue(claims, tenantClaim) || claimValue(claims, 'tenantId');
    const role = claimValue(claims, roleClaim);
    sessions.set(sessionId, { subject: claims.sub, tenantId, role, expiresAt: Date.now() + 8 * 60 * 60_000 });
    return { sessionId, identity: { subject: claims.sub, tenantId, role } };
  }

  function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session || session.expiresAt < Date.now()) { if (session) sessions.delete(sessionId); return null; }
    return session;
  }

  return Object.freeze({
    issuer,
    clientId,
    redirectUri,
    tenantClaim,
    roleClaim,
    beginLogin,
    finishLogin,
    getSession,
    verifyAccessToken: (token) => metadata().then((endpoints) => verifyJwt(token, { issuer, audience: clientId, jwksUri: endpoints.jwksUri, fetchImpl })),
  });
}
