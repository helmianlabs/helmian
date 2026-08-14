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
import { createEnvoyStore, normalizeEnvoyChannel } from './envoy-chat.mjs';
import { createCoraOrganizationConfigRepository } from '../cora/organization-config-repository.mjs';
import { createProviderUsageRepository } from '../cora/provider-usage-repository.mjs';
import { createOrganizationDatabaseRepository } from './organization-database-repository.mjs';
import { createWorkspacePreviewRepository } from '../cora/workspace-preview-repository.mjs';
import { createAgentTaskRepository } from '../cora/agent-task-repository.mjs';
import { createArtifactStudioRepository } from '../cora/artifact-studio-repository.mjs';
import { createArtifactSourceRepository } from '../cora/artifact-source-repository.mjs';
import { createArtifactScriptRepository } from '../cora/artifact-script-repository.mjs';
import { createArtifactExecutionRepository } from '../cora/artifact-execution-repository.mjs';
import { createApprovalInboxRepository } from '../cora/approval-inbox.mjs';
import { createCoraPersonalPreferencesRepository } from '../cora/personal-preferences-repository.mjs';
import { createConnectorRegistrationRepository } from '../cora/connector-registration-repository.mjs';
import { CONNECTOR_MAX_BODY_BYTES, readCommunicationConnectorStatus, verifyDiscordInteraction, verifySlackRequest } from './communication-connectors.mjs';
import { receiveInboundConnectorEvent } from './connector-gateway.mjs';
import { createWorkspaceLayoutRepository } from './workspace-layout-repository.mjs';
import { createAuditEventRepository } from './audit-event-repository.mjs';
import { createOrganizationRoleRepository } from './organization-role-repository.mjs';
import { readOrganizationReadiness } from './organization-readiness.mjs';

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
export const LIVE_ADMIN_ENVOY_CHANNELS_PATH = '/api/admin/envoy/channels';
export const LIVE_ADMIN_ENVOY_MESSAGES_PATH = '/api/admin/envoy/messages';
export const LIVE_ADMIN_ENVOY_STREAM_PATH = '/api/admin/envoy/stream';
export const LIVE_ADMIN_CORA_CONFIG_PATH = '/api/admin/cora/config';
export const LIVE_ADMIN_CORA_CONFIGS_PATH = '/api/admin/cora/configs';
export const LIVE_ADMIN_CORA_TRANSITION_PATH = '/api/admin/cora/configs/transition';
export const LIVE_ADMIN_CORA_KNOWLEDGE_PATH = '/api/admin/cora/knowledge-sources';
export const LIVE_ADMIN_CORA_KNOWLEDGE_QUERY_PATH = '/api/admin/cora/knowledge/query';
export const LIVE_ADMIN_CORA_KNOWLEDGE_MANAGE_PATH = '/api/admin/cora/knowledge/manage';
export const LIVE_ADMIN_CORA_KNOWLEDGE_SOURCES_PATH = '/api/admin/cora/knowledge/sources';
export const LIVE_ADMIN_CORA_KNOWLEDGE_PACKS_PATH = '/api/admin/cora/knowledge/packs';
export const LIVE_ADMIN_CORA_KNOWLEDGE_SNIPPETS_PATH = '/api/admin/cora/knowledge/snippets';
export const LIVE_ADMIN_CORA_KNOWLEDGE_TRANSITION_PATH = '/api/admin/cora/knowledge/transition';
export const LIVE_ADMIN_CORA_USAGE_PATH = '/api/admin/cora/usage';
export const LIVE_ADMIN_CORA_PREVIEW_PATH = '/api/admin/cora/workspace/previews';
export const LIVE_ADMIN_CORA_TASKS_PATH = '/api/admin/cora/tasks';
export const LIVE_ADMIN_CORA_ARTIFACTS_PATH = '/api/admin/cora/artifacts';
export const LIVE_ADMIN_CORA_ARTIFACT_SOURCES_PATH = '/api/admin/cora/artifact-sources';
export const LIVE_ADMIN_CORA_ARTIFACT_SOURCE_LINKS_PATH = '/api/admin/cora/artifact-source-links';
export const LIVE_ADMIN_CORA_ARTIFACT_SOURCE_TRANSITION_PATH = '/api/admin/cora/artifact-sources/transition';
export const LIVE_ADMIN_CORA_ARTIFACT_SCRIPTS_PATH = '/api/admin/cora/artifact-scripts';
export const LIVE_ADMIN_CORA_ARTIFACT_EXECUTION_PATH = '/api/admin/cora/artifact-execution-requests';
export const LIVE_ADMIN_CORA_APPROVALS_PATH = '/api/admin/cora/approvals';
export const LIVE_ADMIN_CORA_CONNECTORS_PATH = '/api/admin/cora/connectors';
export const LIVE_CONNECTOR_SLACK_INBOUND_PATH = '/api/connectors/slack/inbound';
export const LIVE_CONNECTOR_DISCORD_INBOUND_PATH = '/api/connectors/discord/inbound';
export const LIVE_ADMIN_CORA_PERSONAL_PREFERENCES_PATH = '/api/admin/cora/personal-preferences';
export const LIVE_ADMIN_ORGANIZATION_DATABASE_PATH = '/api/admin/control-plane/organization-database';
export const LIVE_ADMIN_WORKSPACE_LAYOUT_PATH = '/api/admin/workspace/layout-preferences';
export const LIVE_ADMIN_WORKSPACE_LAYOUT_RESET_PATH = '/api/admin/workspace/layout-preferences/reset';
export const LIVE_ADMIN_WORKSPACE_ROLE_DEFAULTS_PATH = '/api/admin/workspace/role-defaults';
export const LIVE_ADMIN_ORGANIZATION_MEMBERSHIPS_PATH = '/api/admin/organization/memberships';
export const LIVE_ADMIN_ORGANIZATION_ROLE_PLAN_PATH = '/api/admin/organization/membership-role-plan';
export const LIVE_ADMIN_ORGANIZATION_READINESS_PATH = '/api/admin/organization/readiness';

const MAX_ADMIN_BODY_BYTES = 16 * 1024;
const MAX_PENDING_PREVIEWS = 256;
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_ENVOY_STREAM_MS = 30 * 60 * 1000;

const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'unsafe-inline'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
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

function requestOrigin(request, env) {
  const configured = String(env.HELMION_ADMIN_ORIGIN ?? '').trim();
  if (configured) {
    try { return new URL(configured).origin; } catch { return null; }
  }
  const protocol = String(request.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim().toLowerCase() || 'http';
  try { return new URL(`${protocol}://${request.headers.host ?? 'localhost'}`).origin; } catch { return null; }
}

function originAllowed(request, env) {
  const presented = String(request.headers.origin ?? '').trim();
  if (!presented) return true;
  if (presented === 'null') return false;
  try { return new URL(presented).origin === requestOrigin(request, env); } catch { return false; }
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

async function readRawBody(request, maxBytes = CONNECTOR_MAX_BODY_BYTES) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw Object.assign(new Error('connector body is too large'), { status: 413 });
  const chunks = []; let total = 0;
  for await (const chunk of request) { total += chunk.length; if (total > maxBytes) throw Object.assign(new Error('connector body is too large'), { status: 413 }); chunks.push(chunk); }
  return Buffer.concat(chunks, total).toString('utf8');
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
  coraConfigRepository: suppliedCoraConfigRepository = null,
  providerUsageRepository: suppliedProviderUsageRepository = null,
  workspacePreviewRepository: suppliedWorkspacePreviewRepository = null,
  agentTaskRepository: suppliedAgentTaskRepository = null,
  artifactStudioRepository: suppliedArtifactStudioRepository = null,
  artifactSourceRepository: suppliedArtifactSourceRepository = null,
  artifactScriptRepository: suppliedArtifactScriptRepository = null,
  artifactExecutionRepository: suppliedArtifactExecutionRepository = null,
  approvalInboxRepository: suppliedApprovalInboxRepository = null,
  connectorRegistrationRepository: suppliedConnectorRegistrationRepository = null,
  connectorSecretResolver = null,
  connectorResolveUser = null,
  connectorResolveChannel = null,
  personalPreferencesRepository: suppliedPersonalPreferencesRepository = null,
  organizationDatabaseRepository: suppliedOrganizationDatabaseRepository = null,
  workspaceLayoutRepository: suppliedWorkspaceLayoutRepository = null,
  auditEventRepository: suppliedAuditEventRepository = null,
    organizationRoleRepository: suppliedOrganizationRoleRepository = null,
  envoyStore: suppliedEnvoyStore = null,
  envoyStreamIntervalMs = 1000,
  envoyStreamMaxMs = MAX_ENVOY_STREAM_MS,
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
  const envoy = suppliedEnvoyStore ?? createEnvoyStore(pool);
  const coraConfig = suppliedCoraConfigRepository ?? createCoraOrganizationConfigRepository(pool);
  const providerUsage = suppliedProviderUsageRepository ?? createProviderUsageRepository(pool);
  const workspacePreviews = suppliedWorkspacePreviewRepository ?? createWorkspacePreviewRepository(pool);
  const agentTasks = suppliedAgentTaskRepository ?? createAgentTaskRepository(pool);
  const artifacts = suppliedArtifactStudioRepository ?? createArtifactStudioRepository(pool);
  const artifactSources = suppliedArtifactSourceRepository ?? createArtifactSourceRepository(pool);
  const artifactScripts = suppliedArtifactScriptRepository ?? createArtifactScriptRepository(pool);
  const artifactExecution = suppliedArtifactExecutionRepository ?? createArtifactExecutionRepository(pool);
  const approvals = suppliedApprovalInboxRepository ?? createApprovalInboxRepository(pool);
  const connectorRegistrations = suppliedConnectorRegistrationRepository ?? createConnectorRegistrationRepository(pool);
  const personalPreferences = suppliedPersonalPreferencesRepository ?? createCoraPersonalPreferencesRepository(pool);
  const organizationDatabase = suppliedOrganizationDatabaseRepository ?? createOrganizationDatabaseRepository(pool);
  const workspaceLayout = suppliedWorkspaceLayoutRepository ?? createWorkspaceLayoutRepository(pool);
  const auditEvents = suppliedAuditEventRepository ?? createAuditEventRepository(pool);
  const organizationRoles = suppliedOrganizationRoleRepository ?? createOrganizationRoleRepository(pool);
  const resolveConnectorSecret = connectorSecretResolver;
  const sessionIdentity = (request) => identity.getSession(cookieValue(request, 'helmion_admin_session'));
  const pendingPreviews = new Map();
  const streamIntervalMs = Math.max(250, Number(envoyStreamIntervalMs));
  const streamMaxMs = Math.max(streamIntervalMs, Number(envoyStreamMaxMs));
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

  async function deriveTenantActor(request) {
    const claimed = sessionIdentity(request);
    if (!claimed?.subject) throw Object.assign(new Error('Identity required'), { status: 403 });
    const client = await pool.connect();
    try {
      const membership = await client.query(
        `select tenant_id, role from helmion.tenant_memberships where subject=$1 and active order by tenant_id`,
        [claimed.subject],
      );
      if (membership.rowCount !== 1) throw Object.assign(new Error('Exactly one active organization membership is required'), { status: 403 });
      return { subject: claimed.subject, tenantId: membership.rows[0].tenant_id, role: membership.rows[0].role };
    } finally { client.release(); }
  }

  async function activeTenantActor(request) {
    const actor = await deriveTenantActor(request);
    const context = { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: randomUUID(), requestId: randomUUID() };
    await withTenantTransaction(pool, context, async (client) => { await requireActiveTenantMembership(client, context); return {}; });
    return { ...actor, sessionId: context.sessionId, requestId: context.requestId };
  }

  async function streamEnvoyMessages(request, response, initialActor, channelId, afterId) {
    let cursor = afterId || null;
    const initialResult = await envoy.listMessages(initialActor, channelId, 100, cursor);
    let closed = false;
    let timer = null;
    let expiryTimer = null;
    const close = () => { closed = true; if (timer) clearTimeout(timer); if (expiryTimer) clearTimeout(expiryTimer); };
    request.once?.('close', close);
    response.once?.('close', close);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-cache, max-age=0, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...SECURITY_HEADERS,
    });
    response.write('retry: 3000\n\n');
    const writeEvent = (event, data, id = null) => {
      if (closed) return;
      if (id != null) response.write(`id: ${id}\n`);
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    expiryTimer = setTimeout(() => {
      if (closed) return;
      writeEvent('envoy_error', { code: 'ENVOY_STREAM_ROTATE', retryable: true });
      close();
      response.end();
    }, streamMaxMs);
    const tick = async (actor, suppliedResult = null) => {
      if (closed) return;
      try {
        const result = suppliedResult ?? await envoy.listMessages(actor, channelId, 100, cursor);
        for (const message of result.messages ?? []) {
          cursor = message.id;
          writeEvent('message', message, message.id);
        }
        if (!result.messages?.length) writeEvent('ready', { status: 'connected', cursor });
      } catch (error) {
        const denied = error?.status === 403 || error instanceof TenantAuthorizationError || /membership|Organization|channel/u.test(error?.message ?? '');
        writeEvent('envoy_error', { code: denied ? 'ENVOY_MEMBERSHIP_REVOKED' : 'ENVOY_STREAM_UNAVAILABLE', retryable: !denied });
        close();
        response.end();
        return;
      }
      if (closed) return;
      timer = setTimeout(async () => {
        try {
          const actor = await activeTenantActor(request);
          await tick(actor);
        } catch (error) {
          writeEvent('envoy_error', { code: 'ENVOY_MEMBERSHIP_REVOKED', retryable: false });
          close();
          response.end();
        }
      }, streamIntervalMs);
    };
    await tick(initialActor, initialResult);
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
    const inboundProvider = requestUrl.pathname === LIVE_CONNECTOR_SLACK_INBOUND_PATH ? 'slack' : requestUrl.pathname === LIVE_CONNECTOR_DISCORD_INBOUND_PATH ? 'discord' : null;
    if (inboundProvider) {
      if (request.method !== 'POST') { send(response, 405, JSON.stringify({ valid: false, code: 'CONNECTOR_METHOD_NOT_ALLOWED' }), 'application/json; charset=utf-8', { allow: 'POST' }); return true; }
      try {
        if (typeof connectorRegistrations.resolveEnabled !== 'function' || typeof resolveConnectorSecret !== 'function' || typeof connectorResolveUser !== 'function' || typeof connectorResolveChannel !== 'function') throw Object.assign(new Error('connector inbound runtime is not configured'), { status: 503 });
        const resolved = await connectorRegistrations.resolveEnabled(inboundProvider);
        if (resolved.registration.lifecycle !== 'enabled' || resolved.registration.enabled !== true || resolved.registration.publicEndpointReady !== true) throw Object.assign(new Error('connector registration is not ready'), { status: 503 });
        const reference = resolved.registration.secretReferenceName;
        if (!reference) throw Object.assign(new Error('connector signing reference is unavailable'), { status: 503 });
        const credential = await resolveConnectorSecret({ provider: inboundProvider, secretReferenceName: reference });
        if (!credential) throw Object.assign(new Error('connector signing credential is unavailable'), { status: 503 });
        const rawBody = await readRawBody(request);
        const timestamp = inboundProvider === 'slack' ? request.headers['x-slack-request-timestamp'] : request.headers['x-signature-timestamp'];
        const signature = inboundProvider === 'slack' ? request.headers['x-slack-signature'] : request.headers['x-signature-ed25519'];
        if (inboundProvider === 'slack') verifySlackRequest({ rawBody, timestamp, signature, signingSecret: credential });
        else verifyDiscordInteraction({ rawBody, timestamp, signature, publicKey: credential });
        let payload; try { payload = JSON.parse(rawBody); } catch { throw Object.assign(new Error('connector payload is not valid JSON'), { status: 400 }); }
        const channelId = String(payload?.channelId ?? payload?.channel_id ?? '').trim();
        if (!channelId || !resolved.registration.allowedInboundChannels.some((channel) => channel.enabled && channel.externalChannelId === channelId)) throw Object.assign(new Error('connector channel is not registered for inbound delivery'), { status: 403 });
        const sessionId = `connector-${inboundProvider}-${String(payload?.eventId ?? payload?.event_id ?? payload?.id ?? '').slice(0, 160)}`;
        const result = await receiveInboundConnectorEvent({ provider: inboundProvider, rawBody, payload, headers: { timestamp, signature }, signingSecret: inboundProvider === 'slack' ? credential : undefined, publicKey: inboundProvider === 'discord' ? credential : undefined, resolveUser: connectorResolveUser, resolveChannel: connectorResolveChannel, persistReceipt: async (binding) => { if (binding.tenantId !== resolved.tenantId) throw new Error('connector registration Organization mismatch'); return envoy.appendConnectorMessage({ ...binding, sessionId, requestId: sessionId }); } });
        send(response, 200, JSON.stringify({ valid: true, ...result }));
      } catch (error) { const status = error?.status === 503 ? 503 : error?.status === 413 ? 413 : error?.status === 403 ? 403 : error?.status === 409 ? 409 : 400; send(response, status, JSON.stringify({ valid: false, code: status === 503 ? 'CONNECTOR_RUNTIME_UNAVAILABLE' : status === 403 ? 'CONNECTOR_NOT_REGISTERED' : status === 409 ? 'CONNECTOR_REGISTRATION_AMBIGUOUS' : 'CONNECTOR_INBOUND_INVALID' })); }
      return true;
    }
    if (requestUrl.pathname.startsWith('/api/admin/') && !originAllowed(request, env)) {
      send(response, 403, JSON.stringify({ valid: false, code: 'ADMIN_ORIGIN_REQUIRED' }));
      return true;
    }
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
        if (['tenant_id', 'organization_id', 'plant_id', 'facility_id'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 });
        const actor = await activeTenantActor(request);
        send(response, 200, JSON.stringify({ valid: true, ...await auditEvents.list(actor, {
          action: requestUrl.searchParams.get('action'), actor: requestUrl.searchParams.get('actor'), status: requestUrl.searchParams.get('status'), from: requestUrl.searchParams.get('from'), to: requestUrl.searchParams.get('to'), cursor: requestUrl.searchParams.get('cursor'), limit: requestUrl.searchParams.get('limit'),
        }) }));
      } catch (error) {
        const denied = error?.status === 403 || error instanceof TenantAuthorizationError;
        send(response, denied ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: denied ? 'AUDIT_MEMBERSHIP_REQUIRED' : error?.status === 400 ? 'AUDIT_QUERY_INVALID' : 'AUDIT_DATABASE_READ_FAILED' }));
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
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_ENVOY_CHANNELS_PATH) {
      try { const actor = await activeTenantActor(request); send(response, 200, JSON.stringify({ valid: true, ...await envoy.listChannels(actor) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 503, JSON.stringify({ valid: false, code: error?.status === 403 ? 'ENVOY_MEMBERSHIP_REQUIRED' : 'ENVOY_DATABASE_READ_FAILED' })); }
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === LIVE_ADMIN_ENVOY_CHANNELS_PATH) {
      try { const actor = await activeTenantActor(request); const body = await readJsonObject(request); exactKeys(body, ['kind', 'slug', 'title']); send(response, 200, JSON.stringify({ valid: true, ...await envoy.createChannel(actor, body) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'ENVOY_MEMBERSHIP_REQUIRED' : 'ENVOY_CHANNEL_INVALID' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_ENVOY_MESSAGES_PATH) {
      try { const actor = await activeTenantActor(request); const channelId = requestUrl.searchParams.get('channel_id'); if (requestUrl.searchParams.has('tenant_id')) throw new Error('tenant selector is not accepted'); send(response, 200, JSON.stringify({ valid: true, ...await envoy.listMessages(actor, channelId, requestUrl.searchParams.get('limit'), requestUrl.searchParams.get('after_id')) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'ENVOY_MEMBERSHIP_REQUIRED' : 'ENVOY_MESSAGE_INVALID' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_ENVOY_STREAM_PATH) {
      try {
        if (['tenant_id', 'organization_id', 'plant_id', 'facility_id'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 });
        const actor = await activeTenantActor(request);
        const channelId = requestUrl.searchParams.get('channel_id');
        const afterId = requestUrl.searchParams.get('after_id') ?? request.headers['last-event-id'] ?? null;
        await streamEnvoyMessages(request, response, actor, channelId, afterId);
      } catch (error) {
        send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'ENVOY_MEMBERSHIP_REQUIRED' : 'ENVOY_STREAM_INVALID' }));
      }
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === LIVE_ADMIN_ENVOY_MESSAGES_PATH) {
      try { const actor = await activeTenantActor(request); const body = await readJsonObject(request); exactKeys(body, ['body', 'channelId', 'idempotencyKey']); if (Object.prototype.hasOwnProperty.call(body, 'tenantId')) throw new Error('tenant selector is not accepted'); send(response, 200, JSON.stringify({ valid: true, ...await envoy.appendMessage(actor, body) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'ENVOY_MEMBERSHIP_REQUIRED' : 'ENVOY_MESSAGE_INVALID' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_CORA_CONFIG_PATH) {
      try { if (requestUrl.searchParams.has('tenant_id') || requestUrl.searchParams.has('organization_id')) throw Object.assign(new Error('Organization selector is not accepted'), { status: 400 }); const actor = await activeTenantActor(request); send(response, 200, JSON.stringify({ valid: true, ...await coraConfig.readPublishedConfig(actor) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_MEMBERSHIP_REQUIRED' : error?.status === 400 ? 'CORA_SELECTOR_INVALID' : 'CORA_CONFIG_READ_FAILED' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_CORA_KNOWLEDGE_PATH) {
      try { if (requestUrl.searchParams.has('tenant_id') || requestUrl.searchParams.has('organization_id')) throw Object.assign(new Error('Organization selector is not accepted'), { status: 400 }); const actor = await activeTenantActor(request); send(response, 200, JSON.stringify({ valid: true, ...await coraConfig.listKnowledgeSources(actor) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_MEMBERSHIP_REQUIRED' : error?.status === 400 ? 'CORA_SELECTOR_INVALID' : 'CORA_KNOWLEDGE_READ_FAILED' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_CORA_KNOWLEDGE_QUERY_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const query = requestUrl.searchParams.get('q'); const actor = await activeTenantActor(request); send(response, 200, JSON.stringify({ valid: true, ...await coraConfig.queryApprovedKnowledge(actor, query, requestUrl.searchParams.get('limit')) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_MEMBERSHIP_REQUIRED' : error?.status === 400 ? 'CORA_QUERY_INVALID' : 'CORA_KNOWLEDGE_QUERY_UNAVAILABLE' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_CORA_KNOWLEDGE_MANAGE_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeActor(request); send(response, 200, JSON.stringify({ valid: true, ...await coraConfig.listKnowledgeAdmin(actor) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_KNOWLEDGE_ADMIN_REQUIRED' : error?.status === 400 ? 'CORA_KNOWLEDGE_SELECTOR_INVALID' : 'CORA_KNOWLEDGE_MANAGE_READ_FAILED' })); }
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === LIVE_ADMIN_CORA_KNOWLEDGE_SOURCES_PATH) {
      try { const actor = await activeActor(request); const body = await readJsonObject(request); exactKeys(body, ['canonicalUri', 'effectiveAt', 'expiresAt', 'provenance', 'publisher', 'sourceKey', 'title']); send(response, 200, JSON.stringify({ valid: true, ...await coraConfig.createKnowledgeSource(actor, body) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_KNOWLEDGE_ADMIN_REQUIRED' : 'CORA_KNOWLEDGE_SOURCE_INVALID' })); }
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === LIVE_ADMIN_CORA_KNOWLEDGE_PACKS_PATH) {
      try { const actor = await activeActor(request); const body = await readJsonObject(request); exactKeys(body, ['effectiveAt', 'expiresAt', 'packKey', 'provenance', 'sourceId', 'version']); send(response, 200, JSON.stringify({ valid: true, ...await coraConfig.createKnowledgePack(actor, body) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_KNOWLEDGE_ADMIN_REQUIRED' : 'CORA_KNOWLEDGE_PACK_INVALID' })); }
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === LIVE_ADMIN_CORA_KNOWLEDGE_SNIPPETS_PATH) {
      try { const actor = await activeActor(request); const body = await readJsonObject(request); exactKeys(body, ['citation', 'contentSha256', 'excerpt', 'expiresAt', 'packId', 'textReference']); send(response, 200, JSON.stringify({ valid: true, ...await coraConfig.createKnowledgeSnippet(actor, body) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_KNOWLEDGE_ADMIN_REQUIRED' : 'CORA_KNOWLEDGE_SNIPPET_INVALID' })); }
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === LIVE_ADMIN_CORA_KNOWLEDGE_TRANSITION_PATH) {
      try { const actor = await activeActor(request); const body = await readJsonObject(request); exactKeys(body, ['id', 'kind', 'lifecycle', 'reason']); send(response, 200, JSON.stringify({ valid: true, ...await coraConfig.transitionKnowledge(actor, body) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_KNOWLEDGE_ADMIN_REQUIRED' : 'CORA_KNOWLEDGE_TRANSITION_INVALID' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_CORA_USAGE_PATH) {
      try { if (requestUrl.searchParams.has('tenant_id') || requestUrl.searchParams.has('organization_id') || requestUrl.searchParams.has('plant_id')) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeTenantActor(request); const detailAllowed = ['owner', 'admin'].includes(String(actor.role).toLowerCase()); const result = requestUrl.searchParams.has('limit') && detailAllowed ? await providerUsage.list(actor, requestUrl.searchParams.get('limit')) : await providerUsage.readSummary(actor); send(response, 200, JSON.stringify({ valid: true, ...result })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_USAGE_MEMBERSHIP_REQUIRED' : error?.status === 400 ? 'CORA_USAGE_SELECTOR_INVALID' : 'CORA_USAGE_READ_FAILED' })); }
      return true;
    }
    if (request.method === 'PUT' && requestUrl.pathname === LIVE_ADMIN_CORA_USAGE_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeActor(request); const body = await readJsonObject(request); exactKeys(body, ['allocations', 'currency', 'hardLimitMinor', 'lowCostLimitMinor', 'period', 'policyState', 'softLimitMinor']); send(response, 200, JSON.stringify({ valid: true, ...await providerUsage.savePolicy(actor, body) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_USAGE_POLICY_ADMIN_REQUIRED' : 'CORA_USAGE_POLICY_INVALID' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_CORA_PREVIEW_PATH) {
      try { if (requestUrl.searchParams.has('tenant_id') || requestUrl.searchParams.has('organization_id') || requestUrl.searchParams.has('plant_id')) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeTenantActor(request); const result = await workspacePreviews.list(actor, requestUrl.searchParams.get('limit')); send(response, 200, JSON.stringify({ valid: true, ...result })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_PREVIEW_MEMBERSHIP_REQUIRED' : error?.status === 400 ? 'CORA_PREVIEW_SELECTOR_INVALID' : 'CORA_PREVIEW_READ_FAILED' })); }
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === LIVE_ADMIN_CORA_PREVIEW_PATH) {
      try { const actor = await activeTenantActor(request); const body = await readJsonObject(request); exactKeys(body, ['department', 'idempotencyKey', 'intent', 'mode', 'templateId', 'title']); const result = await workspacePreviews.append(actor, body); send(response, 200, JSON.stringify({ valid: true, ...result })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_PREVIEW_MEMBERSHIP_REQUIRED' : 'CORA_PREVIEW_INTENT_INVALID' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_CORA_TASKS_PATH) {
      try { if (requestUrl.searchParams.has('tenant_id') || requestUrl.searchParams.has('organization_id') || requestUrl.searchParams.has('plant_id')) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeTenantActor(request); const result = await agentTasks.list(actor, requestUrl.searchParams.get('limit')); send(response, 200, JSON.stringify({ valid: true, ...result })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_TASK_MEMBERSHIP_REQUIRED' : error?.status === 400 ? 'CORA_TASK_SELECTOR_INVALID' : 'CORA_TASK_READ_FAILED' })); }
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === LIVE_ADMIN_CORA_TASKS_PATH) {
      try { const actor = await activeTenantActor(request); const body = await readJsonObject(request); if (Object.keys(body).some((key) => !['contextRef', 'costCenter', 'department', 'goal', 'idempotencyKey', 'intent', 'taskType'].includes(key))) throw Object.assign(new Error('Request body has unexpected fields'), { status: 400 }); const result = await agentTasks.append(actor, body); send(response, 200, JSON.stringify({ valid: true, ...result })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_TASK_MEMBERSHIP_REQUIRED' : 'CORA_TASK_INTENT_INVALID' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_CORA_ARTIFACTS_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeTenantActor(request); const result = await artifacts.list(actor, requestUrl.searchParams.get('limit')); send(response, 200, JSON.stringify({ valid: true, ...result })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_ARTIFACT_MEMBERSHIP_REQUIRED' : error?.status === 400 ? 'CORA_ARTIFACT_SELECTOR_INVALID' : 'CORA_ARTIFACT_READ_FAILED' })); }
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === LIVE_ADMIN_CORA_ARTIFACTS_PATH) {
      try { const body = await readJsonObject(request); exactKeys(body, ['approvalReason', 'artifactType', 'department', 'idempotencyKey', 'objective', 'sourceRefs', 'stage', 'title']); const actor = body.stage === 'approval_requested' ? { ...(await activeActor(request)), sessionId: randomUUID(), requestId: randomUUID() } : await activeTenantActor(request); const result = await artifacts.append(actor, body); send(response, 200, JSON.stringify({ valid: true, ...result })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_ARTIFACT_APPROVAL_REQUIRED' : 'CORA_ARTIFACT_INTENT_INVALID' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_CORA_ARTIFACT_SOURCES_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeTenantActor(request); send(response, 200, JSON.stringify({ valid: true, ...await artifactSources.list(actor, requestUrl.searchParams.get('limit')) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_ARTIFACT_SOURCE_MEMBERSHIP_REQUIRED' : error?.status === 400 ? 'CORA_ARTIFACT_SOURCE_SELECTOR_INVALID' : 'CORA_ARTIFACT_SOURCE_READ_FAILED' })); }
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === LIVE_ADMIN_CORA_ARTIFACT_SOURCES_PATH) {
      try { const actor = await activeTenantActor(request); const body = await readJsonObject(request); exactKeys(body, ['classification', 'effectiveAt', 'expiresAt', 'idempotencyKey', 'provenance', 'publisher', 'reference', 'sourceKey', 'title']); send(response, 200, JSON.stringify({ valid: true, ...await artifactSources.append(actor, body) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_ARTIFACT_SOURCE_MEMBERSHIP_REQUIRED' : 'CORA_ARTIFACT_SOURCE_INVALID' })); }
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === LIVE_ADMIN_CORA_ARTIFACT_SOURCE_TRANSITION_PATH) {
      try { const actor = await activeActor(request); const body = await readJsonObject(request); exactKeys(body, ['lifecycle', 'reason', 'sourceId']); send(response, 200, JSON.stringify({ valid: true, ...await artifactSources.transition({ ...actor, sessionId: randomUUID(), requestId: randomUUID() }, body) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_ARTIFACT_SOURCE_APPROVAL_REQUIRED' : 'CORA_ARTIFACT_SOURCE_TRANSITION_INVALID' })); }
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === LIVE_ADMIN_CORA_ARTIFACT_SOURCE_LINKS_PATH) {
      try { const actor = await activeTenantActor(request); const body = await readJsonObject(request); exactKeys(body, ['artifactReceiptId', 'linkReason', 'idempotencyKey', 'sourceId']); send(response, 200, JSON.stringify({ valid: true, ...await artifactSources.link(actor, body) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_ARTIFACT_SOURCE_MEMBERSHIP_REQUIRED' : 'CORA_ARTIFACT_SOURCE_LINK_INVALID' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_CORA_ARTIFACT_SCRIPTS_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const artifactReceiptId = requestUrl.searchParams.get('artifact_receipt_id'); if (!artifactReceiptId) throw Object.assign(new Error('artifact receipt is required'), { status: 400 }); const actor = await activeTenantActor(request); send(response, 200, JSON.stringify({ valid: true, ...await artifactScripts.list(actor, artifactReceiptId, requestUrl.searchParams.get('limit')) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_ARTIFACT_SCRIPT_MEMBERSHIP_REQUIRED' : error?.status === 400 ? 'CORA_ARTIFACT_SCRIPT_SELECTOR_INVALID' : 'CORA_ARTIFACT_SCRIPT_READ_FAILED' })); }
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === LIVE_ADMIN_CORA_ARTIFACT_SCRIPTS_PATH) {
      try { const body = await readJsonObject(request); exactKeys(body, ['approvalReason', 'artifactReceiptId', 'idempotencyKey', 'scriptKind', 'sourceLinkReceiptIds', 'stage', 'text']); const actor = body.stage === 'approval_requested' ? { ...(await activeActor(request)), sessionId: randomUUID(), requestId: randomUUID() } : await activeTenantActor(request); send(response, 200, JSON.stringify({ valid: true, ...await artifactScripts.append(actor, body) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_ARTIFACT_SCRIPT_APPROVAL_REQUIRED' : 'CORA_ARTIFACT_SCRIPT_INVALID' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_CORA_ARTIFACT_EXECUTION_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const artifactReceiptId = requestUrl.searchParams.get('artifact_receipt_id'); if (!artifactReceiptId) throw Object.assign(new Error('artifact receipt is required'), { status: 400 }); const actor = await activeTenantActor(request); send(response, 200, JSON.stringify({ valid: true, ...await artifactExecution.list(actor, artifactReceiptId, requestUrl.searchParams.get('limit')) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_ARTIFACT_EXECUTION_MEMBERSHIP_REQUIRED' : error?.status === 400 ? 'CORA_ARTIFACT_EXECUTION_SELECTOR_INVALID' : 'CORA_ARTIFACT_EXECUTION_READ_FAILED' })); }
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === LIVE_ADMIN_CORA_ARTIFACT_EXECUTION_PATH) {
      try { const body = await readJsonObject(request); exactKeys(body, ['approvalRef', 'artifactReceiptId', 'catalogEntryId', 'currency', 'estimatedAudioSeconds', 'estimatedCostMinor', 'estimatedImageUnits', 'estimatedRequestedTokens', 'estimatedVideoUnits', 'externalExecution', 'idempotencyKey', 'modality', 'model', 'provider', 'scriptReceiptId', 'sourceLinkReceiptIds', 'supersedesReceiptId']); const actor = await activeTenantActor(request); send(response, 200, JSON.stringify({ valid: true, ...await artifactExecution.append(actor, body) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_ARTIFACT_EXECUTION_APPROVAL_REQUIRED' : 'CORA_ARTIFACT_EXECUTION_INVALID' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_CORA_APPROVALS_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeTenantActor(request); send(response, 200, JSON.stringify({ valid: true, ...await approvals.list(actor, { status: requestUrl.searchParams.get('status'), requestKind: requestUrl.searchParams.get('request_kind'), limit: requestUrl.searchParams.get('limit') }) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_APPROVAL_MEMBERSHIP_REQUIRED' : error?.status === 400 ? 'CORA_APPROVAL_SELECTOR_INVALID' : 'CORA_APPROVAL_READ_FAILED' })); }
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === LIVE_ADMIN_CORA_APPROVALS_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeActor(request); const body = await readJsonObject(request); exactKeys(body, ['decision', 'idempotencyKey', 'reason', 'requestKind', 'requestReceiptId']); send(response, 200, JSON.stringify({ valid: true, ...await approvals.decide(actor, body) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_APPROVAL_ADMIN_REQUIRED' : 'CORA_APPROVAL_INVALID' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_CORA_CONNECTORS_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeTenantActor(request); const result = await connectorRegistrations.list(actor); send(response, 200, JSON.stringify({ valid: true, ...result, verifierStatus: readCommunicationConnectorStatus(env) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_CONNECTOR_MEMBERSHIP_REQUIRED' : error?.status === 400 ? 'CORA_CONNECTOR_SELECTOR_INVALID' : 'CORA_CONNECTOR_READ_FAILED' })); }
      return true;
    }
    if (request.method === 'PUT' && requestUrl.pathname === LIVE_ADMIN_CORA_CONNECTORS_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeActor(request); const body = await readJsonObject(request); exactKeys(body, ['allowedInboundChannels', 'enabled', 'lifecycle', 'provider', 'publicEndpointReady', 'secretReferenceName']); send(response, 200, JSON.stringify({ valid: true, ...await connectorRegistrations.save(actor, body) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_CONNECTOR_ADMIN_REQUIRED' : 'CORA_CONNECTOR_INVALID' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_CORA_PERSONAL_PREFERENCES_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id', 'subject', 'user_subject'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeTenantActor(request); send(response, 200, JSON.stringify({ valid: true, ...await personalPreferences.read(actor) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_PERSONAL_PREFERENCES_MEMBERSHIP_REQUIRED' : error?.status === 400 ? 'CORA_PERSONAL_PREFERENCES_SELECTOR_INVALID' : 'CORA_PERSONAL_PREFERENCES_READ_FAILED' })); }
      return true;
    }
    if (request.method === 'PUT' && requestUrl.pathname === LIVE_ADMIN_CORA_PERSONAL_PREFERENCES_PATH) {
      try { const actor = await activeTenantActor(request); const body = await readJsonObject(request); exactKeys(body, ['interruptMode', 'muted', 'turnMode', 'verbosity', 'volume', 'voiceProfile']); send(response, 200, JSON.stringify({ valid: true, ...await personalPreferences.save(actor, body) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_PERSONAL_PREFERENCES_MEMBERSHIP_REQUIRED' : 'CORA_PERSONAL_PREFERENCES_INVALID' })); }
      return true;
    }

    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_ORGANIZATION_DATABASE_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeTenantActor(request); send(response, 200, JSON.stringify({ valid: true, ...await organizationDatabase.resolve(actor) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: error?.status === 400 ? 'ORGANIZATION_DATABASE_SELECTOR_INVALID' : error?.status === 403 ? 'ORGANIZATION_DATABASE_MEMBERSHIP_REQUIRED' : 'ORGANIZATION_DATABASE_UNAVAILABLE' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_ORGANIZATION_MEMBERSHIPS_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id', 'subject', 'user_subject'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeTenantActor(request); send(response, 200, JSON.stringify({ valid: true, ...organizationRoles.list ? await organizationRoles.list(actor) : organizationRoles.catalog() })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: error?.status === 403 ? 'ORGANIZATION_MEMBERSHIP_REQUIRED' : error?.status === 400 ? 'ORGANIZATION_SELECTOR_INVALID' : 'ORGANIZATION_MEMBERSHIP_READ_FAILED' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_ORGANIZATION_READINESS_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeTenantActor(request); send(response, 200, JSON.stringify({ valid: true, readiness: await readOrganizationReadiness({ actor, organizationRoles, coraConfig, providerUsage, connectors: connectorRegistrations, workspaceLayout: workspaceLayout, auditEvents }) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: error?.status === 403 ? 'ORGANIZATION_READINESS_MEMBERSHIP_REQUIRED' : error?.status === 400 ? 'ORGANIZATION_READINESS_SELECTOR_INVALID' : 'ORGANIZATION_READINESS_UNAVAILABLE' })); }
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === LIVE_ADMIN_ORGANIZATION_ROLE_PLAN_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeTenantActor(request); const body = await readJsonObject(request); exactKeys(body, ['idempotencyKey', 'jobTitle', 'reason', 'subject']); send(response, 200, JSON.stringify({ valid: true, ...await organizationRoles.prepareRolePlan(actor, body) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : error?.status === 409 ? 409 : error?.status === 404 ? 404 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'ORGANIZATION_ROLE_ADMIN_REQUIRED' : error?.status === 409 ? 'ORGANIZATION_SELF_LOCKOUT' : error?.status === 404 ? 'ORGANIZATION_MEMBER_NOT_FOUND' : 'ORGANIZATION_ROLE_PLAN_INVALID' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_WORKSPACE_LAYOUT_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id', 'subject', 'user_subject'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeTenantActor(request); send(response, 200, JSON.stringify({ valid: true, ...await workspaceLayout.read(actor) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: error?.status === 403 ? 'WORKSPACE_LAYOUT_MEMBERSHIP_REQUIRED' : error?.status === 400 ? 'WORKSPACE_LAYOUT_SELECTOR_INVALID' : 'WORKSPACE_LAYOUT_READ_FAILED' })); }
      return true;
    }
    if (request.method === 'PUT' && requestUrl.pathname === LIVE_ADMIN_WORKSPACE_LAYOUT_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id', 'subject', 'user_subject'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeTenantActor(request); const body = await readJsonObject(request); exactKeys(body, ['defaultEnvoyChannelId', 'density', 'panelOrder', 'visibleShelves']); send(response, 200, JSON.stringify({ valid: true, ...await workspaceLayout.save(actor, body) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'WORKSPACE_LAYOUT_MEMBERSHIP_REQUIRED' : 'WORKSPACE_LAYOUT_INVALID' })); }
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === LIVE_ADMIN_WORKSPACE_LAYOUT_RESET_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id', 'subject', 'user_subject'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeTenantActor(request); const body = await readJsonObject(request); exactKeys(body, []); send(response, 200, JSON.stringify({ valid: true, ...await workspaceLayout.reset(actor) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'WORKSPACE_LAYOUT_MEMBERSHIP_REQUIRED' : 'WORKSPACE_LAYOUT_RESET_INVALID' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_WORKSPACE_ROLE_DEFAULTS_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id', 'subject', 'user_subject'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeActor(request); const scoped = { ...actor, ...actorContext(actor) }; send(response, 200, JSON.stringify({ valid: true, ...await workspaceLayout.readRoleDefaults(scoped) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: error?.status === 403 ? 'WORKSPACE_ROLE_DEFAULTS_ADMIN_REQUIRED' : error?.status === 400 ? 'WORKSPACE_ROLE_DEFAULTS_SELECTOR_INVALID' : 'WORKSPACE_ROLE_DEFAULTS_READ_FAILED' })); }
      return true;
    }
    if (request.method === 'PUT' && requestUrl.pathname === LIVE_ADMIN_WORKSPACE_ROLE_DEFAULTS_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id', 'subject', 'user_subject'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeActor(request); const body = await readJsonObject(request); exactKeys(body, ['defaultEnvoyChannelId', 'density', 'panelOrder', 'role', 'visibleShelves']); const { role, ...layoutInput } = body; const scoped = { ...actor, ...actorContext(actor) }; send(response, 200, JSON.stringify({ valid: true, ...await workspaceLayout.saveRoleDefault(scoped, role, layoutInput) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'WORKSPACE_ROLE_DEFAULTS_ADMIN_REQUIRED' : 'WORKSPACE_ROLE_DEFAULTS_INVALID' })); }
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === LIVE_ADMIN_CORA_CONFIGS_PATH) {
      try { const actor = await activeActor(request); const body = await readJsonObject(request); exactKeys(body, ['config', 'reason', 'provenance']); send(response, 200, JSON.stringify({ valid: true, ...await coraConfig.createDraft(actor, body) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_CONFIG_ADMIN_REQUIRED' : 'CORA_CONFIG_DRAFT_INVALID' })); }
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === LIVE_ADMIN_CORA_CONFIGS_PATH) {
      try { if (['tenant_id', 'organization_id', 'plant_id', 'facility_id'].some((key) => requestUrl.searchParams.has(key))) throw Object.assign(new Error('authority selector is not accepted'), { status: 400 }); const actor = await activeActor(request); send(response, 200, JSON.stringify({ valid: true, ...await coraConfig.listConfigs(actor) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : error?.status === 400 ? 400 : 503, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_CONFIG_ADMIN_REQUIRED' : error?.status === 400 ? 'CORA_CONFIG_SELECTOR_INVALID' : 'CORA_CONFIG_HISTORY_READ_FAILED' })); }
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === LIVE_ADMIN_CORA_TRANSITION_PATH) {
      try { const actor = await activeActor(request); const body = await readJsonObject(request); exactKeys(body, ['id', 'lifecycle', 'reason']); send(response, 200, JSON.stringify({ valid: true, ...await coraConfig.transition(actor, body) })); }
      catch (error) { send(response, error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400, JSON.stringify({ valid: false, code: error?.status === 403 ? 'CORA_CONFIG_ADMIN_REQUIRED' : 'CORA_CONFIG_TRANSITION_INVALID' })); }
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
    appendProviderUsage: (actor, input) => providerUsage.append(actor, input),
    appendWorkspacePreview: (actor, input) => workspacePreviews.append(actor, input),
    appendAgentTask: (actor, input) => agentTasks.append(actor, input),
    appendArtifactStudio: (actor, input) => artifacts.append(actor, input),
    appendArtifactSource: (actor, input) => artifactSources.append(actor, input),
    linkArtifactSource: (actor, input) => artifactSources.link(actor, input),
    appendArtifactScript: (actor, input) => artifactScripts.append(actor, input),
    appendArtifactExecution: (actor, input) => artifactExecution.append(actor, input),
    readPersonalPreferences: (actor) => personalPreferences.read(actor),
    savePersonalPreferences: (actor, input) => personalPreferences.save(actor, input),
    resolveOrganizationDatabase: (actor) => organizationDatabase.resolve(actor),
    claimAgentTask: (workerActor, input) => agentTasks.claimPrepared(workerActor, input),
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
