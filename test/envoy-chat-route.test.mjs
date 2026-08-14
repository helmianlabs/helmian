import assert from 'node:assert/strict';
import test from 'node:test';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import {
  createLiveHelmianCloudAdminHandler,
  LIVE_ADMIN_ENVOY_CHANNELS_PATH,
  LIVE_ADMIN_ENVOY_MESSAGES_PATH,
} from '../src/cloud/live-admin.mjs';

const env = {
  HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require',
  HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com',
  HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback',
};

function fakePool() {
  const channels = [{ id: 'channel-1', slug: 'ops', title: 'Operations', kind: 'team', created_by_subject: 'user-1', created_at: 'now' }];
  const messages = [];
  const memberships = { 'user-1': { tenant_id: 'org-a', role: 'member' }, 'user-2': { tenant_id: 'org-b', role: 'member' } };
  const client = {
    async query(sql, values = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q)) return { rowCount: 0, rows: [] };
      if (q.startsWith('select tenant_id, role from helmion.tenant_memberships')) {
        const member = memberships[values[0]];
        return member ? { rowCount: 1, rows: [member] } : { rowCount: 0, rows: [] };
      }
      if (q.startsWith('select set_config')) return { rowCount: 1, rows: [{}] };
      if (q.startsWith('select role from helmion.tenant_memberships')) {
        return { rowCount: 1, rows: [{ role: memberships[values[1]]?.role ?? 'member' }] };
      }
      if (q.startsWith('select id, slug, title, kind, created_by_subject')) return { rowCount: channels.length, rows: channels };
      if (q.startsWith('insert into helmion.envoy_channels')) {
        const row = { id: 'channel-2', slug: values[1], title: values[2], kind: values[3], created_by_subject: values[4], created_at: 'now' };
        channels.push(row); return { rowCount: 1, rows: [row] };
      }
      if (q.startsWith('insert into helmion.envoy_messages')) {
        const existing = messages.find((row) => row.tenant_id === values[0] && row.channel_id === values[1] && row.author_subject === values[2] && row.idempotency_key === values[5]);
        if (existing) return { rowCount: 0, rows: [] };
        const row = { id: `message-${messages.length + 1}`, tenant_id: values[0], channel_id: values[1], author_subject: values[2], author_kind: values[3], body: values[4], idempotency_key: values[5], created_at: 'now' };
        messages.push(row); return { rowCount: 1, rows: [row] };
      }
      if (q.startsWith('select id, channel_id, author_subject, author_kind, body, idempotency_key')) {
        const rows = messages.filter((row) => row.tenant_id === values[0] && row.channel_id === values[1]
          && (values.length !== 4 || (row.author_subject === values[2] && row.idempotency_key === values[3])));
        return { rowCount: rows.length, rows };
      }
      throw new Error(`Unexpected query: ${q}`);
    },
    release() {},
  };
  return { connect: async () => client };
}

function identity() { return { getSession: (id) => id === 'active-session' ? { subject: 'user-1' } : null }; }

async function fixture() {
  const admin = await createLiveHelmianCloudAdminHandler({
    env, pool: fakePool(), identity: identity(), page: '<p>test</p>', script: 'void 0;', expectedMigrations: [],
  });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 'test' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  return { url: clm.healthUrl.replace('/healthz', ''), close: async () => { await clm.close(); await admin.close(); } };
}

test('authenticated Envoy route resolves organization from membership and replays idempotently', async (t) => {
  const app = await fixture(); t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=active-session' };
  const created = await fetch(`${app.url}${LIVE_ADMIN_ENVOY_CHANNELS_PATH}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'chat', title: 'Chat', kind: 'team' }) });
  assert.equal(created.status, 200);
  const channelId = (await created.json()).channel.id;
  const body = { channelId, body: 'hello', idempotencyKey: 'message-0001' };
  const first = await fetch(`${app.url}${LIVE_ADMIN_ENVOY_MESSAGES_PATH}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const replay = await fetch(`${app.url}${LIVE_ADMIN_ENVOY_MESSAGES_PATH}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await first.json()).receipt.replayed, false);
  assert.equal((await replay.json()).receipt.replayed, true);
  const listed = await fetch(`${app.url}${LIVE_ADMIN_ENVOY_MESSAGES_PATH}?channel_id=${channelId}`, { headers });
  assert.equal((await listed.json()).messages.length, 1);
});

test('Envoy rejects tenant selectors instead of allowing body or URL cross-organization injection', async (t) => {
  const app = await fixture(); t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=active-session' };
  const urlTenant = await fetch(`${app.url}${LIVE_ADMIN_ENVOY_MESSAGES_PATH}?tenant_id=org-b&channel_id=channel-1`, { headers });
  assert.equal(urlTenant.status, 400);
  const bodyTenant = await fetch(`${app.url}${LIVE_ADMIN_ENVOY_MESSAGES_PATH}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ channelId: 'channel-1', body: 'nope', idempotencyKey: 'message-0002', tenantId: 'org-b' }) });
  assert.equal(bodyTenant.status, 400);
});
