import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { assertExpectedNeonEndpoint } from '../core/database-target.mjs';
import { requireActiveTenantMembership, TenantAuthorizationError, withTenantTransaction } from '../core/tenant-context.mjs';
import { listExpectedMigrationManifest } from '../adapters/neon.mjs';
import {
  AIMFORGE_BOARD_TOOL_NAME,
  AIMFORGE_DEPARTMENT_HANDOFF_TOOL_NAME,
  AIMFORGE_PREPARE_DRIVER_MESSAGE_TOOL_NAME,
} from '../cora/aimforge-board-action.mjs';
import { inspectHelmianCloudDeployment } from './deployment-contract.mjs';
import { createIdentityGateway } from './identity-gateway.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = join(here, '..', '..', 'web', 'cloud-admin', 'index.html');
const scriptPath = join(here, '..', '..', 'web', 'cloud-admin', 'app.js');

export const LIVE_ADMIN_PAGE_PATH = '/admin';
export const LIVE_ADMIN_SCRIPT_PATH = '/admin/assets/app.js';
export const LIVE_ADMIN_LOGIN_PATH = '/admin/auth/login';
export const LIVE_ADMIN_CALLBACK_PATH = '/admin/auth/callback';
export const LIVE_ADMIN_LOGOUT_PATH = '/admin/auth/logout';
export const LIVE_ADMIN_SESSION_PATH = '/api/admin/session';
export const LIVE_ADMIN_CONTROL_PATH = '/api/admin/control-surface';

const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'unsafe-inline'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

export function shouldMountLiveAdmin(env = process.env) {
  const cloud = ['staging', 'production'].includes(String(env.HELMION_CLOUD_ENVIRONMENT ?? '').trim().toLowerCase());
  const configured = [env.HELMION_ADMIN_ISSUER, env.HELMION_ADMIN_CLIENT_ID, env.HELMION_ADMIN_REDIRECT_URI]
    .some((value) => String(value ?? '').trim());
  return cloud || configured;
}

function send(response, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...SECURITY_HEADERS, ...extra });
  response.end(body);
}

function cookieValue(request, name) {
  const cookies = String(request.headers.cookie ?? '').split(';').map((part) => part.trim());
  const prefix = `${name}=`;
  return cookies.find((part) => part.startsWith(prefix))?.slice(prefix.length) ?? '';
}

function cookieOptions(path) {
  return `Path=${path}; HttpOnly; Secure; SameSite=Lax`;
}

export async function createLiveHelmianCloudAdminHandler({
  env = process.env,
  fetchImpl = fetch,
  pool: suppliedPool = null,
  identity: suppliedIdentity = null,
  page: suppliedPage = null,
  script: suppliedScript = null,
  expectedMigrations: suppliedMigrations = null,
} = {}) {
  const connectionString = String(env.HELMION_DATABASE_URL ?? '').trim();
  const expectedEndpointId = String(env.HELMION_EXPECTED_ENDPOINT_ID ?? '').trim();
  if (!connectionString || !expectedEndpointId) throw new Error('Live admin requires HELMION_DATABASE_URL and HELMION_EXPECTED_ENDPOINT_ID');
  assertExpectedNeonEndpoint(connectionString, expectedEndpointId);
  const identity = suppliedIdentity ?? createIdentityGateway({ env, fetchImpl });
  const page = suppliedPage ?? await readFile(pagePath, 'utf8');
  const script = suppliedScript ?? await readFile(scriptPath, 'utf8');
  const expectedMigrations = suppliedMigrations ?? await listExpectedMigrationManifest();
  const ownsPool = !suppliedPool;
  const pool = suppliedPool ?? new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 5 });
  const sessionIdentity = (request) => identity.getSession(cookieValue(request, 'helmion_admin_session'));

  async function deriveAdminActor(request) {
    const claimed = sessionIdentity(request);
    if (!claimed?.subject) throw Object.assign(new Error('Admin identity required'), { status: 403 });
    const client = await pool.connect();
    try {
      const membership = await client.query(
        `select tenant_id, role from helmion.tenant_memberships
         where subject=$1 and active and role in ('owner','admin')
         order by tenant_id`,
        [claimed.subject],
      );
      const role = membership.rowCount === 1 ? membership.rows[0]?.role : null;
      if (!['owner', 'admin'].includes(role)) throw Object.assign(new Error('Admin tenant membership required'), { status: 403 });
      return { subject: claimed.subject, tenantId: membership.rows[0].tenant_id, role };
    } finally { client.release(); }
  }

  function actorContext(actor) {
    if (!actor?.tenantId || !['owner', 'admin'].includes(actor.role)) throw Object.assign(new Error('Admin tenant membership required'), { status: 403 });
    return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: randomUUID(), requestId: randomUUID() };
  }

  async function activeActor(request) {
    const actor = await deriveAdminActor(request);
    const context = actorContext(actor);
    await withTenantTransaction(pool, context, async (client) => {
      await requireActiveTenantMembership(client, context);
      return {};
    });
    return actor;
  }

  async function controlSurface(actor) {
    const context = actorContext(actor);
    return withTenantTransaction(pool, context, async (client) => {
      await requireActiveTenantMembership(client, context);
      const [tenant, audit, outbox, migrationTable] = await Promise.all([
        client.query('select tenant_id, display_name from helmion.tenants where tenant_id=$1', [context.tenantId]),
        client.query('select count(*)::integer as count from helmion.audit_events where tenant_id=$1', [context.tenantId]),
        client.query('select count(*)::integer as count from helmion.audit_outbox where tenant_id=$1 and delivered_at is null', [context.tenantId]),
        client.query("select to_regclass('helmion.schema_migrations') as migration_table"),
      ]);
      const applied = migrationTable.rows[0]?.migration_table
        ? await client.query('select version, name, checksum from helmion.schema_migrations order by version')
        : { rows: [] };
      if (tenant.rowCount !== 1) throw Object.assign(new Error('Tenant was not found'), { status: 404 });
      const deployment = inspectHelmianCloudDeployment(env);
      const appliedByVersion = new Map(applied.rows.map((row) => [row.version, row]));
      const migrationStates = expectedMigrations.map((migration) => {
        const row = appliedByVersion.get(migration.version);
        return !row ? 'pending' : row.name === migration.name && row.checksum === migration.checksum ? 'applied' : 'mismatch';
      });
      const expectedVersions = new Set(expectedMigrations.map((migration) => migration.version));
      const unexpectedCount = applied.rows.filter((row) => !expectedVersions.has(row.version)).length;
      const toolNames = [
        AIMFORGE_BOARD_TOOL_NAME,
        AIMFORGE_PREPARE_DRIVER_MESSAGE_TOOL_NAME,
        AIMFORGE_DEPARTMENT_HANDOFF_TOOL_NAME,
      ];
      return {
        format: 'helmion.cloud-admin-control-surface.v2',
        tenant: tenant.rows[0],
        actor: { subject: actor.subject, role: actor.role },
        sections: [
          { id: 'tools', state: 'read_only', action: 'view_bounded_tool_release' },
          { id: 'release', state: deployment.ready ? 'ready' : 'blocked', action: 'view_release_preflight' },
          { id: 'migrations', state: migrationStates.every((state) => state === 'applied') && unexpectedCount === 0 ? 'ready' : 'blocked', action: 'view_migration_readiness' },
          { id: 'audit', state: 'read_only', action: 'view_tenant_audit_posture' },
        ],
        database: { connected: true, targetVerified: true, environment: deployment.environment, provider: deployment.provider },
        tools: { count: toolNames.length, names: toolNames, genericTools: false, invocation: 'not_performed' },
        release: { ready: deployment.ready, missingEnvironmentNames: deployment.missing },
        migrations: {
          expectedCount: expectedMigrations.length,
          appliedCount: migrationStates.filter((state) => state === 'applied').length,
          pendingCount: migrationStates.filter((state) => state === 'pending').length,
          mismatchCount: migrationStates.filter((state) => state === 'mismatch').length,
          unexpectedCount,
          ready: migrationStates.every((state) => state === 'applied') && unexpectedCount === 0,
        },
        audit: { eventCount: audit.rows[0]?.count ?? 0, pendingOutboxCount: outbox.rows[0]?.count ?? 0 },
        authorization: 'oidc_identity_plus_neon_membership_verified',
        invocation: 'read_only',
        mutation: 'not_performed',
      };
    });
  }

  async function handler(request, response, requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)) {
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_PAGE_PATH) { send(response, 308, '', 'text/plain; charset=utf-8', { location: `${LIVE_ADMIN_PAGE_PATH}/` }); return true; }
    if (request.method === 'GET' && requestUrl.pathname === `${LIVE_ADMIN_PAGE_PATH}/`) { send(response, 200, page, 'text/html; charset=utf-8'); return true; }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_SCRIPT_PATH) { send(response, 200, script, 'text/javascript; charset=utf-8'); return true; }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_LOGIN_PATH) {
      try { const login = await identity.beginLogin(); send(response, 302, '', 'text/plain; charset=utf-8', { location: login.url, 'set-cookie': `helmion_admin_login_state=${login.state}; ${cookieOptions('/admin')}` }); }
      catch { send(response, 503, JSON.stringify({ error: 'identity_gateway_unavailable', code: 'ADMIN_IDENTITY_NOT_CONFIGURED' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_CALLBACK_PATH) {
      try {
        const code = requestUrl.searchParams.get('code') ?? '';
        const state = requestUrl.searchParams.get('state') ?? '';
        if (!code || state !== cookieValue(request, 'helmion_admin_login_state')) throw new Error('OIDC callback state invalid');
        const result = await identity.finishLogin(code, state);
        send(response, 302, '', 'text/plain; charset=utf-8', { location: `${LIVE_ADMIN_PAGE_PATH}/`, 'set-cookie': [
          `helmion_admin_session=${result.sessionId}; ${cookieOptions('/admin')}`,
          `helmion_admin_session=${result.sessionId}; ${cookieOptions('/api/admin')}`,
          `helmion_admin_login_state=; Max-Age=0; ${cookieOptions('/admin')}`,
        ] });
      } catch { send(response, 401, JSON.stringify({ error: 'identity_callback_rejected', code: 'ADMIN_IDENTITY_REJECTED' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_SESSION_PATH) {
      try {
        const actor = await activeActor(request);
        send(response, 200, JSON.stringify({ authenticated: true, actor: { subject: actor.subject, tenantId: actor.tenantId, role: actor.role } }));
      } catch (error) {
        const denied = error?.status === 403 || error instanceof TenantAuthorizationError;
        send(response, denied ? 403 : 503, JSON.stringify({ authenticated: false, code: denied ? 'ADMIN_MEMBERSHIP_REQUIRED' : 'ADMIN_DATABASE_READ_FAILED' }));
      }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_LOGOUT_PATH) {
      identity.revokeSession?.(cookieValue(request, 'helmion_admin_session'));
      send(response, 302, '', 'text/plain; charset=utf-8', { location: `${LIVE_ADMIN_PAGE_PATH}/`, 'set-cookie': [
        `helmion_admin_session=; Max-Age=0; ${cookieOptions('/admin')}`,
        `helmion_admin_session=; Max-Age=0; ${cookieOptions('/api/admin')}`,
      ] });
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_CONTROL_PATH) {
      try {
        const actor = await activeActor(request);
        send(response, 200, JSON.stringify({ valid: true, result: await controlSurface(actor) }));
      }
      catch (error) {
        const denied = error?.status === 403 || error instanceof TenantAuthorizationError;
        send(response, denied ? 403 : 500, JSON.stringify({ valid: false, code: denied ? 'ADMIN_MEMBERSHIP_REQUIRED' : 'ADMIN_DATABASE_READ_FAILED' }));
      }
      return true;
    }
    if (requestUrl.pathname.startsWith('/admin') || requestUrl.pathname.startsWith('/api/admin')) {
      const methodAllowed = request.method === 'GET';
      send(response, methodAllowed ? 404 : 405, JSON.stringify({ valid: false, code: methodAllowed ? 'CLOUD_ADMIN_ROUTE_NOT_FOUND' : 'CLOUD_ADMIN_METHOD_NOT_ALLOWED' }), 'application/json; charset=utf-8', methodAllowed ? {} : { allow: 'GET' });
      return true;
    }
    return false;
  }

  return Object.freeze({
    handler,
    close: () => ownsPool ? pool.end() : Promise.resolve(),
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
