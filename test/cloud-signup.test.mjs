import assert from 'node:assert/strict';
import test from 'node:test';
import { createSignupHandler } from '../src/cloud/signup.mjs';
function res() { const r = { status: 0, body: '', writeHead(s) { r.status = s; }, end(b) { r.body = b; } }; return r; }
test('cookie session creates trial tenant once', async () => {
  const q = []; const client = { query: async (sql, args) => { q.push(sql); if (sql.startsWith('select')) return { rowCount: 0, rows: [] }; return {}; }, release() {} };
  const h = createSignupHandler({ getIdentityImpl: () => ({ getSession: (c) => c === 'sealed' ? { subject: 'user_abc123' } : null }), getPoolImpl: () => ({ connect: async () => client }) });
  const r = res(); await h({ method: 'POST', headers: { cookie: 'helmion_admin_session=sealed' } }, r);
  assert.equal(r.status, 201); assert.ok(q.some((s) => s.includes('insert into helmion.tenants')));
});
test('bearer path uses Clerk verifier; 401 when nothing valid', async () => {
  const h = createSignupHandler({ getIdentityImpl: () => ({ getSession: () => null }), verifyBearer: async (t) => (t === 'good' ? { subject: 'user_x1234' } : null),
    getPoolImpl: () => ({ connect: async () => ({ query: async (s) => (s.startsWith('select') ? { rowCount: 1, rows: [{ tenant_id: 't1' }] } : {}), release() {} }) }) });
  const ok = res(); await h({ method: 'POST', headers: { authorization: 'Bearer good' } }, ok); assert.equal(ok.status, 200);
  const no = res(); await h({ method: 'POST', headers: { authorization: 'Bearer bad' } }, no); assert.equal(no.status, 401);
});
function resH() { const r = { status: 0, body: '', headers: null, writeHead(s, h) { r.status = s; r.headers = h ?? null; }, end(b) { r.body = b; } }; return r; }
test('fresh signup rotates the app session onto the new subject, displacing a stale cookie session', async () => {
  const minted = [];
  const identity = {
    getSession: (c) => (c === 'oldsealed' ? { subject: 'user_oldowner' } : null),
    createSession: async ({ subject, remember }) => { minted.push({ subject, remember }); return { sessionId: 'newsession' }; },
  };
  const client = { query: async (sql) => (sql.startsWith('select') ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ id: 'chan-1' }] }), release() {} };
  const h = createSignupHandler({ getIdentityImpl: () => identity, verifyBearer: async (t) => (t === 'newtoken' ? { subject: 'user_newbie1' } : null), getPoolImpl: () => ({ connect: async () => client }) });
  // The browser presents BOTH the previous user's remembered app-session
  // cookie and the new account's Clerk Bearer token: the Bearer identity
  // must win, and the response must replace the app session at both paths.
  const r = resH(); await h({ method: 'POST', headers: { cookie: 'helmion_admin_session=oldsealed', authorization: 'Bearer newtoken' } }, r);
  assert.equal(r.status, 201);
  assert.deepEqual(minted, [{ subject: 'user_newbie1', remember: true }]);
  const cookies = r.headers?.['set-cookie'] ?? [];
  assert.equal(cookies.length, 2);
  assert.ok(cookies.some((c) => c.startsWith('helmion_admin_session=newsession;') && c.includes('Path=/admin;')));
  assert.ok(cookies.some((c) => c.startsWith('helmion_admin_session=newsession;') && c.includes('Path=/api/admin;')));
});
test('returning user (already has a workspace) also gets the rotated app session', async () => {
  const minted = [];
  const identity = { getSession: () => null, createSession: async ({ subject }) => { minted.push(subject); return { sessionId: 'sess2' }; } };
  const h = createSignupHandler({ getIdentityImpl: () => identity, verifyBearer: async () => ({ subject: 'user_x1234' }),
    getPoolImpl: () => ({ connect: async () => ({ query: async (s) => (s.startsWith('select') ? { rowCount: 1, rows: [{ tenant_id: 't1' }] } : {}), release() {} }) }) });
  const r = resH(); await h({ method: 'POST', headers: { authorization: 'Bearer good' } }, r);
  assert.equal(r.status, 200); assert.deepEqual(minted, ['user_x1234']);
  assert.equal((r.headers?.['set-cookie'] ?? []).length, 2);
});
test('database down is a clean 503, not a crash', async () => {
  const h = createSignupHandler({ getIdentityImpl: () => ({ getSession: () => ({ subject: 'user_abc123' }) }), getPoolImpl: () => { throw new Error('HELMION_DATABASE_URL not set'); } });
  const r = res(); await h({ method: 'POST', headers: { cookie: 'helmion_admin_session=x' } }, r); assert.equal(r.status, 503);
});
