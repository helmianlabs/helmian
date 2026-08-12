import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { assertExpectedNeonEndpoint } from '../core/database-target.mjs';
import { requireActiveTenantMembership, TenantAuthorizationError, withTenantTransaction } from '../core/tenant-context.mjs';
import { listExpectedMigrationManifest } from '../adapters/neon.mjs';
import { inspectHelmianCloudDeployment } from './deployment-contract.mjs';
import { createIdentityGateway } from './identity-gateway.mjs';
import {
  ActionPolicyConflictError,
  HELMIAN_ACTION_TOOL_NAMES,
  auditActionPolicyAttempt,
  normalizeEnabledActionNames,
  readAdminActionPolicy,
  resolvePlatformActionPolicy,
  updateAdminActionPolicy,
} from './tenant-action-policy.mjs';
import { AIMFORGE_EQUIPMENT_SAFETY_TOOL_NAMES } from '../cora/aimforge-board-action.mjs';
import { buildMaestroWorkspaceSnapshot } from './maestro-workspace.mjs';

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
export const LIVE_ADMIN_EVENTS_PATH = '/api/admin/events';
export const LIVE_ADMIN_WORKSPACE_PATH = '/api/admin/workspace';
export const LIVE_ADMIN_ACTION_POLICY_PATH = '/api/admin/action-policy';
export const LIVE_ADMIN_ACTION_POLICY_PREVIEW_PATH = '/api/admin/action-policy/preview';
export const LIVE_ADMIN_ACTION_POLICY_CONFIRM_PATH = '/api/admin/action-policy/confirm';

const MAX_ADMIN_BODY_BYTES = 16 * 1024;
const MAX_PENDING_PREVIEWS = 256;
const PREVIEW_TTL_MS = 5 * 60 * 1000;

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

function policyEtag(version) {
  return `\"helmion-action-policy-v${version}\"`;
}

function expectedVersion(request) {
  const match = /^"helmion-action-policy-v([0-9]+)"$/u.exec(String(request.headers['if-match'] ?? ''));
  if (!match) throw Object.assign(new Error('A current action-policy If-Match header is required'), { status: 428, code: 'ACTION_POLICY_PRECONDITION_REQUIRED' });
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version)) throw Object.assign(new Error('Action-policy If-Match header is invalid'), { status: 400, code: 'ACTION_POLICY_INPUT_INVALID' });
  return version;
}

async function readJsonObject(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(String(request.headers['content-type'] ?? '').trim())) {
    throw Object.assign(new Error('application/json is required'), { status: 415, code: 'ACTION_POLICY_MEDIA_TYPE_REQUIRED' });
  }
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_ADMIN_BODY_BYTES) {
    throw Object.assign(new Error('Request body is too large'), { status: 413, code: 'ACTION_POLICY_BODY_TOO_LARGE' });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_ADMIN_BODY_BYTES) throw Object.assign(new Error('Request body is too large'), { status: 413, code: 'ACTION_POLICY_BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks, total).toString('utf8')); }
  catch { throw Object.assign(new Error('Request body is not valid JSON'), { status: 400, code: 'ACTION_POLICY_INPUT_INVALID' }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('Request body must be an object'), { status: 400, code: 'ACTION_POLICY_INPUT_INVALID' });
  }
  return value;
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw Object.assign(new Error('Request body has unexpected fields'), { status: 400, code: 'ACTION_POLICY_INPUT_INVALID' });
  }
}

export async function createLiveHelmianCloudAdminHandler({
  env = process.env,
  fetchImpl = fetch,
  pool: suppliedPool = null,
  identity: suppliedIdentity = null,
  page: suppliedPage = null,
  script: suppliedScript = null,
  expectedMigrations: suppliedMigrations = null,
  logger = () => {},
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
  const pendingPreviews = new Map();
  const prunePreviews = () => {
    const now = Date.now();
    for (const [id, preview] of pendingPreviews) if (preview.expiresAt <= now) pendingPreviews.delete(id);
  };
  const noteAttempt = (event, outcome, detail = null) => {
    try {
      logger({
        level: outcome === 'allowed' ? 'info' : 'warn',
        event,
        outcome,
        ...(detail ? { detail } : {}),
      });
    } catch {
      // Logging is evidence, not authority. A logger failure must not turn an
      // already-committed policy write into a false failure response.
    }
  };

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
    const actionPolicy = await readAdminActionPolicy(pool, actorContext(actor));
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
      const toolNames = HELMIAN_ACTION_TOOL_NAMES;
      return {
        format: 'helmion.cloud-admin-control-surface.v3',
        tenant: tenant.rows[0],
        actor: { subject: actor.subject, role: actor.role },
        sections: [
          { id: 'tools', state: 'configurable', action: 'preview_then_confirm_platform_global_kill_switches' },
          { id: 'release', state: deployment.ready ? 'ready' : 'blocked', action: 'view_release_preflight' },
          { id: 'migrations', state: migrationStates.every((state) => state === 'applied') && unexpectedCount === 0 ? 'ready' : 'blocked', action: 'view_migration_readiness' },
          { id: 'audit', state: 'read_only', action: 'view_tenant_audit_posture' },
        ],
        database: { connected: true, targetVerified: true, environment: deployment.environment, provider: deployment.provider },
        tools: {
          count: toolNames.length,
          names: toolNames,
          genericTools: false,
          humeAttached: { count: 0, names: [] },
          helmianHands: {
            available: toolNames,
            enabled: actionPolicy.enabledActions,
            policyManaged: HELMIAN_ACTION_TOOL_NAMES,
            driverSafety: {
              available: AIMFORGE_EQUIPMENT_SAFETY_TOOL_NAMES,
              scope: 'signed_driver_mobile_session_with_server_focused_assignment',
              authority: 'aimforge_live_safety_service',
              holdRelease: false,
            },
            policyVersion: actionPolicy.version,
            policySource: actionPolicy.source,
            policyScope: actionPolicy.scope,
            effect: actionPolicy.effect,
          },
          invocation: 'not_performed',
        },
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

  async function recentAuditEvents(actor) {
    const context = actorContext(actor);
    return withTenantTransaction(pool, context, async (client) => {
      await requireActiveTenantMembership(client, context);
      const result = await client.query(
        `select id, action_type, decision, privacy_summary, created_at
         from helmion.audit_events
         where tenant_id=$1
         order by created_at desc, id desc
         limit 25`,
        [context.tenantId],
      );
      return result.rows.map((row) => ({
        id: String(row.id),
        actionType: String(row.action_type).slice(0, 120),
        decision: String(row.decision).slice(0, 40),
        summary: String(row.privacy_summary).slice(0, 240),
        createdAt: row.created_at,
      }));
    });
  }

  async function workspaceSnapshot(actor) {
    const events = await recentAuditEvents(actor);
    const agentEvents = events.map((event) => {
      const match = /^agent:([a-z0-9-]+):(idle|running|blocked|waiting)$/u.exec(event.actionType.toLowerCase());
      return match ? { agentId: match[1], status: match[2], lastAction: event.summary, occurredAt: event.createdAt } : null;
    }).filter(Boolean);
    return buildMaestroWorkspaceSnapshot({ tenantId: actor.tenantId, events: agentEvents });
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
        send(response, denied ? 403 : 503, JSON.stringify({ valid: false, code: denied ? 'ADMIN_MEMBERSHIP_REQUIRED' : 'ADMIN_DATABASE_READ_FAILED' }));
      }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_EVENTS_PATH) {
      try {
        const actor = await activeActor(request);
        send(response, 200, JSON.stringify({ valid: true, events: await recentAuditEvents(actor) }));
      } catch (error) {
        const denied = error?.status === 403 || error instanceof TenantAuthorizationError;
        send(response, denied ? 403 : 503, JSON.stringify({ valid: false, code: denied ? 'ADMIN_MEMBERSHIP_REQUIRED' : 'ADMIN_DATABASE_READ_FAILED' }));
      }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_WORKSPACE_PATH) {
      try {
        const actor = await activeActor(request);
        send(response, 200, JSON.stringify({ valid: true, workspace: await workspaceSnapshot(actor) }));
      } catch (error) {
        const denied = error?.status === 403 || error instanceof TenantAuthorizationError;
        send(response, denied ? 403 : 503, JSON.stringify({ valid: false, code: denied ? 'ADMIN_MEMBERSHIP_REQUIRED' : 'ADMIN_DATABASE_READ_FAILED' }));
      }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_ACTION_POLICY_PATH) {
      try {
        const actor = await activeActor(request);
        const policy = await readAdminActionPolicy(pool, actorContext(actor));
        noteAttempt('admin_action_policy_read', 'allowed');
        send(response, 200, JSON.stringify({ valid: true, policy, allowedActions: HELMIAN_ACTION_TOOL_NAMES }), 'application/json; charset=utf-8', { etag: policyEtag(policy.version) });
      } catch (error) {
        const denied = error?.status === 403 || error instanceof TenantAuthorizationError;
        noteAttempt('admin_action_policy_read', denied ? 'denied' : 'failed', denied ? 'membership' : 'database');
        send(response, denied ? 403 : 503, JSON.stringify({ valid: false, code: denied ? 'ADMIN_MEMBERSHIP_REQUIRED' : 'ADMIN_DATABASE_READ_FAILED' }));
      }
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === LIVE_ADMIN_ACTION_POLICY_PREVIEW_PATH) {
      let actor = null;
      try {
        actor = await activeActor(request);
        const body = await readJsonObject(request);
        exactKeys(body, ['enabledActions']);
        const enabledActions = normalizeEnabledActionNames(body.enabledActions);
        const version = expectedVersion(request);
        const current = await readAdminActionPolicy(pool, actorContext(actor));
        if (current.version !== version) throw new ActionPolicyConflictError(current.version);
        prunePreviews();
        if (pendingPreviews.size >= MAX_PENDING_PREVIEWS) throw Object.assign(new Error('Preview capacity reached'), { status: 503, code: 'ACTION_POLICY_PREVIEW_CAPACITY' });
        const previewId = randomUUID();
        const preview = {
          previewId,
          tenantId: actor.tenantId,
          subject: actor.subject,
          role: actor.role,
          expectedVersion: version,
          enabledActions,
          expiresAt: Date.now() + PREVIEW_TTL_MS,
        };
        await auditActionPolicyAttempt(pool, actorContext(actor), {
          decision: 'ALLOW',
          actionType: 'admin.action_policy.preview',
          beforePolicy: current,
          afterPolicy: { version: current.version, enabledActions },
          reason: 'preview_created',
        });
        pendingPreviews.set(previewId, preview);
        noteAttempt('admin_action_policy_preview', 'allowed');
        send(response, 200, JSON.stringify({
          valid: true,
          preview: {
            previewId,
            from: current.enabledActions,
            to: enabledActions,
            effect: 'next_signed_session',
            scope: 'all_signed_aimforge_tenants',
            expiresInSeconds: PREVIEW_TTL_MS / 1000,
          },
        }), 'application/json; charset=utf-8', { etag: policyEtag(version) });
      } catch (error) {
        const conflict = error instanceof ActionPolicyConflictError;
        const denied = error?.status === 403 || error instanceof TenantAuthorizationError;
        const status = conflict ? 409 : denied ? 403 : error?.status ?? (error instanceof TypeError ? 400 : 503);
        const code = conflict ? 'ACTION_POLICY_VERSION_CONFLICT' : denied ? 'ADMIN_MEMBERSHIP_REQUIRED' : error?.code ?? (error instanceof TypeError ? 'ACTION_POLICY_INPUT_INVALID' : 'ADMIN_DATABASE_WRITE_FAILED');
        if (actor && status < 500) {
          await auditActionPolicyAttempt(pool, actorContext(actor), {
            decision: 'DENY', actionType: 'admin.action_policy.preview', reason: code,
          }).catch(() => {});
        }
        noteAttempt('admin_action_policy_preview', status < 500 ? 'denied' : 'failed', code);
        send(response, status, JSON.stringify({ valid: false, code, ...(conflict ? { currentVersion: error.currentVersion } : {}) }));
      }
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === LIVE_ADMIN_ACTION_POLICY_CONFIRM_PATH) {
      let actor = null;
      try {
        actor = await activeActor(request);
        const body = await readJsonObject(request);
        exactKeys(body, ['previewId']);
        const previewId = String(body.previewId ?? '');
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(previewId)) throw Object.assign(new Error('previewId is invalid'), { status: 400, code: 'ACTION_POLICY_INPUT_INVALID' });
        const version = expectedVersion(request);
        prunePreviews();
        const preview = pendingPreviews.get(previewId);
        if (!preview || preview.tenantId !== actor.tenantId || preview.subject !== actor.subject
          || preview.role !== actor.role || preview.expectedVersion !== version) {
          throw Object.assign(new Error('Preview is missing, expired, or belongs to another actor'), { status: 409, code: 'ACTION_POLICY_PREVIEW_INVALID' });
        }
        pendingPreviews.delete(previewId);
        const policy = await updateAdminActionPolicy(pool, actorContext(actor), {
          expectedVersion: version,
          enabledActions: preview.enabledActions,
        });
        noteAttempt('admin_action_policy_confirm', 'allowed');
        send(response, 200, JSON.stringify({ valid: true, policy }), 'application/json; charset=utf-8', { etag: policyEtag(policy.version) });
      } catch (error) {
        const conflict = error instanceof ActionPolicyConflictError;
        const denied = error?.status === 403 || error instanceof TenantAuthorizationError;
        const status = conflict ? 409 : denied ? 403 : error?.status ?? (error instanceof TypeError ? 400 : 503);
        const code = conflict ? 'ACTION_POLICY_VERSION_CONFLICT' : denied ? 'ADMIN_MEMBERSHIP_REQUIRED' : error?.code ?? (error instanceof TypeError ? 'ACTION_POLICY_INPUT_INVALID' : 'ADMIN_DATABASE_WRITE_FAILED');
        if (actor && status < 500 && !conflict) {
          await auditActionPolicyAttempt(pool, actorContext(actor), {
            decision: 'DENY', actionType: 'admin.action_policy.confirm', reason: code,
          }).catch(() => {});
        }
        noteAttempt('admin_action_policy_confirm', status < 500 ? 'denied' : 'failed', code);
        send(response, status, JSON.stringify({ valid: false, code, ...(conflict ? { currentVersion: error.currentVersion } : {}) }));
      }
      return true;
    }
    const adminPath = requestUrl.pathname === '/admin' || requestUrl.pathname.startsWith('/admin/');
    const adminApiPath = requestUrl.pathname === '/api/admin' || requestUrl.pathname.startsWith('/api/admin/');
    if (adminPath || adminApiPath) {
      const methodAllowed = request.method === 'GET';
      send(response, methodAllowed ? 404 : 405, JSON.stringify({ valid: false, code: methodAllowed ? 'CLOUD_ADMIN_ROUTE_NOT_FOUND' : 'CLOUD_ADMIN_METHOD_NOT_ALLOWED' }), 'application/json; charset=utf-8', methodAllowed ? {} : { allow: 'GET, POST' });
      return true;
    }
    return false;
  }

  return Object.freeze({
    handler,
    resolveActionPolicy: () => resolvePlatformActionPolicy(pool),
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
