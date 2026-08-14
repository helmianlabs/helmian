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
    createDraft({ reason }) {
      return requestJson(fetchImpl, '/api/admin/cora/configs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          config: { style: 'professional_brief', maxSpokenChars: 900, interruptMode: 'barge_in', turnMode: 'concise' },
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
