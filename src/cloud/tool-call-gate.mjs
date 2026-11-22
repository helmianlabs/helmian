// The tool-call gate: the attribute-policy check that runs BEFORE an agent
// tool call executes and BEFORE an outbound network request leaves.
//
// Rules come from the tenant's own store — the same Organization panel
// rules (sql/095) that govern audit reads — loaded fresh inside each
// call's tenant transaction, so a rule an admin creates on the panel
// takes effect on the next call with no redeploy. A shipped floor rule
// allows verified in-tenant work; the policy engine itself hard-denies
// any resource whose tenant differs from the actor's, and tenant DENY
// rules win over the floor. Rules can match on the actor's role and job
// title (actor.*), the tool name or destination domain and data label
// (resource.*), the tenant (tenant.* / actor.tenantId), and the time
// (request.hour, request.time).
//
// Every decision — allow and deny alike — writes a receipt to the audit
// trail inside the same transaction, so the manager audit view shows the
// call, the verdict, and the rules that matched. A denied call throws
// (for tool calls) or returns its verdict (for network requests, whose
// callers decide how to surface a refusal); either way the receipt is
// already written.

import { randomUUID } from 'node:crypto';
import { evaluateAttributePolicy } from './attribute-policy.mjs';
import { loadTenantAttributeRules } from './tenant-attribute-rules-repository.mjs';
import { appendAuditEvent } from './audit-event-repository.mjs';
import { withTenantTransaction, requireActiveTenantMembership } from '../core/tenant-context.mjs';

export const TOOL_CALL_ACTION = 'tool.call';
export const NETWORK_REQUEST_ACTION = 'network.request';

const FLOOR_RULES = Object.freeze([{
  id: 'verified-tenant-floor',
  effect: 'ALLOW',
  actions: [TOOL_CALL_ACTION, NETWORK_REQUEST_ACTION],
  conditions: { 'request.tenantScope': 'verified' },
  reason: 'Verified in-tenant work is allowed unless a tenant rule denies it.',
}]);

export class ToolCallDeniedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ToolCallDeniedError';
    this.code = 'TOOL_CALL_ATTRIBUTE_POLICY_DENIED';
    this.status = 403;
    this.details = details;
  }
}

function hostOf(url) {
  try { return new URL(String(url)).hostname; } catch { return null; }
}

/**
 * Create the gate. `rulesProvider(client, tenantId)` is injectable for
 * tests; in production it is the panel rule store loader, read inside the
 * call's own tenant transaction.
 */
export function createToolCallGate({ pool, rulesProvider = null, now = () => new Date(), requireMembership = true } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool is required');
  const loadRules = rulesProvider ?? ((client, tenantId) => loadTenantAttributeRules(client, tenantId));

  async function authorize(actor, { action, resource }) {
    if (!actor?.tenantId || !actor?.subject) throw new TypeError('an actor with tenantId and subject is required');
    const context = {
      tenantId: actor.tenantId,
      actorSubject: actor.subject,
      actorRole: actor.role ?? 'member',
      sessionId: actor.sessionId ?? randomUUID(),
      requestId: randomUUID(),
    };
    const outcome = await withTenantTransaction(pool, context, async (client, scoped) => {
      // System actors (the outbound delivery worker acting for a tenant)
      // are not tenant members; their gate is constructed with
      // requireMembership: false. Human and agent actors keep the
      // membership requirement — a non-member's call never reaches the
      // policy evaluation.
      if (requireMembership) await requireActiveTenantMembership(client, scoped);
      const tenantRules = await loadRules(client, actor.tenantId);
      const at = now();
      const attributes = actor.attributes ?? (actor.jobTitle != null ? { jobTitle: actor.jobTitle } : {});
      const result = evaluateAttributePolicy({
        action,
        context: { ...scoped, attributes },
        resource,
        request: { tenantScope: 'verified', time: at.toISOString(), hour: at.getUTCHours() },
        rules: [...FLOOR_RULES, ...tenantRules],
      });
      const allowed = result.decision === 'ALLOW';
      const label = action === TOOL_CALL_ACTION ? `tool ${resource.toolName ?? '?'}` : `network ${resource.domain ?? '?'}`;
      const receiptId = await appendAuditEvent(client, scoped, {
        actionType: action,
        canonicalTarget: {
          kind: resource.kind,
          toolName: resource.toolName ?? null,
          domain: resource.domain ?? null,
          dataLabel: resource.dataLabel ?? null,
          tenantId: resource.tenantId ?? actor.tenantId,
        },
        policyVersion: result.policyVersion,
        decision: allowed ? 'allow' : 'deny',
        privacySummary: `${label} ${allowed ? 'allowed' : 'refused'} by attribute policy (${result.reason})`.slice(0, 240),
        result: { decision: result.decision, matchedRuleIds: result.matchedRuleIds, reason: result.reason },
      });
      return { allowed, decision: result.decision, receiptId, matchedRuleIds: result.matchedRuleIds, reason: result.reason, policyVersion: result.policyVersion };
    });
    return outcome;
  }

  return Object.freeze({
    /** Returns the verdict (with receiptId). Never throws for a denial. */
    async authorizeToolCall(actor, { toolName, dataLabel = null, resourceTenantId = null } = {}) {
      return authorize(actor, {
        action: TOOL_CALL_ACTION,
        resource: { kind: 'tool_call', toolName: toolName ?? null, dataLabel, tenantId: resourceTenantId ?? actor.tenantId },
      });
    },
    /** Returns the verdict (with receiptId). Never throws for a denial. */
    async authorizeNetworkRequest(actor, { url = null, domain = null, dataLabel = null, resourceTenantId = null } = {}) {
      return authorize(actor, {
        action: NETWORK_REQUEST_ACTION,
        resource: { kind: 'network_request', domain: domain ?? hostOf(url), dataLabel, tenantId: resourceTenantId ?? actor.tenantId },
      });
    },
    /** Throws ToolCallDeniedError on a denial — for call sites that must not proceed. */
    async assertToolCall(actor, input) {
      const verdict = await this.authorizeToolCall(actor, input);
      if (!verdict.allowed) {
        throw new ToolCallDeniedError(`Tool call refused by attribute policy: ${verdict.reason}`, verdict);
      }
      return verdict;
    },
    async assertNetworkRequest(actor, input) {
      const verdict = await this.authorizeNetworkRequest(actor, input);
      if (!verdict.allowed) {
        throw new ToolCallDeniedError(`Network request refused by attribute policy: ${verdict.reason}`, verdict);
      }
      return verdict;
    },
  });
}
