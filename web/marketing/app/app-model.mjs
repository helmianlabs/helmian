// Pure helpers for the Helmian Cloud app (no DOM) so they can be unit tested.
export const VIEWS = Object.freeze(['console', 'overview', 'settings', 'workspace', 'activity', 'evidence', 'approvals', 'integrations', 'release']);
export const VIEW_TITLES = Object.freeze({ console: 'Console', overview: 'Overview', settings: 'Settings', workspace: 'Workspace', activity: 'Live activity', evidence: 'Evidence', approvals: 'Approvals', integrations: 'Integrations', release: 'Release roadmap' });
export const PROVIDERS = Object.freeze(['Claude', 'ChatGPT', 'Grok', 'Gemini']);
export const PROVIDER_REGISTRY = Object.freeze([
  { key: 'slack', name: 'Slack', kind: 'Team chat' }, { key: 'discord', name: 'Discord', kind: 'Team chat' }, { key: 'github', name: 'GitHub', kind: 'Code' },
  { key: 'anthropic', name: 'Claude', kind: 'AI provider' }, { key: 'openai', name: 'ChatGPT', kind: 'AI provider' }, { key: 'xai', name: 'Grok', kind: 'AI provider' }, { key: 'google', name: 'Gemini', kind: 'AI provider' },
]);

export function viewFromHash(hash = '') { const v = String(hash).replace(/^#\/?/, '').toLowerCase(); return VIEWS.includes(v) ? v : 'console'; }
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

export function approvalsModel(body = {}, role = null) {
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 100).map((i) => ({ ...i, canDecide: Boolean(i.approvalRequired && !i.decision && isAdminRole(role)) }));
  return { items, empty: items.length === 0, pending: items.filter((i) => !i.decision).length };
}

export function formatTime(value, opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) { const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], opts); }
export function clockTime(value) { return formatTime(value, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }

// Console log lines from Envoy messages.
export function logLines(body = {}, subject = null) {
  return (Array.isArray(body.messages) ? body.messages : []).map((m) => ({
    id: m.id, ts: m.createdAt ? clockTime(m.createdAt) : '', text: String(m.body ?? ''),
    mine: Boolean(subject && (m.authorSubject === subject || m.authorId === subject)),
    who: m.authorKind === 'human' ? (m.authorName || (subject && (m.authorSubject === subject || m.authorId === subject) ? 'you' : 'member')) : (m.authorName || m.authorKind || 'agent'),
  }));
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

export function maskSecret(hint = '') { const tail = String(hint).replace(/[^A-Za-z0-9]/g, '').slice(-4); return tail ? `••••••••${tail}` : '••••••••'; }

export function integrationsModel(connectors = {}, providers = {}) {
  const status = connectors.verifierStatus ?? {};
  const connected = new Set([...(connectors.registrations ?? []).map((r) => String(r.provider ?? r.connectorKind ?? '').toLowerCase()), ...(providers.connections ?? []).map((c) => String(c.provider ?? c.providerKey ?? '').toLowerCase())]);
  return PROVIDER_REGISTRY.map((p) => ({ ...p, connected: connected.has(p.key) || status[p.key]?.configured === true }));
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
  return (Array.isArray(body.sessions) ? body.sessions : []).map((s) => ({ id: String(s.id), name: String(s.name), provider: String(s.provider), createdAt: s.createdAt ?? null }));
}
