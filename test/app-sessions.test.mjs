import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import { createLiveHelmianCloudAdminHandler } from '../src/cloud/live-admin.mjs';
import { normalizeAppSession, assertAppSessionRole, createAppSessionStore } from '../src/cloud/app-sessions.mjs';

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };

test('session input validation and role gate', () => {
  assert.deepEqual(normalizeAppSession({ name: ' Fix login ', provider: 'Claude', idempotencyKey: '12345678' }), { name: 'Fix login', provider: 'Claude', idempotencyKey: '12345678' });
  for (const bad of [{ name: '', provider: 'Claude', idempotencyKey: '12345678' }, { name: 'x', provider: 'Llama', idempotencyKey: '12345678' }, { name: 'x', provider: 'Grok', idempotencyKey: 'short' }, { name: 'x'.repeat(61), provider: 'Grok', idempotencyKey: '12345678' }]) assert.throws(() => normalizeAppSession(bad), /invalid|missing|unsupported/);
  assert.throws(() => assertAppSessionRole({ role: 'member' }), (e) => e.status === 403);
  assert.doesNotThrow(() => assertAppSessionRole({ role: 'admin' }));
});

test('member role cannot reach the store', async () => {
  const store = createAppSessionStore({ connect: async () => { throw new Error('should not connect'); } });
  await assert.rejects(store.list({ tenantId: 't', subject: 's', role: 'member' }), (e) => e.status === 403);
});

test('migration 042 is org-scoped, owner/admin only and holds no credentials', async () => {
  const sql = await readFile(new URL('../sql/042_app_sessions.sql', import.meta.url), 'utf8');
  assert.match(sql, /enable row level security/);
  assert.match(sql, /current_setting\('helmion.tenant_id', true\)/);
  assert.match(sql, /in \('owner','admin'\)/);
  assert.doesNotMatch(sql, /token|secret|api_key|password/i);
});

test('session routes: list, create (exact keys), archive, and 503 when the table is missing', async (t) => {
  const calls = [];
  const appSessionStore = {
    list: async (actor) => { calls.push(['list', actor.role]); return { sessions: [{ id: 'a', name: 'n', provider: 'Grok' }] }; },
    create: async (actor, body) => { calls.push(['create', body.provider]); return { session: { id: 'b', ...body }, created: true }; },
    archive: async (actor, id) => { calls.push(['archive', id]); if (id === 'missing-table') throw new Error('relation "helmion.app_sessions" does not exist'); return { archived: true }; },
  };
  const client = { async query(sql) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (q.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ tenant_id: 't1', role: 'owner' }] };
    return { rowCount: 0, rows: [] };
  }, release() {} };
  const pool = { connect: async () => client };
  const identity = { getSession: (id) => (id === 's' ? { subject: 'u1' } : null) };
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool, identity, page: '<p>t</p>', script: 'void 0;', expectedMigrations: [], appSessionStore });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 't' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  const base = clm.healthUrl.replace('/healthz', '');
  const req = (path, body) => fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { cookie: 'helmion_admin_session=s', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const list = await req('/api/admin/app/sessions');
  assert.equal(list.status, 200);
  assert.equal((await list.json()).sessions.length, 1);
  assert.equal((await req('/api/admin/app/sessions', { name: 'x', provider: 'Grok', idempotencyKey: '12345678', extra: 1 })).status, 400);
  assert.equal((await req('/api/admin/app/sessions', { name: 'x', provider: 'Grok', idempotencyKey: '12345678' })).status, 200);
  assert.equal((await req('/api/admin/app/sessions/archive', { id: 'a' })).status, 200);
  assert.equal((await req('/api/admin/app/sessions/archive', { id: 'missing-table' })).status, 503);
});

test('member role is refused by the session routes', async (t) => {
  const client = { async query(sql) { const q = String(sql).toLowerCase(); if (q.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ tenant_id: 't1', role: 'member' }] }; return { rowCount: 0, rows: [] }; }, release() {} };
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: { connect: async () => client }, identity: { getSession: () => ({ subject: 'u2' }) }, page: '<p>t</p>', script: 'void 0;', expectedMigrations: [], appSessionStore: { list: async () => { throw new Error('must not be called'); } } });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 't' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  const res = await fetch(`${clm.healthUrl.replace('/healthz', '')}/api/admin/app/sessions`, { headers: { cookie: 'helmion_admin_session=s' } });
  assert.equal(res.status, 403);
});

test('creating a new Envoy channel writes an audit event; re-creating it does not', async () => {
  const { createEnvoyStore } = await import('../src/cloud/envoy-chat.mjs');
  for (const inserted of [true, false]) {
    const seen = [];
    const client = { async query(sql) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase(); seen.push(q);
      if (q.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ tenant_id: 't1', role: 'owner' }] };
      if (q.startsWith('insert into helmion.envoy_channels')) return { rowCount: 1, rows: [{ id: 'c1', slug: 'team', title: 'Team', kind: 'team', created_by_subject: 'u1', created_at: 'now', inserted }] };
      if (q.startsWith('insert into helmion.audit_events')) return { rowCount: 1, rows: [{ id: '9' }] };
      return { rowCount: 0, rows: [] };
    }, release() {} };
    const store = createEnvoyStore({ connect: async () => client });
    const r = await store.createChannel({ tenantId: 't1', subject: 'u1', role: 'owner', sessionId: 's', requestId: 'r' }, { slug: 'team', title: 'Team', kind: 'team' });
    assert.equal(r.channel.id, 'c1');
    assert.equal(seen.some((q) => q.startsWith('insert into helmion.audit_events') ), inserted);
  }
});
