import assert from 'node:assert/strict';
import test from 'node:test';
import { agentTaskPanelModel, appBuildPanelModel, approvalInboxPanelModel, artifactSourcePanelModel, artifactStudioPanelModel, connectorRegistrationPanelModel, createCoraConfigClient, knowledgeQueryModel, personalPreferencesModel, usagePanelModel, workspacePreviewPanelModel } from '../web/cloud-admin/cora-config-client.mjs';

function fakeFetch() {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/config')) return new Response(JSON.stringify({ status: 'not_published', config: null }), { status: 200 });
    if (url.endsWith('/knowledge-sources')) return new Response(JSON.stringify({ sources: [] }), { status: 200 });
    if (url.includes('/knowledge/query')) return new Response(JSON.stringify({ status: 'no_approved_source_match', excerpts: [], answer: null, providerCall: 'not_performed' }), { status: 200 });
    if (url.endsWith('/usage')) return new Response(JSON.stringify({ budget: { policyState: 'active' }, totals: { eventCount: 1, estimatedCostMinor: 12, reconciledCostMinor: null }, source: 'tenant_append_only_ledger', providerCalls: 'not_performed' }), { status: 200 });
    if (url.endsWith('/workspace/previews')) return new Response(JSON.stringify({ receipts: [] }), { status: 200 });
    if (url.endsWith('/app-builds/from-prompt')) return new Response(JSON.stringify({ receiptId: 'prompt-receipt-1', title: 'Driver onboarding', department: 'hr', route: '/hr/onboarding', providerInvocation: 'performed', execution: 'not_performed' }), { status: 200 });
    if (url.includes('/app-build-revisions?')) return new Response(JSON.stringify({ receipts: [] }), { status: 200 });
    if (url.endsWith('/app-build-revisions')) return new Response(JSON.stringify({ receiptId: 'revision-receipt-1', execution: 'not_performed', publication: 'not_performed' }), { status: 200 });
    if (url.endsWith('/app-build-approvals')) return new Response(JSON.stringify({ receiptId: 'approval-receipt-1', decision: 'approve', execution: 'not_performed', publication: 'not_performed' }), { status: 200 });
    if (url.endsWith('/app-build-execution-requests')) return new Response(JSON.stringify({ receiptId: 'execution-receipt-1', status: 'queued', execution: 'not_performed', filesystemMutation: 'not_performed', publication: 'not_performed', deployment: 'not_performed' }), { status: 200 });
    if (url.endsWith('/app-builds')) return new Response(JSON.stringify({ receipts: [] }), { status: 200 });
    if (url.endsWith('/tasks')) return new Response(JSON.stringify({ receipts: [] }), { status: 200 });
    if (url.endsWith('/personal-preferences')) return new Response(JSON.stringify({ bounds: { verbosity: ['concise', 'standard', 'detailed'], interruptMode: ['barge_in'], turnMode: ['concise'], voiceProfiles: ['emma'] }, preferences: { format: 'cora.personal-preferences.v1', valid: true, organizationId: 'customer-a', subject: 'user-1', preferences: { muted: false, volume: 80, verbosity: 'standard', interruptMode: 'barge_in', turnMode: 'concise', voiceProfile: 'emma' } } }), { status: 200 });
    if (url.endsWith('/artifacts')) return new Response(JSON.stringify({ receipts: [] }), { status: 200 });
    if (url.endsWith('/artifact-sources')) return new Response(JSON.stringify({ sources: [], links: [] }), { status: 200 });
    return new Response(JSON.stringify({ config: { id: 'c1', lifecycle: 'draft' } }), { status: 200 });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('Cora config client uses same-origin auth and sends no tenant or Plant selector', async () => {
  const fetchImpl = fakeFetch();
  const client = createCoraConfigClient({ fetchImpl });
  await client.readConfig();
  await client.readKnowledgeSources();
  await client.queryKnowledge('hours service');
  await client.readUsage();
  await client.saveUsagePolicy({ period: 'monthly', currency: 'USD', softLimitMinor: 100, hardLimitMinor: 200, lowCostLimitMinor: 20, policyState: 'active', allocations: [] });
  await client.readWorkspacePreviews();
  await client.createWorkspacePreview({ mode: 'workspace', intent: 'prepare', department: 'operations', templateId: 'sop-1', title: 'Prepare SOP preview', idempotencyKey: 'idem-1' });
  await client.readAppBuilds();
  await client.createAppBuild({ intent: 'draft', title: 'Driver onboarding', department: 'hr', route: '/hr/onboarding', description: 'Draft only.', components: [{ type: 'heading', text: 'Driver onboarding' }], idempotencyKey: 'app-build-0001' });
  await client.createAppBuildFromPrompt('Build HR driver self-onboarding.');
  await client.readAppBuildRevisions('app-build-receipt-1');
  await client.createAppBuildRevision({ appBuildReceiptId: 'app-build-receipt-1', description: 'Revise onboarding.', components: [{ type: 'heading', text: 'Onboarding' }], reason: 'HR review', idempotencyKey: 'revision-0001' });
  await client.decideAppBuildApproval({ revisionReceiptId: 'revision-receipt-1', decision: 'approve', reason: 'Approved by HR', idempotencyKey: 'approval-0001' });
  await client.createAppBuildExecutionRequest({ revisionReceiptId: 'revision-receipt-1', approvalReceiptId: 'approval-receipt-1', workspaceProjectKey: 'tms-cloud', idempotencyKey: 'execution-0001' });
  await client.readAgentTasks();
  await client.readPersonalPreferences();
  await client.savePersonalPreferences({ muted: true, volume: 40, verbosity: 'concise', interruptMode: 'barge_in', turnMode: 'concise', voiceProfile: 'emma' });
  await client.createAgentTask({ taskType: 'workspace_preview', intent: 'prepare', goal: 'Prepare task', idempotencyKey: 'task-0001' });
  await client.readArtifacts();
  await client.createArtifact({ artifactType: 'training', title: 'Orientation', department: 'operations', objective: 'Explain steps', sourceRefs: [], stage: 'draft', idempotencyKey: 'artifact-0001', approvalReason: null });
  await client.readArtifactSources();
  await client.createArtifactSource({ sourceKey: 'dock-sop', title: 'Dock SOP', publisher: 'Ops', classification: 'sop', provenance: 'reviewed', reference: 'manual://dock-sop', idempotencyKey: 'source-0001' });
  await client.linkArtifactSource({ artifactReceiptId: 'artifact-1', sourceId: '1', linkReason: 'orientation', idempotencyKey: 'link-0001' });
  await client.createDraft({ reason: 'reviewed brief defaults', routingPolicy: null, approvedModelCatalog: [] });
  await client.transition({ id: 'c1', lifecycle: 'testing', reason: 'begin test' });
  assert.equal(fetchImpl.calls.every(({ options }) => options.credentials === 'same-origin'), true);
  assert.equal(fetchImpl.calls.some(({ url, options }) => url.includes('tenant') || url.includes('plant') || String(options.body).includes('tenant') || String(options.body).includes('plant')), false);
  assert.match(fetchImpl.calls[2].url, /knowledge\/query\?q=hours%20service/);
  const artifactCall = fetchImpl.calls.find(({ url, options }) => url.endsWith('/artifacts') && options.method === 'POST');
  assert.equal(JSON.parse(artifactCall.options.body).stage, 'draft');
  const previewCall = fetchImpl.calls.find(({ url, options }) => url.endsWith('/workspace/previews') && options.method === 'POST');
  assert.deepEqual(JSON.parse(previewCall.options.body), { mode: 'workspace', intent: 'prepare', department: 'operations', templateId: 'sop-1', title: 'Prepare SOP preview', idempotencyKey: 'idem-1' });
  const appBuildCall = fetchImpl.calls.find(({ url, options }) => url.endsWith('/app-builds') && options.method === 'POST');
  assert.deepEqual(JSON.parse(appBuildCall.options.body), { intent: 'draft', title: 'Driver onboarding', department: 'hr', route: '/hr/onboarding', description: 'Draft only.', components: [{ type: 'heading', text: 'Driver onboarding' }], idempotencyKey: 'app-build-0001' });
  const promptBuildCall = fetchImpl.calls.find(({ url, options }) => url.endsWith('/app-builds/from-prompt') && options.method === 'POST');
  assert.deepEqual(JSON.parse(promptBuildCall.options.body), { userRequest: 'Build HR driver self-onboarding.' });
  const revisionRead = fetchImpl.calls.find(({ url }) => url.includes('/app-build-revisions?')); assert.match(revisionRead.url, /app_build_receipt_id=app-build-receipt-1/);
  const revisionCall = fetchImpl.calls.find(({ url, options }) => url.endsWith('/app-build-revisions') && options.method === 'POST');
  assert.deepEqual(JSON.parse(revisionCall.options.body), { appBuildReceiptId: 'app-build-receipt-1', description: 'Revise onboarding.', components: [{ type: 'heading', text: 'Onboarding' }], reason: 'HR review', idempotencyKey: 'revision-0001' });
  const approvalCall = fetchImpl.calls.find(({ url, options }) => url.endsWith('/app-build-approvals') && options.method === 'POST');
  assert.deepEqual(JSON.parse(approvalCall.options.body), { revisionReceiptId: 'revision-receipt-1', decision: 'approve', reason: 'Approved by HR', idempotencyKey: 'approval-0001' });
  const executionRequestCall = fetchImpl.calls.find(({ url, options }) => url.endsWith('/app-build-execution-requests') && options.method === 'POST');
  assert.deepEqual(JSON.parse(executionRequestCall.options.body), { revisionReceiptId: 'revision-receipt-1', approvalReceiptId: 'approval-receipt-1', workspaceProjectKey: 'tms-cloud', idempotencyKey: 'execution-0001' });
  const taskCall = fetchImpl.calls.find(({ url, options }) => url.endsWith('/tasks') && options.method === 'POST');
  assert.deepEqual(JSON.parse(taskCall.options.body), { taskType: 'workspace_preview', intent: 'prepare', goal: 'Prepare task', idempotencyKey: 'task-0001' });
  const preferencesCall = fetchImpl.calls.find(({ url }) => url.endsWith('/personal-preferences'));
  assert.equal(preferencesCall.options.method, undefined);
  const preferenceSave = fetchImpl.calls.find(({ url, options }) => url.endsWith('/personal-preferences') && options.method === 'PUT');
  assert.deepEqual(JSON.parse(preferenceSave.options.body), { muted: true, volume: 40, verbosity: 'concise', interruptMode: 'barge_in', turnMode: 'concise', voiceProfile: 'emma' });
  const draftCall = fetchImpl.calls.find(({ url, options }) => url.endsWith('/configs') && options.method === 'POST');
  assert.deepEqual(JSON.parse(draftCall.options.body).config, { style: 'professional_brief', maxSpokenChars: 900, interruptMode: 'barge_in', turnMode: 'concise', allowedUserPreferences: { verbosity: ['concise', 'standard', 'detailed'], interruptMode: ['barge_in', 'after_sentence'], turnMode: ['concise', 'standard'], voiceProfiles: [] }, voiceProfiles: [], approvedModelCatalog: [], routingPolicy: null, knowledgePacks: [] });
});

test('approval inbox model preserves empty, decision, and no-execution states', () => {
  assert.equal(approvalInboxPanelModel({ items: [] }).empty, true);
  const model = approvalInboxPanelModel({ items: [{ requestKind: 'artifact_execution_request', status: 'approval_required', decision: 'approve', execution: 'not_performed' }] });
  assert.equal(model.empty, false); assert.equal(model.items[0].decision, 'approve');
});

test('connector model distinguishes empty metadata from provider connection', () => {
  assert.equal(connectorRegistrationPanelModel({ registrations: [] }).empty, true);
  const model = connectorRegistrationPanelModel({ registrations: [{ provider: 'discord', lifecycle: 'testing' }] });
  assert.equal(model.empty, false); assert.match(model.statusLabel, /delivery remains inactive/u);
});

test('personal preference model exposes own bounded settings without provider controls', () => {
  const model = personalPreferencesModel({ policy: { published: true }, bounds: { verbosity: ['concise', 'standard'], voiceProfiles: ['emma'] }, preferences: { preferences: { muted: true, volume: 20, verbosity: 'concise', voiceProfile: 'emma' } } });
  assert.equal(model.preferences.muted, true);
  assert.deepEqual(model.bounds.voiceProfiles, ['emma']);
  assert.equal(model.published, true);
  assert.match(model.statusLabel, /published Organization bounds/iu);
  for (const key of ['provider', 'model', 'organizationId', 'plantId']) assert.equal(Object.hasOwn(model.preferences, key), false);
});

test('personal preference model distinguishes safe-defaults state without a published policy', () => {
  const model = personalPreferencesModel({ policy: { published: false }, bounds: { verbosity: ['concise'], voiceProfiles: [] }, preferences: { preferences: {} } });
  assert.equal(model.published, false);
  assert.match(model.statusLabel, /safe defaults/iu);
});

test('workspace preview model keeps empty, replay, and not-performed states truthful', () => {
  assert.equal(workspacePreviewPanelModel({ receipts: [] }).empty, true);
  const model = workspacePreviewPanelModel({ replayed: true, receipts: [{ receiptId: 'r1', intent: 'prepare', mode: 'builder', title: 'SOP' }] });
  assert.equal(model.empty, false);
  assert.match(model.statusLabel, /replay receipt/);
  assert.equal(model.execution, 'not_performed');
  assert.equal(model.providerInvocation, 'not_performed');
  assert.equal(model.filesystemMutation, 'not_performed');
});

test('app-build panel model keeps its draft-only boundary truthful', () => {
  assert.equal(appBuildPanelModel({ receipts: [] }).empty, true);
  const model = appBuildPanelModel({ replayed: true, receipts: [{ title: 'Driver onboarding', route: '/hr/onboarding', status: 'draft-recorded' }] });
  assert.equal(model.empty, false); assert.match(model.statusLabel, /cannot run, publish, or deploy/);
});

test('agent task panel model reports empty, replay, and not-performed states', () => {
  assert.equal(agentTaskPanelModel({ receipts: [] }).empty, true);
  const model = agentTaskPanelModel({ replayed: true, receipts: [{ taskType: 'workspace_preview', status: 'prepared', goal: 'SOP', receiptId: 'r1' }] });
  assert.equal(model.empty, false); assert.match(model.statusLabel, /replay receipt/); assert.equal(model.execution, 'not_performed'); assert.equal(model.agentInvocation, 'not_performed');
});

test('Artifact Studio panel model keeps source-only receipt states truthful', () => {
  assert.equal(artifactStudioPanelModel({ receipts: [] }).empty, true);
  const model = artifactStudioPanelModel({ replayed: true, receipts: [{ artifactType: 'training', status: 'draft', receiptId: 'r1' }] });
  assert.equal(model.empty, false); assert.match(model.statusLabel, /replay receipt/); assert.equal(model.availableThrough, 'approval_requested');
  assert.equal(model.execution, 'not_performed'); assert.equal(model.media, 'not_generated'); assert.equal(model.providerInvocation, 'not_performed');
});

test('Artifact source panel model distinguishes empty metadata and immutable links', () => {
  assert.equal(artifactSourcePanelModel({ sources: [], links: [] }).empty, true);
  const model = artifactSourcePanelModel({ sources: [{ sourceKey: 'dock-sop' }], links: [{ linkReceiptId: 'l1' }] });
  assert.equal(model.empty, false); assert.equal(model.links.length, 1); assert.match(model.statusLabel, /immutable/);
});

test('Artifact script client model keeps manual revision truth', async () => {
  const client = createCoraConfigClient({ fetchImpl: async () => new Response(JSON.stringify({ receipts: [] }), { status: 200 }) });
  const model = (await import('../web/cloud-admin/cora-config-client.mjs')).artifactScriptPanelModel({ receipts: [] });
  assert.equal(model.empty, true); assert.equal(model.generation, 'not_generated'); assert.equal(model.providerInvocation, 'not_performed');
  await client.readArtifactScripts('artifact-1');
});

test('Artifact execution client model keeps approval and non-execution truth', async () => {
  const { artifactExecutionPanelModel } = await import('../web/cloud-admin/cora-config-client.mjs');
  const model = artifactExecutionPanelModel({ receipts: [{ status: 'approval_required', execution: 'not_executed' }] });
  assert.equal(model.receipts[0].status, 'approval_required'); assert.equal(model.execution, 'not_executed'); assert.equal(model.providerInvocation, 'not_performed'); assert.equal(model.media, 'not_generated');
});

test('knowledge query model never exposes an answer and distinguishes no-source state', () => {
  assert.equal(knowledgeQueryModel({ status: 'no_approved_source_match', excerpts: [], answer: 'forged' }).empty, true);
  const model = knowledgeQueryModel({ status: 'approved_sources_only', excerpts: [{ excerpt: 'stored', citation: 'manual §1' }], answer: null, providerCall: 'not_performed' });
  assert.equal(model.empty, false); assert.equal(model.answer, null); assert.equal(model.providerCall, 'not_performed');
});

test('usage panel model exposes truthful empty, soft, hard, and unavailable reconciliation states', () => {
  assert.equal(usagePanelModel({ budget: null, totals: { eventCount: 0 } }).empty, true);
  assert.equal(usagePanelModel({ budget: { policyState: 'soft_exceeded' }, totals: { eventCount: 2, estimatedCostMinor: 10, reconciledCostMinor: null } }).state, 'soft');
  const hard = usagePanelModel({ budget: { policyState: 'hard_exceeded' }, totals: { eventCount: 2, estimatedCostMinor: 10, reconciledCostMinor: null } });
  assert.equal(hard.state, 'hard');
  assert.equal(hard.reconciledCostMinor, null);
  assert.equal(hard.providerCalls, 'not_performed');
});

test('Cora config client preserves unauthorized status for UI error state', async () => {
  const client = createCoraConfigClient({ fetchImpl: async () => new Response(JSON.stringify({ code: 'CORA_MEMBERSHIP_REQUIRED' }), { status: 403 }) });
  await assert.rejects(() => client.readConfig(), (error) => error.status === 403 && /CORA_MEMBERSHIP_REQUIRED/.test(error.message));
});

test('app-build review client preserves 403 and validation errors for the owner/admin UI', async () => {
  const denied = createCoraConfigClient({ fetchImpl: async () => new Response(JSON.stringify({ code: 'CORA_APP_BUILD_REVISION_MEMBERSHIP_REQUIRED' }), { status: 403 }) });
  await assert.rejects(() => denied.createAppBuildRevision({ appBuildReceiptId: 'draft-1', description: 'Revision', components: [{ type: 'heading', text: 'HR' }], reason: 'Review', idempotencyKey: 'revision-0001' }), (error) => error.status === 403 && /REVISION_MEMBERSHIP_REQUIRED/u.test(error.message));
  const invalid = createCoraConfigClient({ fetchImpl: async () => new Response(JSON.stringify({ code: 'CORA_APP_BUILD_APPROVAL_INVALID' }), { status: 400 }) });
  await assert.rejects(() => invalid.decideAppBuildApproval({ revisionReceiptId: 'revision-1', decision: 'approve', reason: 'Review', idempotencyKey: 'approval-0001' }), (error) => error.status === 400 && /APPROVAL_INVALID/u.test(error.message));
  const queuedDenied = createCoraConfigClient({ fetchImpl: async () => new Response(JSON.stringify({ code: 'CORA_APP_BUILD_EXECUTION_MEMBERSHIP_REQUIRED' }), { status: 403 }) });
  await assert.rejects(() => queuedDenied.createAppBuildExecutionRequest({ revisionReceiptId: 'revision-1', approvalReceiptId: 'approval-1', workspaceProjectKey: 'tms-cloud', idempotencyKey: 'execution-0001' }), (error) => error.status === 403 && /EXECUTION_MEMBERSHIP_REQUIRED/u.test(error.message));
});
