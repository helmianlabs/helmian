import assert from 'node:assert/strict';
import test from 'node:test';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import { createLiveHelmianCloudAdminHandler, LIVE_ADMIN_CONSOLE_COMMANDS_PATH } from '../src/cloud/live-admin.mjs';

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };

function pool(role = 'member') {
  const client = { async query(sql) { const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase(); if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] }; if (q.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ tenant_id: 'customer-a', role }] }; throw new Error(`unexpected query ${q}`); }, release() {} };
  return { connect: async () => client };
}

function identity() { return { getSession: (id) => id === 'active-session' ? { subject: 'user-1' } : null }; }

test('console command intents are tenant-scoped and never execute', async (t) => {
  const calls = [];
  const repository = { async list(actor) { calls.push(['list', actor]); return { commands: [{ commandName: 'workspace_context', status: 'prepared', reason: 'Inspect project scope', receiptId: 'receipt-1', execution: 'not_performed' }], execution: 'not_performed' }; }, async append(actor, input) { calls.push(['append', actor, input]); return { durable: true, command: { commandName: input.commandName, status: 'prepared', receiptId: 'receipt-2', execution: 'not_performed' }, source: 'tenant_console_command_intents' }; } };
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: pool('member'), identity: identity(), page: '<p>test</p>', script: 'void 0;', expectedMigrations: [], consoleCommandRepository: repository });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 'test' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  const base = clm.healthUrl.replace('/healthz', '');
  const headers = { cookie: 'helmion_admin_session=active-session' };
  const read = await fetch(`${base}${LIVE_ADMIN_CONSOLE_COMMANDS_PATH}`, { headers });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).commands[0].execution, 'not_performed');
  assert.equal(calls[0][1].tenantId, 'customer-a');
  const body = { commandName: 'workspace_context', arguments: { project: 'aimforge' }, reason: 'Inspect project scope', idempotencyKey: 'console-0001' };
  const appended = await fetch(`${base}${LIVE_ADMIN_CONSOLE_COMMANDS_PATH}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(appended.status, 200);
  assert.equal((await appended.json()).command.execution, 'not_performed');
  assert.equal(calls[1][2].arguments.project, 'aimforge');
  assert.equal((await fetch(`${base}${LIVE_ADMIN_CONSOLE_COMMANDS_PATH}?tenant_id=other`, { headers })).status, 400);
  const injected = await fetch(`${base}${LIVE_ADMIN_CONSOLE_COMMANDS_PATH}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, tenantId: 'other' }) });
  assert.equal(injected.status, 400);
});
