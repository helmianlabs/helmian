import { normalizeTenantContext } from '../core/tenant-context.mjs';

export const ATTRIBUTE_POLICY_VERSION = 'attribute-policy.v1';
export const ATTRIBUTE_POLICY_DECISIONS = Object.freeze({ ALLOW: 'ALLOW', DENY: 'DENY' });

const MAX_RULES = 100;
const MAX_ACTION_CHARS = 160;
const MAX_PATH_CHARS = 160;
const MAX_REASON_CHARS = 240;
const EFFECTS = new Set(['ALLOW', 'DENY']);
const OPERATORS = new Set(['eq', 'in', 'notIn', 'exists', 'contains', 'startsWith', 'endsWith', 'gt', 'gte', 'lt', 'lte']);

function plainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function boundedText(value, field, max) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/u.test(text)) throw new TypeError(`${field} is invalid`);
  return text;
}

function normalizeAction(value, field = 'action') {
  const action = boundedText(value, field, MAX_ACTION_CHARS);
  if (action !== '*' && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(action)) throw new TypeError(`${field} is invalid`);
  return action;
}

function normalizePath(value) {
  const path = boundedText(value, 'attribute path', MAX_PATH_CHARS);
  if (!/^(?:actor|resource|request|tenant)(?:\.[A-Za-z0-9_:-]+)+$/u.test(path)) throw new TypeError('attribute path must start with actor, resource, request, or tenant');
  return path;
}

function isOperatorObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length > 0 && Object.keys(value).every((key) => OPERATORS.has(key));
}

function normalizeCondition(value, field) {
  if (isOperatorObject(value)) {
    const output = {};
    for (const [operator, operand] of Object.entries(value)) {
      if (operator === 'exists') {
        if (typeof operand !== 'boolean') throw new TypeError(`${field}.exists must be boolean`);
      } else if (operator === 'in' || operator === 'notIn') {
        if (!Array.isArray(operand) || operand.length === 0 || operand.length > 100) throw new TypeError(`${field}.${operator} must be a non-empty array`);
      } else if (operator === 'contains' || operator === 'startsWith' || operator === 'endsWith') {
        if (typeof operand !== 'string') throw new TypeError(`${field}.${operator} must be a string`);
      } else if (operand && typeof operand === 'object') {
        throw new TypeError(`${field}.${operator} must be a scalar`);
      }
      output[operator] = Array.isArray(operand) ? [...operand] : operand;
    }
    return Object.freeze(output);
  }
  if (Array.isArray(value)) {
    if (value.length === 0 || value.length > 100) throw new TypeError(`${field} array must be non-empty`);
    return Object.freeze([...value]);
  }
  if (value && typeof value === 'object') throw new TypeError(`${field} must be a scalar, array, or operator object`);
  return value;
}

export function normalizeAttributeRules(input = []) {
  if (!Array.isArray(input)) throw new TypeError('attribute rules must be an array');
  if (input.length > MAX_RULES) throw new TypeError(`attribute rules cannot exceed ${MAX_RULES} entries`);
  return Object.freeze(input.map((raw, index) => {
    const rule = plainObject(raw, `attribute rule ${index}`);
    const id = boundedText(rule.id ?? `rule-${index + 1}`, `attribute rule ${index} id`, MAX_ACTION_CHARS);
    const effect = boundedText(rule.effect, `attribute rule ${index} effect`, 8).toUpperCase();
    if (!EFFECTS.has(effect)) throw new TypeError(`attribute rule ${index} effect must be ALLOW or DENY`);
    const actionsInput = rule.actions ?? (rule.action == null ? null : [rule.action]);
    if (!Array.isArray(actionsInput) || actionsInput.length === 0 || actionsInput.length > 32) throw new TypeError(`attribute rule ${index} actions must be a non-empty array`);
    const actions = Object.freeze(actionsInput.map((action) => normalizeAction(action, `attribute rule ${index} action`)));
    const conditionsInput = plainObject(rule.conditions ?? {}, `attribute rule ${index} conditions`);
    const conditions = {};
    for (const [path, condition] of Object.entries(conditionsInput)) conditions[normalizePath(path)] = normalizeCondition(condition, `attribute rule ${index} condition`);
    return Object.freeze({ id, effect, actions, conditions: Object.freeze(conditions), reason: rule.reason == null ? null : boundedText(rule.reason, `attribute rule ${index} reason`, MAX_REASON_CHARS) });
  }));
}

function getPath(root, path) {
  const segments = path.split('.');
  let current = root;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment)) return { exists: false, value: undefined };
    current = current[segment];
  }
  return { exists: true, value: current };
}

function equalValue(actual, expected) {
  if (actual === expected) return true;
  if (typeof actual === 'string' && typeof expected === 'string') return actual.localeCompare(expected, undefined, { sensitivity: 'accent' }) === 0;
  return false;
}

function compareCondition(actual, exists, condition) {
  if (!isOperatorObject(condition)) return Array.isArray(condition) ? condition.some((item) => equalValue(actual, item)) : equalValue(actual, condition);
  for (const [operator, expected] of Object.entries(condition)) {
    if (operator === 'exists' && exists !== expected) return false;
    if (operator === 'eq' && (!exists || !equalValue(actual, expected))) return false;
    if (operator === 'in' && (!exists || !expected.some((item) => equalValue(actual, item)))) return false;
    if (operator === 'notIn' && exists && expected.some((item) => equalValue(actual, item))) return false;
    if (operator === 'contains' && (!exists || typeof actual !== 'string' || !actual.includes(expected))) return false;
    if (operator === 'startsWith' && (!exists || typeof actual !== 'string' || !actual.startsWith(expected))) return false;
    if (operator === 'endsWith' && (!exists || typeof actual !== 'string' || !actual.endsWith(expected))) return false;
    if (operator === 'gt' && (!exists || !(actual > expected))) return false;
    if (operator === 'gte' && (!exists || !(actual >= expected))) return false;
    if (operator === 'lt' && (!exists || !(actual < expected))) return false;
    if (operator === 'lte' && (!exists || !(actual <= expected))) return false;
  }
  return true;
}

function ruleMatches(rule, subject, action) {
  if (!rule.actions.includes('*') && !rule.actions.includes(action)) return false;
  return Object.entries(rule.conditions).every(([path, condition]) => {
    const resolved = getPath(subject, path);
    return compareCondition(resolved.value, resolved.exists, condition);
  });
}

function subjectFor({ context, resource = {}, request = {} }) {
  const normalized = normalizeTenantContext({
    ...context,
    actorSubject: context?.actorSubject ?? context?.subject,
    actorRole: context?.actorRole ?? context?.role,
    sessionId: context?.sessionId ?? 'attribute-policy-session',
    requestId: context?.requestId ?? 'attribute-policy-request',
  });
  // Verified identity fields win over copied attributes. A connector binding
  // may carry descriptive attributes, but it cannot override tenant or actor
  // identity used by authorization.
  const actor = { ...(context.attributes ?? {}), tenantId: normalized.tenantId, subject: normalized.actorSubject, role: normalized.actorRole };
  const tenant = { id: normalized.tenantId };
  return { actor, tenant, resource: plainObject(resource, 'resource'), request: plainObject(request, 'request') };
}

/**
 * Evaluate deterministic tenant-scoped attribute rules. The context must be
 * the already-verified tenant transaction identity; this function never treats
 * actor-supplied attributes as an authorization override for tenant identity.
 */
export function evaluateAttributePolicy({ action, context, rules = [], resource = {}, request = {} } = {}) {
  const normalizedAction = normalizeAction(action);
  const subject = subjectFor({ context, resource, request });
  const normalizedRules = normalizeAttributeRules(rules);
  const resourceTenant = subject.resource.tenantId ?? subject.resource.tenant_id;
  if (resourceTenant != null && String(resourceTenant).toLowerCase() !== subject.actor.tenantId) {
    return Object.freeze({ decision: ATTRIBUTE_POLICY_DECISIONS.DENY, policyVersion: ATTRIBUTE_POLICY_VERSION, reason: 'resource tenant does not match verified actor tenant', matchedRuleIds: Object.freeze([]), evaluatedAttributes: Object.freeze({ tenantId: subject.actor.tenantId, actorSubject: subject.actor.subject, actorRole: subject.actor.role }) });
  }
  const matches = normalizedRules.filter((rule) => ruleMatches(rule, subject, normalizedAction));
  const deny = matches.find((rule) => rule.effect === ATTRIBUTE_POLICY_DECISIONS.DENY);
  const allow = matches.find((rule) => rule.effect === ATTRIBUTE_POLICY_DECISIONS.ALLOW);
  const decision = deny ? ATTRIBUTE_POLICY_DECISIONS.DENY : allow ? ATTRIBUTE_POLICY_DECISIONS.ALLOW : ATTRIBUTE_POLICY_DECISIONS.DENY;
  return Object.freeze({ decision, policyVersion: ATTRIBUTE_POLICY_VERSION, reason: deny?.reason ?? allow?.reason ?? (decision === ATTRIBUTE_POLICY_DECISIONS.DENY ? 'no matching allow rule' : 'matching allow rule'), matchedRuleIds: Object.freeze(matches.map((rule) => rule.id)), evaluatedAttributes: Object.freeze({ tenantId: subject.actor.tenantId, actorSubject: subject.actor.subject, actorRole: subject.actor.role }) });
}

export function assertAttributePolicy(input) {
  const result = evaluateAttributePolicy(input);
  if (result.decision !== ATTRIBUTE_POLICY_DECISIONS.ALLOW) {
    throw Object.assign(new Error(result.reason), { code: 'ATTRIBUTE_POLICY_DENIED', policyVersion: result.policyVersion, matchedRuleIds: result.matchedRuleIds });
  }
  return result;
}
