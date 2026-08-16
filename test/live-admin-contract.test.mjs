import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { createLiveHelmianCloudAdminHandler, shouldMountLiveAdmin } from '../src/cloud/live-admin.mjs';
import { createIdentityGateway } from '../src/cloud/identity-gateway.mjs';

test('live admin fails closed when the exact Neon target is not configured', async () => {
  await assert.rejects(
    () => createLiveHelmianCloudAdminHandler({ env: {} }),
    /HELMION_DATABASE_URL and HELMION_EXPECTED_ENDPOINT_ID/,
  );
});

test('identity gateway requires all OIDC deployment settings', () => {
  assert.throws(
    () => createIdentityGateway({ env: { HELMION_ADMIN_ISSUER: 'https://issuer.example' } }),
    /HELMION_ADMIN_CLIENT_ID is required/,
  );
});

test('cloud binds require the admin mount even before OIDC values are supplied', () => {
  assert.equal(shouldMountLiveAdmin({ HELMION_CLOUD_ENVIRONMENT: 'production' }), true);
  assert.equal(shouldMountLiveAdmin({ HELMION_CLOUD_ENVIRONMENT: 'staging' }), true);
  assert.equal(shouldMountLiveAdmin({}), false);
});

test('identity gateway requires the exact mounted HTTPS callback', () => {
  assert.throws(
    () => createIdentityGateway({ env: {
      HELMION_ADMIN_ISSUER: 'https://issuer.example',
      HELMION_ADMIN_CLIENT_ID: 'helmian-admin',
      HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example/auth/callback',
    } }),
    /ending exactly \/admin\/auth\/callback/,
  );
});

test('production identity gateway requires a signing secret for cross-process sessions', () => {
  assert.throws(
    () => createIdentityGateway({ env: {
      HELMION_CLOUD_ENVIRONMENT: 'production',
      HELMION_ADMIN_ISSUER: 'https://issuer.example',
      HELMION_ADMIN_CLIENT_ID: 'helmian-admin',
      HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example/admin/auth/callback',
    } }),
    /HELMION_ADMIN_SESSION_SECRET must be at least 32 characters/u,
  );
});

test('identity login requests public Clerk PKCE scopes without trusting organization claims', async () => {
  const gateway = createIdentityGateway({
    env: {
      HELMION_ADMIN_ISSUER: 'https://issuer.example',
      HELMION_ADMIN_CLIENT_ID: 'helmian-admin',
      HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example/admin/auth/callback',
    },
    fetchImpl: async () => new Response(JSON.stringify({
      authorization_endpoint: 'https://issuer.example/authorize',
      token_endpoint: 'https://issuer.example/token',
      jwks_uri: 'https://issuer.example/jwks',
    })),
  });
  const login = await gateway.beginLogin();
  const url = new URL(login.url);
  assert.equal(url.searchParams.get('scope'), 'openid profile email');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://helmian.example/admin/auth/callback');
});

test('identity discovery refuses redirects and oversized JSON with a timeout signal', async () => {
  let init;
  const config = {
    HELMION_ADMIN_ISSUER: 'https://issuer.example',
    HELMION_ADMIN_CLIENT_ID: 'helmian-admin',
    HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example/admin/auth/callback',
  };
  const redirected = createIdentityGateway({ env: config, fetchImpl: async (_url, options) => {
    init = options;
    return new Response('', { status: 302, headers: { location: 'https://evil.example' } });
  } });
  await assert.rejects(() => redirected.beginLogin(), /OIDC discovery failed/u);
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  const oversized = createIdentityGateway({ env: config, fetchImpl: async () => new Response('{}', {
    status: 200, headers: { 'content-length': String(65 * 1024) },
  }) });
  await assert.rejects(() => oversized.beginLogin(), /too large/u);
});

test('OIDC callback issues a signed session that a fresh gateway can verify', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issuer = 'https://issuer.example';
  const clientId = 'helmian-admin';
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: issuer, aud: clientId, sub: 'user-troy', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const idToken = `${signingInput}.${sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url')}`;
  const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const config = {
    HELMION_CLOUD_ENVIRONMENT: 'production',
    HELMION_ADMIN_ISSUER: issuer,
    HELMION_ADMIN_CLIENT_ID: clientId,
    HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example/admin/auth/callback',
    HELMION_ADMIN_SESSION_SECRET: 's'.repeat(32),
  };
  const fetchImpl = async (url) => {
    if (url.endsWith('/.well-known/openid-configuration')) return new Response(JSON.stringify({ authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }));
    if (url.endsWith('/token')) return new Response(JSON.stringify({ id_token: idToken }));
    if (url.endsWith('/jwks')) return new Response(JSON.stringify({ keys: [publicJwk] }));
    throw new Error(`unexpected OIDC URL: ${url}`);
  };
  const first = createIdentityGateway({ env: config, fetchImpl });
  const login = await first.beginLogin();
  const result = await first.finishLogin('authorization-code', login.state);
  assert.match(result.sessionId, /^hs1\.[^.]+\.[^.]+$/u);
  assert.equal(first.getSession(result.sessionId).subject, 'user-troy');
  const fresh = createIdentityGateway({ env: config, fetchImpl });
  assert.equal(fresh.getSession(result.sessionId).subject, 'user-troy');
  assert.equal(fresh.getSession(`${result.sessionId.slice(0, -1)}x`), null);
  assert.equal(fresh.revokeSession(result.sessionId), true);
  assert.equal(fresh.getSession(result.sessionId), null);
});
