import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { restorePath } from '../api/helmian-admin.js';

test('restores the original admin path and query from the rewrite', () => {
  assert.equal(restorePath('/api/helmian-admin?__p=/admin'), '/admin/');
  assert.equal(restorePath('/api/helmian-admin?__p=/admin/auth/callback&code=c&state=s'), '/admin/auth/callback?code=c&state=s');
  assert.equal(restorePath('/api/helmian-admin?__p=/api/admin/session'), '/api/admin/session');
  assert.equal(restorePath('/api/helmian-admin'), null);
  assert.equal(restorePath('/api/helmian-admin?__p=/api/herald-control'), null);
});

test('public account routes reach the admin function (self-serve signup + profile)', () => {
  assert.equal(restorePath('/api/helmian-admin?__p=/api/signup'), '/api/signup');
  assert.equal(restorePath('/api/helmian-admin?__p=/api/profile'), '/api/profile');
  assert.equal(restorePath('/api/helmian-admin?__p=/api/signup/x'), null);
});

test('user provider OAuth routes reach the admin function (Integrations Connect buttons)', () => {
  assert.equal(restorePath('/api/helmian-admin?__p=/api/provider-oauth/gemini/start'), '/api/provider-oauth/gemini/start');
  assert.equal(restorePath('/api/helmian-admin?__p=/api/provider-oauth/gemini/callback&code=c&state=s'), '/api/provider-oauth/gemini/callback?code=c&state=s');
  assert.equal(restorePath('/api/helmian-admin?__p=/api/provider-oauth/openai/start'), '/api/provider-oauth/openai/start');
  assert.equal(restorePath('/api/helmian-admin?__p=/api/provider-oauth/openai/callback'), '/api/provider-oauth/openai/callback');
  assert.equal(restorePath('/api/helmian-admin?__p=/api/provider-oauth/grok/start'), '/api/provider-oauth/grok/start');
  assert.equal(restorePath('/api/helmian-admin?__p=/api/provider-oauth/grok/poll'), '/api/provider-oauth/grok/poll');
});

test('lookalike paths stay out of the admin function', () => {
  assert.equal(restorePath('/api/helmian-admin?__p=/api/provider-oauthx/gemini/start'), null);
  assert.equal(restorePath('/api/helmian-admin?__p=/api/provider-oauth-evil/start'), null);
  assert.equal(restorePath('/api/helmian-admin?__p=/api/adminx/session'), null);
  assert.equal(restorePath('/api/helmian-admin?__p=/administrator'), null);
});

test('vercel.json rewrites provider OAuth paths into the admin function, and restorePath round-trips them', () => {
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const rewrite = (vercel.rewrites ?? []).find((entry) => entry.source === '/api/provider-oauth/:path*');
  assert.ok(rewrite, 'a rewrite must carry /api/provider-oauth/* to the admin function');
  for (const sub of ['gemini/start', 'gemini/callback', 'openai/start', 'openai/callback', 'grok/start', 'grok/poll']) {
    const destination = rewrite.destination.replace(':path*', sub);
    assert.equal(restorePath(destination), `/api/provider-oauth/${sub}`);
  }
});
