import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createLiveHelmianCloudAdminHandler, LIVE_ADMIN_ENVOY_MESSAGES_PATH } from '../src/cloud/live-admin.mjs';

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };

// The live bridge case (2026-11-06): the device subject's EARLIEST
// membership is the platform tenant (joined 2026-10-17, when the bridge
// was paired there), but its desktop link was minted in the real
// workspace. The old deriver resolved the device into the platform
// tenant, so the bridge could never claim the real workspace's
// profile-sync jobs. A device must resolve to its LINK's tenant.
const BRIDGE_MEMBERSHIPS = [
  { tenant_id: 'tenant-platform', role: 'member', created_at: '2026-10-17T01:50:00.000Z' },
  { tenant_id: 'tenant-real', role: 'owner', created_at: '2026-10-20T00:00:00.000Z' },
];

function pool(memberships) {
  const pair = (tenant, subject) => memberships.find((m) => m.tenant_id === tenant && m.subject === subject);
  const client = { async query(sql, args = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
    if (q.includes('from helmion.tenant_memberships') && q.includes('tenant_id=$1 and subject=$2')) {
      // requireActiveTenantMembership: one tenant, one subject.
      const row = pair(args[0], args[1]);
      return row ? { rowCount: 1, rows: [{ role: row.role }] } : { rowCount: 0, rows: [] };
    }
    if (q.includes('from helmion.tenant_memberships') && q.includes('subject=$1 and tenant_id=$2')) {
      // The device deriver: membership scoped to the link's tenant.
      const row = pair(args[1], args[0]);
      return row ? { rowCount: 1, rows: [{ tenant_id: row.tenant_id, role: row.role }] } : { rowCount: 0, rows: [] };
    }
    if (q.includes('from helmion.tenant_memberships')) {
      // The session deriver: all of the subject's memberships, earliest first.
      const rows = memberships.filter((m) => m.subject === args[0])
        .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : (a.tenant_id < b.tenant_id ? -1 : 1)));
      return { rowCount: rows.length, rows: rows.map(({ tenant_id, role }) => ({ tenant_id, role })) };
    }
    return { rowCount: 0, rows: [] };
  }, release() {} };
  return { connect: async () => client };
}

const withSubject = (rows, subject) => rows.map((m) => ({ ...m, subject }));

function fakeResponse() {
  const r = { status: 0, headers: null, body: '',
    writeHead(s, h) { r.status = s; r.headers = h ?? null; },
    write() { return true; },
    end(b) { r.body = b ?? ''; } };
  return r;
}

function devicePost(path, token, body) {
  const payload = Buffer.from(JSON.stringify(body));
  const req = Readable.from([payload]);
  req.method = 'POST';
  req.url = path;
  req.headers = { authorization: `Bearer ${token}`, host: 'localhost', 'content-type': 'application/json', 'content-length': String(payload.length) };
  return req;
}

async function makeAdmin(t, { memberships, link }) {
  const captured = [];
  const admin = await createLiveHelmianCloudAdminHandler({
    env,
    pool: pool(memberships),
    identity: { getSession: () => null },
    orgInviteStore: { desktopIdentity: async (token) => (token === 'devtok' ? link : null) },
    envoyStore: {
      appendMessage: async (actor, body) => { captured.push({ actor, body }); return { message: { id: 'm1' } }; },
      listMessages: async () => ({ messages: [] }),
    },
    page: '<p>t</p>',
    script: 'void 0;',
    expectedMigrations: [],
  });
  t.after(async () => { await admin.close(); });
  return { admin, captured };
}

test('device token: the actor resolves to the desktop LINK tenant, not the subject earliest membership', async (t) => {
  const memberships = withSubject(BRIDGE_MEMBERSHIPS, 'user_bridge');
  const { admin, captured } = await makeAdmin(t, { memberships, link: { subject: 'user_bridge', tenantId: 'tenant-real' } });
  const r = fakeResponse();
  await admin.handler(devicePost(LIVE_ADMIN_ENVOY_MESSAGES_PATH, 'devtok', { channelId: 'c1', body: 'bridge reply' }), r);
  assert.equal(r.status, 200);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].actor.subject, 'user_bridge');
  assert.equal(captured[0].actor.tenantId, 'tenant-real');
  assert.equal(captured[0].actor.role, 'owner');
  assert.equal(captured[0].actor.viaDeviceToken, true);
});

test('device token: a link whose tenant the subject is NOT a member of still refuses with 403', async (t) => {
  const memberships = withSubject(BRIDGE_MEMBERSHIPS, 'user_bridge');
  const { admin, captured } = await makeAdmin(t, { memberships, link: { subject: 'user_bridge', tenantId: 'tenant-stranger' } });
  const r = fakeResponse();
  await admin.handler(devicePost(LIVE_ADMIN_ENVOY_MESSAGES_PATH, 'devtok', { channelId: 'c1', body: 'bridge reply' }), r);
  assert.equal(r.status, 403);
  assert.equal(captured.length, 0);
});

test('device token: an unknown token still refuses with 403', async (t) => {
  const memberships = withSubject(BRIDGE_MEMBERSHIPS, 'user_bridge');
  const { admin, captured } = await makeAdmin(t, { memberships, link: { subject: 'user_bridge', tenantId: 'tenant-real' } });
  const r = fakeResponse();
  await admin.handler(devicePost(LIVE_ADMIN_ENVOY_MESSAGES_PATH, 'wrongtok', { channelId: 'c1', body: 'bridge reply' }), r);
  assert.equal(r.status, 403);
  assert.equal(captured.length, 0);
});
