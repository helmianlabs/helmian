export const CORA_ROUTING_POLICY_FORMAT = 'cora.routing-policy.v1';
export const CORA_ROUTING_TASK_CLASSES = Object.freeze(['voice_conversation', 'cited_knowledge', 'safe_action_preparation', 'artifact_execution_request']);

const BUDGET_TIERS = new Set(['low', 'standard', 'high']);
const LATENCY_TIERS = new Set(['interactive', 'standard', 'batch']);
const MODALITIES = new Set(['text', 'audio', 'image', 'video', 'multimodal']);
const POLICY_KEYS = ['taskClass', 'allowedCatalogIds', 'defaultCatalogId', 'fallbackCatalogIds', 'budgetTier', 'latencyTier', 'userSelectable', 'usageWorkflow', 'usageAction', 'modality'];

function text(value, name, max) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function rejectAuthority(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  if (['organizationId', 'organization_id', 'tenantId', 'tenant_id', 'plantId', 'plant_id', 'facilityId', 'facility_id'].some((key) => Object.hasOwn(value, key))) throw new Error(`${name} cannot select Organization, tenant, Plant, or facility authority`);
}

function exactKeys(value, allowed, name) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${name} contains unsupported fields`);
}

function ids(value, name) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) throw new Error(`${name} must contain 1 to 16 catalog ids`);
  const result = [...new Set(value.map((item) => text(item, `${name} catalog id`, 128)))];
  if (result.length !== value.length) throw new Error(`${name} contains duplicate catalog ids`);
  return Object.freeze(result);
}

export function normalizeCoraRoutingPolicy(input, approvedCatalog = []) {
  if (input == null) return null;
  rejectAuthority(input, 'Cora routing policy');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Cora routing policy must be an object');
  exactKeys(input, ['format', 'version', 'entries'], 'Cora routing policy');
  if (input.format !== undefined && input.format !== CORA_ROUTING_POLICY_FORMAT) throw new Error('Cora routing policy format is invalid');
  const version = Number(input.version ?? 1);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Cora routing policy version is invalid');
  if (!Array.isArray(input.entries) || input.entries.length !== CORA_ROUTING_TASK_CLASSES.length) throw new Error('Cora routing policy must define every task class exactly once');
  const catalogIds = new Set(approvedCatalog.map((entry) => text(entry.id, 'approved catalog id', 128)));
  const seen = new Set();
  const entries = input.entries.map((entry) => {
    rejectAuthority(entry, 'Cora routing policy entry');
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Cora routing policy entry must be an object');
    exactKeys(entry, POLICY_KEYS, 'Cora routing policy entry');
    const taskClass = text(entry.taskClass, 'routing task class', 64);
    if (!CORA_ROUTING_TASK_CLASSES.includes(taskClass) || seen.has(taskClass)) throw new Error('Cora routing policy task classes are invalid');
    seen.add(taskClass);
    const allowedCatalogIds = ids(entry.allowedCatalogIds, 'allowed catalog ids');
    const fallbackCatalogIds = entry.fallbackCatalogIds === undefined ? [] : (entry.fallbackCatalogIds.length ? ids(entry.fallbackCatalogIds, 'fallback catalog ids') : []);
    const all = [...allowedCatalogIds, ...fallbackCatalogIds];
    if (all.some((id) => !catalogIds.has(id))) throw new Error('Cora routing policy references an unapproved catalog entry');
    const defaultCatalogId = text(entry.defaultCatalogId, 'default catalog id', 128);
    if (!allowedCatalogIds.includes(defaultCatalogId)) throw new Error('Cora routing policy default is not allowed');
    if (fallbackCatalogIds.some((id) => allowedCatalogIds.includes(id))) throw new Error('Cora routing policy fallback duplicates an allowed catalog entry');
    if (!BUDGET_TIERS.has(entry.budgetTier) || !LATENCY_TIERS.has(entry.latencyTier) || typeof entry.userSelectable !== 'boolean' || !MODALITIES.has(entry.modality)) throw new Error('Cora routing policy tier or modality is invalid');
    return Object.freeze({ taskClass, allowedCatalogIds, defaultCatalogId, fallbackCatalogIds, budgetTier: entry.budgetTier, latencyTier: entry.latencyTier, userSelectable: entry.userSelectable, usageWorkflow: text(entry.usageWorkflow, 'usage workflow', 128), usageAction: text(entry.usageAction, 'usage action', 128), modality: entry.modality });
  });
  if (seen.size !== CORA_ROUTING_TASK_CLASSES.length) throw new Error('Cora routing policy task classes are incomplete');
  return Object.freeze({ format: CORA_ROUTING_POLICY_FORMAT, version, entries: Object.freeze(entries) });
}

export function resolveCoraRouting({ policy, taskClass, requestedCatalogId, approvedCatalog = [] } = {}) {
  const normalized = normalizeCoraRoutingPolicy(policy, approvedCatalog);
  if (!normalized) return Object.freeze({ status: 'unavailable', taskClass: text(taskClass, 'routing task class', 64), selection: 'policy_unavailable' });
  const entry = normalized.entries.find((candidate) => candidate.taskClass === taskClass);
  if (!entry) throw new Error('routing task class is not configured');
  const requested = requestedCatalogId == null ? null : text(requestedCatalogId, 'requested catalog id', 128);
  const selected = requested && entry.userSelectable && entry.allowedCatalogIds.includes(requested) ? requested : entry.defaultCatalogId;
  const catalogEntry = approvedCatalog.find((candidate) => candidate.id === selected);
  return Object.freeze({ status: 'policy_selected', policyVersion: normalized.version, taskClass, catalogId: selected, provider: catalogEntry.provider, model: catalogEntry.model, selection: requested === selected ? 'user_selected' : 'policy_selected', budgetTier: entry.budgetTier, latencyTier: entry.latencyTier, usageLedger: Object.freeze({ workflow: entry.usageWorkflow, action: entry.usageAction, modality: entry.modality }), fallbackCatalogIds: entry.fallbackCatalogIds });
}

const BUDGET_ORDER = Object.freeze({ low: 0, standard: 1, high: 2 });
const ROUTE_TASK_CLASS = Object.freeze({ approved_knowledge_lookup: 'cited_knowledge', workspace_preview: 'safe_action_preparation', artifact_execution_request: 'artifact_execution_request' });

export function resolveCoraExecutionRoute({ policy, approvedCatalog = [], taskType, requestedCatalogId = null, requestedBudgetTier = null, requestedLatencyTier = null, external = false } = {}) {
  const taskClass = ROUTE_TASK_CLASS[taskType] ?? taskType;
  let route;
  try { route = resolveCoraRouting({ policy, approvedCatalog, taskClass, requestedCatalogId }); } catch (error) { return Object.freeze({ status: 'no_route', taskType, taskClass, reason: error.message }); }
  if (route.status === 'unavailable') return Object.freeze({ status: 'no_route', taskType, taskClass, reason: 'published routing policy is unavailable' });
  if (requestedBudgetTier && BUDGET_ORDER[requestedBudgetTier] === undefined) return Object.freeze({ status: 'blocked', taskType, taskClass, reason: 'requested budget tier is invalid', route });
  if (requestedBudgetTier && BUDGET_ORDER[requestedBudgetTier] > BUDGET_ORDER[route.budgetTier]) return Object.freeze({ status: 'blocked', taskType, taskClass, reason: 'requested budget tier exceeds Organization policy', route });
  if (requestedLatencyTier && requestedLatencyTier !== route.latencyTier) return Object.freeze({ status: 'blocked', taskType, taskClass, reason: 'requested latency tier is outside Organization policy', route });
  if (external === true || taskClass === 'artifact_execution_request' || route.budgetTier === 'high') return Object.freeze({ status: 'approval_required', taskType, taskClass, reason: 'external or high-cost route requires step-up', route });
  return Object.freeze({ status: 'allowed', taskType, taskClass, reason: 'normal in-scope route allowed', route });
}
