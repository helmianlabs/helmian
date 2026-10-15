// Pure helpers for the Helmian Cloud app shell (no DOM) so they can be unit tested.
export const VIEWS = Object.freeze(['console', 'overview', 'projects', 'approvals', 'activity', 'connect', 'agents', 'settings']);
export const VIEW_TITLES = Object.freeze({ console: 'Team workspace', overview: 'Overview', projects: 'Workspace', approvals: 'Approvals', activity: 'Review & History', connect: 'Connect', agents: 'Agents', settings: 'Settings' });

export function viewFromHash(hash = '') {
  const v = String(hash).replace(/^#\/?/, '').toLowerCase();
  return VIEWS.includes(v) ? v : 'console';
}

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
  return { projects, empty: projects.length === 0 };
}

export function filterProjects(projects, query = '') {
  const q = String(query).trim().toLowerCase();
  return q ? projects.filter((p) => p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q)) : projects;
}

export function approvalsModel(body = {}, role = null) {
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 100).map((i) => ({
    ...i, canDecide: Boolean(i.approvalRequired && !i.decision && isAdminRole(role)),
  }));
  return { items, empty: items.length === 0, pending: items.filter((i) => !i.decision).length };
}

export function messagesModel(body = {}, subject = null) {
  const messages = (Array.isArray(body.messages) ? body.messages : []).map((m) => ({
    id: m.id, body: String(m.body ?? ''), mine: Boolean(subject && (m.authorSubject === subject || m.authorId === subject)),
    who: m.authorKind === 'human' ? (m.authorName || 'Member') : (m.authorName || m.authorKind || 'Agent'),
    at: m.createdAt ? formatTime(m.createdAt) : '',
  }));
  return { messages, empty: messages.length === 0 };
}

export function formatTime(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function metricsModel(body = {}) {
  const c = body.counts ?? {};
  return [['Active projects', c.activeProjects ?? 0], ['Members', c.members ?? 0], ['Agent tasks', c.agentTasks ?? 0], ['AI providers', c.verifiedProviders ?? 0]];
}

export function postureModel(body = {}) {
  const s = body.settings ?? {};
  return [['Sign-in', s.signIn ? 'On' : 'Off'], ['Cloud database', s.database ? 'Connected' : 'Offline'], ['AI provider', s.coraProvider ? String(s.coraProvider) : 'Not set'], ['Console worker', s.consoleWorker ? 'Running' : 'Idle']];
}
