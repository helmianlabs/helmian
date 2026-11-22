import { randomUUID } from 'node:crypto';
import { requireActiveTenantMembership, TenantAuthorizationError, withTenantTransaction } from '../core/tenant-context.mjs';
import { normalizeAttributeRules } from './attribute-policy.mjs';

// Tenant attribute rules: the ABAC half of the Organization panel. An owner
// or admin writes rules for their own tenant; the audit read path evaluates
// them with the shipped defaults (defaults are the floor, deny wins). Every
// write lands an audit receipt in the same transaction.

function context(actor) {
  if (!actor?.tenantId || !actor.subject || !actor.role) throw new TenantAuthorizationError('verified Organization membership is required');
  return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId ?? randomUUID(), requestId: actor.requestId ?? randomUUID() };
}

function requireAdmin(actor) {
  if (!['owner', 'admin'].includes(String(actor.role).toLowerCase())) throw Object.assign(new Error('owner or admin membership is required'), { status: 403 });
}

function ruleView(row) {
  return {
    ruleId: String(row.rule_id),
    effect: String(row.effect),
    actions: Array.isArray(row.actions) ? row.actions.map(String) : [],
    conditions: row.conditions && typeof row.conditions === 'object' && !Array.isArray(row.conditions) ? row.conditions : {},
    reason: row.reason == null ? null : String(row.reason),
    active: row.active === true,
    createdBy: String(row.created_by),
    createdAt: row.created_at,
  };
}

function normalizeOneRule(input = {}) {
  const ruleId = String(input.ruleId ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(ruleId)) throw Object.assign(new Error('rule id is invalid'), { status: 400 });
  const candidate = { id: ruleId, effect: input.effect, actions: input.actions, conditions: input.conditions ?? {}, reason: input.reason ?? null };
  let normalized;
  try { [normalized] = normalizeAttributeRules([candidate]); } catch (error) { throw Object.assign(new Error(error.message), { status: 400 }); }
  return normalized;
}

// Enforcement read: the tenant's active rules in engine shape, read inside
// the caller's tenant transaction so RLS and the tenant GUC apply.
export async function loadTenantAttributeRules(client, tenantId) {
  const result = await client.query(
    'select rule_id, effect, actions, conditions, reason from helmion.tenant_attribute_rules where tenant_id=$1 and active order by id asc',
    [tenantId],
  );
  return result.rows.map((row) => ({ id: String(row.rule_id), effect: String(row.effect), actions: row.actions, conditions: row.conditions ?? {}, reason: row.reason ?? null }));
}

export function createTenantAttributeRulesRepository(pool) {
  return Object.freeze({
    async list(actor) {
      const active = context(actor);
      requireAdmin(actor);
      return withTenantTransaction(pool, active, async (client, scoped) => {
        await requireActiveTenantMembership(client, scoped);
        const result = await client.query(
          'select rule_id, effect, actions, conditions, reason, active, created_by, created_at from helmion.tenant_attribute_rules where tenant_id=$1 order by id asc',
          [scoped.tenantId],
        );
        return { rules: result.rows.map(ruleView), source: 'helmion.tenant_attribute_rules', mutation: 'not_performed' };
      });
    },
    async create(actor, input = {}) {
      const active = context(actor);
      requireAdmin(actor);
      const rule = normalizeOneRule(input);
      const reason = String(input.reason ?? '').trim();
      if (!reason || reason.length > 1000) throw Object.assign(new Error('attribute rule reason is required'), { status: 400 });
      return withTenantTransaction(pool, active, async (client, scoped) => {
        await requireActiveTenantMembership(client, scoped);
        const existing = await client.query('select id from helmion.tenant_attribute_rules where tenant_id=$1 and rule_id=$2', [scoped.tenantId, rule.id]);
        if (existing.rowCount > 0) throw Object.assign(new Error('a rule with this id already exists for this Organization'), { status: 409 });
        const inserted = await client.query(
          `insert into helmion.tenant_attribute_rules (tenant_id, rule_id, effect, actions, conditions, reason, created_by)
           values ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)
           returning rule_id, effect, actions, conditions, reason, active, created_by, created_at`,
          [scoped.tenantId, rule.id, rule.effect, JSON.stringify(rule.actions), JSON.stringify(rule.conditions), rule.reason, scoped.actorSubject],
        );
        const receipt = await client.query(
          `insert into helmion.audit_events (tenant_id, actor_subject, actor_role, session_id, request_id, action_type, canonical_target, policy_version, decision, privacy_summary, result)
           values ($1,$2,$3,$4,$5,'organization.attribute_rule_create',$6::jsonb,'tenant-attribute-rules.v1','ALLOW',$7,$8::jsonb) returning id`,
          [scoped.tenantId, scoped.actorSubject, scoped.actorRole, scoped.sessionId, scoped.requestId,
            JSON.stringify({ ruleId: rule.id, effect: rule.effect, actions: rule.actions }),
            `Attribute rule created: ${rule.id}`,
            JSON.stringify({ ruleId: rule.id, status: 'created' })],
        );
        return { durable: true, receiptId: String(receipt.rows[0]?.id ?? ''), status: 'created', rule: ruleView(inserted.rows[0]) };
      });
    },
    async remove(actor, input = {}) {
      const active = context(actor);
      requireAdmin(actor);
      const ruleId = String(input.ruleId ?? '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(ruleId)) throw Object.assign(new Error('rule id is invalid'), { status: 400 });
      const reason = String(input.reason ?? '').trim();
      if (!reason || reason.length > 1000) throw Object.assign(new Error('attribute rule removal reason is required'), { status: 400 });
      return withTenantTransaction(pool, active, async (client, scoped) => {
        await requireActiveTenantMembership(client, scoped);
        const deleted = await client.query(
          'delete from helmion.tenant_attribute_rules where tenant_id=$1 and rule_id=$2 returning rule_id',
          [scoped.tenantId, ruleId],
        );
        if (deleted.rowCount !== 1) throw Object.assign(new Error('attribute rule not found for this Organization'), { status: 404 });
        const receipt = await client.query(
          `insert into helmion.audit_events (tenant_id, actor_subject, actor_role, session_id, request_id, action_type, canonical_target, policy_version, decision, privacy_summary, result)
           values ($1,$2,$3,$4,$5,'organization.attribute_rule_delete',$6::jsonb,'tenant-attribute-rules.v1','ALLOW',$7,$8::jsonb) returning id`,
          [scoped.tenantId, scoped.actorSubject, scoped.actorRole, scoped.sessionId, scoped.requestId,
            JSON.stringify({ ruleId }), `Attribute rule removed: ${ruleId}`, JSON.stringify({ ruleId, status: 'removed' })],
        );
        return { durable: true, receiptId: String(receipt.rows[0]?.id ?? ''), status: 'removed', ruleId };
      });
    },
  });
}
