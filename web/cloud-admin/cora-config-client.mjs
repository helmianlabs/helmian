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
    readUsage() { return requestJson(fetchImpl, '/api/admin/cora/usage'); },
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
