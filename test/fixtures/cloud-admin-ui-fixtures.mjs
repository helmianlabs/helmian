function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const CLOUD_ADMIN_UI_FIXTURES = freeze({
  session: {
    member: { authenticated: true, actor: { subject: 'fixture-user', tenantId: 'fixture-organization', role: 'member' } },
    admin: { authenticated: true, actor: { subject: 'fixture-admin', tenantId: 'fixture-organization', role: 'admin' } },
  },
  envoy: {
    loading: { status: 'loading', channels: [], messages: [] },
    empty: { status: 'empty', channels: [], messages: [] },
    connected: { status: 'connected', channels: [{ id: 'fixture-channel', title: 'Operations', slug: 'operations', kind: 'team' }], messages: [{ id: '1', channelId: 'fixture-channel', authorKind: 'human', authorSubject: 'fixture-user', body: 'Fixture message only.', createdAt: '2026-01-01T00:00:00Z' }] },
    reconnecting: { status: 'reconnecting', channels: [{ id: 'fixture-channel', title: 'Operations', slug: 'operations', kind: 'team' }], messages: [] },
    revoked: { status: 'revoked', channels: [{ id: 'fixture-channel', title: 'Operations', slug: 'operations', kind: 'team' }], messages: [] },
    pollingFallback: { status: 'polling_fallback', channels: [{ id: 'fixture-channel', title: 'Operations', slug: 'operations', kind: 'team' }], messages: [] },
  },
  cora: {
    published: { status: 'published', config: { style: 'professional_brief', interruptMode: 'barge_in', turnMode: 'concise' } },
    unavailable: { status: 'unavailable', config: null },
    knowledgeMatch: { status: 'approved_sources_only', excerpts: [{ excerpt: 'Fixture approved excerpt.', citation: 'Fixture Manual §1', provenance: 'fixture-pack-v1' }] },
    knowledgeEmpty: { status: 'no_approved_source_match', excerpts: [] },
    usageNormal: { source: 'tenant_append_only_ledger', budget: { policyState: 'normal' }, totals: { eventCount: 1, estimatedCostMinor: null, reconciledCostMinor: null }, providerCalls: 'not_performed' },
    usageSoft: { source: 'tenant_append_only_ledger', budget: { policyState: 'soft_exceeded' }, totals: { eventCount: 2, estimatedCostMinor: null, reconciledCostMinor: null }, providerCalls: 'not_performed' },
    usageHard: { source: 'tenant_append_only_ledger', budget: { policyState: 'hard_exceeded' }, totals: { eventCount: 3, estimatedCostMinor: null, reconciledCostMinor: null }, providerCalls: 'not_performed' },
    usageEmpty: { source: 'tenant_append_only_ledger', budget: null, totals: { eventCount: 0, estimatedCostMinor: null, reconciledCostMinor: null }, providerCalls: 'not_performed' },
  },
  preparation: {
    empty: { receipts: [] },
    prepared: { receipts: [{ receiptId: 'fixture-preview-receipt', status: 'prepared', execution: 'not_performed', providerInvocation: 'not_performed' }] },
    replayed: { receipts: [{ receiptId: 'fixture-task-receipt', status: 'prepared', replayed: true, execution: 'not_performed', agentInvocation: 'not_performed' }] },
  },
  workspace: {
    layout: { visibleShelves: ['chat', 'cora', 'prepare', 'artifact', 'governance'], panelOrder: ['chat', 'cora', 'prepare', 'artifact', 'governance'], density: 'comfortable', defaultEnvoyChannelId: null },
  },
});

export function createCloudAdminFixtureFetch({ role = 'member', envoy = 'connected', knowledge = 'knowledgeEmpty', usage = 'usageEmpty', preparation = 'empty' } = {}) {
  const calls = [];
  const selected = CLOUD_ADMIN_UI_FIXTURES;
  let workspaceLayout = structuredClone(selected.workspace.layout);
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const path = new URL(url, 'https://fixture.local').pathname;
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/admin/session') return json(selected.session[role]);
    if (path === '/api/admin/envoy/channels') return json({ channels: selected.envoy[envoy].channels });
    if (path === '/api/admin/envoy/messages') return json({ messages: selected.envoy[envoy].messages, nextCursor: selected.envoy[envoy].messages.at(-1)?.id ?? null });
    if (path === '/api/admin/cora/config') return json(selected.cora.published);
    if (path === '/api/admin/cora/knowledge-sources') return json({ sources: [] });
    if (path === '/api/admin/cora/knowledge/query') return json(selected.cora[knowledge]);
    if (path === '/api/admin/cora/usage') return json(selected.cora[usage]);
    if (path === '/api/admin/cora/workspace/previews') return json(selected.preparation[preparation]);
    if (path === '/api/admin/cora/tasks') return json(selected.preparation[preparation]);
    if (path === '/api/admin/workspace/layout-preferences' && options.method === 'PUT') {
      workspaceLayout = JSON.parse(options.body ?? '{}');
      return json({ layout: workspaceLayout, source: 'fixture_organization_workspace' });
    }
    if (path === '/api/admin/workspace/layout-preferences') return json({ layout: workspaceLayout, source: 'fixture_organization_workspace' });
    if (path === '/api/admin/workspace/layout-preferences/reset' && options.method === 'POST') {
      workspaceLayout = structuredClone(selected.workspace.layout);
      return json({ layout: workspaceLayout, source: 'fixture_organization_workspace' });
    }
    if (path === '/api/admin/events') return json({ events: [] });
    if (path === '/api/admin/workspace') return json({ workspace: { agents: [] } });
    if (path === '/api/admin/control-surface') return json({ result: { authorization: 'fixture_membership_verified' } });
    return json({ valid: true, receipt: { durable: true, replayed: false } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
