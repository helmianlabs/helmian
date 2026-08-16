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
    cloud: 'Workspace nav: Chat, Cora, Prepare, Artifact Studio, Approvals, Connect, Agents, Governance, Audit, Readiness, Capabilities, People',
    cloudEvidence: 'web/cloud-admin/index.html:90-99',
    status: 'partial',
    missing: 'Cloud has no hosted Overview, Settings, Workspace-folder, Console, Evidence, or Release pages with desktop behavior.',
  },
  {
    id: 'workspace',
    desktop: 'Local project selection, branch, lease, migration and evidence inventories',
    desktopEvidence: 'desktop/Helmion.Desktop/MainWindow.xaml:2661-2890',
    cloud: 'Tenant workspace snapshot and personal layout preferences',
    cloudEvidence: 'src/cloud/live-admin.mjs:618-628; src/cloud/live-admin.mjs:836-849',
    status: 'partial',
    missing: 'No hosted project-folder selector, local lease, or source inventory is exposed.',
  },
  {
    id: 'console',
    desktop: 'Maestro conversation, permission selector, commands, MCP security, clear output and full-screen controls',
    desktopEvidence: 'desktop/Helmion.Desktop/MainWindow.xaml:3441-3847',
    cloud: 'Organization Envoy conversation plus tenant-scoped console command intent receipts',
    cloudEvidence: 'web/cloud-admin/index.html:122-133; web/cloud-admin/app.js:520-543; web/cloud-admin/app.js:946-961; src/cloud/live-admin.mjs:908-927',
    status: 'partial',
    missing: 'Hosted console records bounded intents but does not execute desktop commands, MCP audits, filesystem tools, or provider turns.',
  },
  {
    id: 'artifact-studio',
    desktop: 'Create/Preview artifact workspace with local split panes',
    desktopEvidence: 'desktop/Helmion.Desktop/MainWindow.xaml:2942-3402',
    cloud: 'Artifact Studio intent, source, script, and execution-request receipts',
    cloudEvidence: 'web/cloud-admin/index.html:279-319; src/cloud/live-admin.mjs:730-780',
    status: 'partial',
    missing: 'Cloud records bounded intents and preflights; it does not execute the desktop artifact workflow.',
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
