// Pure helpers for the Helmian Cloud app (no DOM) so they can be unit tested.
export const VIEWS = Object.freeze(['home', 'console', 'desktop', 'overview', 'settings', 'workspace', 'devices', 'activity', 'evidence', 'approvals', 'upcoming', 'integrations', 'agents', 'create', 'browser', 'canvas', 'preview', 'release']);
export const VIEW_TITLES_PLAYFUL = Object.freeze({ home: '🏠 Home', console: '💬 Session console', desktop: '🖥️ Workspace', overview: '📊 Overview', settings: '⚙️ Settings', workspace: '🗂️ Projects', devices: '📱 Devices', activity: '📡 Live activity', evidence: '📦 Evidence', approvals: '✅ Approvals', upcoming: '⏳ Upcoming', integrations: '🔌 Integrations', agents: '🤖 Agents', create: '✨ Create', browser: '🌐 Browser', canvas: '🎨 Canvas', preview: '👁 Preview', release: '🚀 Release roadmap' });
export const VIEW_TITLES_PLAIN = Object.freeze({ home: 'Home', console: 'Session console', desktop: 'Workspace', overview: 'Overview', settings: 'Settings', workspace: 'Projects', devices: 'Devices', activity: 'Live activity', evidence: 'Evidence', approvals: 'Approvals', upcoming: 'Upcoming', integrations: 'Integrations', agents: 'Agents', create: 'Create', browser: 'Browser', canvas: 'Canvas', preview: 'Preview', release: 'Release roadmap' });
// VIEW_TITLES stays as the playful alias for existing importers; viewTitles() picks per preference.
export const VIEW_TITLES = VIEW_TITLES_PLAYFUL;
export function viewTitles(emojiMode) { return emojiMode === 'plain' ? VIEW_TITLES_PLAIN : VIEW_TITLES_PLAYFUL; }
export function isPlainEmojiMode(emojiMode) { return emojiMode === 'plain'; }
export const PRIMARY_VIEWS = Object.freeze(['desktop', 'home', 'workspace', 'approvals']);
export const ADVANCED_VIEWS = Object.freeze(['console', 'devices', 'overview', 'settings', 'activity', 'evidence', 'integrations', 'agents', 'release']);
// Browser, Canvas, Preview, Create live in the right workbench panel now
// (BROWSE-001), not the Advanced accordion. They stay in VIEWS/VIEW_TITLES so
// old #hash links resolve, and show() redirects them to the panel tab.
export const PANEL_VIEWS = Object.freeze(['browser', 'canvas', 'preview', 'create']);
export const PANEL_TABS = Object.freeze(['browser', 'canvas', 'preview', 'create']);
export const PROVIDERS = Object.freeze(['Claude', 'ChatGPT', 'Grok', 'Gemini']);
export const PROVIDER_REGISTRY = Object.freeze([
  { key: 'slack', name: 'Slack', kind: 'Team chat mirror' }, { key: 'discord', name: 'Discord', kind: 'Team chat mirror' }, { key: 'github', name: 'GitHub', kind: 'Code' },
  { key: 'anthropic', name: 'Claude', kind: 'AI provider' }, { key: 'openai', name: 'ChatGPT', kind: 'AI provider' }, { key: 'xai', name: 'Grok', kind: 'AI provider' }, { key: 'google', name: 'Gemini', kind: 'AI provider' },
]);

// Phones open on Home; wider screens keep the desktop-style Console default.
export function viewFromHash(hash = '', { phone = false } = {}) { const v = String(hash).replace(/^#\/?/, '').toLowerCase(); return VIEWS.includes(v) ? v : 'desktop'; }
export function isAdminRole(role) { return ['owner', 'admin'].includes(String(role ?? '').toLowerCase()); }

export function sessionModel(status, body = {}) {
  if (status === 200 && body?.actor) return { signedIn: true, member: true, actor: body.actor };
  if (body?.signedIn) return { signedIn: true, member: false, actor: null };
  return { signedIn: false, member: false, actor: null };
}

export function projectsModel(body = {}) {
  const projects = (Array.isArray(body.projects) ? body.projects : []).map((p) => ({
    key: String(p.projectKey ?? ''), name: String(p.displayName || p.projectKey || 'Untitled project'),
    branch: String(p.defaultBranch ?? 'main'), source: String(p.sourceKind ?? ''), lifecycle: String(p.lifecycle ?? 'active'),
  }));
  return { projects, empty: projects.length === 0, canManage: body.canManage === true };
}
export function filterProjects(projects, query = '') { const q = String(query).trim().toLowerCase(); return q ? projects.filter((p) => p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q)) : projects; }
export function projectKeyFromName(name = '') { return String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'project'; }

// Account-owned Desktops from GET /api/remote/v1/desktops (Herald Remote Control shape).
export function desktopsModel(body = {}) {
  const desktops = (Array.isArray(body.desktops) ? body.desktops : []).map((d) => ({
    desktopId: String(d.desktopId ?? ''),
    displayName: String(d.displayName || d.desktopId || 'Desktop'),
    sessions: (Array.isArray(d.sessions) ? d.sessions : []).map((s) => ({
      sessionId: String(s.sessionId ?? ''),
      name: String(s.name ?? 'Session'),
      state: String(s.state ?? ''),
      projectName: String(s.project?.name ?? s.projectName ?? 'Project'),
    })),
  }));
  const rows = desktops.flatMap((d) => d.sessions.map((s) => ({
    desktopId: d.desktopId, displayName: d.displayName, ...s,
  })));
  // `empty` = nothing to drive (no sessions). `noDesktops` = nothing paired at all;
  // a paired Desktop with no open session still shows so it can be forgotten.
  return { desktops, rows, empty: rows.length === 0, noDesktops: desktops.length === 0 };
}

// "Forget this pairing" (POST /api/remote/v1/desktops action revoke). The server
// revokes the registration and every control grant; the Desktop sees desktop_denied
// on its next status check, wipes its local credential and can be paired again.
export function forgetDesktopPayload(desktopId) {
  const id = String(desktopId ?? '').trim();
  if (!id) throw new Error('desktopId is required');
  return { action: 'revoke', desktopId: id, confirmed: true };
}

export function approvalsModel(body = {}, role = null) {
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 100).map((i) => ({ ...i, canDecide: Boolean(i.approvalRequired && !i.decision && isAdminRole(role)) }));
  return { items, empty: items.length === 0, pending: items.filter((i) => !i.decision).length };
}

export function formatTime(value, opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) { const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], opts); }
export function clockTime(value) { return formatTime(value, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }

// Console log lines from Envoy messages.
//
// Bridge identity: the PC bridge posts with authorKind='agent' and an
// authorSubject ending in ':bridge' (server-derived in src/cloud/envoy-chat.mjs).
// Give it a name instead of the generic "agent" fallback. Rename in one line here.
// The name is "PC bridge", not Maestro: Maestro is the human's seat,
// and no reply is authored under that name (Maestro Bite 2).
export const BRIDGE_DISPLAY_NAME = 'PC bridge';
const BRIDGE_SUBJECT_SUFFIX = ':bridge';

export function logLines(body = {}, subject = null) {
  return (Array.isArray(body.messages) ? body.messages : []).map((m) => {
    const isBridge = m.authorKind === 'agent' && String(m.authorSubject ?? '').endsWith(BRIDGE_SUBJECT_SUFFIX);
    const who = m.authorKind === 'human'
      ? (m.authorName || (subject && (m.authorSubject === subject || m.authorId === subject) ? 'you' : 'member'))
      : (isBridge ? BRIDGE_DISPLAY_NAME : (m.authorName || m.authorKind || 'agent'));
    return {
      id: m.id, ts: m.createdAt ? clockTime(m.createdAt) : '', text: String(m.body ?? ''),
      mine: Boolean(subject && (m.authorSubject === subject || m.authorId === subject)),
      who, bridge: isBridge,
    };
  });
}

export function humanAction(type = '') { return String(type).replace(/^[a-z]+\./, '').replaceAll(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()); }

// Guard Feed: pending approvals are critical; denied/blocked events warn; everything else is info.
export function feedModel({ events = [], approvals = [] } = {}, { filter = 'all', showInfo = true, showApprovals = true, acknowledged = new Set(), cleared = new Set() } = {}) {
  const cards = [];
  if (showApprovals) for (const a of approvals) if (!a.decision) cards.push({ id: `apr:${a.requestReceiptId}`, severity: 'critical', title: a.summary || humanAction(a.requestKind) || 'Approval needed', body: 'Waiting for an owner decision', at: a.createdAt || null, approval: a });
  for (const e of events) {
    const s = String(e.status ?? '').toUpperCase();
    const severity = ['DENY', 'BLOCK', 'BLOCKED', 'REJECT', 'ERROR', 'FAIL'].some((x) => s.includes(x)) ? 'warning' : 'info';
    if (severity === 'info' && !showInfo) continue;
    const plain = plainEvent(e);
    cards.push({ id: `evt:${e.id}`, severity, title: plain.title, body: plain.body, at: e.createdAt || null, actor: e.actor });
  }
  return cards.filter((c) => !cleared.has(c.id)).map((c) => (acknowledged.has(c.id) ? { ...c, severity: 'warning', ack: true } : c))
    .filter((c) => filter === 'all' || c.severity === filter);
}

// Guard Feed "Ack all": the card ids an acknowledge-everything moves into
// the persisted cleared set, so the pile is gone for good (a reload
// refetches the same events from the server and must not resurrect them).
// Every current event card clears. Findings clear too, except criticals —
// a critical finding is never hidden by an ack; it stays visible, marked
// acknowledged. Pending approvals are decisions, not notices, and are
// never cleared by an ack (they leave when they are decided).
export function feedAckClearIds({ events = [], findings = [] } = {}) {
  const ids = [];
  for (const e of events) ids.push(`evt:${e.id}`);
  for (const f of findings) if (String(f.severity ?? '').toLowerCase() !== 'critical') ids.push(`finding:${f.fingerprint}`);
  return ids;
}

export function maskSecret(hint = '') { const tail = String(hint).replace(/[^A-Za-z0-9]/g, '').slice(-4); return tail ? `••••••••${tail}` : '••••••••'; }

// ---- connection truth (bite 1b: the read-path) ----
// Every surface that shows a connection state renders THESE rows — the
// private-room CONNECTORS panel and the Integrations page alike — and each
// row names the source its state came from (`source`), so a state is never
// a guess wearing a label:
// - Tool connections (GitHub and any future tool service): the row from
//   helmion.tool_connections (GET /api/admin/tool-connections). "Connected"
//   renders ONLY from a probe receipt — state 'verified' with a fresh
//   lastVerifiedAt (toolConnectionStatus below; the same rule the store
//   enforces server-side, isVerifiedFresh in src/cloud/tool-connections.mjs).
//   A failed probe reads "Check failed"; a verified receipt gone stale
//   reads "Not checked recently"; a row never probed reads "Not checked".
// - Slack / Discord are CHANNEL MIRRORS (sql/026 registrations), not tool
//   connections: their rows read "Linked" / "Not linked" — the mirror is
//   live exactly when its registration is lifecycle 'enabled' and enabled,
//   the same test the inbound gateway resolves by. An env "configured"
//   flag or a half-finished registration never reads as linked.
// - The AI providers are NOT tool connections either: their truth is the
//   agent's own runner link — a provider connection saved as verified
//   (sql/031) or the runner presence feed saying that provider is
//   answering right now. When neither source answered, the row reads
//   "Not checked" — never a guessed "Not connected".
// Rows keep `connected` (the boolean the attach gate uses): it is true
// only for a verified+fresh tool connection, a live mirror link, or a
// provider with a live runner link.

// How long a probe receipt still counts as "Connected" on screen. The
// probe-wiring follow-on should check connections at least this often.
export const CONNECTION_FRESH_MS = 60 * 60 * 1000;

// The render rule for one tool_connections row (the store's row shape:
// state, lastVerifiedAt). Pure; `now`/`maxAgeMs` injectable for tests.
export function toolConnectionStatus(row, { now = Date.now(), maxAgeMs = CONNECTION_FRESH_MS } = {}) {
  if (!row) return { status: 'none', statusText: null, connected: false };
  if (row.state === 'verified' && row.lastVerifiedAt) {
    const verifiedMs = new Date(row.lastVerifiedAt).getTime();
    if (Number.isFinite(verifiedMs) && verifiedMs <= now && now - verifiedMs <= maxAgeMs) {
      return { status: 'connected', statusText: 'Connected', connected: true };
    }
    return { status: 'stale', statusText: 'Not checked recently', connected: false };
  }
  if (row.state === 'failed') return { status: 'failed', statusText: 'Check failed', connected: false };
  if (row.state === 'revoked') return { status: 'revoked', statusText: 'Not connected', connected: false };
  // 'registered' / 'probing': intent on file, never proven either way.
  return { status: 'unchecked', statusText: 'Not checked', connected: false };
}

// A service can hold rows in several scopes (workspace + per-agent). The
// panel shows the strongest truth any of them earned: a live verified
// receipt first, then a failure (a broken scope is worth saying out loud),
// then staleness, then never-checked, then revoked.
const TOOL_STATUS_RANK = Object.freeze({ connected: 5, failed: 4, stale: 3, unchecked: 2, revoked: 1, none: 0 });
export function bestToolConnectionStatus(rows = [], serviceId, opts = {}) {
  let best = { status: 'none', statusText: null, connected: false };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (String(row?.serviceId ?? '') !== serviceId) continue;
    const s = toolConnectionStatus(row, opts);
    if (TOOL_STATUS_RANK[s.status] > TOOL_STATUS_RANK[best.status]) best = s;
  }
  return best;
}

const MIRROR_KEYS = new Set(['slack', 'discord']);
// How the same provider is named in the other two sources: the provider
// connections list (sql/031 — OAuth-era ids) and the runner presence feed.
const PROVIDER_SOURCE_NAMES = Object.freeze({
  anthropic: Object.freeze({ connections: ['anthropic', 'claude'], presence: ['claude', 'anthropic'] }),
  openai: Object.freeze({ connections: ['openai'], presence: ['openai'] }),
  xai: Object.freeze({ connections: ['xai', 'grok'], presence: ['xai', 'grok'] }),
  google: Object.freeze({ connections: ['google', 'gemini'], presence: ['gemini', 'google'] }),
});

function mirrorRow(p, connectors) {
  const registrations = connectors?.registrations;
  if (!Array.isArray(registrations)) return { ...p, connected: false, status: 'unchecked', statusText: 'Not checked', source: 'channel-mirror' };
  const reg = registrations.find((r) => String(r?.provider ?? r?.connectorKind ?? '').toLowerCase() === p.key);
  const linked = Boolean(reg && reg.lifecycle === 'enabled' && reg.enabled === true);
  return { ...p, connected: linked, status: linked ? 'linked' : 'not-linked', statusText: linked ? 'Linked' : 'Not linked', source: 'channel-mirror' };
}

function providerRow(p, providers, presence) {
  const names = PROVIDER_SOURCE_NAMES[p.key];
  const connections = providers?.connections;
  const connectionsAnswered = Array.isArray(connections);
  const saved = connectionsAnswered
    ? connections.find((c) => names.connections.includes(String(c?.providerId ?? c?.provider ?? c?.providerKey ?? '').toLowerCase()))
    : null;
  const presenceAnswered = Array.isArray(presence);
  const live = presenceAnswered && presence.some((r) => r?.connected === true && names.presence.includes(String(r?.provider ?? r?.providerName ?? '').toLowerCase()));
  if (live) return { ...p, connected: true, status: 'connected', statusText: 'Connected', source: 'runner-presence' };
  if (saved && saved.lifecycle === 'verified') return { ...p, connected: true, status: 'connected', statusText: 'Connected', source: 'provider-connection' };
  // "Not connected" is a claim both sources must have answered to make:
  // if either read never arrived, a working link could be sitting in the
  // one we didn't see — the row says "Not checked" instead of guessing.
  if (!connectionsAnswered || !presenceAnswered) return { ...p, connected: false, status: 'unchecked', statusText: 'Not checked', source: 'none' };
  return { ...p, connected: false, status: 'not-connected', statusText: 'Not connected', source: saved ? 'provider-connection' : 'runner-presence' };
}

// connectors: GET /api/admin/cora/connectors body; providers: GET
// /api/admin/provider-connections body; toolConnections: the rows from
// GET /api/admin/tool-connections (null when that read never arrived);
// presence: the runner presence rows (null likewise).
export function integrationsModel(connectors = {}, providers = {}, { toolConnections = null, presence = null, now = Date.now() } = {}) {
  return PROVIDER_REGISTRY.map((p) => {
    if (MIRROR_KEYS.has(p.key)) return mirrorRow(p, connectors);
    if (PROVIDER_SOURCE_NAMES[p.key]) return providerRow(p, providers, presence);
    if (Array.isArray(toolConnections)) {
      const s = bestToolConnectionStatus(toolConnections, p.key, { now });
      if (s.status !== 'none') return { ...p, ...s, source: 'tool-connections' };
    }
    // No tool_connections row (or the read never arrived): the registry's
    // existing answer for this service, exactly as before this bite.
    return { ...p, connected: false, status: 'not-connected', statusText: 'Not connected', source: 'registry' };
  });
}

export function metricsModel(body = {}) { const c = body.counts ?? {}; return [['Active projects', c.activeProjects ?? 0], ['Members', c.members ?? 0], ['Agent tasks', c.agentTasks ?? 0], ['AI providers', c.verifiedProviders ?? 0]]; }
export function postureModel(body = {}) { const s = body.settings ?? {}; return [['Sign-in', s.signIn ? 'On' : 'Off'], ['Cloud database', s.database ? 'Connected' : 'Offline'], ['AI provider', s.coraProvider ? String(s.coraProvider) : 'Not set'], ['Console worker', s.consoleWorker ? 'Running' : 'Idle']]; }

// Sessions live in this browser (the cloud has no session store yet).
export function addSession(list = [], { name, provider, id = null, now = Date.now() } = {}) {
  const n = String(name ?? '').trim().slice(0, 60); if (!n || !PROVIDERS.includes(provider)) return list;
  return [{ id: id ?? `s${now}`, name: n, provider, createdAt: new Date(now).toISOString() }, ...list].slice(0, 20);
}

// Plain-language wording for Guard Feed / activity / evidence. Server summaries can carry
// internal policy jargon, so known actions get fixed copy and unknown ones are cleaned.
const PLAIN = Object.freeze({
  'admin.bootstrap_owner': ['Owner added', 'You were set up as the owner of this organization.'],
  'cora.session.started': ['Session started', 'An AI session was started.'],
  'app.session.created': ['Session started', null],
  'app.session.archived': ['Session closed', 'A session was closed.'],
  'app.task.planned': ['Task plan set', null],
  'app.task.step_running': ['Step started', null],
  'app.task.step_done': ['Step finished', null],
  'app.task.step_failed': ['Step failed', null],
  'app.task.step_skipped': ['Step skipped', null],
  'envoy.channel.created': ['Team channel created', 'Your team chat channel is ready.'],
  'workspace.project.register': ['Project added', 'A project was added to the workspace.'],
  'admin.action_policy.preview': ['Action checked', 'An action was checked against your guardrails.'],
  'admin.action_policy.confirm': ['Action confirmed', 'An action was confirmed by an owner.'],
  'organization.membership_role_plan': ['Role change requested', 'A team member role change is waiting for review.'],
});
const JARGON = /\b(actual-evidence-only|evidence-only|not_performed|no-execution|receipt[s]?|durable|provider usage is|canonical|policy version)\b/i;
export function plainEvent(e = {}) {
  const known = PLAIN[e.actionType];
  const title = known ? known[0] : humanAction(e.actionType || 'event');
  let body = known ? known[1] : null;
  if (body == null) {
    const first = String(e.summary ?? '').split(/[;\n]/)[0].trim();
    body = first && !JARGON.test(first) ? first : '';
  }
  return { title, body };
}

export function sessionsFromServer(body = {}) {
  return (Array.isArray(body.sessions) ? body.sessions : []).map((s) => ({ id: String(s.id), name: String(s.name), provider: String(s.provider), createdAt: s.createdAt ?? null, progress: s.progress ?? null }));
}

// ---- live task progress checklist ----
const STEP_ICON = Object.freeze({ pending: '○', running: '◐', done: '✓', failed: '✕', skipped: '–' });
const STEP_WORD = Object.freeze({ pending: 'To do', running: 'In progress', done: 'Done', failed: 'Failed', skipped: 'Skipped' });
const NEXT_STATUS = Object.freeze({ pending: 'running', running: 'done', done: 'pending', failed: 'running', skipped: 'pending' });
export function progressModel(body = {}) {
  const steps = (Array.isArray(body.steps) ? body.steps : []).filter((s) => STEP_ICON[s?.status]).slice().sort((a, b) => a.position - b.position);
  const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const failed = steps.filter((s) => s.status === 'failed').length;
  const current = steps.find((s) => s.status === 'running') ?? null;
  const total = steps.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const summary = !total ? 'No plan yet' : failed ? `${done} of ${total} done · ${failed} failed` : done === total ? `All ${total} steps done` : `${done} of ${total} done${current ? ` · now: ${current.label}` : ''}`;
  return { total, done, failed, pct, summary, current: current?.label ?? null, complete: total > 0 && done === total,
    items: steps.map((s) => ({ position: s.position, label: s.label, status: s.status, icon: STEP_ICON[s.status], word: STEP_WORD[s.status], next: NEXT_STATUS[s.status] })) };
}
export function planFromText(text = '') {
  return String(text).split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)]|\[[ x]?\])\s*/i, '').trim()).filter(Boolean).map((l) => l.slice(0, 120)).slice(0, 20);
}


// Desktop Agents dock parity: four providers + open sessions (no cloud execution).
const AGENT_ALIASES = Object.freeze({ anthropic: 'Claude', claude: 'Claude', openai: 'ChatGPT', chatgpt: 'ChatGPT', xai: 'Grok', grok: 'Grok', google: 'Gemini', gemini: 'Gemini' });
export function agentsModel(providers = {}, sessionsBody = {}) {
  const conns = Array.isArray(providers.connections) ? providers.connections : [];
  const byName = new Map();
  for (const c of conns) {
    const name = AGENT_ALIASES[String(c.provider || c.providerId || '').toLowerCase()] || (c.displayName || c.provider || 'Provider');
    byName.set(name, c);
  }
  const agents = PROVIDERS.map((name) => {
    const c = byName.get(name);
    return {
      name,
      connected: Boolean(c),
      lifecycle: c ? String(c.lifecycle || c.status || 'saved') : 'not connected',
      authMode: c ? String(c.authMode || c.authorization || '') : '',
      adapter: c ? String(c.adapter || c.kind || '') : '',
      updatedAt: c?.updatedAt || c?.updated_at || null,
    };
  });
  const active = sessionsFromServer(sessionsBody);
  return { agents, active, empty: agents.every((a) => !a.connected) && active.length === 0 };
}

// ---- Home dashboard (phone default) ----
function money(minor, currency = 'USD') { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(minor || 0) / 100); } catch { return `$${(Number(minor || 0) / 100).toFixed(2)}`; } }

// Create / Artifact Studio (cloud records intents only; media runs on the desktop EXE).
export const CREATE_TYPES = Object.freeze([
  { id: 'training', label: 'Training' },
  { id: 'orientation', label: 'Orientation' },
]);
export function createModel(body = {}) {
  const receipts = (Array.isArray(body.receipts) ? body.receipts : []).slice(0, 50).map((r) => ({
    id: String(r.receiptId || r.id || ''),
    title: String(r.title || 'Untitled'),
    type: String(r.artifactType || r.type || ''),
    status: String(r.status || r.stage || 'draft'),
    objective: String(r.objective || ''),
    department: String(r.department || ''),
    sources: Array.isArray(r.sourceRefs) ? r.sourceRefs.length : 0,
    replayed: r.replayed === true,
    createdAt: r.createdAt || r.created_at || null,
  }));
  return { receipts, empty: receipts.length === 0 };
}
export function createIntentPayload({ title, objective, type, department = 'general', sourcesText = '', stage = 'draft' } = {}) {
  const sourceRefs = String(sourcesText).split('\n').map((line) => line.trim()).filter(Boolean).map((citation) => ({ citation, title: citation.slice(0, 240) }));
  const t = String(title || '').trim();
  const o = String(objective || '').trim();
  const artifactType = CREATE_TYPES.some((x) => x.id === type) ? type : 'training';
  return {
    artifactType,
    stage: stage === 'approval_requested' ? 'approval_requested' : 'draft',
    title: t,
    department: String(department || 'general').trim() || 'general',
    objective: o || t,
    sourceRefs,
    idempotencyKey: `create-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
    approvalReason: null,
  };
}


export function usageModel(body = {}) {
  const spent = Number(body?.totals?.reconciledCostMinor ?? body?.totals?.estimatedCostMinor ?? 0);
  const b = body?.budget ?? null; const currency = b?.currency || 'USD';
  const limit = b ? Number(b.hardLimitMinor ?? b.softLimitMinor ?? 0) : 0;
  const soft = b ? Number(b.softLimitMinor ?? 0) : 0;
  const pct = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : null;
  const level = limit > 0 && spent >= limit ? 'over' : soft > 0 && spent >= soft ? 'near' : 'ok';
  const period = b?.period ? String(b.period).replace(/_/g, ' ') : null;
  return { spent: money(spent, currency), limit: limit > 0 ? money(limit, currency) : null, pct, level, calls: Number(body?.totals?.eventCount ?? 0),
    text: limit > 0 ? `${money(spent, currency)} of ${money(limit, currency)}${period ? ` this ${period}` : ''}` : `${money(spent, currency)} used · no limit set` };
}
export function homeModel({ sessions = [], approvals = [], usage = null, overview = null } = {}) {
  const running = sessions.filter((s) => s.progress && s.progress.total > 0 && s.progress.done + s.progress.failed < s.progress.total)
    .map((s) => ({ id: s.id, name: s.name, provider: s.provider, total: s.progress.total, done: s.progress.done, failed: s.progress.failed, pct: Math.round((s.progress.done / s.progress.total) * 100), current: s.progress.current }));
  const pending = approvals.filter((a) => !a.decision);
  const c = overview?.counts ?? {};
  return { usage: usage ? usageModel(usage) : null, running, idleSessions: sessions.length - running.length,
    pending: pending.slice(0, 5).map((a) => ({ title: a.summary || humanAction(a.requestKind || 'approval request'), canDecide: !!a.canDecide, item: a })), pendingCount: pending.length,
    stats: [['Projects', c.activeProjects ?? 0], ['Members', c.members ?? 0], ['Sessions', sessions.length]] };
}

// sms: link that opens the phone's Messages app with the invite prefilled.
export function smsInviteHref(url) {
  const body = `Join me on Helmian. Tap to create your account: ${String(url ?? '')}`;
  return `sms:?&body=${encodeURIComponent(body)}`;
}

// Fold back-to-back Guard cards that say the same thing into one, with a count.
export function collapseRepeats(cards = []) {
  const out = [];
  for (const c of cards) {
    const prev = out[out.length - 1];
    if (prev && !c.finding?.fingerprint && !prev.card.finding?.fingerprint && prev.card.severity === c.severity && prev.card.title === c.title && (prev.card.body || '') === (c.body || '')) prev.repeat += 1;
    else out.push({ card: c, repeat: 1 });
  }
  return out;
}

// A workspace id that is a raw UUID is not something to show a person.
export function friendlyWorkspace(id) {
  const s = String(id || '');
  return !s || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) ? 'your workspace' : s;
}
