import assert from 'node:assert/strict';
import test from 'node:test';
import { agentTaskPanelModel, artifactSourcePanelModel, artifactStudioPanelModel, createCoraConfigClient, knowledgeQueryModel, usagePanelModel, workspacePreviewPanelModel } from '../web/cloud-admin/cora-config-client.mjs';

function fakeFetch() {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/config')) return new Response(JSON.stringify({ status: 'not_published', config: null }), { status: 200 });
    if (url.endsWith('/knowledge-sources')) return new Response(JSON.stringify({ sources: [] }), { status: 200 });
    if (url.includes('/knowledge/query')) return new Response(JSON.stringify({ status: 'no_approved_source_match', excerpts: [], answer: null, providerCall: 'not_performed' }), { status: 200 });
    if (url.endsWith('/usage')) return new Response(JSON.stringify({ budget: { policyState: 'active' }, totals: { eventCount: 1, estimatedCostMinor: 12, reconciledCostMinor: null }, source: 'tenant_append_only_ledger', providerCalls: 'not_performed' }), { status: 200 });
    if (url.endsWith('/workspace/previews')) return new Response(JSON.stringify({ receipts: [] }), { status: 200 });
    if (url.endsWith('/tasks')) return new Response(JSON.stringify({ receipts: [] }), { status: 200 });
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
  await client.readWorkspacePreviews();
  await client.createWorkspacePreview({ mode: 'workspace', intent: 'prepare', department: 'operations', templateId: 'sop-1', title: 'Prepare SOP preview', idempotencyKey: 'idem-1' });
  await client.readAgentTasks();
  await client.createAgentTask({ taskType: 'workspace_preview', intent: 'prepare', goal: 'Prepare task', idempotencyKey: 'task-0001' });
  await client.readArtifacts();
  await client.createArtifact({ artifactType: 'training', title: 'Orientation', department: 'operations', objective: 'Explain steps', sourceRefs: [], stage: 'draft', idempotencyKey: 'artifact-0001', approvalReason: null });
  await client.readArtifactSources();
  await client.createArtifactSource({ sourceKey: 'dock-sop', title: 'Dock SOP', publisher: 'Ops', classification: 'sop', provenance: 'reviewed', reference: 'manual://dock-sop', idempotencyKey: 'source-0001' });
  await client.linkArtifactSource({ artifactReceiptId: 'artifact-1', sourceId: '1', linkReason: 'orientation', idempotencyKey: 'link-0001' });
  await client.createDraft({ reason: 'reviewed brief defaults' });
  await client.transition({ id: 'c1', lifecycle: 'testing', reason: 'begin test' });
  assert.equal(fetchImpl.calls.every(({ options }) => options.credentials === 'same-origin'), true);
  assert.equal(fetchImpl.calls.some(({ url, options }) => url.includes('tenant') || url.includes('plant') || String(options.body).includes('tenant') || String(options.body).includes('plant')), false);
  assert.match(fetchImpl.calls[2].url, /knowledge\/query\?q=hours%20service/);
  const artifactCall = fetchImpl.calls.find(({ url, options }) => url.endsWith('/artifacts') && options.method === 'POST');
  assert.equal(JSON.parse(artifactCall.options.body).stage, 'draft');
  assert.deepEqual(JSON.parse(fetchImpl.calls[5].options.body), { mode: 'workspace', intent: 'prepare', department: 'operations', templateId: 'sop-1', title: 'Prepare SOP preview', idempotencyKey: 'idem-1' });
  assert.deepEqual(JSON.parse(fetchImpl.calls[7].options.body), { taskType: 'workspace_preview', intent: 'prepare', goal: 'Prepare task', idempotencyKey: 'task-0001' });
  assert.deepEqual(JSON.parse(fetchImpl.calls[13].options.body).config, { style: 'professional_brief', maxSpokenChars: 900, interruptMode: 'barge_in', turnMode: 'concise' });
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
