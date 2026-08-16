import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';

const PROJECT_KEYS = new Set(['projectKey', 'displayName', 'sourceKind', 'defaultBranch', 'lifecycle']);
const SOURCE_KINDS = new Set(['cloud', 'desktop_mirror', 'external']);
const LIFECYCLES = new Set(['active', 'archived']);

function context(actor) {
  if (!actor?.tenantId || !actor.subject || !actor.role || !actor.sessionId || !actor.requestId) throw new Error('verified Organization membership is required');
  return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId, requestId: actor.requestId };
}

function text(value, max) { return String(value ?? '').trim().slice(0, max); }

function normalizeProject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('workspace project must be an object'), { status: 400 });
  if (Object.keys(input).some((key) => !PROJECT_KEYS.has(key))) throw Object.assign(new Error('workspace project contains a forbidden field'), { status: 400 });
  const projectKey = text(input.projectKey, 96).toLowerCase();
  const displayName = text(input.displayName, 160);
  const sourceKind = text(input.sourceKind, 32).toLowerCase();
  const defaultBranch = text(input.defaultBranch || 'main', 160);
  const lifecycle = text(input.lifecycle || 'active', 16).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,95}$/.test(projectKey) || !displayName || !SOURCE_KINDS.has(sourceKind) || !defaultBranch || !LIFECYCLES.has(lifecycle)) throw Object.assign(new Error('workspace project metadata is invalid'), { status: 400 });
  return { projectKey, displayName, sourceKind, defaultBranch, lifecycle };
}

function row(item) {
  return { projectKey: item.project_key, displayName: item.display_name, sourceKind: item.source_kind, defaultBranch: item.default_branch, lifecycle: item.lifecycle, createdBySubject: item.created_by_subject, createdAt: item.created_at, updatedAt: item.updated_at, execution: 'not_performed', sourceInventory: 'not_connected' };
}

const SELECT = 'project_key, display_name, source_kind, default_branch, lifecycle, created_by_subject, created_at, updated_at';

export function createWorkspaceProjectRepository(pool) {
  return Object.freeze({
    async list(actor) {
      const active = context(actor);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const result = await client.query(`select ${SELECT} from helmion.workspace_projects where tenant_id=$1 order by lifecycle, display_name, project_key`, [active.tenantId]);
        return { projects: result.rows.map(row), source: 'tenant_workspace_project_registry', execution: 'not_performed', canManage: ['owner', 'admin'].includes(String(active.actorRole).toLowerCase()) };
      });
    },
    async save(actor, input) {
      if (!['owner', 'admin'].includes(String(actor?.role ?? '').toLowerCase())) throw Object.assign(new Error('workspace project registry requires owner or admin membership'), { status: 403 });
        const active = context(actor);
        const project = normalizeProject(input);
        return withTenantTransaction(pool, active, async (client) => {
          await requireActiveTenantMembership(client, active);
          const result = await client.query(`insert into helmion.workspace_projects (tenant_id, project_key, display_name, source_kind, default_branch, lifecycle, created_by_subject) values ($1,$2,$3,$4,$5,$6,$7) on conflict (tenant_id,project_key) do update set display_name=excluded.display_name, source_kind=excluded.source_kind, default_branch=excluded.default_branch, lifecycle=excluded.lifecycle, updated_at=clock_timestamp() returning ${SELECT}`, [active.tenantId, project.projectKey, project.displayName, project.sourceKind, project.defaultBranch, project.lifecycle, active.actorSubject]);
          const projectView = row(result.rows[0]);
          const receipt = await client.query(`insert into helmion.audit_events (tenant_id, actor_subject, actor_role, session_id, request_id, action_type, canonical_target, policy_version, decision, privacy_summary, result) values ($1,$2,$3,$4,$5,'workspace.project.write',$6::jsonb,'tenant-rbac-abac.v1','ALLOW',$7,$8::jsonb) returning id`, [active.tenantId, active.actorSubject, active.actorRole, active.sessionId, active.requestId, JSON.stringify({ resource: 'workspace.project', projectKey: project.projectKey }), 'Tenant workspace project metadata registered', JSON.stringify({ projectKey: project.projectKey, durableSource: 'helmion.workspace_projects' })]);
          if (receipt.rowCount !== 1 || receipt.rows[0]?.id == null) throw new Error('workspace project receipt was not durable');
          return { durable: true, receiptId: String(receipt.rows[0].id), project: projectView, source: 'tenant_workspace_project_registry', execution: 'not_performed' };
        });
      },
  });
}

export { normalizeProject as normalizeWorkspaceProject };
