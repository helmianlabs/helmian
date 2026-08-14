import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCoraOrganizationConfig,
  DEFAULT_CORA_PUBLISHED_DEFAULTS,
  evaluateCoraActionPolicy,
  lookupApprovedKnowledge,
  normalizeCoraPolicyConfig,
} from '../src/cora/organization-config.mjs';

const membership = { organizationId: 'org-a', role: 'member', active: true, membershipVerified: true };
const pack = { id: 'fmcsa-core', version: '2026-01', source: 'FMCSA handbook', provenance: 'admin-reviewed source manifest', status: 'approved' };

test('builds professional brief Organization config from verified membership only', () => {
  const config = buildCoraOrganizationConfig({ verifiedMembership: membership, knowledgePacks: [pack] });
  assert.equal(config.organizationId, 'org-a');
  assert.deepEqual(config.publishedDefaults, DEFAULT_CORA_PUBLISHED_DEFAULTS);
  assert.equal(config.effective.style, 'professional_brief');
  assert.equal(config.runtime.modelInvocation, 'not_connected');
  assert.equal(config.runtime.knowledgeRetrieval, 'source_adapter_required');
  assert.equal(config.runtime.secrets, 'not_in_contract');
  assert.doesNotMatch(JSON.stringify(config), /super-secret|access-token|plantId|facilityId/i);
});

test('allows bounded user preferences but rejects arbitrary config and Organization overrides', () => {
  const config = buildCoraOrganizationConfig({
    verifiedMembership: membership,
    userPreferences: { verbosity: 'standard', interruptMode: 'after_sentence' },
  });
  assert.equal(config.effective.verbosity, 'standard');
  assert.equal(config.effective.interruptMode, 'after_sentence');
  assert.throws(() => buildCoraOrganizationConfig({ verifiedMembership: membership, userPreferences: { provider: 'fake' } }), /unsupported fields/);
  assert.throws(() => buildCoraOrganizationConfig({ verifiedMembership: membership, requestedOrganizationId: 'org-b' }), /selection/);
  assert.throws(() => buildCoraOrganizationConfig({ verifiedMembership: { ...membership, plantId: 'warehouse-1' } }), /Plant or facility/);
});

test('knowledge lookup returns only allowlisted cited snippets and no legal answer', () => {
  const config = buildCoraOrganizationConfig({ verifiedMembership: membership, knowledgePacks: [pack] });
  const result = lookupApprovedKnowledge({
    config,
    query: 'hours of service',
    snippets: [{ packId: pack.id, version: pack.version, source: pack.source, citation: 'FMCSA handbook §3', text: 'Hours of service limits are described here.' }],
  });
  assert.equal(result.status, 'approved_sources_only');
  assert.equal(result.snippets.length, 1);
  assert.equal(result.answer, null);
  assert.equal(result.legalConclusion, 'not_provided');
  assert.equal(result.providerCall, 'not_performed');
  assert.throws(() => lookupApprovedKnowledge({ config, query: 'hours', snippets: [{ packId: pack.id, version: pack.version, source: pack.source, citation: '', text: 'uncited' }] }), /citation/);
  assert.throws(() => lookupApprovedKnowledge({ config, query: 'hours', snippets: [{ packId: pack.id, version: pack.version, source: 'unapproved', citation: 'x', text: 'hours' }] }), /allowlist/);
});

test('Organization config keeps routing policy separate from personal preferences and binds it to approved catalog', () => {
  const catalog = [{ id: 'text-primary', provider: 'openai', model: 'text-v1', version: '1', status: 'approved', source: 'reviewed catalog' }];
  const routingPolicy = { version: 2, entries: ['voice_conversation', 'cited_knowledge', 'safe_action_preparation', 'artifact_execution_request'].map((taskClass) => ({ taskClass, allowedCatalogIds: ['text-primary'], defaultCatalogId: 'text-primary', fallbackCatalogIds: [], budgetTier: 'low', latencyTier: 'interactive', userSelectable: false, usageWorkflow: 'cora.workflow', usageAction: taskClass, modality: 'text' })) };
  const config = buildCoraOrganizationConfig({ verifiedMembership: membership, approvedModelCatalog: catalog, routingPolicy, userPreferences: { verbosity: 'standard' } });
  assert.equal(config.routingPolicy.version, 2);
  assert.equal(config.userPreferences.verbosity, 'standard');
  assert.throws(() => buildCoraOrganizationConfig({ verifiedMembership: membership, approvedModelCatalog: catalog, routingPolicy: { ...routingPolicy, entries: routingPolicy.entries.map((entry) => ({ ...entry, provider: 'not-allowed' })) } }), /unsupported/);
  assert.throws(() => buildCoraOrganizationConfig({ verifiedMembership: membership, approvedModelCatalog: [{ ...catalog[0], status: 'draft' }], routingPolicy }), /not approved/);
});

test('structured admin policy config normalizes bounded controls and rejects authority or unapproved metadata', () => {
  const catalog = [{ id: 'text-primary', provider: 'openai', model: 'text-v1', version: '1', status: 'approved', source: 'reviewed catalog' }];
  const policy = normalizeCoraPolicyConfig({ style: 'professional_brief', maxSpokenChars: 700, interruptMode: 'barge_in', turnMode: 'concise', allowedUserPreferences: { verbosity: ['concise', 'standard'], interruptMode: ['barge_in'], turnMode: ['concise'], voiceProfiles: ['emma'] }, voiceProfiles: ['emma'], approvedModelCatalog: catalog, routingPolicy: null, knowledgePacks: [{ id: 'sop', version: '1', source: 'manual', provenance: 'reviewed', status: 'approved' }] });
  assert.deepEqual(policy.allowedUserPreferences.voiceProfiles, ['emma']);
  assert.equal(policy.knowledgePacks[0].status, 'approved');
  assert.throws(() => normalizeCoraPolicyConfig({ plantId: 'warehouse-1' }), /Plant or facility/);
  assert.throws(() => normalizeCoraPolicyConfig({ style: 'professional_brief', approvedModelCatalog: [{ ...catalog[0], status: 'draft' }] }), /not approved/);
});

test('normal Cora work stays frictionless while high-risk actions step up', () => {
  assert.equal(evaluateCoraActionPolicy({ action: 'read', in_scope: true, role_verified: true }).decision, 'allow');
  assert.equal(evaluateCoraActionPolicy({ action: 'prepare', in_scope: true, role_verified: true }).approval_required, false);
  assert.equal(evaluateCoraActionPolicy({ action: 'publish', in_scope: true, role_verified: true, publish: true }).decision, 'step-up');
});
