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
test('database down is a clean 503, not a crash', async () => {
  const h = createSignupHandler({ getIdentityImpl: () => ({ getSession: () => ({ subject: 'user_abc123' }) }), getPoolImpl: () => { throw new Error('HELMION_DATABASE_URL not set'); } });
  const r = res(); await h({ method: 'POST', headers: { cookie: 'helmion_admin_session=x' } }, r); assert.equal(r.status, 503);
});
