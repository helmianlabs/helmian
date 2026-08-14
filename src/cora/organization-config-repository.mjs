import { requireActiveTenantMembership, TenantAuthorizationError, withTenantTransaction } from '../core/tenant-context.mjs';

const ADMIN_ROLES = new Set(['owner', 'admin']);
const LIFECYCLES = new Set(['draft', 'testing', 'approved', 'published', 'rolled_back']);
const TRANSITIONS = Object.freeze({ draft: new Set(['testing', 'rolled_back']), testing: new Set(['approved', 'rolled_back']), approved: new Set(['published', 'rolled_back']), published: new Set(['rolled_back']), rolled_back: new Set() });

function text(value, name, max) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max) throw new Error(`${name} is missing or too long`);
  return result;
}

function rejectAuthority(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  if (['organizationId', 'organization_id', 'tenantId', 'tenant_id', 'plantId', 'plant_id', 'facilityId', 'facility_id'].some((key) => Object.hasOwn(value, key))) {
    throw new Error(`${name} cannot select Organization, tenant, Plant, or facility authority`);
  }
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  rejectAuthority(value, name);
  return value;
}

function actorContext(actor) {
  if (!actor?.tenantId || !actor.subject || !actor.role) throw new TenantAuthorizationError('verified Organization membership is required');
  return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId, requestId: actor.requestId };
}

function requireAdmin(actor) {
  if (!ADMIN_ROLES.has(String(actor?.role ?? '').toLowerCase())) throw new TenantAuthorizationError('Cora configuration admin membership required');
}

function configRow(row) {
  return Object.freeze({
    id: String(row.id), organizationId: String(row.tenant_id), configVersion: Number(row.config_version), lifecycle: String(row.lifecycle),
    config: row.config, reason: String(row.reason), provenance: row.provenance, isCurrent: row.is_current === true,
    createdBySubject: String(row.created_by_subject), createdAt: row.created_at, approvedBySubject: row.approved_by_subject ?? null,
    approvedAt: row.approved_at ?? null, publishedBySubject: row.published_by_subject ?? null, publishedAt: row.published_at ?? null,
    rollbackBySubject: row.rollback_by_subject ?? null, rollbackAt: row.rollback_at ?? null, rollbackReason: row.rollback_reason ?? null,
  });
}

export function createCoraOrganizationConfigRepository(pool) {
  return Object.freeze({
    async readPublishedConfig(actor) {
      const context = actorContext(actor);
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query(
          `select id, tenant_id, config_version, lifecycle, config, reason, provenance, is_current,
                  created_by_subject, created_at, approved_by_subject, approved_at,
                  published_by_subject, published_at, rollback_by_subject, rollback_at, rollback_reason
           from helmion.cora_configs where tenant_id=$1 and lifecycle='published' and is_current limit 1`,
          [context.tenantId],
        );
        return { status: result.rowCount === 1 ? 'published' : 'not_published', config: result.rowCount === 1 ? configRow(result.rows[0]) : null };
      });
    },
    async listKnowledgeSources(actor) {
      const context = actorContext(actor);
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query(
          `select s.source_key, s.title, s.publisher, s.canonical_uri, s.provenance, s.lifecycle,
                  p.pack_key, p.version, p.lifecycle as pack_lifecycle, p.allowlisted,
                  k.citation, k.text_reference, k.content_sha256
           from helmion.cora_knowledge_sources s
           left join helmion.cora_knowledge_packs p on p.tenant_id=s.tenant_id and p.source_id=s.id
           left join helmion.cora_knowledge_snippets k on k.tenant_id=p.tenant_id and k.pack_id=p.id
           where s.tenant_id=$1 and s.lifecycle='approved'
           order by s.source_key, p.pack_key, p.version, k.id`,
          [context.tenantId],
        );
        return { sources: result.rows.map((row) => Object.freeze({
          sourceKey: String(row.source_key), title: String(row.title), publisher: String(row.publisher), canonicalUri: String(row.canonical_uri),
          provenance: String(row.provenance), lifecycle: String(row.lifecycle), pack: row.pack_key ? Object.freeze({ key: String(row.pack_key), version: String(row.version), lifecycle: String(row.pack_lifecycle), allowlisted: row.allowlisted === true }) : null,
          snippet: row.citation ? Object.freeze({ citation: String(row.citation), textReference: String(row.text_reference), contentSha256: row.content_sha256 ?? null }) : null,
        })) };
      });
    },
    async createDraft(actor, input) {
      requireAdmin(actor);
      const body = object(input, 'Cora config draft');
      const config = object(body.config, 'Cora config');
      const reason = text(body.reason, 'Cora config reason', 2000);
      const provenance = object(body.provenance ?? {}, 'Cora config provenance');
      const context = actorContext(actor);
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const version = await client.query('select coalesce(max(config_version), 0) + 1 as next_version from helmion.cora_configs where tenant_id=$1', [context.tenantId]);
        const result = await client.query(
          `insert into helmion.cora_configs(tenant_id, config_version, lifecycle, config, reason, provenance, created_by_subject, created_by_role)
           values ($1,$2,'draft',$3::jsonb,$4,$5::jsonb,$6,$7)
           returning id, tenant_id, config_version, lifecycle, config, reason, provenance, is_current, created_by_subject, created_at,
                     approved_by_subject, approved_at, published_by_subject, published_at, rollback_by_subject, rollback_at, rollback_reason`,
          [context.tenantId, Number(version.rows[0].next_version), JSON.stringify(config), reason, JSON.stringify(provenance), context.actorSubject, context.actorRole],
        );
        return { config: configRow(result.rows[0]) };
      });
    },
    async transition(actor, input) {
      requireAdmin(actor);
      const body = object(input, 'Cora config transition');
      const id = text(body.id, 'Cora config id', 64);
      const next = text(body.lifecycle, 'Cora config lifecycle', 32).toLowerCase();
      const reason = text(body.reason, 'Cora transition reason', 2000);
      if (!LIFECYCLES.has(next)) throw new Error('Cora config lifecycle is invalid');
      const context = actorContext(actor);
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const current = await client.query(
          `select id, tenant_id, config_version, lifecycle, config, reason, provenance, is_current, created_by_subject, created_at,
                  approved_by_subject, approved_at, published_by_subject, published_at, rollback_by_subject, rollback_at, rollback_reason
           from helmion.cora_configs where tenant_id=$1 and id=$2 for update`, [context.tenantId, id],
        );
        if (current.rowCount !== 1) throw new Error('Cora config was not found in this Organization');
        const row = current.rows[0];
        if (!TRANSITIONS[row.lifecycle]?.has(next)) throw new Error(`Cora lifecycle transition ${row.lifecycle} to ${next} is invalid`);
        if (next === 'published') {
          const other = await client.query(`select id from helmion.cora_configs where tenant_id=$1 and lifecycle='published' and is_current and id<>$2 for update`, [context.tenantId, id]);
          if (other.rowCount) {
            await client.query(`update helmion.cora_configs set lifecycle='rolled_back', is_current=false, rollback_by_subject=$3, rollback_at=clock_timestamp(), rollback_reason=$4, updated_at=clock_timestamp() where tenant_id=$1 and id=$2`, [context.tenantId, other.rows[0].id, context.actorSubject, 'replaced by newer approved Cora config']);
          }
          await client.query(`update helmion.cora_configs set lifecycle='published', is_current=true, published_by_subject=$3, published_at=clock_timestamp(), updated_at=clock_timestamp() where tenant_id=$1 and id=$2`, [context.tenantId, id, context.actorSubject]);
        } else if (next === 'approved') {
          await client.query(`update helmion.cora_configs set lifecycle='approved', approved_by_subject=$3, approved_at=clock_timestamp(), updated_at=clock_timestamp() where tenant_id=$1 and id=$2`, [context.tenantId, id, context.actorSubject]);
        } else if (next === 'rolled_back') {
          await client.query(`update helmion.cora_configs set lifecycle='rolled_back', is_current=false, rollback_by_subject=$3, rollback_at=clock_timestamp(), rollback_reason=$4, updated_at=clock_timestamp() where tenant_id=$1 and id=$2`, [context.tenantId, id, context.actorSubject, reason]);
        } else {
          await client.query(`update helmion.cora_configs set lifecycle=$3, updated_at=clock_timestamp() where tenant_id=$1 and id=$2`, [context.tenantId, id, next]);
        }
        return { lifecycle: next, id, reason, actorSubject: context.actorSubject };
      });
    },
  });
}

