import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import { createLiveHelmianCloudAdminHandler } from '../src/cloud/live-admin.mjs';
import { normalizeStepPlan, normalizeStepUpdate, createAppSessionStore } from '../src/cloud/app-sessions.mjs';

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };
const SID = '0b3f2a8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

test('step plan and update validation', () => {
  assert.deepEqual(normalizeStepPlan({ sessionId: SID, steps: [' Read code ', 'Write tests'] }).steps, ['Read code', 'Write tests']);
  for (const bad of [{ sessionId: 'x', steps: ['a'] }, { sessionId: SID, steps: [] }, { sessionId: SID, steps: Array(21).fill('a') }, { sessionId: SID, steps: [''] }, { sessionId: SID, steps: ['x'.repeat(121)] }]) assert.throws(() => normalizeStepPlan(bad), (e) => e.status === 400);
  assert.deepEqual(normalizeStepUpdate({ sessionId: SID, position: 2, status: 'done' }), { sessionId: SID, position: 2, status: 'done' });
  for (const bad of [{ sessionId: SID, position: 20, status: 'done' }, { sessionId: SID, position: 1.5, status: 'done' }, { sessionId: SID, position: 0, status: 'finished' }]) assert.throws(() => normalizeStepUpdate(bad), (e) => e.status === 400);
});

test('members cannot read or write steps', async () => {
  const store = createAppSessionStore({ connect: async () => { throw new Error('should not connect'); } });
  await assert.rejects(store.steps({ tenantId: 't', subject: 's', role: 'member' }, SID), (e) => e.status === 403);
  await assert.rejects(store.setPlan({ tenantId: 't', subject: 's', role: 'member' }, { sessionId: SID, steps: ['a'] }), (e) => e.status === 403);
});

test('migration 044 is org-scoped, owner/admin only, bounded and cascades with the session', async () => {
  const sql = await readFile(new URL('../sql/044_app_session_steps.sql', import.meta.url), 'utf8');
  assert.match(sql, /enable row level security/);
  assert.match(sql, /in \('owner','admin'\)/);
  assert.match(sql, /references helmion.app_sessions\(id\) on delete cascade/);
  assert.match(sql, /status in \('pending','running','done','failed','skipped'\)/);
  assert.doesNotMatch(sql, /token|secret|password/i);
});

test('step routes: read, plan (exact keys), update, 404 for unknown step', async (t) => {
  const calls = [];
  const appSessionStore = {
    steps: async (actor, sid) => { calls.push(['steps', sid]); return { sessionId: sid, steps: [{ position: 0, label: 'a', status: 'running' }] }; },
    setPlan: async (actor, body) => { calls.push(['plan', body.steps.length]); return { sessionId: body.sessionId, steps: [] }; },
    updateStep: async (actor, body) => { if (body.position === 9) throw Object.assign(new Error('step not found'), { status: 404 }); calls.push(['update', body.status]); return { step: { position: body.position, status: body.status } }; },
  };
  const client = { async query(sql) { if (String(sql).toLowerCase().includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ tenant_id: 't1', role: 'owner' }] }; return { rowCount: 0, rows: [] }; }, release() {} };
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: { connect: async () => client }, identity: { getSession: (id) => (id === 's' ? { subject: 'u1' } : null) }, page: '<p>t</p>', script: 'void 0;', expectedMigrations: [], appSessionStore });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 't' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  const base = clm.healthUrl.replace('/healthz', '');
  const req = (path, body) => fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { cookie: 'helmion_admin_session=s', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const r = await req(`/api/admin/app/sessions/steps?sessionId=${SID}`);
  assert.equal(r.status, 200); assert.equal((await r.json()).steps[0].status, 'running');
  assert.equal((await req('/api/admin/app/sessions/steps', { sessionId: SID, steps: ['a', 'b'] })).status, 200);
  assert.equal((await req('/api/admin/app/sessions/steps', { sessionId: SID, steps: ['a'], extra: 1 })).status, 400);
  assert.equal((await req('/api/admin/app/sessions/steps/update', { sessionId: SID, position: 0, status: 'done' })).status, 200);
  assert.equal((await req('/api/admin/app/sessions/steps/update', { sessionId: SID, position: 9, status: 'done' })).status, 404);
  assert.deepEqual(calls, [['steps', SID], ['plan', 2], ['update', 'done']]);
});
