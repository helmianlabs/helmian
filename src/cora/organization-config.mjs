import { evaluateCoraActionPolicy } from './action-policy.mjs';
import { normalizeCoraRoutingPolicy } from './routing-policy.mjs';

export const CORA_ORGANIZATION_CONFIG_FORMAT = 'cora.organization-config.v1';
export const CORA_KNOWLEDGE_RESPONSE_FORMAT = 'cora.approved-knowledge-response.v1';

const ROLES = new Set(['owner', 'admin', 'member', 'auditor']);
const STYLES = new Set(['professional_brief']);
const INTERRUPT_MODES = new Set(['barge_in', 'after_sentence']);
const TURN_MODES = new Set(['concise', 'standard']);
const VERBOSITIES = new Set(['brief', 'standard']);

export const DEFAULT_CORA_PUBLISHED_DEFAULTS = Object.freeze({
  style: 'professional_brief',
  maxSpokenChars: 900,
  interruptMode: 'barge_in',
  turnMode: 'concise',
});

function bounded(value, name, max) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max) throw new Error(`${name} is missing or too long`);
  return result;
}

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${name} contains unsupported fields`);
}

function rejectPhysicalAuthority(value, name) {
  if (!value || typeof value !== 'object') return;
  if (['plantId', 'plant_id', 'facilityId', 'facility_id'].some((key) => Object.hasOwn(value, key))) {
    throw new Error(`${name} cannot use Plant or facility as authority`);
  }
}

function normalizePublishedDefaults(input = {}) {
  rejectPhysicalAuthority(input, 'Cora defaults');
  exactKeys(input, ['style', 'maxSpokenChars', 'interruptMode', 'turnMode'], 'Cora defaults');
  const result = { ...DEFAULT_CORA_PUBLISHED_DEFAULTS, ...input };
  if (!STYLES.has(result.style)) throw new Error('Cora style is unsupported');
  if (!Number.isSafeInteger(result.maxSpokenChars) || result.maxSpokenChars < 240 || result.maxSpokenChars > 1200) {
    throw new Error('Cora spoken budget is invalid');
  }
  if (!INTERRUPT_MODES.has(result.interruptMode)) throw new Error('Cora interrupt mode is unsupported');
  if (!TURN_MODES.has(result.turnMode)) throw new Error('Cora turn mode is unsupported');
  return Object.freeze(result);
}

function normalizeUserPreferences(input = {}) {
  rejectPhysicalAuthority(input, 'Cora user preferences');
  exactKeys(input, ['verbosity', 'interruptMode', 'turnMode'], 'Cora user preferences');
  const result = {};
  if (input.verbosity !== undefined) {
    if (!VERBOSITIES.has(input.verbosity)) throw new Error('Cora verbosity is unsupported');
    result.verbosity = input.verbosity;
  }
  if (input.interruptMode !== undefined) {
    if (!INTERRUPT_MODES.has(input.interruptMode)) throw new Error('Cora interrupt mode is unsupported');
    result.interruptMode = input.interruptMode;
  }
  if (input.turnMode !== undefined) {
    if (!TURN_MODES.has(input.turnMode)) throw new Error('Cora turn mode is unsupported');
    result.turnMode = input.turnMode;
  }
  return Object.freeze(result);
}

export function normalizeCoraApprovedModelCatalog(entries = []) {
  if (!Array.isArray(entries) || entries.length > 32) throw new Error('approved model catalog is invalid');
  return Object.freeze(entries.map((entry) => {
    rejectPhysicalAuthority(entry, 'approved model catalog entry');
    exactKeys(entry, ['id', 'provider', 'model', 'version', 'status', 'source'], 'approved model catalog entry');
    if (entry.status !== 'approved') throw new Error('model catalog entry is not approved');
    return Object.freeze({
      id: bounded(entry.id, 'model catalog id', 128),
      provider: bounded(entry.provider, 'model provider', 64),
      model: bounded(entry.model, 'model name', 128),
      version: bounded(entry.version, 'model version', 64),
      status: 'approved',
      source: bounded(entry.source, 'model catalog source', 512),
    });
  }));
}

function normalizeKnowledgePacks(entries = []) {
  if (!Array.isArray(entries) || entries.length > 64) throw new Error('knowledge pack allowlist is invalid');
  return Object.freeze(entries.map((entry) => {
    rejectPhysicalAuthority(entry, 'knowledge pack');
    exactKeys(entry, ['id', 'version', 'source', 'provenance', 'status'], 'knowledge pack');
    if (entry.status !== 'approved') throw new Error('knowledge pack is not approved');
    return Object.freeze({
      id: bounded(entry.id, 'knowledge pack id', 128),
      version: bounded(entry.version, 'knowledge pack version', 64),
      source: bounded(entry.source, 'knowledge pack source', 512),
      provenance: bounded(entry.provenance, 'knowledge pack provenance', 512),
      status: 'approved',
    });
  }));
}

function effectiveDefaults(published, prefs) {
  return Object.freeze({
    style: published.style,
    maxSpokenChars: published.maxSpokenChars,
    interruptMode: prefs.interruptMode ?? published.interruptMode,
    turnMode: prefs.turnMode ?? published.turnMode,
    verbosity: prefs.verbosity ?? (published.turnMode === 'concise' ? 'brief' : 'standard'),
  });
}

/**
 * Build a source-only Organization configuration from already verified
 * membership. Organization identity comes from the server-side membership;
 * callers cannot select it through a config field. No secrets or provider
 * runtime handles are accepted.
 */
export function buildCoraOrganizationConfig({
  verifiedMembership,
  publishedDefaults = {},
  userPreferences = {},
  approvedModelCatalog = [],
  knowledgePacks = [],
  routingPolicy = null,
  requestedOrganizationId,
} = {}) {
  rejectPhysicalAuthority(verifiedMembership, 'verified membership');
  if (!verifiedMembership?.active || verifiedMembership.membershipVerified !== true) {
    throw new Error('verified active Organization membership is required');
  }
  const organizationId = bounded(verifiedMembership.organizationId, 'Organization id', 128);
  if (requestedOrganizationId !== undefined && requestedOrganizationId !== organizationId) {
    throw new Error('Organization selection is not accepted');
  }
  const role = bounded(verifiedMembership.role, 'Organization role', 32).toLowerCase();
  if (!ROLES.has(role)) throw new Error('Organization role is unsupported');
  const published = normalizePublishedDefaults(publishedDefaults);
  const prefs = normalizeUserPreferences(userPreferences);
  const catalog = normalizeCoraApprovedModelCatalog(approvedModelCatalog);
  const normalizedRoutingPolicy = normalizeCoraRoutingPolicy(routingPolicy, catalog);
  const packs = normalizeKnowledgePacks(knowledgePacks);
  return Object.freeze({
    format: CORA_ORGANIZATION_CONFIG_FORMAT,
    organizationId,
    role,
    publishedDefaults: published,
    userPreferences: prefs,
    effective: effectiveDefaults(published, prefs),
    approvedModelCatalog: catalog,
    routingPolicy: normalizedRoutingPolicy,
    knowledgePacks: packs,
    runtime: Object.freeze({
      humeVoice: 'process_env_readiness_only',
      modelInvocation: 'not_connected',
      knowledgeRetrieval: 'source_adapter_required',
      secrets: 'not_in_contract',
    }),
    actionPolicyFormat: 'cora.action-policy.v1',
  });
}

function normalizedSnippet(snippet, allowedPacks) {
  rejectPhysicalAuthority(snippet, 'knowledge snippet');
  exactKeys(snippet, ['packId', 'version', 'source', 'citation', 'text'], 'knowledge snippet');
  const pack = allowedPacks.find((entry) => entry.id === snippet.packId && entry.version === snippet.version);
  if (!pack || pack.source !== snippet.source) throw new Error('knowledge snippet is outside the approved allowlist');
  return Object.freeze({
    packId: pack.id,
    version: pack.version,
    source: pack.source,
    citation: bounded(snippet.citation, 'knowledge citation', 512),
    text: bounded(snippet.text, 'knowledge snippet', 2_000),
  });
}

/**
 * Source-only retrieval seam. It accepts snippets from a future approved
 * adapter, never calls a provider, and refuses to return an uncited answer.
 */
export function lookupApprovedKnowledge({ config, query, snippets = [] } = {}) {
  const search = bounded(query, 'knowledge query', 500).toLowerCase();
  if (!Array.isArray(snippets) || snippets.length > 32) throw new Error('knowledge snippets are invalid');
  const approved = snippets.map((snippet) => normalizedSnippet(snippet, config?.knowledgePacks ?? []));
  const terms = search.split(/\s+/u).filter(Boolean);
  const matches = approved.filter((snippet) => terms.every((term) => snippet.text.toLowerCase().includes(term)));
  return Object.freeze({
    format: CORA_KNOWLEDGE_RESPONSE_FORMAT,
    status: matches.length ? 'approved_sources_only' : 'no_approved_source_match',
    query: search,
    snippets: Object.freeze(matches),
    citations: Object.freeze(matches.map((snippet) => snippet.citation)),
    answer: null,
    legalConclusion: 'not_provided',
    providerCall: 'not_performed',
  });
}

export { evaluateCoraActionPolicy };
