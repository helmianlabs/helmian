import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  CLOUD_INTEGRATION_IDS,
  HERALD_PHONE_COMPANION,
  listToggleableCloudIntegrations,
  normalizeIntegrationToggle,
} from '../src/cloud/integration-registry.mjs';
import { createLiveHelmianCloudAdminHandler } from '../src/cloud/live-admin.mjs';

const ACTOR = { subject: 'user_admin_1', tenantId: 'acme-operations', role: 'admin' };
const ENV = {
  HELMION_DATABASE_URL: 'postgresql://user:password@ep-test.neon.tech/helmion?sslmode=require',
  HELMION_EXPECTED_ENDPOINT_ID: 'ep-test',
  HELMION_CLOUD_ENVIRONMENT: 'staging',
  HELMION_CORA_PROVIDER: 'openai',
  HELMION_CORA_TOKEN: 't'.repeat(32),
  OPENAI_API_KEY: 'k'.repeat(32),
  HELMION_ADMIN_COOKIE_SECURE: 'true',
};

test('cloud integration catalog keeps Herald phone-only and exposes four toggleable ids', () => {
  assert.deepEqual(CLOUD_INTEGRATION_IDS, ['envoy', 'discord', 'slack', 'github']);
  assert.equal(HERALD_PHONE_COMPANION.toggleable, false);
  assert.equal(HERALD_PHONE_COMPANION.state, 'phone_only');
  const rows = listToggleableCloudIntegrations([]);
  assert.deepEqual(rows.map((row) => row.integration_id), CLOUD_INTEGRATION_IDS);
  assert.ok(rows.every((row) => row.enabled === false && row.connection_state === 'not_connected'));
});

test('toggle input rejects unknown providers and non-boolean state', () => {
  assert.deepEqual(normalizeIntegrationToggle({ integration_id: 'SLACK', enabled: true }), {
    integration_id: 'slack', enabled: true,
  });
  assert.throws(() => normalizeIntegrationToggle({ integration_id: 'herald', enabled: true }));
  assert.throws(() => normalizeIntegrationToggle({ integration_id: 'github', enabled: 'true' }));
});

test('cloud admin UI is wired to the authenticated session, toggle route, and phone-only Herald label', async () => {
  const html = await readFile(new URL('../web/cloud-admin/index.html', import.meta.url), 'utf8');
  assert.match(html, /fetch\('\/api\/session'/);
  assert.match(html, /method: 'PATCH'/);
  assert.match(html, /surface\.integrations/);
  assert.match(html, /Phone app only/);
});

class FakePool {
  constructor() {
    this.integrations = new Map();
    this.auditEvents = [];
  }

  async connect() {
    return { query: (sql, values) => this.query(sql, values), release() {} };
  }

  async end() {}

  async query(sql, values = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(normalized)) return { rowCount: 0, rows: [] };
    if (normalized.startsWith('select set_config')) return { rowCount: 1, rows: [] };
    if (normalized.startsWith('select role from helmion.tenant_memberships')) {
      return { rowCount: 1, rows: [{ role: ACTOR.role }] };
    }
    if (normalized.startsWith('select tenant_id, display_name from helmion.tenants')) {
      return { rowCount: 1, rows: [{ tenant_id: ACTOR.tenantId, display_name: 'Acme Operations' }] };
    }
    if (normalized.startsWith('select count(*)::integer as count from helmion.audit_events')) {
      return { rowCount: 1, rows: [{ count: this.auditEvents.length }] };
    }
    if (normalized.startsWith('select count(*)::integer as count from helmion.audit_outbox')) {
      return { rowCount: 1, rows: [{ count: 0 }] };
    }
    if (normalized.startsWith('select integration_id, enabled, updated_at from helmion.cloud_integrations')) {
      return { rowCount: this.integrations.size, rows: [...this.integrations.values()] };
    }
    if (normalized.startsWith('select integration_id, enabled, updated_at from helmion.cloud_integrations where')) {
      const row = this.integrations.get(values[1]);
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    }
    if (normalized.startsWith('insert into helmion.cloud_integrations')) {
      const row = { integration_id: values[1], enabled: values[2], updated_at: '2026-08-16T12:00:00.000Z' };
      this.integrations.set(values[1], row);
      return { rowCount: 1, rows: [row] };
    }
    if (normalized.startsWith('insert into helmion.audit_events')) {
      this.auditEvents.push({ values });
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected query: ${normalized}`);
  }
}

function request(method, url, body = '') {
  return {
    method,
    url,
    headers: { host: 'cloud.test', cookie: 'helmion_admin_session=session_1' },
    async *[Symbol.asyncIterator]() { if (body) yield body; },
  };
}

function response() {
  const value = { headers: {}, status: null, body: '' };
  return {
    value,
    writeHead(status, headers) { value.status = status; value.headers = headers; },
    end(body = '') { value.body = body; },
  };
}

test('authenticated admin control surface persists a toggle and audits the committed write', async () => {
  const pool = new FakePool();
  const app = await createLiveHelmianCloudAdminHandler({
    env: ENV,
    PoolClass: class { constructor() { return pool; } },
    identityGateway: { getSession: () => ACTOR },
  });
  const surfaceResponse = response();
  await app.handler(request('GET', '/api/admin/control-surface'), surfaceResponse);
  assert.equal(surfaceResponse.value.status, 200);
  const surface = JSON.parse(surfaceResponse.value.body);
  assert.equal(surface.result.integrations.length, 4);
  assert.equal(surface.result.phone_companion.state, 'phone_only');

  const toggleResponse = response();
  await app.handler(request('PATCH', '/api/admin/integrations/slack', '{"enabled":true}'), toggleResponse);
  assert.equal(toggleResponse.value.status, 200);
  const toggle = JSON.parse(toggleResponse.value.body);
  assert.equal(toggle.result.integration.integration_id, 'slack');
  assert.equal(toggle.result.integration.enabled, true);
  assert.equal(pool.integrations.get('slack').enabled, true);
  assert.equal(pool.auditEvents.length, 1);
  assert.match(String(pool.auditEvents[0].values[5]), /cloud_integration_toggle/);

  const refreshed = response();
  await app.handler(request('GET', '/api/admin/control-surface'), refreshed);
  const next = JSON.parse(refreshed.value.body);
  assert.equal(next.result.integrations.find((row) => row.integration_id === 'slack').enabled, true);
  await app.close();
});

test('OIDC login and callback write bounded cookies that feed the admin session endpoint', async () => {
  const pool = new FakePool();
  const app = await createLiveHelmianCloudAdminHandler({
    env: ENV,
    PoolClass: class { constructor() { return pool; } },
    identityGateway: {
      beginLogin: async () => ({ url: 'https://issuer.example/authorize?state=state_1', state: 'state_1' }),
      finishLogin: async () => ({ sessionId: 'session_1' }),
      getSession: () => ACTOR,
    },
  });
  const loginResponse = response();
  await app.handler(request('GET', '/auth/login'), loginResponse);
  assert.equal(loginResponse.value.status, 302);
  assert.equal(loginResponse.value.headers.location, 'https://issuer.example/authorize?state=state_1');
  assert.match(loginResponse.value.headers['set-cookie'], /HttpOnly/);
  assert.match(loginResponse.value.headers['set-cookie'], /Max-Age=600/);

  const callbackRequest = request('GET', '/auth/callback?code=one-time&state=state_1');
  callbackRequest.headers.cookie = 'helmion_admin_login_state=state_1';
  const callbackResponse = response();
  await app.handler(callbackRequest, callbackResponse);
  assert.equal(callbackResponse.value.status, 302);
  assert.match(callbackResponse.value.headers['set-cookie'][0], /helmion_admin_session=session_1/);
  assert.match(callbackResponse.value.headers['set-cookie'][0], /Max-Age=28800/);

  const sessionResponse = response();
  await app.handler(request('GET', '/api/session'), sessionResponse);
  assert.equal(sessionResponse.value.status, 200);
  assert.equal(JSON.parse(sessionResponse.value.body).actor.tenantId, ACTOR.tenantId);
  await app.close();
});
