/**
 * The desktop and hosted Cloud surfaces are different runtimes.  This manifest
 * is deliberately an honest parity ledger: a mapped shelf is not the same as
 * an executable hosted feature.  Every row names the desktop source, the
 * Cloud surface that currently represents it, and the missing transition.
 */
const PARITY = Object.freeze([
  {
    id: 'navigation',
    desktop: 'Pilot pages: Overview, Settings, Workspace, Create, Console, Review & History, Evidence, Approvals, Connect, Agents, Guard, Release roadmap',
    desktopEvidence: 'desktop/Helmion.Desktop/MainWindow.xaml:2098-2198',
    cloud: 'Workspace nav: Overview, Chat, Cora, Prepare, Artifact Studio, Approvals, Connect, Agents, Governance, Audit, Readiness, Capabilities, People, Settings, Release',
    cloudEvidence: 'web/cloud-admin/index.html:90-99',
    status: 'partial',
    missing: 'Overview, Settings and Release are hosted (read-only, Neon + GitHub Releases); Workspace-folder and Evidence pages are still desktop-only.',
  },
  {
    id: 'workspace',
    desktop: 'Local project selection, branch, lease, migration and evidence inventories',
    desktopEvidence: 'desktop/Helmion.Desktop/MainWindow.xaml:2661-2890',
    cloud: 'Tenant project registry with per-user active-project selection, GitHub repo bindings, computed source inventory, and cloud write leases for the desktop handoff',
    cloudEvidence: 'src/cloud/live-admin.mjs:LIVE_ADMIN_WORKSPACE_PROJECTS_PATH; src/cloud/live-admin.mjs:LIVE_ADMIN_WORKSPACE_ACTIVE_PROJECT_PATH; src/cloud/live-admin.mjs:LIVE_ADMIN_WORKSPACE_REPO_BINDINGS_PATH; src/cora/workspace-lease.mjs',
    status: 'partial',
    missing: 'Cloud lease/mutual-exclusion design beyond the handoff lease needs a design call; branch and migration inventories are still desktop-only.',
  },
  {
    id: 'console',
    desktop: 'Maestro conversation, permission selector, commands, MCP security, clear output and full-screen controls',
    desktopEvidence: 'desktop/Helmion.Desktop/MainWindow.xaml:3441-3847',
    cloud: 'Organization Envoy conversation plus tenant-scoped console commands; the cloud console worker executes workspace_context, list_agents and open_project against Neon and shows results',
    cloudEvidence: 'web/cloud-admin/index.html:122-133; web/cloud-admin/app.js:520-543; web/cloud-admin/app.js:946-961; src/cloud/live-admin.mjs:908-927',
    status: 'partial',
    missing: 'Project tasks and previews are marked needs_desktop: no filesystem tools, MCP audits or provider turns run in the cloud yet.',
  },
  {
    id: 'artifact-studio',
    desktop: 'Create/Preview artifact workspace with local split panes',
    desktopEvidence: 'desktop/Helmion.Desktop/MainWindow.xaml:2942-3402',
    cloud: 'Artifact Studio intent, source, script, and execution-request receipts; the cloud worker drains approved and pre-approved queued requests as needs_desktop; the paired desktop reports completion back through the device-authed result endpoint (needs_desktop -> completed); script text is content-validated at request time',
    cloudEvidence: 'web/cloud-admin/index.html:279-319; src/cloud/live-admin.mjs:730-780; src/cora/artifact-execution-worker.mjs; src/cora/artifact-execution-repository.mjs',
    status: 'partial',
    missing: 'The generative step still runs on the paired desktop: the cloud never invokes providers, generates media, or holds credentials (019 contract).',
  },
  {
    id: 'guard',
    desktop: 'Guard tabs, findings, acknowledgement and slide-off right dock',
    desktopEvidence: 'desktop/Helmion.Desktop/MainWindow.xaml:1316-1493; desktop/Helmion.Desktop/MainWindow.xaml:1531',
    cloud: 'Governance/readiness cards and Guard preview navigation',
    cloudEvidence: 'web/cloud-admin/index.html:341-364; web/cloud-admin/app.js:849-856',
    status: 'partial',
    missing: 'Hosted Guard does not receive browser events or persist desktop finding acknowledgements.',
  },
  {
    id: 'approvals',
    desktop: 'Approval queue and explicit approve/reject actions',
    desktopEvidence: 'desktop/Helmion.Desktop/MainWindow.xaml:2169-2176',
    cloud: 'Organization approvals inbox with durable receipts',
    cloudEvidence: 'web/cloud-admin/index.html:220-225; src/cloud/live-admin.mjs:780-790',
    status: 'mapped',
    missing: 'The hosted approval path is receipt-only; it does not invoke desktop workers.',
  },
  {
    id: 'connectors',
    desktop: 'Connectors shelf for Discord, GitHub and Slack',
    desktopEvidence: 'desktop/Helmion.Desktop/MainWindow.xaml:2178-2182; desktop/Helmion.Desktop/MainWindow.xaml:3304-3324',
    cloud: 'Connector registration metadata and readiness',
    cloudEvidence: 'web/cloud-admin/index.html:227-232; src/cloud/live-admin.mjs:790-800',
    status: 'partial',
    missing: 'Hosted registration does not itself establish OAuth, secrets, or outbound delivery.',
  },
  {
    id: 'agents',
    desktop: 'Agents dock and activity controls',
    desktopEvidence: 'desktop/Helmion.Desktop/MainWindow.xaml:2183-2187',
    cloud: 'Agent task intent receipts and activity snapshot',
    cloudEvidence: 'web/cloud-admin/index.html:205-218; src/cloud/live-admin.mjs:720-730',
    status: 'partial',
    missing: 'Cloud task intents do not start a worker or provider execution.',
  },
  {
    id: 'settings',
    desktop: 'Theme, local service, sidebar/details/bottom-panel toggles',
    desktopEvidence: 'desktop/Helmion.Desktop/MainWindow.xaml:1570-1598; desktop/Helmion.Desktop/MainWindow.xaml:1894-1900',
    cloud: 'Personal workspace layout and density preferences',
    cloudEvidence: 'web/cloud-admin/index.html:110-121; src/cloud/live-admin.mjs:836-861',
    status: 'partial',
    missing: 'Cloud has no desktop theme, local-service, or panel-toggle parity.',
  },
  {
    id: 'voice-remote',
    desktop: 'Voice host, dictation, Herald and phone mirror controls',
    desktopEvidence: 'desktop/Helmion.Desktop/MainWindow.xaml:1137; desktop/Helmion.Desktop/MainWindow.Herald.cs:1',
    cloud: 'Cora preferences, capability explorer and WebSocket service boundary',
    cloudEvidence: 'web/cloud-admin/index.html:132-183; src/cora/clm-server.mjs:1049-1054',
    status: 'not_wired',
    missing: 'No cited hosted chain currently proves phone voice → Cloud session → desktop action.',
  },
  {
    id: 'release',
    desktop: 'Release roadmap and local package posture',
    desktopEvidence: 'desktop/Helmion.Desktop/MainWindow.xaml:2194-2198; desktop/scripts/publish.ps1:1-188',
    cloud: 'Organization readiness and deployment contract cards',
    cloudEvidence: 'web/cloud-admin/index.html:251-255; src/cloud/live-admin.mjs:821-826',
    status: 'partial',
    missing: 'Cloud readiness does not build, sign, or publish a Windows installer.',
  },
  {
    id: 'evidence',
    desktop: 'Evidence page: handoff timeline, evidence contract card, local file inventory',
    desktopEvidence: 'desktop/Helmion.Desktop/MainWindow.xaml:4690-4707',
    cloud: '/admin Evidence section (handoff timeline, checkpoints, unified run-receipt ledger, lease posture) and /app evidence view extended with handoffs and checkpoints; the Evidence contract is ported as static copy',
    cloudEvidence: 'web/cloud-admin/index.html:section-evidence; web/cloud-admin/app.js:loadEvidenceSection; src/cloud/evidence.mjs; src/cloud/live-admin.mjs:LIVE_ADMIN_MAESTRO_HANDOFFS_PATH',
    status: 'partial',
    missing: 'Handoffs, checkpoints, and Maestro leases are owner/admin-only reads: the migration-002 tables are keyed by project_slug with no tenant_id, so no tenant scoping exists yet (no slug == project_key convention adopted). The local filesystem evidence inventory (.helmion/evidence files, test-file counts, runbooks) stays desktop-only.',
  },
]);

export function buildDesktopParityManifest() {
  return {
    format: 'helmion.desktop-cloud-parity.v1',
    claim: 'inventory_only',
    statuses: { mapped: 'mapped', partial: 'partial', not_wired: 'not_wired' },
    entries: PARITY.map((entry) => ({ ...entry, chain: [entry.desktopEvidence, entry.cloudEvidence] })),
    parityComplete: false,
    invocation: 'not_performed',
    mutation: 'not_performed',
  };
}
