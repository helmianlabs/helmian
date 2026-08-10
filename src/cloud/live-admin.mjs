import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { assertExpectedNeonEndpoint } from '../core/database-target.mjs';
import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';
import { inspectHelmianCloudDeployment } from './deployment-contract.mjs';
import { createIdentityGateway } from './identity-gateway.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = join(here, '..', '..', 'web', 'cloud-admin', 'index.html');

function send(response, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  response.end(body);
}

function cookieValue(request, name) {
  const cookies = String(request.headers.cookie ?? '').split(';').map((part) => part.trim());
  const prefix = `${name}=`;
  return cookies.find((part) => part.startsWith(prefix))?.slice(prefix.length) ?? '';
}

function cookieOptions(request) {
  const secure = request.headers['x-forwarded-proto'] === 'https' || process.env.HELMION_ADMIN_COOKIE_SECURE === 'true';
  return `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export async function createLiveHelmianCloudAdminHandler({ env = process.env, fetchImpl = fetch } = {}) {
  const connectionString = String(env.HELMION_DATABASE_URL ?? '').trim();
  const expectedEndpointId = String(env.HELMION_EXPECTED_ENDPOINT_ID ?? '').trim();
  if (!connectionString || !expectedEndpointId) throw new Error('Live admin requires HELMION_DATABASE_URL and HELMION_EXPECTED_ENDPOINT_ID');
  assertExpectedNeonEndpoint(connectionString, expectedEndpointId);
  const identity = createIdentityGateway({ env, fetchImpl });
  const page = await readFile(pagePath, 'utf8');
  const pool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 5 });
  const sessionIdentity = (request) => identity.getSession(cookieValue(request, 'helmion_admin_session'));

  async function controlSurface(actor) {
    if (!actor?.tenantId || !['owner', 'admin'].includes(actor.role)) throw Object.assign(new Error('Admin tenant membership required'), { status: 403 });
    const context = { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: randomUUID(), requestId: randomUUID() };
    return withTenantTransaction(pool, context, async (client) => {
      await requireActiveTenantMembership(client, context);
      const [tenant, audit, outbox] = await Promise.all([
        client.query('select tenant_id, display_name from helmion.tenants where tenant_id=$1', [context.tenantId]),
        client.query('select count(*)::integer as count from helmion.audit_events where tenant_id=$1', [context.tenantId]),
        client.query('select count(*)::integer as count from helmion.audit_outbox where tenant_id=$1 and delivered_at is null', [context.tenantId]),
      ]);
      if (tenant.rowCount !== 1) throw Object.assign(new Error('Tenant was not found'), { status: 404 });
      const deployment = inspectHelmianCloudDeployment(env);
      return {
        format: 'helmion.cloud-admin-control-surface.v2',
        tenant: tenant.rows[0],
        actor: { subject: actor.subject, role: actor.role },
        sections: [
          { id: 'tenant', state: 'live', action: 'view_tenant_scope' },
          { id: 'integrations', state: 'configuration_readiness', action: 'view_connection_readiness' },
          { id: 'audit', state: 'live', action: 'view_tenant_audit_posture' },
        ],
        database: { connected: true, targetVerified: true, environment: deployment.environment, provider: deployment.provider },
        audit: { eventCount: audit.rows[0]?.count ?? 0, pendingOutboxCount: outbox.rows[0]?.count ?? 0 },
        authorization: 'oidc_identity_plus_neon_membership_verified',
        invocation: 'read_only',
        mutation: 'not_performed',
      };
    });
  }

  async function handler(request, response, requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)) {
    if (request.method === 'GET' && requestUrl.pathname === '/') { send(response, 200, page, 'text/html; charset=utf-8'); return true; }
    if (request.method === 'GET' && requestUrl.pathname === '/auth/login') {
      try { const login = await identity.beginLogin(); send(response, 302, '', 'text/plain; charset=utf-8', { location: login.url, 'set-cookie': `helmion_admin_login_state=${login.state}; ${cookieOptions(request)}` }); }
      catch { send(response, 503, JSON.stringify({ error: 'identity_gateway_unavailable', code: 'ADMIN_IDENTITY_NOT_CONFIGURED' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/auth/callback') {
      try {
        const code = requestUrl.searchParams.get('code') ?? '';
        const state = requestUrl.searchParams.get('state') ?? '';
        if (!code || state !== cookieValue(request, 'helmion_admin_login_state')) throw new Error('OIDC callback state invalid');
        const result = await identity.finishLogin(code, state);
        send(response, 302, '', 'text/plain; charset=utf-8', { location: '/', 'set-cookie': [`helmion_admin_session=${result.sessionId}; ${cookieOptions(request)}`, `helmion_admin_login_state=; Max-Age=0; ${cookieOptions(request)}`] });
      } catch { send(response, 401, JSON.stringify({ error: 'identity_callback_rejected', code: 'ADMIN_IDENTITY_REJECTED' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/session') {
      const actor = sessionIdentity(request);
      send(response, actor ? 200 : 401, JSON.stringify(actor ? { authenticated: true, actor: { subject: actor.subject, tenantId: actor.tenantId, role: actor.role } } : { authenticated: false }));
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/admin/control-surface') {
      try { send(response, 200, JSON.stringify({ valid: true, result: await controlSurface(sessionIdentity(request)) })); }
      catch (error) { send(response, error.status ?? 500, JSON.stringify({ valid: false, code: error.status === 403 ? 'ADMIN_MEMBERSHIP_REQUIRED' : 'ADMIN_DATABASE_READ_FAILED' })); }
      return true;
    }
    return false;
  }

  return Object.freeze({
    handler,
    close: () => pool.end(),
  });
}

export async function startLiveHelmianCloudAdmin({ host = '127.0.0.1', port = 7431, env = process.env } = {}) {
  const live = await createLiveHelmianCloudAdminHandler({ env });
  const server = createServer((request, response) => {
    void live.handler(request, response).then((handled) => { if (!handled) send(response, 404, JSON.stringify({ valid: false, code: 'CLOUD_ADMIN_ROUTE_NOT_FOUND' })); }).catch(() => send(response, 500, JSON.stringify({ valid: false, code: 'CLOUD_ADMIN_INTERNAL_ERROR' })));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const address = server.address();
  return { url: `http://${host}:${address.port}`, close: async () => { await live.close(); return new Promise((resolve) => server.close(resolve)); } };
}
