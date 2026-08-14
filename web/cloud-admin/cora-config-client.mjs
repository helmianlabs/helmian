async function requestJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, { credentials: 'same-origin', ...options });
  let body = {};
  try { body = await response.json(); } catch { /* bounded error response */ }
  if (!response.ok) {
    const error = new Error(body.code || `Cora settings request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

export function createCoraConfigClient({ fetchImpl = fetch } = {}) {
  return Object.freeze({
    readConfig() { return requestJson(fetchImpl, '/api/admin/cora/config'); },
    readKnowledgeSources() { return requestJson(fetchImpl, '/api/admin/cora/knowledge-sources'); },
    queryKnowledge(query) { return requestJson(fetchImpl, `/api/admin/cora/knowledge/query?q=${encodeURIComponent(query)}`); },
    readUsage() { return requestJson(fetchImpl, '/api/admin/cora/usage'); },
    readPersonalPreferences() { return requestJson(fetchImpl, '/api/admin/cora/personal-preferences'); },
    savePersonalPreferences(preferences) { return requestJson(fetchImpl, '/api/admin/cora/personal-preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(preferences) }); },
    readWorkspaceLayout() { return requestJson(fetchImpl, '/api/admin/workspace/layout-preferences'); },
    saveWorkspaceLayout(layout) { return requestJson(fetchImpl, '/api/admin/workspace/layout-preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(layout) }); },
    resetWorkspaceLayout() { return requestJson(fetchImpl, '/api/admin/workspace/layout-preferences/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); },
    readWorkspacePreviews() { return requestJson(fetchImpl, '/api/admin/cora/workspace/previews'); },
    createWorkspacePreview({ mode, intent, department, templateId, title, idempotencyKey }) {
      return requestJson(fetchImpl, '/api/admin/cora/workspace/previews', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, intent, department, templateId, title, idempotencyKey }),
      });
    },
    readAgentTasks() { return requestJson(fetchImpl, '/api/admin/cora/tasks'); },
    createAgentTask({ taskType, goal, contextRef, department, costCenter, intent, idempotencyKey }) {
      return requestJson(fetchImpl, '/api/admin/cora/tasks', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskType, goal, contextRef, department, costCenter, intent, idempotencyKey }),
      });
    },
    readArtifacts() { return requestJson(fetchImpl, '/api/admin/cora/artifacts'); },
    createArtifact({ artifactType, title, department, objective, sourceRefs, stage = 'draft', idempotencyKey, approvalReason = null }) {
      return requestJson(fetchImpl, '/api/admin/cora/artifacts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ artifactType, title, department, objective, sourceRefs, stage, idempotencyKey, approvalReason }),
      });
    },
    readArtifactSources() { return requestJson(fetchImpl, '/api/admin/cora/artifact-sources'); },
    createArtifactSource({ sourceKey, title, publisher, classification, provenance, reference, effectiveAt = null, expiresAt = null, idempotencyKey }) {
      return requestJson(fetchImpl, '/api/admin/cora/artifact-sources', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceKey, title, publisher, classification, provenance, reference, effectiveAt, expiresAt, idempotencyKey }) });
    },
    linkArtifactSource({ artifactReceiptId, sourceId, linkReason, idempotencyKey }) {
      return requestJson(fetchImpl, '/api/admin/cora/artifact-source-links', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ artifactReceiptId, sourceId, linkReason, idempotencyKey }) });
    },
    readArtifactScripts(artifactReceiptId) { return requestJson(fetchImpl, `/api/admin/cora/artifact-scripts?artifact_receipt_id=${encodeURIComponent(artifactReceiptId)}`); },
    createArtifactScript({ artifactReceiptId, scriptKind, text, sourceLinkReceiptIds, stage = 'draft', approvalReason = null, idempotencyKey }) {
      return requestJson(fetchImpl, '/api/admin/cora/artifact-scripts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ artifactReceiptId, scriptKind, text, sourceLinkReceiptIds, stage, approvalReason, idempotencyKey }) });
    },
    readArtifactExecutionRequests(artifactReceiptId) { return requestJson(fetchImpl, `/api/admin/cora/artifact-execution-requests?artifact_receipt_id=${encodeURIComponent(artifactReceiptId)}`); },
    createArtifactExecutionRequest(input) { return requestJson(fetchImpl, '/api/admin/cora/artifact-execution-requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalRef: null, estimatedAudioSeconds: null, estimatedImageUnits: null, estimatedRequestedTokens: null, estimatedVideoUnits: null, supersedesReceiptId: null, ...input }) }); },
    createDraft({ reason, routingPolicy = null, approvedModelCatalog = [] }) {
      return requestJson(fetchImpl, '/api/admin/cora/configs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          config: { style: 'professional_brief', maxSpokenChars: 900, interruptMode: 'barge_in', turnMode: 'concise', approvedModelCatalog, routingPolicy },
          reason, provenance: { source: 'cloud-admin-ui', providerCall: 'not_performed' },
        }),
      });
    },
    transition({ id, lifecycle, reason }) {
      return requestJson(fetchImpl, '/api/admin/cora/configs/transition', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, lifecycle, reason }),
      });
    },
  });
}

export function workspacePreviewPanelModel(body = {}) {
  const receipts = Array.isArray(body.receipts) ? body.receipts.slice(0, 100) : [];
  return Object.freeze({
    empty: receipts.length === 0,
    receipts,
    statusLabel: body.replayed ? 'Preview intent already received. Durable replay receipt confirmed.' : 'Preview intent prepared. Durable receipt confirmed.',
    execution: 'not_performed',
    agentInvocation: 'not_performed',
    providerInvocation: 'not_performed',
    filesystemMutation: 'not_performed',
  });
}

export function agentTaskPanelModel(body = {}) {
  const receipts = Array.isArray(body.receipts) ? body.receipts.slice(0, 100) : [];
  return Object.freeze({ empty: receipts.length === 0, receipts, execution: 'not_performed', agentInvocation: 'not_performed', providerInvocation: 'not_performed', filesystemMutation: 'not_performed', statusLabel: body.replayed ? 'Task intent already received. Durable replay receipt confirmed.' : 'Task intent recorded. No worker execution occurred.' });
}

export function artifactStudioPanelModel(body = {}) {
  const receipts = Array.isArray(body.receipts) ? body.receipts.slice(0, 100) : [];
  return Object.freeze({
    empty: receipts.length === 0,
    receipts,
    availableThrough: 'approval_requested',
    execution: 'not_performed',
    media: 'not_generated',
    providerInvocation: 'not_performed',
    statusLabel: body.replayed ? 'Artifact intent already received. Durable replay receipt confirmed.' : 'Artifact intent recorded. No media or provider execution occurred.',
  });
}

export function artifactSourcePanelModel(body = {}) {
  const sources = Array.isArray(body.sources) ? body.sources.slice(0, 100) : [];
  const links = Array.isArray(body.links) ? body.links.slice(0, 100) : [];
  return Object.freeze({ empty: sources.length === 0 && links.length === 0, sources, links, unavailable: body.unavailable === true, statusLabel: links.length ? `${links.length} immutable source link receipt(s).` : sources.length ? 'No Artifact Studio source links recorded yet.' : 'No Artifact Studio source metadata is available.' });
}

export function artifactScriptPanelModel(body = {}) {
  const receipts = Array.isArray(body.receipts) ? body.receipts.slice(0, 100) : [];
  return Object.freeze({ empty: receipts.length === 0, receipts, statusLabel: receipts.length ? `${receipts.length} manual script revision(s).` : 'No manual script revisions recorded.', generation: 'not_generated', providerInvocation: 'not_performed', media: 'not_generated' });
}

export function artifactExecutionPanelModel(body = {}) {
  const receipts = Array.isArray(body.receipts) ? body.receipts.slice(0, 100) : [];
  return Object.freeze({ empty: receipts.length === 0, receipts, execution: 'not_executed', providerInvocation: 'not_performed', media: 'not_generated', statusLabel: receipts.length ? `${receipts.length} execution request receipt(s).` : 'No execution request receipts recorded.' });
}

export function knowledgeQueryModel(body = {}) {
  const excerpts = Array.isArray(body.excerpts) ? body.excerpts.slice(0, 20) : [];
  return Object.freeze({ empty: excerpts.length === 0, excerpts, status: body.status === 'approved_sources_only' && excerpts.length ? 'approved_sources_only' : 'no_approved_source_match', answer: null, providerCall: 'not_performed' });
}

export function usagePanelModel(body = {}) {
  const totals = body.totals ?? {};
  const budget = body.budget ?? null;
  const state = budget?.policyState === 'soft_exceeded' ? 'soft' : budget?.policyState === 'hard_exceeded' || budget?.policyState === 'paused' ? 'hard' : 'normal';
  const eventCount = Number(totals.eventCount ?? 0);
  return Object.freeze({
    empty: !budget && eventCount === 0,
    state,
    stateLabel: state === 'soft' ? 'Soft budget threshold' : state === 'hard' ? 'Hard budget state' : 'Normal budget state',
    eventCount,
    estimatedCostMinor: totals.estimatedCostMinor ?? null,
    reconciledCostMinor: totals.reconciledCostMinor ?? null,
    source: body.source === 'tenant_append_only_ledger' ? body.source : 'tenant_append_only_ledger',
    providerCalls: body.providerCalls === 'not_performed' ? body.providerCalls : 'not_performed',
  });
}

export function personalPreferencesModel(body = {}) {
  const preferences = body.preferences?.preferences ?? body.preferences ?? {};
  const bounds = body.bounds ?? {};
  return Object.freeze({ preferences, bounds, statusLabel: body.preferences ? 'Personal Cora preferences loaded for this signed-in user.' : 'Personal Cora preferences are unavailable.' });
}

export function workspaceLayoutModel(body = {}) {
  const layout = body.layout ?? {};
  return Object.freeze({ layout, statusLabel: body.layout ? 'Workspace layout loaded for this signed-in user.' : 'Workspace layout is unavailable.' });
}
