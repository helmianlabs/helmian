const ADMIN_ROLES = new Set(['owner', 'admin']);

async function settled(name, work) {
  try { return { name, ok: true, value: await work() }; }
  catch (error) { return { name, ok: false, error: error?.message ?? 'source unavailable' }; }
}

function sourceFailure(result) { return { state: 'unavailable', source: result.name, reason: 'source read failed' }; }

export async function readOrganizationReadiness({ actor, organizationRoles, coraConfig, providerUsage, connectors, workspaceLayout, auditEvents } = {}) {
  const admin = ADMIN_ROLES.has(String(actor?.role ?? '').toLowerCase());
  const results = await Promise.all([
    settled('helmion.tenant_memberships', () => organizationRoles.list(actor)),
    settled('organization_cora_config', () => coraConfig.readPublishedConfig(actor)),
    settled('organization_approved_knowledge', () => coraConfig.listKnowledgeSources(actor)),
    settled('organization_budget_policy', () => providerUsage.readSummary(actor)),
    settled('organization_connector_registration', () => connectors.list(actor)),
    settled('workspace_role_defaults', () => admin ? workspaceLayout.readRoleDefaults({ ...actor, actorRole: actor.role }) : ({ notPermitted: true })),
    settled('helmion.audit_events', () => auditEvents.list(actor, { limit: 1 })),
    settled('organization_role_plan_receipts', () => auditEvents.list(actor, { action: 'organization.membership_role_plan', limit: 1 })),
  ]);
  const byName = new Map(results.map((result) => [result.name, result]));
  const membership = byName.get('helmion.tenant_memberships');
  const config = byName.get('organization_cora_config');
  const knowledge = byName.get('organization_approved_knowledge');
  const budget = byName.get('organization_budget_policy');
  const connector = byName.get('organization_connector_registration');
  const workspace = byName.get('workspace_role_defaults');
  const audit = byName.get('helmion.audit_events');
  const plans = byName.get('organization_role_plan_receipts');
  const registrations = connector?.ok ? (connector.value.registrations ?? []) : [];
  const approvedSources = knowledge?.ok ? (knowledge.value.sources ?? []) : [];
  const approvedPacks = new Set(approvedSources.filter((item) => item.pack?.lifecycle === 'approved' && item.pack.allowlisted === true).map((item) => `${item.pack.key}:${item.pack.version}`));
  return Object.freeze({
    format: 'helmion.organization-readiness.v1',
    claim: 'not_a_global_production_ready_claim',
    organization: { state: membership?.ok ? 'verified' : 'unavailable', role: actor?.role ?? null, memberCount: admin && membership?.ok ? (membership.value.memberships ?? []).length : null, source: 'active_membership' },
    coraConfig: config?.ok ? { state: config.value.status === 'published' ? 'published' : 'unpublished', version: admin ? config.value.config?.configVersion ?? null : null, source: 'organization_cora_config' } : sourceFailure(config),
    knowledge: knowledge?.ok ? { state: approvedSources.length ? 'approved_sources_present' : 'none_approved', approvedSourceCount: approvedSources.length, approvedPackCount: approvedPacks.size, source: 'organization_approved_knowledge' } : sourceFailure(knowledge),
    budget: budget?.ok ? { state: budget.value.budget ? 'configured' : 'unconfigured', policyState: budget.value.budget?.policyState ?? null, recordedEventCount: budget.value.totals?.eventCount ?? null, reconciledCost: budget.value.totals?.reconciledCostMinor ?? null, source: 'organization_budget_policy', invoiceReconciliation: 'not_provided' } : sourceFailure(budget),
    connectors: connector?.ok ? { state: registrations.length ? 'registered_not_connected' : 'unconfigured', connected: false, registrations: registrations.map((item) => admin ? item : { provider: item.provider, lifecycle: item.lifecycle, enabled: item.enabled, publicEndpointReady: item.publicEndpointReady }), source: 'organization_connector_registration' } : sourceFailure(connector),
    workspace: workspace?.ok ? (workspace.value.notPermitted ? { state: 'not_permitted', source: 'workspace_role_defaults' } : { state: 'available', persisted: 'unknown', source: 'workspace_role_defaults' }) : sourceFailure(workspace),
    rolePlans: plans?.ok ? { state: plans.value.events?.length ? 'prepared_receipts_present' : 'none_prepared', preparedReceiptCount: plans.value.events?.length ?? 0, source: 'helmion.audit_events', membershipMutation: 'not_performed' } : sourceFailure(plans),
    audit: audit?.ok ? { state: audit.value.events?.length ? 'records_present' : 'none', source: 'helmion.audit_events' } : sourceFailure(audit),
    externalCalls: 'not_performed',
  });
}
