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
    readConfigHistory() { return requestJson(fetchImpl, '/api/admin/cora/configs'); },
    readKnowledgeSources() { return requestJson(fetchImpl, '/api/admin/cora/knowledge-sources'); },
    queryKnowledge(query) { return requestJson(fetchImpl, `/api/admin/cora/knowledge/query?q=${encodeURIComponent(query)}`); },
    readKnowledgeAdmin() { return requestJson(fetchImpl, '/api/admin/cora/knowledge/manage'); },
    createKnowledgeSource(input) { return requestJson(fetchImpl, '/api/admin/cora/knowledge/sources', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); },
    createKnowledgePack(input) { return requestJson(fetchImpl, '/api/admin/cora/knowledge/packs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); },
    createKnowledgeSnippet(input) { return requestJson(fetchImpl, '/api/admin/cora/knowledge/snippets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); },
    transitionKnowledge(input) { return requestJson(fetchImpl, '/api/admin/cora/knowledge/transition', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); },
    readUsage() { return requestJson(fetchImpl, '/api/admin/cora/usage'); },
    saveUsagePolicy(policy) { return requestJson(fetchImpl, '/api/admin/cora/usage', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(policy) }); },
    readPersonalPreferences() { return requestJson(fetchImpl, '/api/admin/cora/personal-preferences'); },
    savePersonalPreferences(preferences) { return requestJson(fetchImpl, '/api/admin/cora/personal-preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(preferences) }); },
    readWorkspaceLayout() { return requestJson(fetchImpl, '/api/admin/workspace/layout-preferences'); },
    saveWorkspaceLayout(layout) { return requestJson(fetchImpl, '/api/admin/workspace/layout-preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(layout) }); },
    resetWorkspaceLayout() { return requestJson(fetchImpl, '/api/admin/workspace/layout-preferences/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); },
    readWorkspaceRoleDefaults() { return requestJson(fetchImpl, '/api/admin/workspace/role-defaults'); },
    saveWorkspaceRoleDefault(layout) { return requestJson(fetchImpl, '/api/admin/workspace/role-defaults', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(layout) }); },
    readWorkspacePreviews() { return requestJson(fetchImpl, '/api/admin/cora/workspace/previews'); },
    createWorkspacePreview({ mode, intent, department, templateId, title, idempotencyKey }) {
      return requestJson(fetchImpl, '/api/admin/cora/workspace/previews', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, intent, department, templateId, title, idempotencyKey }),
      });
    },
    readAppBuilds() { return requestJson(fetchImpl, '/api/admin/cora/app-builds'); },
    createAppBuild({ intent, title, department, route, description, components, idempotencyKey }) {
      return requestJson(fetchImpl, '/api/admin/cora/app-builds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intent, title, department, route, description, components, idempotencyKey }) });
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
    readApprovals(filters = {}) { const params = new URLSearchParams(); if (filters.status) params.set('status', filters.status); if (filters.requestKind) params.set('request_kind', filters.requestKind); return requestJson(fetchImpl, `/api/admin/cora/approvals${params.toString() ? `?${params}` : ''}`); },
    decideApproval(input) { return requestJson(fetchImpl, '/api/admin/cora/approvals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); },
    readConnectors() { return requestJson(fetchImpl, '/api/admin/cora/connectors'); },
    saveConnector(input) { return requestJson(fetchImpl, '/api/admin/cora/connectors', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); },
    readProviderConnections() { return requestJson(fetchImpl, '/api/admin/provider-connections'); },
    saveProviderConnection(input) { return requestJson(fetchImpl, '/api/admin/provider-connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); },
    readOrganizationMemberships() { return requestJson(fetchImpl, '/api/admin/organization/memberships'); },
    prepareOrganizationRolePlan(input) { return requestJson(fetchImpl, '/api/admin/organization/membership-role-plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); },
    readOrganizationReadiness() { return requestJson(fetchImpl, '/api/admin/organization/readiness'); },
    readCoraCapabilities() { return requestJson(fetchImpl, '/api/admin/cora/capabilities'); },
    createDraft({ reason, config = null, routingPolicy = null, approvedModelCatalog = [] }) {
      return requestJson(fetchImpl, '/api/admin/cora/configs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          config: config ?? { style: 'professional_brief', maxSpokenChars: 900, interruptMode: 'barge_in', turnMode: 'concise', allowedUserPreferences: { verbosity: ['concise', 'standard', 'detailed'], interruptMode: ['barge_in', 'after_sentence'], turnMode: ['concise', 'standard'], voiceProfiles: [] }, voiceProfiles: [], approvedModelCatalog, routingPolicy, knowledgePacks: [] },
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

export function appBuildPanelModel(body = {}) {
  const receipts = Array.isArray(body.receipts) ? body.receipts.slice(0, 100) : [];
  return Object.freeze({ empty: receipts.length === 0, receipts, statusLabel: body.replayed ? 'App-build draft already received. Durable replay receipt confirmed. It cannot run, publish, or deploy.' : 'App-build drafts loaded. They cannot run, publish, or deploy.' });
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

export function approvalInboxPanelModel(body = {}) {
  const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
  return Object.freeze({ empty: items.length === 0, items, statusLabel: items.length ? `${items.length} Organization request(s).` : 'No approval requests or prepared task intents are waiting.' });
}

export function connectorRegistrationPanelModel(body = {}) {
  const registrations = Array.isArray(body.registrations) ? body.registrations.slice(0, 10) : [];
  return Object.freeze({ empty: registrations.length === 0, registrations, statusLabel: registrations.length ? `${registrations.length} connector registration(s); provider delivery remains inactive until a separate live setup.` : 'No connector registrations yet. Slack and Discord are not connected by this metadata panel.' });
}

export function providerConnectionPanelModel(body = {}) {
  const connections = Array.isArray(body.connections) ? body.connections.slice(0, 20) : [];
  return Object.freeze({
    empty: connections.length === 0,
    connections,
    statusLabel: connections.length ? `${connections.length} tenant provider reference(s); vault verification is still required.` : 'No tenant provider references recorded.',
    vaultStatus: 'external_encrypted_vault_required',
    tools: 'not_granted',
    invocation: 'not_performed',
  });
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
    budget,
    allocations: Array.isArray(budget?.allocations) ? budget.allocations : [],
    source: body.source === 'tenant_append_only_ledger' ? body.source : 'tenant_append_only_ledger',
    providerCalls: body.providerCalls === 'not_performed' ? body.providerCalls : 'not_performed',
  });
}

export function personalPreferencesModel(body = {}) {
  const preferences = body.preferences?.preferences ?? body.preferences ?? {};
  const bounds = body.bounds ?? {};
  const published = body.policy?.published === true;
  return Object.freeze({ preferences, bounds, published, statusLabel: body.preferences ? (published ? 'Personal Cora controls follow the published Organization bounds.' : 'Personal Cora controls use safe defaults; no published Organization preference policy is available.') : 'Personal Cora preferences are unavailable.' });
}

export function workspaceLayoutModel(body = {}) {
  const layout = body.layout ?? {};
  return Object.freeze({ layout, statusLabel: body.layout ? 'Workspace layout loaded for this signed-in user.' : 'Workspace layout is unavailable.' });
}
