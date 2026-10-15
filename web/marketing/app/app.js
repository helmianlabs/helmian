import { VIEW_TITLES, viewFromHash, isAdminRole, sessionModel, projectsModel, filterProjects, projectKeyFromName, approvalsModel, logLines, feedModel, humanAction, formatTime, maskSecret, integrationsModel, metricsModel, postureModel, addSession } from './app-model.mjs';

const $ = (s) => document.querySelector(s);
const shell = $('#shell');
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(`helmian.app.${k}`)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(`helmian.app.${k}`, JSON.stringify(v)); } catch {} } };
const state = { actor: null, projects: [], channelId: null, sessions: store.get('sessions', []), activeSession: store.get('activeSession', null), events: [], approvals: [], ack: new Set(store.get('ack', [])), cleared: new Set(store.get('cleared', [])), pendingProvider: null };
const narrow = () => window.matchMedia('(max-width: 900px)').matches;

async function api(path, init = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.code || body.error || `HTTP ${res.status}`), { status: res.status, body });
  return body;
}
const post = (path, data) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function empty(title, sub) { const d = el('div', 'empty'); d.append(el('p', 't', title)); if (sub) d.append(el('p', 'sm', sub)); return d; }
function row(k, v, cls) { const r = el('div', 'row'); r.append(el('span', null, k), el('span', cls, v)); return r; }
let toastTimer; function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600); }

// ---- appearance ----
function applyTheme(theme) { document.documentElement.dataset.theme = theme; $('#theme').value = theme; $('#theme-quick').value = theme; store.set('theme', theme); }
function applyScale(pct) { document.documentElement.style.setProperty('--scale', String(pct / 100)); $('#text-size').value = String(pct); store.set('scale', pct); }
$('#theme').onchange = (e) => applyTheme(e.target.value); $('#theme-quick').onchange = (e) => applyTheme(e.target.value);
$('#text-size').oninput = (e) => applyScale(Number(e.target.value));
applyTheme(store.get('theme', 'midnight')); applyScale(store.get('scale', 100));

// ---- drawers (mobile) ----
function drawer(which, open) {
  shell.classList.toggle(`${which}-open`, open);
  $(which === 'sidebar' ? '#sidebar-toggle' : '#guard-toggle').setAttribute('aria-expanded', String(open));
  $('#scrim').hidden = !(shell.classList.contains('sidebar-open') || shell.classList.contains('guard-open'));
}
$('#sidebar-toggle').onclick = () => drawer('sidebar', true); $('#sidebar-close').onclick = () => drawer('sidebar', false);
$('#guard-toggle').onclick = () => drawer('guard', true); $('#guard-close').onclick = () => drawer('guard', false);
$('#scrim').onclick = () => { drawer('sidebar', false); drawer('guard', false); };
$('#fullscreen').onclick = () => { shell.classList.toggle('full'); $('#fullscreen').textContent = shell.classList.contains('full') ? 'Exit full screen' : 'Full screen'; };
$('#mcp-toggle').onclick = () => { const p = $('#mcp-panel'); p.hidden = !p.hidden; $('#mcp-toggle').setAttribute('aria-expanded', String(!p.hidden)); if (!p.hidden) show('console'); };
$('#mcp-find-btn').onclick = () => { $('#mcp-result').textContent = $('#mcp-find').value.trim() ? `No matches for “${$('#mcp-find').value.trim()}” — no audit has been run yet.` : 'No audit yet. Run one from the desktop app to see results here.'; };

// ---- views ----
function show(view) {
  if (!state.actor) return;
  shell.dataset.view = view;
  for (const p of document.querySelectorAll('[data-view-panel]')) p.hidden = p.dataset.viewPanel !== view;
  for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('active', b.dataset.view === view);
  $('#view-title').textContent = VIEW_TITLES[view];
  if (narrow()) drawer('sidebar', false);
  loaders[view]?.().catch(() => {});
}
for (const b of document.querySelectorAll('.nav-item')) b.onclick = () => { if (location.hash !== `#${b.dataset.view}`) location.hash = b.dataset.view; else show(b.dataset.view); };
window.addEventListener('hashchange', () => show(viewFromHash(location.hash)));

// ---- projects (sidebar + workspace) ----
async function loadProjects() {
  try { const m = projectsModel(await api('/api/admin/workspace/projects')); state.projects = m.projects; $('#new-project').hidden = !m.canManage; }
  catch { state.projects = []; }
  renderShelf(); renderWorkspace();
}
function renderShelf() {
  const list = filterProjects(state.projects, $('#project-filter').value);
  $('#project-shelf').replaceChildren(...list.map((p) => { const li = el('li', null, p.name); li.title = p.key; li.onclick = () => { location.hash = 'workspace'; }; return li; }));
  $('#project-shelf-empty').hidden = list.length > 0;
}
function renderWorkspace() {
  const box = $('#workspace-cards');
  if (!state.projects.length) { box.replaceChildren(empty('No projects yet.', 'Use “+ New” in the sidebar to add one.')); return; }
  box.replaceChildren(...state.projects.map((p) => { const c = el('article', 'card'); const st = el('span', `status ${p.lifecycle === 'active' ? 'ok' : ''}`, p.lifecycle); c.append(el('div', 'title', p.name), el('div', 'meta', `${p.key} · ${p.branch}`), el('div', 'meta')); c.lastChild.append(st); return c; }));
}
$('#project-filter').oninput = renderShelf;
$('#new-project').onclick = () => { $('#new-project-form').hidden = false; $('#new-project-name').focus(); };
$('#new-project-cancel').onclick = () => { $('#new-project-form').hidden = true; };
$('#new-project-form').onsubmit = async (e) => {
  e.preventDefault(); const name = $('#new-project-name').value.trim(); if (!name) return;
  try { await post('/api/admin/workspace/projects', { projectKey: projectKeyFromName(name), displayName: name, sourceKind: 'git', defaultBranch: 'main', lifecycle: 'active' }); $('#new-project-form').reset(); $('#new-project-form').hidden = true; toast('Project created'); await loadProjects(); }
  catch { toast('Could not create that project — try a different name'); }
};

// ---- sessions (local) ----
function renderSessions() {
  const ul = $('#sessions');
  if (!state.sessions.length) { ul.replaceChildren(el('li', 'faint sm', 'No sessions yet')); ul.firstChild.style.cursor = 'default'; }
  else ul.replaceChildren(...state.sessions.map((s) => { const li = el('li', s.id === state.activeSession ? 'active' : null); li.append(el('span', 'dot'), el('span', null, s.name), el('span', 'prov', s.provider)); li.onclick = () => { state.activeSession = s.id; store.set('activeSession', s.id); renderSessions(); location.hash = 'console'; }; return li; }));
  const active = state.sessions.find((s) => s.id === state.activeSession);
  $('#session-label').textContent = active ? `CONSOLE · ${active.name.toUpperCase()} · ${active.provider.toUpperCase()}` : 'CONSOLE';
  $('#active-agent').textContent = active ? `${active.provider} · ${active.name}` : 'No active agent';
}
for (const chip of document.querySelectorAll('#session-chips .chip')) chip.onclick = () => {
  state.pendingProvider = chip.dataset.provider;
  document.querySelectorAll('#session-chips .chip').forEach((c) => c.classList.toggle('active', c === chip));
  $('#session-form').hidden = false; $('#session-name').value = `${chip.dataset.provider} session`; $('#session-name').select();
};
$('#session-cancel').onclick = () => { $('#session-form').hidden = true; document.querySelectorAll('#session-chips .chip').forEach((c) => c.classList.remove('active')); };
$('#session-form').onsubmit = (e) => {
  e.preventDefault();
  state.sessions = addSession(state.sessions, { name: $('#session-name').value, provider: state.pendingProvider });
  state.activeSession = state.sessions[0]?.id ?? null; store.set('sessions', state.sessions); store.set('activeSession', state.activeSession);
  $('#session-cancel').onclick(); renderSessions(); toast('Session started');
};
for (const t of document.querySelectorAll('.tool')) t.onclick = () => toast(t.dataset.tool === 'tools' ? 'Tools and connectors open from Integrations' : `${t.textContent} is available in the desktop app`);
$('#run-suite').onclick = () => toast('Tool suite runs from the desktop app');

// ---- console (Envoy) ----
async function loadConsole() {
  if (!state.channelId) {
    try { const body = await api('/api/admin/envoy/channels'); const chans = Array.isArray(body.channels) ? body.channels : []; const sel = $('#channel'); sel.replaceChildren(...chans.map((c) => { const o = el('option', null, c.name || c.displayName || c.channelKey || 'Channel'); o.value = c.id ?? c.channelId; return o; })); sel.hidden = chans.length < 2; state.channelId = chans[0] ? (chans[0].id ?? chans[0].channelId) : null; } catch {}
  }
  await loadLog();
}
async function loadLog() {
  const log = $('#log');
  const sys = (t) => { const d = el('div', 'line sys'); d.append(el('span', 'ts', `[${new Date().toTimeString().slice(0, 8)}] `), document.createTextNode(t)); return d; };
  if (!state.channelId) { log.replaceChildren(sys('helmian cloud console ready'), sys(`signed in · ${state.actor.tenantId}`), sys('no team channel yet — messages will stream here once one is set up')); return; }
  try {
    const lines = logLines(await api(`/api/admin/envoy/messages?channel_id=${encodeURIComponent(state.channelId)}`), state.actor?.subject);
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    if (!lines.length) { log.replaceChildren(sys('channel connected · say hello below')); return; }
    log.replaceChildren(...lines.map((l) => { const d = el('div', 'line'); d.append(el('span', 'ts', l.ts ? `[${l.ts}] ` : ''), el('span', l.mine ? 'me' : 'who', `${l.who}> `), document.createTextNode(l.text)); return d; }));
    if (atBottom) log.scrollTop = log.scrollHeight;
  } catch { log.replaceChildren(sys('console is reconnecting…')); }
}
$('#channel').onchange = (e) => { state.channelId = e.target.value; loadLog(); };
const prompt = $('#prompt');
prompt.oninput = () => { prompt.style.height = 'auto'; prompt.style.height = `${Math.min(prompt.scrollHeight, 200)}px`; };
prompt.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !narrow()) { e.preventDefault(); $('#composer').requestSubmit(); } };
$('#composer').onsubmit = async (e) => {
  e.preventDefault(); const body = prompt.value.trim(); if (!body) return;
  if (!state.channelId) { toast('No team channel yet — ask the owner to set one up'); return; }
  $('#send').disabled = true;
  try { await post('/api/admin/envoy/messages', { channelId: state.channelId, body, idempotencyKey: crypto.randomUUID() }); prompt.value = ''; prompt.oninput(); await loadLog(); $('#log').scrollTop = 1e9; }
  catch { toast('Not sent — your message is still in the box'); }
  finally { $('#send').disabled = false; }
};

// ---- guard feed ----
async function loadFeedData() {
  const [ev, ap] = await Promise.allSettled([api('/api/admin/events'), api('/api/admin/cora/approvals')]);
  if (ev.status === 'fulfilled') state.events = Array.isArray(ev.value.events) ? ev.value.events : [];
  if (ap.status === 'fulfilled') state.approvals = approvalsModel(ap.value, state.actor?.role).items;
  const pending = state.approvals.filter((a) => !a.decision).length;
  $('#approvals-badge').hidden = pending === 0; $('#approvals-badge').textContent = String(pending);
  renderFeed();
}
async function decide(item, decision) {
  try { await post('/api/admin/cora/approvals', { decision, requestKind: item.requestKind, requestReceiptId: item.requestReceiptId, reason: `${decision === 'approve' ? 'Approved' : 'Rejected'} in Helmian app`, idempotencyKey: crypto.randomUUID() }); toast(decision === 'approve' ? 'Approved' : 'Rejected'); }
  catch { toast('Decision not saved — try again'); }
  await loadFeedData(); if (shell.dataset.view === 'approvals') renderApprovals();
}
function renderFeed() {
  const cards = feedModel({ events: state.events, approvals: state.approvals }, { filter: $('#feed-filter').value, showInfo: $('#opt-info').checked, showApprovals: $('#opt-approvals').checked, acknowledged: state.ack, cleared: state.cleared });
  const critical = cards.filter((c) => c.severity === 'critical').length;
  $('#guard-count').hidden = critical === 0; $('#guard-count').textContent = String(critical);
  const feed = $('#feed');
  if (!cards.length) { feed.replaceChildren(empty('All clear', 'Alerts from your agents show up here.')); return; }
  feed.replaceChildren(...cards.slice(0, 60).map((c) => {
    const a = el('article', `alert ${c.severity}${c.ack ? ' ack' : ''}`);
    const h = el('div', 'h'); h.append(el('span', null, c.title), el('span', 't', c.at ? formatTime(c.at) : '')); a.append(h);
    if (c.body) a.append(el('div', 'b', c.body));
    const actions = el('div', 'actions');
    if (c.severity === 'critical' && c.approval?.canDecide) {
      const ok = el('button', 'btn primary sm', 'Approve'); const no = el('button', 'btn ghost sm', 'Reject');
      ok.onclick = () => decide(c.approval, 'approve');
      no.onclick = () => { if (a.querySelector('.confirm')) return; const cf = el('div', 'confirm'); cf.append(el('div', null, 'Reject this request?')); const r = el('div', 'actions'); const y = el('button', 'btn danger sm', 'Yes, reject'); const n = el('button', 'btn ghost sm', 'Cancel'); y.onclick = () => decide(c.approval, 'reject'); n.onclick = () => cf.remove(); r.append(y, n); cf.append(r); a.append(cf); };
      actions.append(ok, no);
    }
    if (!c.ack && c.severity !== 'info') { const ack = el('button', 'btn ghost sm', 'Acknowledge'); ack.onclick = () => { state.ack.add(c.id); store.set('ack', [...state.ack]); renderFeed(); }; actions.append(ack); }
    if (actions.childElementCount) a.append(actions);
    return a;
  }));
}
$('#feed-filter').onchange = renderFeed; $('#opt-info').onchange = renderFeed; $('#opt-approvals').onchange = renderFeed;
$('#feed-clear').onclick = () => { for (const id of state.ack) state.cleared.add(id); for (const e of state.events) state.cleared.add(`evt:${e.id}`); store.set('cleared', [...state.cleared]); renderFeed(); };

// ---- other tabs ----
async function loadOverview() {
  try { const body = await api('/api/admin/overview'); $('#metrics').replaceChildren(...metricsModel(body).map(([k, v]) => { const c = el('div', 'card'); c.append(el('div', 'eyebrow', k.toUpperCase()), el('div', 'big', String(v))); return c; })); $('#posture').replaceChildren(...postureModel(body).map(([k, v]) => row(k, v))); }
  catch { $('#metrics').replaceChildren(empty('Overview is loading slowly', 'Try again in a moment.')); }
}
function renderApprovals() {
  const box = $('#approvals');
  if (!state.approvals.length) { box.replaceChildren(empty("You're all caught up.", 'Nothing is waiting for a decision.')); return; }
  box.replaceChildren(...state.approvals.map((i) => {
    const c = el('article', 'card'); c.append(el('div', 'title', i.summary || humanAction(i.requestKind)), el('div', 'meta', i.decision ? `Decided: ${i.decision}` : 'Waiting for a decision'));
    if (i.canDecide) {
      const prev = el('div', 'preview'); prev.hidden = true;
      const r = el('div', 'actions');
      for (const d of ['approve', 'reject']) { const b = el('button', d === 'approve' ? 'btn primary sm' : 'btn ghost sm', d === 'approve' ? 'Approve' : 'Reject'); b.onclick = () => { prev.hidden = false; prev.replaceChildren(el('div', null, `You are about to ${d} “${i.summary || humanAction(i.requestKind)}”. This is recorded with your name.`)); const go = el('div', 'actions'); const y = el('button', d === 'approve' ? 'btn primary sm' : 'btn danger sm', `Confirm ${d}`); const n = el('button', 'btn ghost sm', 'Cancel'); y.onclick = () => decide(i, d); n.onclick = () => { prev.hidden = true; }; go.append(y, n); prev.append(go); }; r.append(b); }
      c.append(r, prev);
    }
    return c;
  }));
}
async function loadApprovals() { await loadFeedData(); renderApprovals(); }
async function loadActivity() {
  await loadFeedData();
  const box = $('#timeline');
  if (!state.events.length) { box.replaceChildren(empty('No activity yet.', 'Actions from your team and agents will stream here.')); return; }
  box.replaceChildren(...state.events.slice(0, 50).map((e) => { const r = el('div', 'tl'); const w = el('div', 'what'); w.append(el('div', null, humanAction(e.actionType)), el('div', 'meta', [e.summary, e.actorRole].filter(Boolean).join(' · '))); r.append(el('div', 'when', formatTime(e.createdAt)), el('div', 'rail'), w); return r; }));
}
async function loadEvidence() {
  await loadFeedData();
  const tb = $('#evidence');
  if (!state.events.length) { const tr = el('tr'); const td = el('td', 'muted', 'No evidence recorded yet.'); td.colSpan = 4; tr.append(td); tb.replaceChildren(tr); return; }
  tb.replaceChildren(...state.events.slice(0, 100).map((e) => { const tr = el('tr'); const st = el('span', `status ${String(e.status).toUpperCase() === 'ALLOW' ? 'ok' : 'warn'}`, String(e.status ?? '').toLowerCase()); const td = el('td'); td.append(st); tr.append(el('td', 'muted', formatTime(e.createdAt)), el('td', null, humanAction(e.actionType)), el('td', 'muted', e.actorRole || ''), td); return tr; }));
}
async function loadIntegrations() {
  const [c, p] = await Promise.allSettled([api('/api/admin/cora/connectors'), api('/api/admin/provider-connections')]);
  const list = integrationsModel(c.value ?? {}, p.value ?? {});
  $('#integrations').replaceChildren(...list.map((i) => { const card = el('article', 'card'); card.append(el('div', 'title', i.name), el('div', 'meta', i.kind), el('div', 'meta')); card.lastChild.append(el('span', `status ${i.connected ? 'ok' : ''}`, i.connected ? 'Connected' : 'Not connected')); return card; }));
  return p.value;
}
async function loadSettings() {
  const prov = await api('/api/admin/provider-connections').catch(() => ({}));
  const conns = Array.isArray(prov.connections) ? prov.connections : [];
  $('#api-keys').replaceChildren(...(conns.length ? conns.map((c) => row(c.displayName || c.provider || 'Provider', maskSecret(c.secretHint || c.keyHint), 'mask')) : [el('p', 'muted sm', 'No API keys saved yet.')]));
  $('#pilot').replaceChildren(row('Account', state.actor.subject), row('Organization', state.actor.tenantId), row('Role', state.actor.role));
  $('#build').replaceChildren(row('App', 'Helmian Cloud'), row('Surface', 'Web · /app'), row('Theme', document.documentElement.dataset.theme));
}
async function loadRelease() {
  const tb = $('#releases');
  try {
    const body = await api('/api/admin/release'); const rel = Array.isArray(body.releases) ? body.releases : [];
    if (!rel.length) { const tr = el('tr'); const td = el('td', 'muted', 'No releases published yet.'); td.colSpan = 4; tr.append(td); tb.replaceChildren(tr); return; }
    tb.replaceChildren(...rel.map((r) => { const tr = el('tr'); tr.append(el('td', null, r.version || r.tag || ''), el('td', 'muted', r.channel || ''), el('td', null, r.status || ''), el('td', 'muted', formatTime(r.publishedAt || r.createdAt))); return tr; }));
  } catch { const tr = el('tr'); const td = el('td', 'muted', 'No releases published yet.'); td.colSpan = 4; tr.append(td); tb.replaceChildren(tr); }
}
const loaders = { console: loadConsole, overview: loadOverview, workspace: loadProjects, settings: loadSettings, activity: loadActivity, evidence: loadEvidence, approvals: loadApprovals, integrations: loadIntegrations, release: loadRelease };

// ---- boot ----
async function boot() {
  let model;
  try { const res = await fetch('/api/admin/session', { credentials: 'same-origin' }); model = sessionModel(res.status, await res.json().catch(() => ({}))); }
  catch { model = sessionModel(0); }
  if (!model.member) {
    shell.classList.add('signed-out'); $('#signed-out').hidden = false; $('#view-title').textContent = 'Helmian';
    if (model.signedIn) { const n = $('#membership-note'); n.hidden = false; n.textContent = 'You are signed in, but this account has not been added to an Organization yet. Ask the owner to invite you.'; }
    return;
  }
  state.actor = model.actor;
  $('#svc-dot').classList.add('live'); $('#svc-text').textContent = 'Cloud service · Connected - live';
  $('#account').textContent = `${model.actor.tenantId} · ${model.actor.role}`;
  $('#admin-link').hidden = !isAdminRole(model.actor.role); $('#signout').hidden = false;
  renderSessions();
  show(viewFromHash(location.hash));
  loadProjects(); loadFeedData();
  setInterval(() => { if (document.visibilityState !== 'visible' || !$('#opt-auto').checked) return; loadFeedData(); if (shell.dataset.view === 'console') loadLog(); }, 6000);
}
boot();
