import assert from 'node:assert/strict';
import test from 'node:test';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import {
  createLiveHelmianCloudAdminHandler,
  LIVE_ADMIN_ORGANIZATION_ATTRIBUTE_RULES_PATH,
  LIVE_ADMIN_ORGANIZATION_ATTRIBUTE_RULE_DELETE_PATH,
} from '../src/cloud/live-admin.mjs';

const databaseUrl = 'postgresql://app:password@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require';
const env = {
  HELMION_CLOUD_ENVIRONMENT: 'staging',
  HELMION_CORA_PROVIDER: 'claude',
  HELMION_DATABASE_URL: databaseUrl,
  HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4',
  HELMION_ADMIN_ISSUER: 'https://identity.example.com',
  HELMION_ADMIN_CLIENT_ID: 'helmian-cloud-admin',
  HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback',
};

function fakePool() {
  const client = {
    async query(sql, values = []) {
      const text = String(sql);
      if (text.includes('tenant_memberships')) {
        if (text.includes('where subject=$1')) return { rowCount: 1, rows: [{ tenant_id: 'helmian-platform', role: 'owner', job_title: 'owner' }] };
        return { rowCount: 1, rows: [{ role: 'owner' }] };
      }
      if (text.includes("to_regclass('helmion.schema_migrations')")) return { rowCount: 1, rows: [{ migration_table: 'helmion.schema_migrations' }] };
      if (text.includes('from helmion.schema_migrations')) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  return { connect: async () => client };
}

function identity() {
  return {
    issuer: 'https://identity.example.com',
    getSession: (sessionId) => (sessionId === 'active-session' ? { subject: 'user-1' } : null),
    beginLogin: async () => ({ url: 'https://identity.example.com/authorize', state: 'state-1' }),
    finishLogin: async () => ({ sessionId: 'active-session' }),
  };
}

async function fixture(t, tenantAttributeRulesRepository) {
  const admin = await createLiveHelmianCloudAdminHandler({
    env, pool: fakePool(), identity: identity(), page: '<!doctype html><title>Admin</title>', script: 'void 0;',
    expectedMigrations: [], tenantAttributeRulesRepository,
  });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 'test' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  return clm.healthUrl.replace('/healthz', '');
}

const COOKIE = { cookie: 'helmion_admin_session=active-session' };

test('attribute rule routes list, create and delete through the tenant repository', async (t) => {
  const calls = [];
  const stub = {
    async list(actor) { calls.push(['list', actor.subject, actor.role]); return { rules: [{ ruleId: 'r1', effect: 'DENY', actions: ['audit.read'], conditions: {}, reason: 'x', active: true }], source: 'helmion.tenant_attribute_rules', mutation: 'not_performed' }; },
    async create(actor, body) { calls.push(['create', body]); return { durable: true, receiptId: '9', status: 'created', rule: { ruleId: body.ruleId } }; },
    async remove(actor, body) { calls.push(['remove', body]); return { durable: true, receiptId: '10', status: 'removed', ruleId: body.ruleId }; },
  };
  const url = await fixture(t, stub);
  const listed = await fetch(`${url}${LIVE_ADMIN_ORGANIZATION_ATTRIBUTE_RULES_PATH}`, { headers: COOKIE });
  assert.equal(listed.status, 200);
  const listedBody = await listed.json();
  assert.equal(listedBody.valid, true);
  assert.equal(listedBody.rules[0].ruleId, 'r1');

  const created = await fetch(`${url}${LIVE_ADMIN_ORGANIZATION_ATTRIBUTE_RULES_PATH}`, { method: 'POST', headers: { ...COOKIE, 'content-type': 'application/json' }, body: JSON.stringify({ ruleId: 'r2', effect: 'DENY', actions: ['audit.read'], conditions: { 'actor.jobTitle': 'driver' }, reason: 'why' }) });
  assert.equal(created.status, 200);
  assert.equal((await created.json()).receiptId, '9');

  const removed = await fetch(`${url}${LIVE_ADMIN_ORGANIZATION_ATTRIBUTE_RULE_DELETE_PATH}`, { method: 'POST', headers: { ...COOKIE, 'content-type': 'application/json' }, body: JSON.stringify({ ruleId: 'r2', reason: 'done' }) });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).status, 'removed');
  assert.deepEqual(calls.map((c) => c[0]), ['list', 'create', 'remove']);
});

test('attribute rule routes refuse selector params, extra body keys and anonymous calls', async (t) => {
  const stub = { async list() { return { rules: [] }; }, async create() { throw new Error('unreachable'); }, async remove() { throw new Error('unreachable'); } };
  const url = await fixture(t, stub);
  const selector = await fetch(`${url}${LIVE_ADMIN_ORGANIZATION_ATTRIBUTE_RULES_PATH}?tenant_id=x`, { headers: COOKIE });
  assert.equal(selector.status, 400);
  const extra = await fetch(`${url}${LIVE_ADMIN_ORGANIZATION_ATTRIBUTE_RULES_PATH}`, { method: 'POST', headers: { ...COOKIE, 'content-type': 'application/json' }, body: JSON.stringify({ ruleId: 'r', effect: 'DENY', actions: ['audit.read'], conditions: {}, reason: 'x', tenantId: 'other' }) });
  assert.equal(extra.status, 400);
  const anon = await fetch(`${url}${LIVE_ADMIN_ORGANIZATION_ATTRIBUTE_RULES_PATH}`);
  assert.equal(anon.status, 403);
});
