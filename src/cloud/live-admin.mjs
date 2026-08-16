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
import {
  HERALD_PHONE_COMPANION,
  listToggleableCloudIntegrations,
  normalizeIntegrationToggle,
  publicCloudIntegration,
} from './integration-registry.mjs';

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

function cookieOptions(request, env, maxAgeSeconds = null) {
  const secure = request.headers['x-forwarded-proto'] === 'https' || env.HELMION_ADMIN_COOKIE_SECURE === 'true';
  return `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}${maxAgeSeconds == null ? '' : `; Max-Age=${maxAgeSeconds}`}`;
}

async function readJson(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk.toString('utf8');
    if (text.length > 16_384) throw Object.assign(new Error('Request body is too large'), { status: 413 });
  }
  try { return JSON.parse(text || '{}'); }
  catch { throw Object.assign(new Error('Request body is invalid JSON'), { status: 400 }); }
}

function adminContext(actor) {
  if (!actor) {
    throw Object.assign(new Error('Admin session required'), { status: 401 });
  }
  if (!actor.tenantId || !['owner', 'admin'].includes(actor.role)) {
    throw Object.assign(new Error('Admin tenant membership required'), { status: 403 });
  }
  return {
    tenantId: actor.tenantId,
    actorSubject: actor.subject,
    actorRole: actor.role,
    sessionId: randomUUID(),
    requestId: randomUUID(),
  };
}

function errorStatus(error) {
  return Number(error?.status) || 500;
}

function errorCode(error, fallback = 'ADMIN_DATABASE_READ_FAILED') {
  const status = errorStatus(error);
  if (status === 400) return 'CLOUD_ADMIN_REQUEST_INVALID';
  if (status === 401) return 'ADMIN_SESSION_REQUIRED';
  if (status === 403) return 'ADMIN_MEMBERSHIP_REQUIRED';
  if (status === 404) return 'CLOUD_INTEGRATION_NOT_FOUND';
  return fallback;
}

export async function createLiveHelmianCloudAdminHandler({
  env = process.env,
  fetchImpl = fetch,
  identityGateway = null,
  PoolClass = Pool,
} = {}) {
  const connectionString = String(env.HELMION_DATABASE_URL ?? '').trim();
  const expectedEndpointId = String(env.HELMION_EXPECTED_ENDPOINT_ID ?? '').trim();
  if (!connectionString || !expectedEndpointId) throw new Error('Live admin requires HELMION_DATABASE_URL and HELMION_EXPECTED_ENDPOINT_ID');
  assertExpectedNeonEndpoint(connectionString, expectedEndpointId);
  const identity = identityGateway ?? createIdentityGateway({ env, fetchImpl });
  const page = await readFile(pagePath, 'utf8');
  const pool = new PoolClass({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 5 });
  const sessionIdentity = (request) => identity.getSession(cookieValue(request, 'helmion_admin_session'));

  async function controlSurface(actor) {
    const context = adminContext(actor);
    return withTenantTransaction(pool, context, async (client) => {
      await requireActiveTenantMembership(client, context);
      const [tenant, audit, outbox, integrations] = await Promise.all([
        client.query('select tenant_id, display_name from helmion.tenants where tenant_id=$1', [context.tenantId]),
        client.query('select count(*)::integer as count from helmion.audit_events where tenant_id=$1', [context.tenantId]),
        client.query('select count(*)::integer as count from helmion.audit_outbox where tenant_id=$1 and delivered_at is null', [context.tenantId]),
        client.query('select integration_id, enabled, updated_at from helmion.cloud_integrations where tenant_id=$1 order by integration_id', [context.tenantId]),
      ]);
      if (tenant.rowCount !== 1) throw Object.assign(new Error('Tenant was not found'), { status: 404 });
      const deployment = inspectHelmianCloudDeployment(env);
      return {
        format: 'helmion.cloud-admin-control-surface.v2',
        tenant: tenant.rows[0],
        actor: { subject: actor.subject, role: actor.role },
        sections: [
          { id: 'tenant', state: 'live', action: 'view_tenant_scope' },
          { id: 'integrations', state: 'configuration_readiness', action: 'view_and_toggle_connection_readiness' },
          { id: 'audit', state: 'live', action: 'view_tenant_audit_posture' },
        ],
        integrations: listToggleableCloudIntegrations(integrations.rows),
        phone_companion: HERALD_PHONE_COMPANION,
        database: { connected: true, targetVerified: true, environment: deployment.environment, provider: deployment.provider },
        audit: { eventCount: audit.rows[0]?.count ?? 0, pendingOutboxCount: outbox.rows[0]?.count ?? 0 },
        authorization: 'oidc_identity_plus_neon_membership_verified',
        invocation: 'read_only',
        mutation: 'not_performed',
      };
    });
  }

  async function toggleIntegration(actor, request, integrationId) {
    const context = adminContext(actor);
    const requested = normalizeIntegrationToggle({ ...(await readJson(request)), integration_id: integrationId });
    return withTenantTransaction(pool, context, async (client) => {
      await requireActiveTenantMembership(client, context);
      const previous = await client.query(
        'select integration_id, enabled, updated_at from helmion.cloud_integrations where tenant_id=$1 and integration_id=$2',
        [context.tenantId, requested.integration_id],
      );
      const updated = await client.query(
        `insert into helmion.cloud_integrations(tenant_id,integration_id,enabled,updated_by,updated_at)
         values ($1,$2,$3,$4,clock_timestamp())
         on conflict (tenant_id,integration_id) do update set
           enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=clock_timestamp()
         returning integration_id,enabled,updated_at`,
        [context.tenantId, requested.integration_id, requested.enabled, context.actorSubject],
      );
      await client.query(
        `insert into helmion.audit_events
           (tenant_id,actor_subject,actor_role,session_id,request_id,action_type,
            canonical_target,policy_version,decision,before_ref,after_ref,
            privacy_summary,result)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          context.tenantId, context.actorSubject, context.actorRole, context.sessionId,
          context.requestId, 'cloud_integration_toggle',
          { integration_id: requested.integration_id }, 'helmion.cloud-integrations.v1', 'ALLOW',
          previous.rows[0] ? { enabled: previous.rows[0].enabled === true } : null,
          { enabled: requested.enabled },
          'Tenant integration availability changed; provider credentials and invocations are outside this seam.',
          { changed: previous.rows[0]?.enabled !== requested.enabled },
        ],
      );
      return {
        format: 'helmion.cloud-integration-toggle.v1',
        integration: publicCloudIntegration(updated.rows[0]),
        authorization: 'oidc_identity_plus_neon_membership_verified',
        invocation: 'not_performed',
      };
    });
  }

  async function handler(request, response, requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)) {
    if (request.method === 'GET' && requestUrl.pathname === '/') { send(response, 200, page, 'text/html; charset=utf-8'); return true; }
    if (request.method === 'GET' && requestUrl.pathname === '/auth/login') {
      try { const login = await identity.beginLogin(); send(response, 302, '', 'text/plain; charset=utf-8', { location: login.url, 'set-cookie': `helmion_admin_login_state=${login.state}; ${cookieOptions(request, env, 600)}` }); }
      catch { send(response, 503, JSON.stringify({ error: 'identity_gateway_unavailable', code: 'ADMIN_IDENTITY_NOT_CONFIGURED' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/auth/callback') {
      try {
        const code = requestUrl.searchParams.get('code') ?? '';
        const state = requestUrl.searchParams.get('state') ?? '';
        if (!code || state !== cookieValue(request, 'helmion_admin_login_state')) throw new Error('OIDC callback state invalid');
        const result = await identity.finishLogin(code, state);
        send(response, 302, '', 'text/plain; charset=utf-8', { location: '/', 'set-cookie': [`helmion_admin_session=${result.sessionId}; ${cookieOptions(request, env, 8 * 60 * 60)}`, `helmion_admin_login_state=; ${cookieOptions(request, env, 0)}`] });
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
      catch (error) { send(response, errorStatus(error), JSON.stringify({ valid: false, code: errorCode(error) })); }
      return true;
    }
    if (request.method === 'PATCH' && /^\/api\/admin\/integrations\/[^/]+$/.test(requestUrl.pathname)) {
      try {
        const integrationId = decodeURIComponent(requestUrl.pathname.split('/').at(-1));
        send(response, 200, JSON.stringify({ valid: true, result: await toggleIntegration(sessionIdentity(request), request, integrationId) }));
      } catch (error) {
        send(response, errorStatus(error), JSON.stringify({ valid: false, code: errorCode(error, 'CLOUD_INTEGRATION_WRITE_FAILED') }));
      }
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
