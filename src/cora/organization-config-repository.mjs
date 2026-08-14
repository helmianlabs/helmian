import { randomUUID } from 'node:crypto';
import { requireActiveTenantMembership, TenantAuthorizationError, withTenantTransaction } from '../core/tenant-context.mjs';
import { normalizeCoraPolicyConfig } from './organization-config.mjs';

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

function boundedText(value, name, max) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function optionalTimestamp(value, name) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`${name} is invalid`);
  return date.toISOString();
}

function rejectSensitiveExcerpt(value) {
  if (/(?:api[_ -]?key|secret|password|bearer|private key|access[_ -]?token)/iu.test(value)) throw new Error('knowledge excerpt cannot contain credential material');
}

function sourceRow(row) {
  return Object.freeze({ sourceId: String(row.id), sourceKey: String(row.source_key), title: String(row.title), publisher: String(row.publisher), canonicalUri: String(row.canonical_uri), provenance: String(row.provenance), lifecycle: String(row.lifecycle), effectiveAt: row.effective_at ?? null, expiresAt: row.expires_at ?? null, reviewedBySubject: row.reviewed_by_subject ?? null, reviewedAt: row.reviewed_at ?? null });
}

function packRow(row) {
  return Object.freeze({ packId: String(row.id), sourceId: String(row.source_id), packKey: String(row.pack_key), version: String(row.version), lifecycle: String(row.lifecycle), allowlisted: row.allowlisted === true, provenance: String(row.provenance), effectiveAt: row.effective_at ?? null, expiresAt: row.expires_at ?? null, reviewedBySubject: row.reviewed_by_subject ?? null, reviewedAt: row.reviewed_at ?? null });
}

function snippetRow(row) {
  return Object.freeze({ snippetId: String(row.id), packId: String(row.pack_id), citation: String(row.citation), textReference: String(row.text_reference), excerpt: row.excerpt ?? null, contentSha256: row.content_sha256 ?? null, expiresAt: row.expires_at ?? null });
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
    async listConfigs(actor) {
      requireAdmin(actor);
      const context = actorContext(actor);
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query(
          `select id, tenant_id, config_version, lifecycle, config, reason, provenance, is_current,
                  created_by_subject, created_at, approved_by_subject, approved_at,
                  published_by_subject, published_at, rollback_by_subject, rollback_at, rollback_reason
           from helmion.cora_configs where tenant_id=$1 order by config_version desc limit 32`,
          [context.tenantId],
        );
        return { configs: result.rows.map(configRow) };
      });
    },
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
    async queryApprovedKnowledge(actor, query, limit = 8) {
      const context = actorContext(actor);
      const search = text(query, 'knowledge query', 500).toLowerCase();
      const bounded = Math.min(Math.max(Number(limit) || 8, 1), 20);
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query(
          `select s.source_key, s.title, s.publisher, s.canonical_uri, s.provenance,
                  p.pack_key, p.version, p.provenance as pack_provenance,
                  k.citation, k.text_reference, k.excerpt, k.content_sha256
           from helmion.cora_knowledge_sources s
           join helmion.cora_knowledge_packs p on p.tenant_id=s.tenant_id and p.source_id=s.id
           join helmion.cora_knowledge_snippets k on k.tenant_id=p.tenant_id and k.pack_id=p.id
           where s.tenant_id=$1 and s.lifecycle='approved' and p.lifecycle='approved' and p.allowlisted=true
             and k.excerpt is not null
             and (s.expires_at is null or s.expires_at > clock_timestamp())
             and (p.expires_at is null or p.expires_at > clock_timestamp())
             and (k.expires_at is null or k.expires_at > clock_timestamp())
           order by s.source_key, p.pack_key, p.version, k.id
           limit $2`,
          [context.tenantId, bounded * 4],
        );
        const terms = search.split(/\s+/u).filter(Boolean);
        const matches = result.rows.filter((row) => terms.every((term) => `${row.excerpt} ${row.text_reference} ${row.citation}`.toLowerCase().includes(term))).slice(0, bounded);
        return {
          format: 'cora.approved-knowledge-retrieval.v1', status: matches.length ? 'approved_sources_only' : 'no_approved_source_match', query: search,
          answer: null, legalConclusion: 'not_provided', providerCall: 'not_performed', modelCall: 'not_performed',
          excerpts: matches.map((row) => Object.freeze({ excerpt: String(row.excerpt), citation: String(row.citation), source: String(row.source_key), title: String(row.title), publisher: String(row.publisher), canonicalUri: String(row.canonical_uri), provenance: String(row.provenance), pack: `${String(row.pack_key)} v${String(row.version)}`, packProvenance: String(row.pack_provenance), textReference: String(row.text_reference), contentSha256: row.content_sha256 ?? null })),
          citations: matches.map((row) => String(row.citation)),
        };
      });
    },
    async listKnowledgeAdmin(actor) {
      requireAdmin(actor);
      const context = actorContext(actor);
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const sources = await client.query(`select id, source_key, title, publisher, canonical_uri, provenance, lifecycle, effective_at, expires_at, reviewed_by_subject, reviewed_at from helmion.cora_knowledge_sources where tenant_id=$1 order by source_key`, [context.tenantId]);
        const packs = await client.query(`select id, source_id, pack_key, version, lifecycle, allowlisted, provenance, effective_at, expires_at, reviewed_by_subject, reviewed_at from helmion.cora_knowledge_packs where tenant_id=$1 order by pack_key, version`, [context.tenantId]);
        const snippets = await client.query(`select k.id, k.pack_id, k.citation, k.text_reference, k.excerpt, k.content_sha256, k.expires_at from helmion.cora_knowledge_snippets k where k.tenant_id=$1 order by k.pack_id, k.id`, [context.tenantId]);
        return { sources: sources.rows.map(sourceRow), packs: packs.rows.map(packRow), snippets: snippets.rows.map(snippetRow) };
      });
    },
    async createKnowledgeSource(actor, input) {
      requireAdmin(actor); const body = input ?? {}; rejectAuthority(body, 'knowledge source'); const context = actorContext(actor);
      const sourceKey = boundedText(body.sourceKey, 'source key', 128); const title = boundedText(body.title, 'source title', 240); const publisher = boundedText(body.publisher, 'source publisher', 240); const canonicalUri = boundedText(body.canonicalUri, 'canonical URI', 1000); const provenance = boundedText(body.provenance, 'source provenance', 1000); const effectiveAt = optionalTimestamp(body.effectiveAt, 'source effective time'); const expiresAt = optionalTimestamp(body.expiresAt, 'source expiry');
      return withTenantTransaction(pool, context, async (client) => { await requireActiveTenantMembership(client, context); const result = await client.query(`insert into helmion.cora_knowledge_sources (tenant_id, source_key, title, publisher, canonical_uri, provenance, lifecycle, effective_at, expires_at) values ($1,$2,$3,$4,$5,$6,'draft',$7,$8) returning id, source_key, title, publisher, canonical_uri, provenance, lifecycle, effective_at, expires_at, reviewed_by_subject, reviewed_at`, [context.tenantId, sourceKey, title, publisher, canonicalUri, provenance, effectiveAt, expiresAt]); return { source: sourceRow(result.rows[0]), reviewReceiptId: null }; });
    },
    async createKnowledgePack(actor, input) {
      requireAdmin(actor); const body = input ?? {}; rejectAuthority(body, 'knowledge pack'); const context = actorContext(actor); const sourceId = boundedText(body.sourceId, 'source id', 64); const packKey = boundedText(body.packKey, 'pack key', 128); const version = boundedText(body.version, 'pack version', 64); const provenance = boundedText(body.provenance, 'pack provenance', 1000); const effectiveAt = optionalTimestamp(body.effectiveAt, 'pack effective time'); const expiresAt = optionalTimestamp(body.expiresAt, 'pack expiry');
      return withTenantTransaction(pool, context, async (client) => { await requireActiveTenantMembership(client, context); const source = await client.query(`select id, lifecycle from helmion.cora_knowledge_sources where tenant_id=$1 and id=$2`, [context.tenantId, sourceId]); if (source.rowCount !== 1) throw new Error('knowledge source was not found in this Organization'); const result = await client.query(`insert into helmion.cora_knowledge_packs (tenant_id, source_id, pack_key, version, lifecycle, allowlisted, provenance, effective_at, expires_at) values ($1,$2,$3,$4,'draft',false,$5,$6,$7) returning id, source_id, pack_key, version, lifecycle, allowlisted, provenance, effective_at, expires_at, reviewed_by_subject, reviewed_at`, [context.tenantId, sourceId, packKey, version, provenance, effectiveAt, expiresAt]); return { pack: packRow(result.rows[0]) }; });
    },
    async createKnowledgeSnippet(actor, input) {
      requireAdmin(actor); const body = input ?? {}; rejectAuthority(body, 'knowledge snippet'); const context = actorContext(actor); const packId = boundedText(body.packId, 'pack id', 64); const citation = boundedText(body.citation, 'citation', 1000); const textReference = boundedText(body.textReference, 'text reference', 2000); const excerpt = body.excerpt == null ? null : boundedText(body.excerpt, 'excerpt', 2000); if (excerpt) rejectSensitiveExcerpt(excerpt); const contentSha256 = body.contentSha256 == null ? null : boundedText(body.contentSha256, 'content hash', 128); const expiresAt = optionalTimestamp(body.expiresAt, 'snippet expiry');
      return withTenantTransaction(pool, context, async (client) => { await requireActiveTenantMembership(client, context); const pack = await client.query(`select id, lifecycle, allowlisted from helmion.cora_knowledge_packs where tenant_id=$1 and id=$2`, [context.tenantId, packId]); if (pack.rowCount !== 1) throw new Error('knowledge pack was not found in this Organization'); const result = await client.query(`insert into helmion.cora_knowledge_snippets (tenant_id, pack_id, citation, text_reference, content_sha256, excerpt, expires_at) values ($1,$2,$3,$4,$5,$6,$7) returning id, pack_id, citation, text_reference, excerpt, content_sha256, expires_at`, [context.tenantId, packId, citation, textReference, contentSha256, excerpt, expiresAt]); return { snippet: snippetRow(result.rows[0]) }; });
    },
    async transitionKnowledge(actor, input) {
      requireAdmin(actor); const body = input ?? {}; rejectAuthority(body, 'knowledge transition'); const context = actorContext(actor); const kind = boundedText(body.kind, 'knowledge entity kind', 16).toLowerCase(); const id = boundedText(body.id, 'knowledge entity id', 64); const lifecycle = boundedText(body.lifecycle, 'knowledge lifecycle', 16).toLowerCase(); const reason = boundedText(body.reason, 'knowledge review reason', 2000); if (!['source', 'pack'].includes(kind) || !['draft', 'approved', 'retired'].includes(lifecycle)) throw new Error('knowledge lifecycle transition is invalid');
      return withTenantTransaction(pool, context, async (client) => { await requireActiveTenantMembership(client, context); const table = kind === 'source' ? 'cora_knowledge_sources' : 'cora_knowledge_packs'; const current = await client.query(`select id, lifecycle, source_id from helmion.${table} where tenant_id=$1 and id=$2 for update`, [context.tenantId, id]); if (current.rowCount !== 1) throw new Error('knowledge entity was not found in this Organization'); if (lifecycle === 'approved' && kind === 'pack') { const source = await client.query(`select lifecycle from helmion.cora_knowledge_sources where tenant_id=$1 and id=$2`, [context.tenantId, current.rows[0].source_id]); if (source.rowCount !== 1 || source.rows[0].lifecycle !== 'approved') throw new Error('knowledge source must be approved before its pack'); } const result = await client.query(`update helmion.${table} set lifecycle=$3, allowlisted=case when $3='approved' and $4='pack' then true when $3<>'approved' and $4='pack' then false else allowlisted end, reviewed_by_subject=$5, reviewed_at=clock_timestamp() where tenant_id=$1 and id=$2 returning *`, [context.tenantId, id, lifecycle, kind, context.actorSubject]); return { kind, lifecycle, id, reason, reviewReceiptId: randomUUID(), entity: kind === 'source' ? sourceRow(result.rows[0]) : packRow(result.rows[0]) }; });
    },
    async createDraft(actor, input) {
      requireAdmin(actor);
      const body = object(input, 'Cora config draft');
      const config = object(body.config, 'Cora config');
      const normalizedConfig = normalizeCoraPolicyConfig(config);
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
          [context.tenantId, Number(version.rows[0].next_version), JSON.stringify(normalizedConfig), reason, JSON.stringify(provenance), context.actorSubject, context.actorRole],
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
