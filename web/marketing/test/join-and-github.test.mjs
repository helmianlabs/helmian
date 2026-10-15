import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { joinModel } from '../join/join-model.mjs';
import { createGitHubHandoffHandlers, GITHUB_SCOPES, DEFAULT_GITHUB_REDIRECT } from '../api/_team-oauth-github.js';

test('join page states', () => {
  const token = `hinv_${'a'.repeat(32)}`;
  assert.equal(joinModel({ token: 'x' }).state, 'problem');
  assert.equal(joinModel({ token }).state, 'check');
  const ready = joinModel({ token, status: 200, preview: { organization: 'Helmian Platform' } });
  assert.deepEqual([ready.state, ready.organization, ready.signupUrl, ready.signinUrl], ['ready', 'Helmian Platform', `/admin/auth/join?token=${token}`, `/admin/auth/join?token=${token}&mode=signin`]);
  assert.match(joinModel({ token, status: 410 }).title, /expired/);
  assert.match(joinModel({ error: 'already_in_organization' }).title, /already belong/);
  assert.equal(joinModel({ error: 'whatever' }).title, 'This invite link is not valid');
});

test('join page has no technical wording', async () => {
  const html = await readFile(new URL('../join/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /token|receipt|tenant|oauth/i);
  assert.match(html, /Create account &amp; join/);
});

function res() { const r = { headers: {}, statusCode: 0, body: '', setHeader(k, v) { r.headers[k.toLowerCase()] = v; }, end(b = '') { r.body = String(b); } }; return r; }
const STATE = `team_${'r'.repeat(24)}.${'s'.repeat(43)}`;

test('GitHub authorize redirects to github.com with the cloud client id, scopes and state', async () => {
  const h = createGitHubHandoffHandlers({ config: () => ({ clientId: 'Iv1.abc', clientSecret: 'x', redirectUri: DEFAULT_GITHUB_REDIRECT }) });
  const r = res(); await h.authorize({ method: 'GET', url: `/api/team-oauth/github/authorize?state=${STATE}`, headers: {} }, r);
  assert.equal(r.statusCode, 302);
  const u = new URL(r.headers.location);
  assert.equal(u.origin + u.pathname, 'https://github.com/login/oauth/authorize');
  assert.deepEqual([u.searchParams.get('client_id'), u.searchParams.get('redirect_uri'), u.searchParams.get('scope'), u.searchParams.get('state')], ['Iv1.abc', 'https://helmian.cloud/api/team-oauth/github/callback', GITHUB_SCOPES, STATE]);
  const bad = res(); await h.authorize({ method: 'GET', url: '/x?state=nope', headers: {} }, bad); assert.equal(bad.statusCode, 400);
});

test('GitHub callback exchanges server-side and stores only the encrypted token; redeem returns it once', async () => {
  const stored = {};
  const h = createGitHubHandoffHandlers({
    config: () => ({ clientId: 'id', clientSecret: 'secret', redirectUri: DEFAULT_GITHUB_REDIRECT }),
    exchange: async (code) => { assert.equal(code, 'gh-code'); return 'gho_token123'; },
    encrypt: (v, id) => ({ ciphertext: Buffer.from(v).toString('base64url'), iv: 'i', tag: id }),
    decrypt: (e) => Buffer.from(e.ciphertext, 'base64url').toString(),
    complete: async (x) => { Object.assign(stored, x); },
    redeem: async () => ({ state: 'complete', encryptedCode: stored.encryptedCode }),
    authorize: () => {},
  });
  const r = res(); await h.callback({ method: 'GET', url: `/cb?state=${STATE}&code=gh-code`, headers: {} }, r);
  assert.equal(r.statusCode, 200);
  assert.equal(stored.provider, 'github');
  assert.doesNotMatch(JSON.stringify(stored), /gh-code|gho_token123/);
  const out = res(); await h.redeem({ method: 'POST', headers: {}, body: { requestId: STATE.split('.')[0], redemptionSecret: 'p'.repeat(43) } }, out);
  assert.equal(JSON.parse(out.body).accessToken, 'gho_token123');
});

test('GitHub is not configured without client id/secret', async () => {
  const { githubConfig } = await import('../api/_team-oauth-github.js');
  assert.throws(() => githubConfig({}), /not configured/);
});
