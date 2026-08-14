import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoraConfigClient, usagePanelModel, workspacePreviewPanelModel } from '../web/cloud-admin/cora-config-client.mjs';

function fakeFetch() {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/config')) return new Response(JSON.stringify({ status: 'not_published', config: null }), { status: 200 });
    if (url.endsWith('/knowledge-sources')) return new Response(JSON.stringify({ sources: [] }), { status: 200 });
    if (url.endsWith('/usage')) return new Response(JSON.stringify({ budget: { policyState: 'active' }, totals: { eventCount: 1, estimatedCostMinor: 12, reconciledCostMinor: null }, source: 'tenant_append_only_ledger', providerCalls: 'not_performed' }), { status: 200 });
    if (url.endsWith('/workspace/previews')) return new Response(JSON.stringify({ receipts: [] }), { status: 200 });
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
  await client.readUsage();
  await client.readWorkspacePreviews();
  await client.createWorkspacePreview({ mode: 'workspace', intent: 'prepare', department: 'operations', templateId: 'sop-1', title: 'Prepare SOP preview', idempotencyKey: 'idem-1' });
  await client.createDraft({ reason: 'reviewed brief defaults' });
  await client.transition({ id: 'c1', lifecycle: 'testing', reason: 'begin test' });
  assert.equal(fetchImpl.calls.every(({ options }) => options.credentials === 'same-origin'), true);
  assert.equal(fetchImpl.calls.some(({ url, options }) => url.includes('tenant') || url.includes('plant') || String(options.body).includes('tenant') || String(options.body).includes('plant')), false);
  assert.deepEqual(JSON.parse(fetchImpl.calls[4].options.body), { mode: 'workspace', intent: 'prepare', department: 'operations', templateId: 'sop-1', title: 'Prepare SOP preview', idempotencyKey: 'idem-1' });
  assert.deepEqual(JSON.parse(fetchImpl.calls[5].options.body).config, { style: 'professional_brief', maxSpokenChars: 900, interruptMode: 'barge_in', turnMode: 'concise' });
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
