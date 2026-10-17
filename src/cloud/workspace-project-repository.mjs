import { appendAuditEvent } from './audit-event-repository.mjs';
import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';

const PROJECT_KEYS = new Set(['projectKey', 'displayName', 'sourceKind', 'defaultBranch', 'lifecycle']);
const SOURCE_KINDS = new Set(['cloud', 'desktop_mirror', 'external']);
const LIFECYCLES = new Set(['active', 'archived']);

function context(actor) {
  if (!actor?.tenantId || !actor.subject || !actor.role || !actor.sessionId || !actor.requestId) throw new Error('verified Organization membership is required');
  return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId, requestId: actor.requestId };
}

function text(value, max) { return String(value ?? '').trim().slice(0, max); }

// Project identity is always the cloud project_key string. Never path-shaped:
// no slashes, no backslashes, no drive letters, no ".." — no local-disk semantics.
function assertCloudProjectKey(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,95}$/.test(key) || key.includes('..') || /^[a-z]:/.test(key)) {
    throw Object.assign(new Error('workspace project key is invalid'), { status: 400 });
  }
  return key;
}

function normalizeProject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('workspace project must be an object'), { status: 400 });
  if (Object.keys(input).some((key) => !PROJECT_KEYS.has(key))) throw Object.assign(new Error('workspace project contains a forbidden field'), { status: 400 });
  const projectKey = assertCloudProjectKey(input.projectKey);
  const displayName = text(input.displayName, 160);
  const sourceKind = text(input.sourceKind, 32).toLowerCase();
  const defaultBranch = text(input.defaultBranch || 'main', 160);
  const lifecycle = text(input.lifecycle || 'active', 16).toLowerCase();
  if (!displayName || !SOURCE_KINDS.has(sourceKind) || !defaultBranch || !LIFECYCLES.has(lifecycle)) throw Object.assign(new Error('workspace project metadata is invalid'), { status: 400 });
  return { projectKey, displayName, sourceKind, defaultBranch, lifecycle };
}

function row(item, repoBinding) {
  // sourceInventory is metadata state only: 'mirror' for desktop mirrors,
  // 'bound' when a repo binding exists, 'unbound' otherwise. It never fetches
  // repo contents — that is a future trust-boundary decision.
  const sourceInventory = item.source_kind === 'desktop_mirror' ? 'mirror' : (repoBinding ? 'bound' : 'unbound');
  return { projectKey: item.project_key, displayName: item.display_name, sourceKind: item.source_kind, defaultBranch: item.default_branch, lifecycle: item.lifecycle, createdBySubject: item.created_by_subject, createdAt: item.created_at, updatedAt: item.updated_at, execution: 'not_performed', sourceInventory, repoBinding: repoBinding ?? null };
}

function normalizeRepoBinding(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('workspace repo binding must be an object'), { status: 400 });
  const projectKey = assertCloudProjectKey(input.projectKey);
  const repoOwner = text(input.repoOwner, 39);
  const repoName = text(input.repoName, 100);
  const installationId = text(input.installationId, 64) || null;
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(repoOwner) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(repoName)) {
    throw Object.assign(new Error('workspace repo binding is invalid'), { status: 400 });
  }
  return { projectKey, repoOwner, repoName, installationId };
}

const SELECT = 'project_key, display_name, source_kind, default_branch, lifecycle, created_by_subject, created_at, updated_at';

export function createWorkspaceProjectRepository(pool) {
  return Object.freeze({
    async list(actor) {
      const active = context(actor);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const result = await client.query(`select ${SELECT} from helmion.workspace_projects where tenant_id=$1 order by lifecycle, display_name, project_key`, [active.tenantId]);
        let bindingsByKey = new Map();
        try {
          const bindings = await client.query(`select project_key, repo_owner, repo_name from helmion.workspace_repo_bindings where tenant_id=$1`, [active.tenantId]);
          for (const b of bindings.rows) bindingsByKey.set(b.project_key, { repoOwner: b.repo_owner, repoName: b.repo_name });
        } catch (error) {
          // Migration 049 not applied yet: bindings unavailable, inventory falls back to unbound.
          if (error?.code !== '42P01') throw error;
        }
        return { projects: result.rows.map((item) => row(item, bindingsByKey.get(item.project_key) ?? null)), source: 'tenant_workspace_project_registry', execution: 'not_performed', canManage: ['owner', 'admin'].includes(String(active.actorRole).toLowerCase()) };
      });
    },
    async save(actor, input) {
      if (!['owner', 'admin'].includes(String(actor?.role ?? '').toLowerCase())) throw Object.assign(new Error('workspace project registry requires owner or admin membership'), { status: 403 });
      const active = context(actor);
      const project = normalizeProject(input);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const result = await client.query(`insert into helmion.workspace_projects (tenant_id, project_key, display_name, source_kind, default_branch, lifecycle, created_by_subject) values ($1,$2,$3,$4,$5,$6,$7) on conflict (tenant_id,project_key) do update set display_name=excluded.display_name, source_kind=excluded.source_kind, default_branch=excluded.default_branch, lifecycle=excluded.lifecycle, updated_at=clock_timestamp() returning ${SELECT}`, [active.tenantId, project.projectKey, project.displayName, project.sourceKind, project.defaultBranch, project.lifecycle, active.actorSubject]);
        const receiptId = await appendAuditEvent(client, active, {
          actionType: 'workspace.project.register',
          canonicalTarget: { resource: 'workspace_project_registry', projectKey: project.projectKey },
          policyVersion: 'workspace-project.v1',
          decision: 'ALLOW',
          privacySummary: 'Bounded tenant workspace project registration; execution and provider invocation were not performed',
          result: { projectKey: project.projectKey, lifecycle: project.lifecycle, execution: 'not_performed', providerInvocation: 'not_performed' },
        });
        return { durable: true, receiptId, project: row(result.rows[0]), source: 'tenant_workspace_project_registry', execution: 'not_performed' };
      });
    },
    async setActiveProject(actor, input) {
      const active = context(actor);
      const projectKey = assertCloudProjectKey(input?.projectKey);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const project = await client.query(`select lifecycle from helmion.workspace_projects where tenant_id=$1 and project_key=$2`, [active.tenantId, projectKey]);
        if (project.rowCount !== 1) throw Object.assign(new Error('workspace project was not found'), { status: 404 });
        if (project.rows[0].lifecycle !== 'active') throw Object.assign(new Error('workspace project is not active'), { status: 409 });
        try {
          await client.query(
            `insert into helmion.workspace_active_project_selections (tenant_id, subject, project_key) values ($1,$2,$3)
             on conflict (tenant_id, subject) do update set project_key=excluded.project_key, selected_at=clock_timestamp()`,
            [active.tenantId, active.actorSubject, projectKey],
          );
        } catch (error) {
          if (error?.code === '42P01') throw Object.assign(new Error('workspace active-project selection is not available yet'), { status: 503 });
          throw error;
        }
        const receiptId = await appendAuditEvent(client, active, {
          actionType: 'workspace.project.selected',
          canonicalTarget: { resource: 'workspace_active_project_selection', projectKey },
          policyVersion: 'workspace-project.v1',
          decision: 'ALLOW',
          privacySummary: 'User selected their active workspace project; no filesystem access was performed',
          result: { projectKey },
        });
        return { durable: true, receiptId, projectKey };
      });
    },
    async getActiveProject(actor) {
      const active = context(actor);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        try {
          const result = await client.query(`select project_key from helmion.workspace_active_project_selections where tenant_id=$1 and subject=$2`, [active.tenantId, active.actorSubject]);
          return { projectKey: result.rowCount === 1 ? result.rows[0].project_key : null };
        } catch (error) {
          // Migration 048 not applied yet: no selection stored.
          if (error?.code === '42P01') return { projectKey: null, selectionUnavailable: true };
          throw error;
        }
      });
    },
    async bindRepo(actor, input) {
      if (!['owner', 'admin'].includes(String(actor?.role ?? '').toLowerCase())) throw Object.assign(new Error('workspace repo bindings require owner or admin membership'), { status: 403 });
      const active = context(actor);
      const binding = normalizeRepoBinding(input);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const project = await client.query(`select 1 from helmion.workspace_projects where tenant_id=$1 and project_key=$2`, [active.tenantId, binding.projectKey]);
        if (project.rowCount !== 1) throw Object.assign(new Error('workspace project was not found'), { status: 404 });
        try {
          await client.query(
            `insert into helmion.workspace_repo_bindings (tenant_id, project_key, repo_owner, repo_name, installation_id, created_by_subject)
             values ($1,$2,$3,$4,$5,$6)
             on conflict (tenant_id, project_key) do update set repo_owner=excluded.repo_owner, repo_name=excluded.repo_name, installation_id=excluded.installation_id, created_by_subject=excluded.created_by_subject, created_at=clock_timestamp()`,
            [active.tenantId, binding.projectKey, binding.repoOwner, binding.repoName, binding.installationId, active.actorSubject],
          );
        } catch (error) {
          if (error?.code === '42P01') throw Object.assign(new Error('workspace repo bindings are not available yet'), { status: 503 });
          throw error;
        }
        const receiptId = await appendAuditEvent(client, active, {
          actionType: 'workspace.repo.bound',
          canonicalTarget: { resource: 'workspace_repo_binding', projectKey: binding.projectKey, repoOwner: binding.repoOwner, repoName: binding.repoName },
          policyVersion: 'workspace-project.v1',
          decision: 'ALLOW',
          privacySummary: 'Owner bound a GitHub repository to a workspace project (metadata only; no repo contents were fetched)',
          result: { projectKey: binding.projectKey, repoOwner: binding.repoOwner, repoName: binding.repoName },
        });
        return { durable: true, receiptId, projectKey: binding.projectKey, repoOwner: binding.repoOwner, repoName: binding.repoName };
      });
    },
    async listRepoBindings(actor) {
      const active = context(actor);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        try {
          const result = await client.query(`select project_key, repo_owner, repo_name, created_by_subject, created_at from helmion.workspace_repo_bindings where tenant_id=$1 order by project_key`, [active.tenantId]);
          return { bindings: result.rows.map((b) => ({ projectKey: b.project_key, repoOwner: b.repo_owner, repoName: b.repo_name, createdBySubject: b.created_by_subject, createdAt: b.created_at })) };
        } catch (error) {
          if (error?.code === '42P01') return { bindings: [], bindingsUnavailable: true };
          throw error;
        }
      });
    },
  });
}

export { normalizeProject as normalizeWorkspaceProject };
