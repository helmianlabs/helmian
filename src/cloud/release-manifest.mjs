// Release roadmap manifest: phases 5A-5E and the capabilities table, ported
// from the desktop's hardcoded PilotSnapshot.cs:280-337 but rewritten for
// cloud current-state. The desktop "Current" column describes local-desktop
// state; every status below reflects the CLOUD, honestly. Read-only.

export const RELEASE_ROADMAP_PATH = '/api/admin/release/roadmap';

export const RELEASE_PHASES = [
  { id: '5A', name: 'Desktop foundation', focus: 'Native shell, explicit state provenance, packaging smoke', status: 'IMPLEMENTED', cloudNote: 'The Windows desktop ships; the cloud is a separate surface, not a replacement.' },
  { id: '5B', name: 'Local service', focus: 'Authenticated named-pipe API with read-only live state', status: 'IMPLEMENTED', cloudNote: 'Cloud live state is served over session-authed HTTPS APIs; the named-pipe channel is desktop-side.' },
  { id: '5C', name: 'Multi-user control plane', focus: 'Tenants, roles, invitations, RLS, and immutable audit', status: 'IMPLEMENTED', cloudNote: 'Tenants, Clerk OIDC roles, invitations, RLS, and immutable audit events all exist in the cloud.' },
  { id: '5D', name: 'Governed integrations', focus: 'Approval authority, OAuth custody, and write workflows', status: 'IN PROGRESS', cloudNote: 'Approval authority with expiring, audited decisions exists; OAuth custody and write workflows are partial.' },
  { id: '5E', name: 'Release engineering', focus: 'Signed installer, updates, recovery, and test certification', status: 'PLANNED', cloudNote: 'Windows installer signing and update channels stay desktop-side; the cloud never builds installers.' },
];

export const RELEASE_CAPABILITIES = [
  { name: 'Tenant isolation', intent: 'Organization → workspace → project boundaries enforced in API and database RLS', cloudStatus: 'IMPLEMENTED', verification: 'Cross-tenant negative tests and reviewed RLS policy' },
  { name: 'Identity & roles', intent: 'OIDC identity with owner, admin, member, and read-only auditor roles', cloudStatus: 'IMPLEMENTED', verification: 'Clerk OIDC; owner/admin/member roles enforced server-side' },
  { name: 'Invitations', intent: 'Expiring, one-time, revocable invitations bound to tenant and intended role', cloudStatus: 'IMPLEMENTED', verification: 'Expiring invitations with revocation and audit' },
  { name: 'Approval authority', intent: 'Role-authorized, exact-action, expiring, one-time owner/admin decisions', cloudStatus: 'IMPLEMENTED', verification: 'Approval inbox with expiring, audited decisions' },
  { name: 'Audit history', intent: 'Immutable actor/action/target/result history with export and retention policy', cloudStatus: 'IMPLEMENTED', verification: 'Append-only audit events with CSV export' },
  { name: 'Safe integrations', intent: 'Per-tenant OAuth grants and vaulted service credentials with least privilege', cloudStatus: 'PLANNED', verification: 'The cloud holds no vaulted credentials; provider keys stay on the desktop' },
  { name: 'Portable profiles', intent: 'Versioned Helmion Profile Package with policy pack and reviewed learning', cloudStatus: 'PLANNED', verification: 'Profile sync remains desktop-side' },
  { name: 'Live orchestration', intent: 'Real-time routing, findings, tests, blockers, checkpoints, and handoffs with evidence links', cloudStatus: 'IN PROGRESS', verification: 'Chat, Guard findings, checkpoints, handoffs, and evidence views exist' },
  { name: 'Installer & updates', intent: 'Signed Windows package, staged update channels, rollback, and SBOM', cloudStatus: 'PLANNED', verification: 'Desktop-side; the cloud never builds or signs installers' },
];

export const RELEASE_BOUNDARIES = [
  { name: 'Identity boundary', text: 'System-browser OIDC + PKCE, short sessions, step-up for sensitive actions, and explicit tenant membership.' },
  { name: 'Data boundary', text: 'Tenant-scoped APIs and database RLS with negative isolation tests; no unscoped shared-state query path.' },
  { name: 'Release boundary', text: 'Signed installer and update manifest, staged rings, rollback, SBOM, clean-machine testing, and incident recovery.' },
];

export function getReleaseRoadmap() {
  return { phases: RELEASE_PHASES, capabilities: RELEASE_CAPABILITIES, boundaries: RELEASE_BOUNDARIES };
}

// Scoping matches GET /api/admin/release: any active tenant member.
export async function handleReleaseRoadmapRoute({ request, response, activeTenantActor, send, TenantAuthorizationError }) {
  try {
    await activeTenantActor(request);
    send(response, 200, JSON.stringify({ valid: true, ...getReleaseRoadmap() }));
  } catch (error) {
    const denied = error?.status === 403 || error instanceof TenantAuthorizationError;
    send(response, denied ? 403 : 503, JSON.stringify({ valid: false, code: denied ? 'RELEASE_MEMBERSHIP_REQUIRED' : 'RELEASE_ROADMAP_UNAVAILABLE' }));
  }
  return true;
}
