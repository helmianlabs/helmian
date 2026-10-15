import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { createIdentityGateway } from '../src/cloud/identity-gateway.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
function idToken(claims) {
  const head = b64({ alg: 'RS256', kid: 'k1' }); const body = b64(claims);
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const env = { HELMION_ADMIN_ISSUER: 'https://issuer.example', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example/admin/auth/callback', HELMION_ADMIN_SESSION_SECRET: 'x'.repeat(40) };
const fetchImpl = async (url) => {
  const u = String(url);
  if (u.endsWith('openid-configuration')) return new Response(JSON.stringify({ authorization_endpoint: 'https://issuer.example/a', token_endpoint: 'https://issuer.example/t', jwks_uri: 'https://issuer.example/j' }));
  if (u.endsWith('/t')) return new Response(JSON.stringify({ id_token: idToken({ iss: env.HELMION_ADMIN_ISSUER, aud: 'helmian', sub: 'user_9', email: 'Troy@x.com', email_verified: true, exp: Math.floor(Date.now() / 1000) + 60 }) }));
  if (u.endsWith('/j')) return new Response(JSON.stringify({ keys: [jwk] }));
  throw new Error(u);
};

test('sealed mode: login and session survive a different gateway instance', async () => {
  const a = createIdentityGateway({ env, fetchImpl });
  const b = createIdentityGateway({ env, fetchImpl });
  const login = await a.beginLogin();
  assert.equal(new URL(login.url).searchParams.get('state'), login.state);
  const done = await b.finishLogin('code', login.state);
  const session = a.getSession(done.sessionId);
  assert.equal(session.subject, 'user_9');
  assert.equal(session.email, 'troy@x.com');
  assert.equal(session.emailVerified, true);
  assert.equal(a.getSession(done.sessionId.slice(0, -2) + 'AA'), null, 'tampered token rejected');
  const other = createIdentityGateway({ env: { ...env, HELMION_ADMIN_SESSION_SECRET: 'y'.repeat(40) }, fetchImpl });
  assert.equal(other.getSession(done.sessionId), null, 'other secret rejected');
  await assert.rejects(() => b.finishLogin('code', done.sessionId), /state invalid/, 'session token is not a login state');
});

test('sealed mode refuses short secrets', () => {
  assert.throws(() => createIdentityGateway({ env: { ...env, HELMION_ADMIN_SESSION_SECRET: 'short' }, fetchImpl }), /32 characters/);
});

test('callback failures carry a stage and OAuth error code, never token material', async () => {
  const failing = (body, status) => async (url) => String(url).endsWith('/t') ? new Response(JSON.stringify(body), { status }) : fetchImpl(url);
  const g1 = createIdentityGateway({ env, fetchImpl: failing({ error: 'invalid_grant', error_description: 'x' }, 400) });
  const e1 = await g1.finishLogin('code', (await g1.beginLogin()).state).catch((e) => e);
  assert.equal(e1.stage, 'token_exchange'); assert.equal(e1.oauthError, 'invalid_grant'); assert.equal(e1.httpStatus, 400);
  const g2 = createIdentityGateway({ env, fetchImpl: failing({ access_token: 'a' }, 200) });
  assert.equal((await g2.finishLogin('code', (await g2.beginLogin()).state).catch((e) => e)).stage, 'id_token_missing');
  const g3 = createIdentityGateway({ env, fetchImpl });
  assert.equal((await g3.finishLogin('code', 'garbage').catch((e) => e)).stage, 'login_state');
});
