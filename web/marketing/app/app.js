import { VIEW_TITLES, viewTitles, isPlainEmojiMode, ADVANCED_VIEWS, PANEL_VIEWS, PANEL_TABS, viewFromHash, isAdminRole, sessionModel, projectsModel, filterProjects, projectKeyFromName, approvalsModel, logLines, BRIDGE_DISPLAY_NAME, feedModel, feedAckClearIds, humanAction, formatTime, maskSecret, integrationsModel, agentsModel, createModel, createIntentPayload, metricsModel, postureModel, addSession, plainEvent, sessionsFromServer, PROVIDERS, progressModel, planFromText, homeModel, smsInviteHref, desktopsModel, forgetDesktopPayload, collapseRepeats, workspaceName, friendlyWorkspace, profileSyncResultModel } from './app-model.mjs';
import { addAttachment, attachmentKey, buildMessageRequest, pickerModel, removeAttachment } from './composer-picker.mjs';
import { accountIdentityModel, downloadsModel, reportIssueHref, SHORTCUTS } from './account-menu.mjs';
import { LIBRARY_FACES, libraryFaceToken, libraryFaceStillUrl } from './face-library.mjs';
const KOKORO_URL = 'https://esm.sh/kokoro-js@1.2.1';

const $ = (s) => document.querySelector(s);
const shell = $('#shell');
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(`helmian.app.${k}`)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(`helmian.app.${k}`, JSON.stringify(v)); } catch {} } };
const state = { serverSessions: false, actor: null, projects: [], channelId: null, envoyChannelId: null, sessions: store.get('sessions', []), activeSession: store.get('activeSession', null), events: [], approvals: [], ack: new Set(store.get('ack', [])), cleared: new Set(store.get('cleared', [])), pendingProvider: null, steps: null, usage: null, overview: null, emojiMode: store.get('emojiMode', 'playful'), agentIcons: {} };
const narrow = () => window.matchMedia('(max-width: 900px)').matches;
// es(): empty-state string picker — playful emoji vs plain text. Sober
// surfaces (Guard, audit, approvals, evidence) never go through here.
const es = (playful, plain) => isPlainEmojiMode(state.emojiMode) ? plain : playful;

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
let toastTimer; function toast(msg, kind) { const t = $('#toast'); const prefix = kind === 'ok' && !isPlainEmojiMode(state.emojiMode) ? '✅ ' : ''; t.textContent = prefix + msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600); }

// ---- emoji mode preference (playful vs plain) ----
function stripLeadingEmoji(label) {
  const m = String(label ?? '').match(/^(\S+)\s+(.+)$/u);
  return (m && !/[A-Za-z0-9]/.test(m[1])) ? m[2] : String(label ?? '');
}
function setNavLabel(btn, label) {
  for (const node of [...btn.childNodes]) if (node.nodeType === 3) node.remove();
  const span = btn.querySelector('.label');
  const clean = stripLeadingEmoji(label);
  if (!span) { btn.prepend(document.createTextNode(clean)); return; }
  span.textContent = clean;
  if (!btn.querySelector('.nav-svg')) {
    const m = String(label).match(/^(\S+)\s+(.+)$/u);
    const icon = m && !/[A-Za-z0-9]/.test(m[1]) ? m[1] : '';
    if (icon) btn.prepend(document.createTextNode(`${icon} `));
  }
  btn.dataset.tip = span.textContent; btn.setAttribute('aria-label', span.textContent);
}
function applyEmojiMode(mode) {
  state.emojiMode = mode === 'plain' ? 'plain' : 'playful';
  store.set('emojiMode', state.emojiMode);
  const titles = viewTitles(state.emojiMode);
  for (const b of document.querySelectorAll('.nav-item[data-view]')) {
    const label = titles[b.dataset.view];
    if (label) setNavLabel(b, label);
  }
  for (const b of document.querySelectorAll('.panel-tab[data-panel-tab]')) {
    const label = titles[b.dataset.panelTab];
    if (label) b.textContent = label;
  }
  const shelfEmpty = $('#project-shelf-empty');
  if (shelfEmpty) shelfEmpty.textContent = es('No projects yet.', 'No projects yet.');
  renderAgentIcons();
  const current = document.querySelector('.nav-item.active')?.dataset.view;
  if (current) $('#view-title').textContent = stripLeadingEmoji(titles[current] ?? '');
  syncWorkspaceViewTitle();
  const sel = $('#emoji-mode');
  if (sel) sel.value = state.emojiMode;
}
async function loadEmojiMode() {
  try {
    const body = await api('/api/admin/workspace/layout-preferences');
    const mode = body?.layout?.emojiMode;
    applyEmojiMode(mode === 'plain' ? 'plain' : 'playful');
  } catch { applyEmojiMode(store.get('emojiMode', 'playful')); }
}
async function saveEmojiMode(mode) {
  try {
    const body = await api('/api/admin/workspace/layout-preferences');
    const layout = body?.layout ?? {};
    await api('/api/admin/workspace/layout-preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visibleShelves: layout.visibleShelves, panelOrder: layout.panelOrder, density: layout.density, emojiMode: mode, defaultEnvoyChannelId: layout.defaultEnvoyChannelId ?? null }) });
    applyEmojiMode(mode);
    toast('Emoji style saved', 'ok');
  } catch { toast('Could not save emoji style'); applyEmojiMode(store.get('emojiMode', 'playful')); }
}
$('#emoji-mode').onchange = (e) => saveEmojiMode(e.target.value);

// ---- custom agent icons (per-user emoji per provider) ----
const AGENT_ICON_PROVIDERS = Object.freeze(['Maestro', 'Claude', 'ChatGPT', 'Grok', 'Gemini']);
const graphemeCount = (text) => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(String(text ?? ''))].length;
function agentIconFor(provider) { return state.agentIcons?.[provider] ?? null; }
function renderAgentIcons() {
  for (const chip of document.querySelectorAll('#session-chips .chip[data-provider]')) {
    const provider = chip.dataset.provider;
    const icon = agentIconFor(provider);
    chip.textContent = icon ? `${icon} ${provider}` : provider;
  }
  renderIconPicker();
}
async function loadAgentIcons() {
  try {
    const body = await api('/api/admin/workspace/agent-icons');
    state.agentIcons = body?.icons ?? {};
  } catch { state.agentIcons = {}; }
  renderAgentIcons();
}
async function saveAgentIcon(provider, iconText) {
  const input = $(`#icon-input-${provider.toLowerCase()}`);
  const status = $('#agent-icons-status');
  const value = (iconText ?? '').trim();
  if (value && graphemeCount(value) !== 1) { status.textContent = 'Use exactly one emoji.'; return; }
  try {
    await api('/api/admin/workspace/agent-icons', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerName: provider, iconEmoji: value || null }) });
    state.agentIcons[provider] = value || null;
    renderAgentIcons();
    status.textContent = value ? `Icon saved for ${provider}.` : `Icon cleared for ${provider}.`;
    toast(value ? 'Agent icon saved' : 'Agent icon cleared', 'ok');
  } catch (error) { status.textContent = error.body?.message || error.message || 'Could not save the icon.'; }
}
function renderIconPicker() {
  const wrap = $('#agent-icons-picker');
  if (!wrap) return;
  wrap.replaceChildren(...AGENT_ICON_PROVIDERS.map((provider) => {
    const row = el('div', 'icon-row');
    const current = agentIconFor(provider);
    row.append(el('span', 'icon-current', current ?? '—'), el('span', null, provider));
    const input = el('input', 'icon-input');
    input.id = `icon-input-${provider.toLowerCase()}`;
    input.maxLength = 16;
    input.placeholder = 'Emoji';
    input.setAttribute('aria-label', `Icon for ${provider}`);
    input.autocomplete = 'off';
    const hint = el('span', 'muted sm', '');
    input.oninput = () => { hint.textContent = input.value && graphemeCount(input.value) !== 1 ? 'One emoji only' : ''; };
    const save = el('button', 'btn sm');
    save.type = 'button';
    save.textContent = 'Save';
    save.onclick = () => saveAgentIcon(provider, input.value);
    row.append(input, hint, save);
    return row;
  }));
}

// ---- appearance ----
const themeMq = window.matchMedia('(prefers-color-scheme: light)');
function resolveTheme(theme) { return theme === 'system' ? (themeMq.matches ? 'light' : 'midnight') : theme; }
function applyTheme(theme) { const resolved = resolveTheme(theme); document.documentElement.dataset.theme = resolved; const tc = document.querySelector('meta[name="theme-color"]'); if (tc) tc.content = resolved === 'light' ? '#F4F6F8' : '#0B1120'; $('#theme').value = theme; $('#theme-quick').value = theme; store.set('theme', theme); }
themeMq.addEventListener('change', () => { if (store.get('theme', 'midnight') === 'system') applyTheme('system'); });
function applyScale(pct) { document.documentElement.style.setProperty('--scale', String(pct / 100)); $('#text-size').value = String(pct); store.set('scale', pct); }
$('#theme').onchange = (e) => applyTheme(e.target.value); $('#theme-quick').onchange = (e) => applyTheme(e.target.value);
$('#text-size').oninput = (e) => applyScale(Number(e.target.value));
applyTheme(store.get('theme', 'midnight')); applyScale(store.get('scale', 100));

// ---- collapsibles: state shown, state remembered ----
// SHOW DETAILS summaries wear a chevron (CSS) and swap their label with
// state; ADVANCED and APPEARANCE restore the state they were left in and
// remember manual toggles (persisted via the app settings store).
function wireCollapsibles() {
  const swapLabel = (d) => {
    const label = d.querySelector('summary .sd-label');
    if (label) label.textContent = d.open ? 'HIDE DETAILS' : 'SHOW DETAILS';
  };
  for (const d of document.querySelectorAll('details.show-details')) {
    swapLabel(d);
    d.addEventListener('toggle', () => swapLabel(d));
  }
  const adv = $('#advanced-nav');
  if (adv) {
    adv.open = store.get('advancedOpen', false);
    // A summary click is a manual toggle; the toggle event that follows it
    // is what marks ADVANCED as hand-set (programmatic opens do not).
    let advClicked = false;
    adv.querySelector('summary')?.addEventListener('click', () => { advClicked = true; });
    adv.addEventListener('toggle', () => {
      store.set('advancedOpen', adv.open);
      if (advClicked) { store.set('advancedManual', true); advClicked = false; }
    });
  }
  const appearance = $('#appearance');
  if (appearance) {
    appearance.open = store.get('appearanceOpen', false);
    appearance.addEventListener('toggle', () => store.set('appearanceOpen', appearance.open));
  }
}
wireCollapsibles();

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

// ---- independent collapsible panels: Guard + Workbench (desktop EXE parity) ----
function setPanelCollapsed(which, collapsed) {
  const panel = which === 'guard' ? $('#guard-panel') : $('#workbench');
  const btn = which === 'guard' ? $('#guard-collapse') : $('#workbench-collapse');
  if (!panel || !btn) return;
  panel.classList.toggle('collapsed', collapsed);
  const label = which === 'guard' ? 'Guard' : 'workbench';
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${label} panel`);
  btn.textContent = which === 'guard' ? (collapsed ? 'Show' : 'Hide') : (collapsed ? '+' : '–');
  btn.title = `${collapsed ? 'Show' : 'Hide'} ${label}`;
  store.set(which === 'guard' ? 'guardCollapsed' : 'workbenchCollapsed', collapsed);
}
$('#guard-collapse').onclick = () => setPanelCollapsed('guard', !$('#guard-panel').classList.contains('collapsed'));
$('#workbench-collapse').onclick = () => setPanelCollapsed('workbench', !$('#workbench').classList.contains('collapsed'));
setPanelCollapsed('guard', store.get('guardCollapsed', false));
setPanelCollapsed('workbench', store.get('workbenchCollapsed', false));

// #guard deep links open the Guard panel itself (it is a panel, not a tab).
function hashIsGuard() { return String(location.hash).replace(/^#\/?/, '').toLowerCase() === 'guard'; }
function openGuardPanel() { setPanelCollapsed('guard', false); if (narrow()) drawer('guard', true); }
$('#mcp-find-btn').onclick = () => { $('#mcp-result').textContent = $('#mcp-find').value.trim() ? `No matches for “${$('#mcp-find').value.trim()}” — no audit has been run yet.` : 'No audit yet. Run one from the desktop app to see results here.'; };

// Guard pane (Workspace): approvals waiting for a decision, newest first.
function renderGuardApprovals() {
  const list = document.getElementById('ew-approvals-list'); if (!list) return;
  const pending = (state.approvals ?? []).filter((i) => !i.decision);
  const count = document.getElementById('ew-approvals-count'); if (count) count.textContent = pending.length ? String(pending.length) : '';
  const badge = document.getElementById('ew-guard-count');
  const crit = (state.findings ?? []).filter((f) => f.severity === 'critical' && !f.acked).length;
  if (badge) { const n = pending.length + crit; badge.hidden = n === 0; badge.textContent = String(n); }
  if (!pending.length) { list.replaceChildren(el('p', 'ew-note', 'Nothing waiting for a decision.')); return; }
  list.replaceChildren(...pending.slice(0, 4).map((i) => {
    const a = el('a', 'ew-approval'); a.href = '#approvals';
    a.append(el('span', 'ew-approval-title', i.summary || humanAction(i.requestKind) || 'Approval needed'), el('span', 'ew-approval-time', formatTime(i.createdAt)));
    return a;
  }));
}

// ---- views ----
function show(view) {
  if (!state.actor) return;
  if (PANEL_VIEWS.includes(view)) {
    // Browser, Canvas, Preview, Create live in the right workbench panel now
    // (BROWSE-001); keep chat visible and select the tab instead.
    // Browser, Canvas, Preview, Create are Workbench tabs in the Workspace.
    state.pendingBenchTab = view;
    view = 'desktop';
  }
  shell.dataset.view = view;
  // Chats is the general-list face of the session console: the same panel
  // and loaders under its own nav item, title and hash.
  const panelView = view === 'chats' ? 'console' : view;
  for (const p of document.querySelectorAll('[data-view-panel]')) p.hidden = p.dataset.viewPanel !== panelView && !p.closest('#chat-panel');
  for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('active', b.dataset.view === view);
  $('#view-title').textContent = stripLeadingEmoji(viewTitles(state.emojiMode)[view]);
  if (view === 'desktop') syncWorkspaceViewTitle();
  // ADVANCED is never forced by navigation: it offers itself once when a
  // view inside it is opened directly, and after that it simply keeps the
  // state it was left in (wireCollapsibles restores + remembers it).
  const adv = $('#advanced-nav');
  if (adv && !adv.open && ADVANCED_VIEWS.includes(view) && !store.get('advancedManual', false)) adv.open = true;
  if (narrow()) drawer('sidebar', false);
  loaders[panelView]?.().catch(() => {});
}

// ---- workbench panel tabs (Browser | Canvas | Preview | Create; Guard is its own panel) ----
function selectPanelTab(name, { openDrawer = false } = {}) {
  const tab = PANEL_TABS.includes(name) ? name : 'browser';
  for (const b of document.querySelectorAll('.panel-tab')) {
    const active = b.dataset.panelTab === tab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  }
  for (const p of document.querySelectorAll('[data-panel-pane]')) p.hidden = p.dataset.panelPane !== tab;
  store.set('panelTab', tab);
  if (narrow() && openDrawer) drawer('guard', true);
  panelLoaders[tab]?.().catch(() => {});
}
for (const b of document.querySelectorAll('.panel-tab')) b.onclick = () => selectPanelTab(b.dataset.panelTab);

// ---- Integrations view tabs (R1: Agents | Connectors | Devices | Chat and code | Account) ----
// Same pattern as the workbench panel tabs above: one pane visible at a
// time, the pick remembered in the store so it survives a reload. The
// four card sections render into #integrations (loadIntegrations tags
// each with data-int-section); the Manage-connectors section is the
// Connectors pane. Sections not yet rendered are simply absent.
const INT_TABS = ['agents', 'connectors', 'devices', 'chat', 'account'];
const INT_TAB_SECTIONS = { agents: 'ai', devices: 'devices', chat: 'chat', account: 'account' };
function selectIntegrationsTab(name) {
  const tab = INT_TABS.includes(name) ? name : 'agents';
  for (const b of document.querySelectorAll('.int-tab')) {
    const active = b.dataset.intTab === tab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  }
  const secId = INT_TAB_SECTIONS[tab];
  for (const s of document.querySelectorAll('#integrations .int-section')) s.hidden = s.dataset.intSection !== secId;
  const cm = document.querySelector('#view-integrations .cm-section');
  if (cm) cm.hidden = tab !== 'connectors';
  store.set('integrationsTab', tab);
}
for (const b of document.querySelectorAll('.int-tab')) b.onclick = () => selectIntegrationsTab(b.dataset.intTab);
selectIntegrationsTab(store.get('integrationsTab', 'agents'));
for (const b of document.querySelectorAll('.nav-item')) b.onclick = () => { if (location.hash !== `#${b.dataset.view}`) location.hash = b.dataset.view; else show(b.dataset.view); };
window.addEventListener('hashchange', () => { if (hashIsGuard()) { openGuardPanel(); return; } show(viewFromHash(location.hash, { phone: narrow() })); });

// ---- projects (sidebar + workspace) ----
async function loadProjects() {
  try { const m = projectsModel(await api('/api/admin/workspace/projects')); state.projects = m.projects; $('#new-project').hidden = !m.canManage; }
  catch { state.projects = []; }
  try { const a = await api('/api/admin/workspace/active-project'); state.activeProjectKey = a.projectKey ?? null; }
  catch { state.activeProjectKey = null; }
  renderShelf(); renderWorkspace();
  const canvasPane = document.querySelector('[data-panel-pane="canvas"]');
  if (canvasPane && !canvasPane.hidden) loadCanvas().catch(() => {});
}
async function setActiveProject(projectKey) {
  try { await post('/api/admin/workspace/active-project', { projectKey }); state.activeProjectKey = projectKey; toast('Active project set', 'ok'); }
  catch { toast('Could not set the active project'); }
  renderShelf(); renderWorkspace();
  const canvasPane = document.querySelector('[data-panel-pane="canvas"]');
  if (canvasPane && !canvasPane.hidden) loadCanvas().catch(() => {});
}
function renderShelf() {
  const list = filterProjects(state.projects, $('#project-filter').value);
  $('#project-shelf').replaceChildren(...list.map((p) => { const li = el('li', p.key === state.activeProjectKey ? 'active' : null, `${p.name}${p.key === state.activeProjectKey ? ' · active' : ''}`); li.title = p.key; li.onclick = () => { setActiveProject(p.key); location.hash = 'workspace'; }; return li; }));
  $('#project-shelf-empty').hidden = list.length > 0;
}
function renderWorkspace() {
  const box = $('#workspace-cards');
  if (!state.projects.length) { box.replaceChildren(empty('No projects yet.', 'Use “+ New” in the sidebar to add one.')); return; }
  box.replaceChildren(...state.projects.map((p) => { const c = el('article', 'card'); const st = el('span', `status ${p.lifecycle === 'active' ? 'ok' : ''}`, p.lifecycle); const active = p.key === state.activeProjectKey ? ' · active project' : ''; c.append(el('div', 'title', p.name), el('div', 'meta', `${p.key} · ${p.branch}${active}`), el('div', 'meta')); c.lastChild.append(st); c.onclick = () => setActiveProject(p.key); c.style.cursor = 'pointer'; return c; }));
}
$('#project-filter').oninput = renderShelf;
$('#new-project').onclick = () => { $('#new-project-form').hidden = false; $('#new-project-name').focus(); };
$('#new-project-cancel').onclick = () => { $('#new-project-form').hidden = true; };
$('#new-project-form').onsubmit = async (e) => {
  e.preventDefault(); const name = $('#new-project-name').value.trim(); if (!name) return;
  try { await post('/api/admin/workspace/projects', { projectKey: projectKeyFromName(name), displayName: name, sourceKind: $('#new-project-source').value || 'cloud', defaultBranch: 'main', lifecycle: 'active' }); $('#new-project-form').reset(); $('#new-project-form').hidden = true; toast('Project created', 'ok'); await loadProjects(); }
  catch { toast('Could not create that project — try a different name'); }
};

// ---- sessions (local) ----
const SESSIONS_SHOWN = 4;
const PROVIDER_LABEL = { gemini: 'Gemini', claude: 'Claude', openai: 'ChatGPT', grok: 'Grok', xai: 'Grok', mistral: 'Mistral' };
// Default names ("Gemini session") say nothing; show provider + when it started instead.
function sessionTitle(s) {
  const prov = PROVIDER_LABEL[String(s.provider).toLowerCase()] ?? s.provider;
  const generic = !s.name || s.name.trim().toLowerCase() === `${String(s.provider).toLowerCase()} session`;
  if (!generic) return s.name;
  const d = s.createdAt ? new Date(s.createdAt) : null;
  const when = d && !Number.isNaN(d.getTime()) ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'session';
  return `${prov} · ${when}`;
}
function renderSessions() {
  const ul = $('#sessions');
  const sorted = [...state.sessions].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const showAll = store.get('sessionsAll', false);
  // Always keep the active session visible, even when it is past the cap.
  const shown = showAll ? sorted : sorted.filter((s, i) => i < SESSIONS_SHOWN || s.id === state.activeSession);
  const more = $('#sessions-more');
  more.hidden = sorted.length <= SESSIONS_SHOWN;
  more.textContent = showAll ? 'Show fewer' : `Show ${sorted.length - shown.length} more`;
  more.onclick = () => { store.set('sessionsAll', !showAll); renderSessions(); };
  const weekAgo = Date.now() - 7 * 86400000;
  const old = sorted.filter((s) => s.id !== state.activeSession && s.createdAt && new Date(s.createdAt).getTime() < weekAgo);
  const clear = $('#sessions-clear');
  clear.hidden = !state.serverSessions || old.length === 0;
  clear.textContent = `Clear old (${old.length})`;
  clear.onclick = async () => {
    if (!confirm(`Close ${old.length} session${old.length === 1 ? '' : 's'} older than 7 days?`)) return;
    for (const s of old) { try { await post('/api/admin/app/sessions/archive', { id: s.id }); } catch {} }
    toast('Old sessions closed', 'ok'); loadSessions();
  };
  if (!sorted.length) { ul.replaceChildren(el('li', 'faint sm', 'No chats yet')); ul.firstChild.style.cursor = 'default'; }
  else ul.replaceChildren(...shown.map((s) => { const li = el('li', s.id === state.activeSession ? 'active' : null); const title = sessionTitle(s); li.title = `${title} (${s.provider})`; li.append(el('span', 'dot'), el('span', 'name', title)); if (state.serverSessions) { const x = el('button', 'x', '×'); x.type = 'button'; x.title = 'Close session'; x.setAttribute('aria-label', `Close ${title}`); x.onclick = async (ev) => { ev.stopPropagation(); try { await post('/api/admin/app/sessions/archive', { id: s.id }); } catch {} loadSessions(); }; li.append(x); } li.onclick = () => { state.activeSession = s.id; store.set('activeSession', s.id); state.steps = null; renderSessions(); loadSteps(); location.hash = 'console'; }; return li; }));
  const active = state.sessions.find((s) => s.id === state.activeSession);
  const sessionLabel = $('#session-label'); if (sessionLabel) sessionLabel.textContent = active ? `CONSOLE · ${active.name.toUpperCase()} · ${active.provider.toUpperCase()}` : 'CONSOLE';
  $('#active-agent').textContent = active ? `${active.provider} · ${active.name}` : 'No active agent';
}
for (const chip of document.querySelectorAll('#session-chips .chip')) chip.onclick = () => {
  state.pendingProvider = chip.dataset.provider;
  document.querySelectorAll('#session-chips .chip').forEach((c) => c.classList.toggle('active', c === chip));
  $('#session-form').hidden = false; $('#session-name').value = `${chip.dataset.provider} session`; $('#session-name').select();
};
$('#session-cancel').onclick = () => { $('#session-form').hidden = true; document.querySelectorAll('#session-chips .chip').forEach((c) => c.classList.remove('active')); };
$('#session-form').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('#session-name').value.trim(); const provider = state.pendingProvider;
  if (!name || !PROVIDERS.includes(provider)) return;
  if (state.serverSessions) {
    try { const r = await post('/api/admin/app/sessions', { name, provider, idempotencyKey: crypto.randomUUID() }); await loadSessions(); state.activeSession = r.session.id; state.steps = null; loadSteps(); }
    catch { toast('Session not saved — try again'); return; }
  } else {
    state.sessions = addSession(state.sessions, { name, provider }); state.activeSession = state.sessions[0]?.id ?? null; store.set('sessions', state.sessions);
  }
  store.set('activeSession', state.activeSession);
  $('#session-cancel').onclick(); renderSessions(); toast('Session started', 'ok');
};
async function loadSessions() {
  try { state.sessions = sessionsFromServer(await api('/api/admin/app/sessions')); state.serverSessions = true; }
  catch { state.serverSessions = false; state.sessions = store.get('sessions', []); }
  if (!state.sessions.some((s) => s.id === state.activeSession)) state.activeSession = state.sessions[0]?.id ?? null;
  renderSessions();
}
// One-tap New chat (Chats section head): the same creation path the
// console's session form uses — POST /api/admin/app/sessions with a name
// and provider (or the local store when the server list is unavailable) —
// with the house default provider, then straight into the fresh chat.
async function startNewChat() {
  const provider = 'Claude';
  const name = `${provider} session`;
  if (state.serverSessions) {
    try { const r = await post('/api/admin/app/sessions', { name, provider, idempotencyKey: crypto.randomUUID() }); await loadSessions(); state.activeSession = r.session.id; state.steps = null; loadSteps(); }
    catch { toast('Chat not saved — try again'); return; }
  } else {
    state.sessions = addSession(state.sessions, { name, provider }); state.activeSession = state.sessions[0]?.id ?? null; store.set('sessions', state.sessions);
  }
  store.set('activeSession', state.activeSession);
  renderSessions(); toast('Chat started', 'ok');
  if (location.hash !== '#chats') location.hash = 'chats'; else show('chats');
}
$('#new-chat').onclick = () => { startNewChat().catch(() => toast('Chat not saved — try again')); };
// Inline copy of web/shared/voice-dictation.mjs (web/shared/ is not
// URL-served; same pattern as the inlined guard-motion copy). Voice mode:
// a toggle enabling a full voice loop. Dictation inserts into #prompt; a
// final transcript ending with "send it" submits the composer; agent
// replies are spoken aloud. Voice chat needs no "send it": when the
// speaker stops, the utterance submits itself after a short silence
// (dictation keeps the command word). Toggle off stops everything.
//
// TTS: Kokoro (fully local) is the primary engine. The model warms up as
// soon as voice chat is enabled — not at the first spoken reply — via the
// full-URL import below, and the one-time download is cached by the
// browser afterwards (the engine's own transformers.js Cache Storage; no
// second cache is built here), so later visits warm from cache. While the
// model loads, replies queue behind it and the engine status reads
// "Voice loading…" — but the wait is BOUNDED (the voice-silence law): a
// reply never waits more than KOKORO_SPEAK_WAIT_MS from the moment the
// load started; past the bound the labelled backup voice speaks the reply
// while the load keeps running in the background, and Kokoro takes over
// when it lands. A load that never settles at all — a hung import, fetch,
// or GPU session cannot be caught, only abandoned — is abandoned past
// KOKORO_LOAD_ABANDON_MS and retried fresh. The room never goes silent.
// The same law bounds each generate: one still running past
// KOKORO_GENERATE_MS is treated as a generate failure — the backup
// voice speaks the chunk and the queue moves on — so a wedged generate
// can neither silence a reply nor, by holding the reply in flight
// forever, hold the microphone with it.
// speechSynthesis is the BACKUP voice only: it speaks when Kokoro truly
// cannot load, is still loading past the bound, or where Web Audio is
// missing, and whenever it speaks the engine status says it is the backup
// voice — it is never substituted silently.
// Default Kokoro voice preset (a voice setting UI comes later).
const KOKORO_VOICE = 'af_heart';
const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
// Two-way voice: the silence that ends an utterance. A final transcript
// only reaches this controller after the recogniser's own end-pointing
// has already heard a pause, so this bound is not the speech detector —
// it spans the gap between recognition turns when a speaker pauses
// mid-thought (a turn ends, the loop restarts, they resume) and leaves
// a conversational beat before the room answers. 1.5s: long enough to
// never cut a thinking speaker off, short enough to feel like talk.
const VOICE_AUTO_SUBMIT_MS = 1500;

// Per-seat voices. Every id below is a voice the bundled model actually
// ships (onnx-community/Kokoro-82M-v1.0-ONNX, voices/<id>.bin — verified
// against the model repo's file list). af_heart stays the house voice:
// Maestro speaks with it, and so does anything unmapped that is not a
// custom seat. Every one of the fourteen room seats carries a NAMED
// entry below — a seat's voice is its spoken identity, fixed across
// sessions and devices, never a dice roll — and all fourteen are
// distinct. The owner takes bm_daniel, the strongest unused male
// voice, rather than af_heart: af_heart is Maestro's (above). Unmapped
// custom seats hash into a small pool so distinct seats usually sound
// distinct, stably across sessions; the pool never reuses a named
// seat's voice, so a custom seat can never collide with a known one.
const SEAT_VOICES = {
  maestro: 'af_heart',
  claude: 'af_bella',
  chatgpt: 'am_michael',
  grok: 'am_fenrir',
  gemini: 'af_nova',
  mistral: 'bf_emma',
  groq: 'am_puck',
  nvidia: 'am_onyx',
  openrouter: 'bf_isabella',
  cloudflare: 'af_sky',
  qwen: 'af_kore',
  muse: 'af_aoede',
  helm: 'bm_george',
  owner: 'bm_daniel',
};
const SEAT_VOICE_POOL = ['af_nicole', 'am_adam', 'bf_lily', 'am_liam', 'af_sarah'];
function voiceForSeat(seat) {
  const key = String(seat ?? '').trim().toLowerCase();
  if (!key) return KOKORO_VOICE;
  if (SEAT_VOICES[key]) return SEAT_VOICES[key];
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return SEAT_VOICE_POOL[hash % SEAT_VOICE_POOL.length];
}
const KOKORO_SAMPLE_RATE = 24000;
// WASM-only device choice for the Kokoro load. WebGPU is never
// used, with or without an adapter in hand: on the vendored runtime
// versions (onnxruntime-web 1.22 + transformers.js 3.8.1) the q8
// model on WebGPU loads without a murmur and then silently computes
// garbage — right length, right engine label, unintelligible tonal
// mush where the words should be (published measurements on this
// model + runtime; heard in Troy's own tab, 2026-11-08). The
// underlying vocoder bug was also measured at fp32, so no dtype swap
// rescues the GPU road — and every clean proof of this pipeline ran
// q8 on WASM. So there is no device decision left to make: no
// adapter probe, no WebGPU attempt, just the WASM load. (The loader
// used to probe the adapter and try WebGPU first; the probe went
// away with the road it served.)
async function loadKokoroEngine(mod) {
  return mod.KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: 'q8', device: 'wasm' });
}

function createVoiceController({ Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition, synthesis = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance, kokoroLoader = null, makeAudioContext = null } = {}) {
  const supported = typeof Recognition === 'function';
  const canSpeak = typeof synthesis?.speak === 'function' && typeof Utterance === 'function';
  let recognition = null;
  let listening = false;
  let voiceMode = false;
  let voiceKind = 'dictate'; // 'dictate' (text only) or 'voice' (two-way)
  let handlers = {};
  let restartTimer = null; // held mic restart while a reply is speaking (see restartTurn)
  let autoSubmitTimer = null; // two-way voice: the pending end-of-utterance submit (see scheduleAutoSubmit)
  let autoSubmitPending = false; // an utterance has landed and is inside its silence bound
  const ERROR_MESSAGES = {
    'not-allowed': 'Microphone permission was not granted. Nothing was recorded.',
    'no-speech': 'No speech detected — try again.',
    'audio-capture': 'No microphone found.',
    'network': "The browser's speech service is unavailable.",
    'service-not-allowed': "The browser's speech service is unavailable.",
  };
  function sendCommand(text) {
    const trimmed = String(text ?? '').trim().replace(/[.!?…]+$/, '');
    if (!/send it$/i.test(trimmed)) return undefined;
    const rest = trimmed.slice(0, -'send it'.length).trim();
    return rest || null;
  }
  function stopTurn() {
    if (!recognition || !listening) return false;
    recognition.stop();
    return true;
  }
  function startTurn() {
    cancelSpeech();
    recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
    recognition.onstart = () => { listening = true; handlers.onState?.('listening'); };
    recognition.onresult = (event) => {
      if (!voiceMode) return; // commands only act while the toggle is on
      if (typeof document !== 'undefined' && document.hidden) return; // never transcribe a hidden tab
      // Echo guard (two-way voice): while a reply is being read aloud,
      // results are the reply's own audio coming back through the mic —
      // a turn can still be open when a reply starts (e.g. one a typed
      // message set off). They are dropped whole: never displayed,
      // never inserted, never submitted, and they never arm or re-arm
      // the auto-submit. The loop's restart is already held until the
      // reply drains (restartTurn), so the next real turn starts clean.
      if (voiceKind === 'voice' && speechActive()) return;
      // Interim/final tracking (bite 2a): results before event.resultIndex
      // were already reported by earlier events in this turn, so each
      // final is committed exactly once (the old handler re-joined every
      // final in the event and could insert one twice). Interim text is
      // display-only: it goes to onInterim and never inserts, submits,
      // or triggers "send it" — finals only.
      const results = event.results ?? [];
      const from = typeof event.resultIndex === 'number' ? event.resultIndex : 0;
      let finalText = '';
      let interimText = '';
      for (let i = from; i < results.length; i += 1) {
        const result = results[i];
        const transcript = String(result?.[0]?.transcript ?? '').trim();
        if (!transcript) continue;
        if (result.isFinal) finalText = finalText ? `${finalText} ${transcript}` : transcript;
        else interimText = interimText ? `${interimText} ${transcript}` : transcript;
      }
      if (interimText) handlers.onInterim?.(interimText);
      // Still talking: interim words from a resumed turn push a pending
      // auto-submit's bound out — the send waits for a real stop, not
      // for a breath between recognition turns.
      if (interimText && autoSubmitPending) scheduleAutoSubmit();
      if (!finalText) return;
      const cmd = sendCommand(finalText);
      if (cmd === undefined) {
        handlers.onTranscript?.(finalText);
        // Two-way voice: no "send it" needed — the utterance that just
        // landed submits itself once the speaker has stopped (the
        // silence bound in scheduleAutoSubmit). Dictate keeps the
        // command word; scheduleAutoSubmit arms only in voice kind.
        scheduleAutoSubmit();
      } else {
        clearAutoSubmit(); // an explicit "send it" supersedes a pending auto-submit
        handlers.onSubmit?.(cmd ?? ''); // null = bare "send it": submit the composer as-is
      }
    };
    recognition.onerror = (event) => {
      if (event?.error === 'aborted') return; // user tapped to stop; silent
      handlers.onError?.(ERROR_MESSAGES[event?.error] ?? 'Dictation stopped before a usable transcript was produced.');
    };
    recognition.onend = () => {
      listening = false;
      recognition = null;
      const hidden = typeof document !== 'undefined' && document.hidden;
      if (voiceMode && !hidden) restartTurn(); // next turn of the loop, held while a reply is in flight
      else if (!voiceMode) handlers.onState?.('idle');
    };
    recognition.start();
  }
  // Whether sound is actually coming out of the speakers right now
  // (either engine: a Kokoro buffer source playing, or a backup
  // utterance speaking). This — and only this — is what the mic must
  // not hear: the echo guard drops recognition results while it is
  // true, and a pending auto-submit holds until it clears. A reply
  // that is merely queued or still generating is NOT speech yet and
  // must not close the mic (mic-hostage fix): while an answer is
  // being prepared, the user's words are accepted normally.
  function speechActive() {
    if (activeSource) return true;
    if (synthSpeaking) return true;
    try { return !!(synthesis?.speaking); } catch { return false; }
  }

  // Whether a reply is in flight on either engine — playing,
  // generating, waiting behind the model load, or queued. The mic
  // loop's restart keys on this rather than speechActive: starting a
  // turn cancels speech (startTurn), so a restart fired while a reply
  // is being prepared would kill the reply before it ever played.
  // The hold can no longer hold the mic hostage: the load wait and
  // every generate are bounded, so an in-flight reply always drains
  // or fails forward within its bounds, and the restart follows.
  function speechInFlight() {
    if (kokoroPlaying || activeSource || kokoroQueue.length > 0) return true;
    if (synthSpeaking || synthQueue.length > 0) return true;
    try { return !!(synthesis?.speaking || synthesis?.pending); } catch { return false; }
  }

  function restartTurn() {
    if (!voiceMode) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (speechInFlight()) {
      if (!restartTimer) {
        restartTimer = setTimeout(() => { restartTimer = null; restartTurn(); }, 400);
      }
      return;
    }
    startTurn();
  }

  // Two-way voice auto-submit (voice kind only). The utterance already
  // sits in the composer — it arrived through onTranscript like any
  // dictation — so firing is exactly the bare "send it" contract:
  // onSubmit with an empty remainder submits the composer as-is, and
  // every wiring's own empty-composer guard keeps a late or duplicate
  // fire harmless. Firing never happens from a hidden tab, and holds
  // while a reply is actually playing (turn-taking: the send goes out
  // once the playback ends, on the restart loop's poll rhythm). A
  // reply still being generated does not hold the send.
  function fireAutoSubmit() {
    autoSubmitTimer = null;
    if (!voiceMode || voiceKind !== 'voice') { autoSubmitPending = false; return; }
    if (typeof document !== 'undefined' && document.hidden) { autoSubmitPending = false; return; }
    if (speechActive()) {
      autoSubmitTimer = setTimeout(fireAutoSubmit, 400);
      return;
    }
    autoSubmitPending = false;
    handlers.onSubmit?.('');
  }

  function scheduleAutoSubmit() {
    if (!voiceMode || voiceKind !== 'voice') return; // dictate never auto-submits
    autoSubmitPending = true;
    if (autoSubmitTimer) clearTimeout(autoSubmitTimer);
    autoSubmitTimer = setTimeout(fireAutoSubmit, VOICE_AUTO_SUBMIT_MS);
  }

  function clearAutoSubmit() {
    autoSubmitPending = false;
    if (autoSubmitTimer) { clearTimeout(autoSubmitTimer); autoSubmitTimer = null; }
  }

  function setVoiceMode(on, next = {}) {
    // Enabling voice chat also warms the Kokoro model (warmup call in the
    // on-branch below): the load starts at enable time, not first speak.
    if (!supported) { next.onError?.('Voice mode is not supported by this browser. You can still type or paste a message.'); return false; }
    if (on && !voiceMode) { voiceMode = true; voiceKind = next.mode === 'voice' ? 'voice' : 'dictate'; handlers = next; startTurn(); if (voiceKind === 'voice') void warmup(); return true; }
    if (!on && voiceMode) { voiceMode = false; voiceKind = 'dictate'; handlers = {}; if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; } clearAutoSubmit(); stopTurn(); cancelSpeech(); setVoiceStatus('', ''); next.onState?.('idle'); return true; }
    return false;
  }
  // Pause the mic while the tab is hidden: speech meant for another tab must
  // never be transcribed, and "send it" must never fire from a hidden tab.
  // Resumes automatically when the tab is visible again.
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      try {
        if (document.hidden) { stopTurn(); cancelSpeech(); clearAutoSubmit(); }
        else if (voiceMode && !listening) { startTurn(); }
      } catch {}
    });
  }
  // ---- Speaking proof (speaker-proof bite) ----
  // A truthful, per-seat "this reply is being spoken right now" signal:
  // Troy asked for a little speaker icon on each seat's message that
  // lights while that seat's voice is actually playing, so a person —
  // or an automated checker — can see WHICH seat's voice fired. The
  // controller owns no message DOM; it reports the signal through the
  // listener registered with setSpeakingListener, and the surface that
  // renders messages (the Envoy room) draws the icon. The signal
  // reflects ACTUAL playback, never intent: on the Kokoro road it is
  // lit from the buffer source's start() until its onended; on the
  // backup road from the utterance's speak() until its onend/onerror.
  // Loading, generating, and queueing never light it.
  // info = { seat, engine: 'kokoro' | 'backup', ref } — ref is the
  // caller-supplied reference speak() was handed (the room passes the
  // message id), or null when the caller has none.
  let speakingListener = null;
  let speakingNow = null;    // the info currently lit, or null
  let speakingSource = null; // the source/utterance that lit it
  function noteSpeaking(seat, engine, ref, source) {
    speakingNow = { seat: seat ?? null, engine, ref: ref ?? null };
    speakingSource = source ?? null;
    try { speakingListener?.(speakingNow); } catch {}
  }
  function clearSpeaking(source) {
    if (!speakingNow) return;
    // A stale source ending (a stopped buffer source, an interrupted
    // utterance) must not clear a newer source's light.
    if (source !== undefined && speakingSource !== source) return;
    speakingNow = null;
    speakingSource = null;
    try { speakingListener?.(null); } catch {}
  }
  function setSpeakingListener(fn) {
    speakingListener = typeof fn === 'function' ? fn : null;
  }

  // ---- Legacy speechSynthesis engine (fallback) ----
  // Long replies are chunked: Chrome's speechSynthesis truncates long
  // utterances, so a reply goes out as sentence-sized pieces chained via
  // onend. A new reply clears the queue; toggle-off cancels everything.
  // Queue entries carry the seat and message ref beside the text so the
  // speaking proof can name the seat each chunk belongs to.
  const synthQueue = [];
  let synthSpeaking = false;
  function pumpSynth() {
    if (synthSpeaking || synthQueue.length === 0 || !canSpeak) return;
    const item = synthQueue.shift();
    const utter = new Utterance(item.text);
    synthSpeaking = true;
    utter.onend = () => { synthSpeaking = false; clearSpeaking(utter); pumpSynth(); };
    utter.onerror = () => { synthSpeaking = false; clearSpeaking(utter); pumpSynth(); };
    try { synthesis.speak(utter); noteSpeaking(item.seat, 'backup', item.ref, utter); }
    catch { synthSpeaking = false; }
  }
  function enqueueSynth(entries, { interrupt = true } = {}) {
    if (!canSpeak || !entries.length) return false;
    let wasSpeaking = false;
    if (interrupt) {
      try { wasSpeaking = !!synthesis.speaking; } catch {}
      try { synthesis.cancel(); } catch {}
      synthQueue.length = 0;
      synthSpeaking = false;
    }
    synthQueue.push(...entries);
    // Chrome quirk: cancel() takes effect asynchronously, so a speak()
    // issued in the same tick can be swallowed. Only delay when we actually
    // interrupted playing audio; the common case stays synchronous.
    if (interrupt && wasSpeaking) setTimeout(pumpSynth, 150);
    else pumpSynth();
    return true;
  }
  const synthEngine = {
    // Speak queue entries ({ text, seat, ref }). interrupt=false
    // appends without silencing what is playing (used when Kokoro
    // hands a reply over mid-stream).
    enqueue: enqueueSynth,
    // Speak pre-chunked text for one seat. interrupt=false appends
    // without silencing what is playing.
    speakChunks(chunks, { interrupt = true, seat = null, ref = null } = {}) {
      return enqueueSynth(chunks.map((text) => ({ text, seat, ref })), { interrupt });
    },
    cancel() {
      synthQueue.length = 0;
      synthSpeaking = false;
      clearSpeaking();
      if (!canSpeak) return;
      try { synthesis.cancel(); } catch {}
    },
  };

  // ---- Kokoro engine (primary where Web Audio exists) ----
  let kokoro = null;          // loaded KokoroTTS instance
  let kokoroPromise = null;   // in-flight load, shared by warmup + speaks
  let kokoroState = 'idle';   // load state: idle | loading | ready | failed
  let kokoroFailedAt = 0;     // timestamp of last Kokoro failure; retry after 60s
  const KOKORO_RETRY_MS = 60000;
  // Bounded-wait law (voice-silence fix): a reply waits at most
  // KOKORO_SPEAK_WAIT_MS — measured from when the load STARTED, so a
  // load that has been in flight since voice-enable does not get a
  // fresh budget per reply — then the labelled backup voice speaks it
  // while the load keeps running in the background. A load still
  // pending past KOKORO_LOAD_ABANDON_MS is treated as stuck (a hung
  // import/fetch/GPU session never settles, so it can never reject
  // into the fallback) and is retried fresh.
  const KOKORO_SPEAK_WAIT_MS = 15000;
  const KOKORO_LOAD_ABANDON_MS = 60000;
  const KOKORO_WAIT_POLL_MS = 250;
  // One generate gets the same budget family as the wait: a generate
  // still running KOKORO_GENERATE_MS after the call is treated as a
  // generate failure — the backup voice speaks the chunk and the queue
  // moves on. A generate is a promise that may never settle (a wedged
  // worker behind a cold incognito model); unbounded, it held
  // kokoroPlaying — and with it the reply queue and the mic — forever
  // (mic-hostage fix).
  const KOKORO_GENERATE_MS = 15000;
  let kokoroLoadStartedAt = 0; // when the current load attempt began
  let kokoroLoadGen = 0;       // generation of the current load attempt
  let kokoroLastError = null;  // last load failure, kept for the console proof point
  let kokoroErrorLatch = '';   // last Kokoro failure message, latched so setVoiceStatus can re-apply it as data-error after any re-render
  let kokoroBackupWhileLoading = false; // bounded wait expired: backup speaks until the load lands
  let kokoroRetryTimer = null;
  let playToken = 0;          // cancel() bumps it; late audio is ignored
  let activeSource = null;    // currently playing AudioBufferSourceNode
  let audioCtx = null;
  const kokoroQueue = [];     // [{ text, token, voice }]
  let kokoroPlaying = false;

  // Engine status, shown next to the voice controls on every surface
  // (all .voice-engine elements: the console composer and both room
  // composers). This is what makes the backup voice honest: whenever
  // speechSynthesis is what will actually speak, the status says so.
  function setVoiceStatus(text, cls) {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    for (const el of document.querySelectorAll('.voice-engine')) {
      // While the diagnostic latch holds a failure, the reason rides IN
      // the visible label text itself — snapshots and find-in-page read
      // text reliably; data attributes do not survive every checker.
      el.textContent = (cls === 'fallback' && kokoroErrorLatch && !text.includes(kokoroErrorLatch))
        ? text + ' · ' + kokoroErrorLatch
        : text;
      el.className = 'voice-engine ' + (cls || '');
      if (kokoroErrorLatch) el.dataset.error = kokoroErrorLatch;
      else delete el.dataset.error;
    }
  }

  // Diagnostic mirror (2026-11-08): the last Kokoro failure is copied
  // onto every .voice-engine element as a data-error attribute, so the
  // exact failure can be read off the page itself — the browser console
  // is not reachable from every checking browser, and "unavailable"
  // alone does not say which stage broke. Cleared when Kokoro is ready.
  function noteKokoroError(err) {
    // A latched local-import failure is sticky: the ready path clearing
    // the latch after a CDN fallback load would bury the root cause.
    if (kokoroErrorLatch && kokoroErrorLatch.startsWith('local import:')) return;
    const msg = String(err?.message ?? err ?? '').slice(0, 300);
    // First failure wins: it is the root cause. A later error in the same
    // session is downstream of it (the CDN fallback failing after the
    // local copy failed would otherwise bury the real reason).
    if (msg && kokoroErrorLatch) return;
    kokoroErrorLatch = msg;
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    for (const el of document.querySelectorAll('.voice-engine')) {
      if (kokoroErrorLatch) el.dataset.error = kokoroErrorLatch;
      else delete el.dataset.error;
    }
  }

  function canTryKokoro() {
    if (kokoro) return true;
    // Allow retry 60s after a failure (transient: network, phone sleep, memory)
    if (kokoroFailedAt && Date.now() - kokoroFailedAt < KOKORO_RETRY_MS) return false;
    if (kokoroLoader) return true; // injected (tests) -> environment is faked too
    try {
      const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      return typeof AC === 'function';
    } catch { return false; }
  }

  // Where the Kokoro runtime comes from. The vendored copy under the
  // site's own /kokoro-js/ is tried first — same origin, so no
  // third-party module host can fail the load — and the esm.sh CDN
  // (KOKORO_URL) is the fallback if the vendored copy is missing from
  // a deploy. Either way the model is pointed at the same-origin
  // /kokoro-model/ tree through the transformers.js env kokoro-js
  // re-exports; if those files are absent, the library still falls
  // back to the HuggingFace originals on its own.
  // KOKORO_GRAPH_VERSION stamps the vendored graph: bump it whenever
  // anything under /kokoro-js/ changes. It rides the import as a query,
  // so a browser holding a cached answer for the bare path — including
  // a cached 404, which is what left a tab importing a missing runtime
  // all evening on 2026-11-08 — asks for a new URL instead of reusing
  // the dead one.
  const KOKORO_GRAPH_VERSION = '2026-11-09.1';
  const KOKORO_LOCAL_URL = `/kokoro-js/kokoro-js@1.2.1.mjs?v=${KOKORO_GRAPH_VERSION}`;
  const KOKORO_MODEL_PATH = '/kokoro-model/';

  async function importKokoro() {
    let mod;
    try {
      mod = await import(KOKORO_LOCAL_URL);
    } catch (localErr) {
      console.warn('[voice] Local Kokoro runtime unavailable, trying the CDN copy:', localErr?.message ?? localErr);
      noteKokoroError('local import: ' + String(localErr?.message ?? localErr));
      mod = await import(KOKORO_URL);
    }
    try {
      if (mod.env) {
        mod.env.allowLocalModels = true;
        mod.env.localModelPath = KOKORO_MODEL_PATH;
      }
    } catch { /* the env pointer is a nicety; the remote defaults still work */ }
    return mod;
  }

  function defaultKokoroLoader() {
    // Full URL for the CDN fallback (no inline import map: the page CSP
    // forbids inline scripts, which silently broke the map). The model
    // downloads once — warmed at voice-enable, see warmup() — and is
    // cached by the browser afterwards. loadKokoroEngine always loads
    // on WASM — the WebGPU road is not taken (see its note for why).
    return importKokoro().then((mod) => loadKokoroEngine(mod));
  }

  // One load, shared: warmup and any number of queued speaks all await
  // the same promise, so the model is never downloaded twice. The load
  // rides the engine's own browser caching (transformers.js Cache
  // Storage) — warmup on a later visit resolves from that cache.
  function ensureKokoro() {
    if (kokoro) return Promise.resolve(kokoro);
    if (kokoroPromise && Date.now() - kokoroLoadStartedAt <= KOKORO_LOAD_ABANDON_MS) return kokoroPromise;
    // A load still pending past the abandon bound is treated as stuck
    // and a fresh attempt starts. The stale attempt cannot be cancelled
    // (a hung import/fetch keeps its promise), so it is superseded by
    // generation instead: a late success is still adopted (an engine is
    // an engine), a late failure is ignored so it cannot latch the
    // retry window or mislabel the state.
    const gen = ++kokoroLoadGen;
    kokoroLoadStartedAt = Date.now();
    kokoroState = 'loading';
    setVoiceStatus('Voice loading…', '');
    let self;
    self = (async () => {
      try {
        const engine = await (kokoroLoader ?? defaultKokoroLoader)();
        if (!kokoro) {
          kokoro = engine;
          kokoroBackupWhileLoading = false;
          if (gen === kokoroLoadGen || kokoroState === 'failed') {
            kokoroState = 'ready';
            noteKokoroError(null);
            setVoiceStatus('Kokoro', 'kokoro');
          }
        }
        return engine;
      } catch (err) {
        if (gen === kokoroLoadGen) {
          kokoroFailedAt = Date.now();
          kokoroState = 'failed';
          kokoroLastError = err;
          kokoroBackupWhileLoading = false;
          noteKokoroError(err);
          setVoiceStatus('Backup voice — Kokoro could not load', 'fallback');
        }
        throw err;
      } finally {
        if (kokoroPromise === self) kokoroPromise = null;
      }
    })();
    kokoroPromise = self;
    return self;
  }

  // The engine a reply may wait for, bounded: resolves the engine, or
  // null when the load has failed or KOKORO_SPEAK_WAIT_MS has elapsed
  // since the load started. The load itself is never cancelled by the
  // wait — it keeps running in the background, and Kokoro takes over
  // for later replies when it lands.
  async function kokoroEngineForSpeak() {
    if (kokoro) return kokoro;
    ensureKokoro().catch(() => {});
    const deadline = kokoroLoadStartedAt + KOKORO_SPEAK_WAIT_MS;
    for (;;) {
      if (kokoro) return kokoro;
      if (kokoroState === 'failed') return null;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, KOKORO_WAIT_POLL_MS));
    }
  }

  // After a stuck load blows the bounded wait, keep retrying in the
  // background: once the pending load crosses the abandon bound, the
  // timer's ensureKokoro starts a fresh attempt on its own — no user
  // action needed. A failed load is left to the normal retry window.
  function scheduleKokoroRetry() {
    if (kokoroRetryTimer) return;
    kokoroRetryTimer = setTimeout(() => {
      kokoroRetryTimer = null;
      if (!kokoro && kokoroState !== 'failed') ensureKokoro().catch(() => {});
    }, KOKORO_LOAD_ABANDON_MS);
  }

  // Start the Kokoro load ahead of the first reply. Called when voice
  // chat is enabled; also safe to call any time. Respects the post-
  // failure retry window so a dead network is not hammered. Returns
  // true when a load is in flight or the model is already warm.
  function warmup() {
    if (kokoro) return true;
    if (!canSpeak || !canTryKokoro()) return false;
    // ensureKokoro itself decides whether the in-flight load is still
    // usable or has crossed the abandon bound and must start fresh.
    ensureKokoro().catch(() => {}); // failure surfaces via status + fallback
    return true;
  }

  function ensureAudioCtx() {
    if (audioCtx) return audioCtx;
    if (makeAudioContext) { audioCtx = makeAudioContext(); return audioCtx; }
    const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (typeof AC !== 'function') throw new Error('Web Audio is not available');
    audioCtx = new AC();
    return audioCtx;
  }

  function playPcm(pcm, sampleRate) {
    const ctx = ensureAudioCtx();
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      try { const r = ctx.resume(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch {}
    }
    const buf = ctx.createBuffer(1, pcm.length, sampleRate);
    buf.getChannelData(0).set(pcm);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    return src;
  }

  // A Kokoro failure hands the failed chunk and everything still queued to
  // speechSynthesis instead — under the backup-voice status, never quietly.
  function kokoroFallback(failedItem, reason = 'unavailable') {
    if (reason === 'loading') setVoiceStatus('Backup voice — Kokoro still loading', 'fallback');
    else if (reason === 'failed') setVoiceStatus('Backup voice — Kokoro could not load', 'fallback');
    else setVoiceStatus('Backup voice — Kokoro unavailable', 'fallback');
    const entries = [];
    if (failedItem) entries.push({ text: failedItem.text, seat: failedItem.seat, ref: failedItem.ref });
    for (const item of kokoroQueue.splice(0)) entries.push({ text: item.text, seat: item.seat, ref: item.ref });
    if (entries.length) synthEngine.enqueue(entries, { interrupt: false });
  }

  // engine.generate with a hard bound, in the load wait's own idiom:
  // a deadline on Date.now, polled on KOKORO_WAIT_POLL_MS. Past the
  // deadline the race resolves null and the caller treats the chunk
  // exactly like a generate failure. The underlying generate promise
  // is left to settle or hang on its own: its late result is never
  // used, and a late rejection stays handled by the race.
  async function kokoroGenerateBounded(engine, item) {
    let settled = false;
    const gen = Promise.resolve(engine.generate(item.text, { voice: item.voice ?? KOKORO_VOICE }))
      .then((out) => { settled = true; return out; }, (err) => { settled = true; throw err; });
    const deadline = Date.now() + KOKORO_GENERATE_MS;
    const bound = (async () => {
      while (!settled && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, KOKORO_WAIT_POLL_MS));
      }
      return null;
    })();
    const out = await Promise.race([gen, bound]);
    if (out === null) throw new Error(`Kokoro generate passed the ${KOKORO_GENERATE_MS}ms bound`);
    return out;
  }

  async function pumpKokoro() {
    if (kokoroPlaying || kokoroQueue.length === 0) return;
    const item = kokoroQueue.shift();
    kokoroPlaying = true;
    let engine;
    try {
      engine = await kokoroEngineForSpeak();
    } catch { engine = null; }
    if (item.token !== playToken) { kokoroPlaying = false; pumpKokoro(); return; } // cancelled while waiting
    if (!engine) {
      kokoroPlaying = false;
      if (kokoroState === 'failed') {
        console.warn('[voice] Kokoro load failed, falling back:', kokoroLastError?.message ?? kokoroLastError);
        kokoroFallback(item, 'failed');
      } else {
        // The load is still running past the bounded wait. The backup
        // voice speaks this reply — and, via kokoroBackupWhileLoading,
        // the replies behind it — while the load continues in the
        // background; Kokoro takes over when it lands, and the retry
        // timer starts a fresh attempt once the stuck load crosses
        // the abandon bound. The room never goes silent.
        kokoroBackupWhileLoading = true;
        scheduleKokoroRetry();
        kokoroFallback(item, 'loading');
      }
      return;
    }
    let out;
    try {
      out = await kokoroGenerateBounded(engine, item);
    } catch (err) {
      if (item.token !== playToken) { kokoroPlaying = false; pumpKokoro(); return; } // cancelled mid-generate
      kokoroPlaying = false;
      kokoroFailedAt = Date.now();
      noteKokoroError(err);
      console.warn('[voice] Kokoro generate failed, falling back:', err?.message ?? err);
      kokoroFallback(item);
      return;
    }
    if (item.token !== playToken) { kokoroPlaying = false; pumpKokoro(); return; } // cancelled mid-generate
    let src;
    try {
      const pcm = out?.audio ?? out?.data;
      if (!pcm || !pcm.length) throw new Error('Kokoro returned no audio');
      src = playPcm(pcm, out?.sampling_rate ?? KOKORO_SAMPLE_RATE);
    } catch (err) {
      kokoroPlaying = false;
      kokoroFailedAt = Date.now();
      noteKokoroError(err);
      console.warn('[voice] Kokoro playback failed, falling back:', err?.message ?? err);
      kokoroFallback(item);
      return;
    }
    activeSource = src;
    setVoiceStatus('Kokoro', 'kokoro');
    src.onended = () => {
      kokoroPlaying = false;
      if (activeSource === src) activeSource = null;
      clearSpeaking(src);
      pumpKokoro();
    };
    try { src.start(); noteSpeaking(item.seat, 'kokoro', item.ref, src); }
    catch { kokoroPlaying = false; if (activeSource === src) activeSource = null; pumpKokoro(); }
  }

  function kokoroCancel() {
    playToken += 1; // orphan any in-flight generation
    kokoroQueue.length = 0;
    kokoroPlaying = false;
    clearSpeaking();
    if (activeSource) {
      try { activeSource.stop(); } catch {}
      activeSource = null;
    }
  }

  const tts = {
    speak(text, seat, ref) {
      const clean = stripSpeechMarkup(text);
      if (!clean) return false;
      const chunks = chunkForSpeech(clean);
      if (!chunks.length) return false;
      // A new reply replaces anything in progress, on either engine.
      synthEngine.cancel();
      kokoroCancel();
      // Bounded-wait law: while a load that already blew its wait is
      // still running in the background, replies go straight to the
      // labelled backup instead of queueing behind a load that may
      // never land.
      if (!kokoro && kokoroBackupWhileLoading) {
        setVoiceStatus('Backup voice — Kokoro still loading', 'fallback');
        return synthEngine.speakChunks(chunks, { seat, ref });
      }
      // Kokoro road whenever the model is warm, loading, or loadable:
      // queued chunks wait behind an in-flight warmup (bounded — see
      // kokoroEngineForSpeak) instead of dropping to the backup voice
      // just because they arrived early.
      if (kokoro || kokoroPromise || canTryKokoro()) {
        const voice = voiceForSeat(seat);
        for (const c of chunks) kokoroQueue.push({ text: c, token: playToken, voice, seat: seat ?? null, ref: ref ?? null });
        void pumpKokoro();
        return true;
      }
      // Backup voice: Kokoro cannot run here, or it failed and the
      // retry window is still open. It speaks — labelled as the backup,
      // and when the load itself is what failed the label keeps saying
      // so instead of erasing it with the generic wording (the owner's
      // live session flipped "could not load" → "unavailable" on the
      // first reply exactly here).
      if (kokoroState === 'failed') setVoiceStatus('Backup voice — Kokoro could not load', 'fallback');
      else setVoiceStatus('Backup voice — Kokoro unavailable', 'fallback');
      return synthEngine.speakChunks(chunks, { seat, ref });
    },
    cancel() {
      synthEngine.cancel();
      kokoroCancel();
    },
  };

  function speak(text, seat, ref) {
    if (!voiceMode || voiceKind !== 'voice') return false; // dictate mode never speaks
    return tts.speak(text, seat, ref);
  }
  function cancelSpeech() {
    tts.cancel();
  }
  return { get supported() { return supported; }, get canSpeak() { return canSpeak; }, get voiceMode() { return voiceMode; }, get mode() { return voiceKind; }, get listening() { return listening; }, get engineState() { return kokoroState; }, get speakingNow() { return speakingNow; }, setSpeakingListener, setVoiceMode, speak, cancelSpeech, warmup };
}
// Spoken mentions (mention-buttons bite, 2026-11-08) — inline copy of
// mapSpokenMentions + SPOKEN_MENTION_TAGS in web/shared/voice-dictation.mjs
// (same inline-copy pattern as the rest of this voice section). Rewrites a
// dictated "at <name>" into "@<Name>" only at a message start / sentence
// boundary; applied ONLY inside insertMaestroDictation below, never to
// typed text. See the shared file for the full rationale.
const SPOKEN_MENTION_TAGS = Object.freeze({
  all: 'all', everyone: 'all', here: 'all',
  claude: 'Claude', chatgpt: 'ChatGPT', gpt: 'ChatGPT', openai: 'ChatGPT',
  grok: 'Grok', gemini: 'Gemini', mistral: 'Mistral', lechat: 'Mistral',
  groq: 'Groq', qwen: 'Qwen', ollama: 'Qwen', muse: 'Muse',
  maestro: 'Maestro', manager: 'Maestro', helm: 'Helm',
  nvidia: 'NVIDIA', nim: 'NVIDIA', cloudflare: 'Cloudflare',
  openrouter: 'OpenRouter',
});
function mapSpokenMentions(text, tags = SPOKEN_MENTION_TAGS, { leadingBoundary = true } = {}) {
  const src = String(text ?? '');
  if (!src || !tags) return src;
  const words = Object.keys(tags).filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return src;
  const re = new RegExp(`(^|[.!?…]\\s+|\\n\\s*)at\\s+(${words.join('|')})(?=[\\s,.!?…;:]|$)`, 'gi');
  return src.replace(re, (whole, boundary, word) => {
    if (boundary === '' && !leadingBoundary) return whole;
    const tag = tags[String(word).toLowerCase()];
    return tag ? `${boundary}@${tag}` : whole;
  });
}
function stripSpeechMarkup(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
// Split a reply into sentence-sized speakable chunks (browser TTS truncates
// long utterances). Overlong single sentences are hard-split.
function chunkForSpeech(text, maxLen = 180) {
  const chunks = [];
  for (const sentence of String(text ?? '').split(/(?<=[.!?])\s+/)) {
    const piece = sentence.trim();
    if (!piece) continue;
    if (piece.length <= maxLen) chunks.push(piece);
    else for (let i = 0; i < piece.length; i += maxLen) chunks.push(piece.slice(i, i + maxLen).trim());
  }
  return chunks;
}
// Spec 3.8: "+" opens Integrations (tools and connectors live there).
function openTools() { if (location.hash !== '#integrations') location.hash = 'integrations'; else show('integrations'); }
const dictateChip = document.querySelector('.tool[data-tool="dictate"]');
const voiceChatChip = document.querySelector('.tool[data-tool="voice"]');
const voice = createVoiceController();
// Speaking proof (speaker-proof bite): forward the controller's
// per-seat speaking signal to the Envoy room, which draws the speaker
// icon on the message being spoken. workspaceModule is the lazily
// imported envoy module (assigned in loadDesktop); the listener can
// only fire after a voice toggle, long after this file has loaded.
voice.setSpeakingListener((info) => { workspaceModule?.noteSpeaking?.(info); });
const seenMessageIds = new Set();
const voicePrivacy = (mode) => mode === 'voice'
  ? es(
    '🎙️ Voice chat: just talk — when you stop talking, your message sends itself, and replies are spoken aloud in a natural voice. First use downloads a one-time ~300MB voice model, use WiFi. Dictation uses your browser\u2019s speech service — in Chrome, audio is sent to Google for transcription. Tap Voice chat again to turn it off.',
    'Voice chat: just talk — when you stop talking, your message sends itself, and replies are spoken aloud in a natural voice. First use downloads a one-time ~300MB voice model, use WiFi. Dictation uses your browser\u2019s speech service — in Chrome, audio is sent to Google for transcription. Tap Voice chat again to turn it off.'
  )
  : es(
    '🎙️ Dictate: talk, text lands in the composer, say "send it" to submit. Replies are not spoken aloud — you read them. Dictation uses your browser\u2019s speech service — in Chrome, audio is sent to Google for transcription. Tap Dictate again to turn it off.',
    'Dictate: talk, text lands in the composer, say "send it" to submit. Replies are not spoken aloud — you read them. Dictation uses your browser\u2019s speech service — in Chrome, audio is sent to Google for transcription. Tap Dictate again to turn it off.'
  );
function insertDictation(text) {
  const box = $('#prompt');
  const start = box.selectionStart ?? box.value.length;
  const end = box.selectionEnd ?? box.value.length;
  const before = box.value.slice(0, start);
  const after = box.value.slice(end);
  const sep = before && !/[\s\n]$/.test(before) ? ' ' : '';
  box.value = before + sep + text + after;
  const pos = before.length + sep.length + text.length;
  box.setSelectionRange(pos, pos);
  box.oninput();
  box.focus();
}
// Second net for the "send it" command: after every insert, check whether the
// composer's full text ends with "send it" (covers words split across turns
// or chunks the turn-level matcher never saw as one phrase).
function checkComposerForSendCommand() {
  const box = $('#prompt');
  const cleaned = box.value.trim().replace(/[.!?…]+$/, '');
  if (!/send it$/i.test(cleaned)) return false;
  box.value = cleaned.slice(0, -'send it'.length).trim();
  box.oninput();
  return true;
}
// Interim dictation (bite 2a): while a turn is still hearing, the
// not-yet-final words render as a replace-in-place trailing span at
// the caret, so the box types along with the speaker. The span is
// tracked as offsets on the box element; a new interim replaces it,
// and every final insert path clears it before splicing the committed
// text in. Interim rendering does no layout work — the box resizes on
// finals only (the insert paths), never per interim.
function clearInterim(box) {
  if (!box || !box._interimSpan) return;
  const span = box._interimSpan;
  box._interimSpan = null;
  box.value = box.value.slice(0, span.start) + box.value.slice(span.end);
  if ((box.selectionStart ?? 0) > span.start) box.setSelectionRange(span.start, span.start);
}
function renderInterim(box, text) {
  if (!box || !text) return;
  clearInterim(box);
  const start = box.selectionStart ?? box.value.length;
  const end = box.selectionEnd ?? start;
  const before = box.value.slice(0, start);
  const after = box.value.slice(end);
  const sep = before && !/[\s\n]$/.test(before) ? ' ' : '';
  const shown = sep + text;
  box.value = before + shown + after;
  box._interimSpan = { start: before.length, end: before.length + shown.length };
  const pos = before.length + shown.length;
  box.setSelectionRange(pos, pos);
}
// Second nets for a split "send it" (bite 2c): the channel and CLI
// composers get the console's checkComposerForSendCommand pattern —
// after an insert, if the box's full text ends with "send it", strip
// it and report true so the caller submits what remains.
function checkMaestroForSendCommand() {
  const box = document.getElementById('maestro-input');
  if (!box) return false;
  const cleaned = box.value.trim().replace(/[.!?…]+$/, '');
  if (!/send it$/i.test(cleaned)) return false;
  box.value = cleaned.slice(0, -'send it'.length).trim();
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}
function checkCliForSendCommand() {
  const box = document.getElementById('ew-cli-input');
  if (!box) return false;
  const cleaned = box.value.trim().replace(/[.!?…]+$/, '');
  if (!/send it$/i.test(cleaned)) return false;
  box.value = cleaned.slice(0, -'send it'.length).trim();
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}
function updateVoiceChips() {
  for (const [chip, mode] of [[dictateChip, 'dictate'], [voiceChatChip, 'voice']]) {
    if (!chip) continue;
    const active = voice.voiceMode && voice.mode === mode;
    chip.classList.toggle('recording', active);
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}
function toggleVoiceChip(mode) {
  clearInterim($('#prompt'));
  if (voice.voiceMode && voice.mode === mode) {
    voice.setVoiceMode(false, { onState: updateVoiceChips });
  } else {
    if (voice.voiceMode) voice.setVoiceMode(false, {});
    if (!store.get('voicePrivacySeen', false)) { toast(voicePrivacy(mode)); store.set('voicePrivacySeen', true); }
    voice.setVoiceMode(true, {
      mode,
      onInterim: (text) => renderInterim($('#prompt'), text),
      onTranscript: (text) => {
        clearInterim($('#prompt'));
        insertDictation(text);
        if (checkComposerForSendCommand() && $('#prompt').value.trim()) $('#composer').requestSubmit();
      },
      onSubmit: (text) => { clearInterim($('#prompt')); if (text) insertDictation(text); if ($('#prompt').value.trim()) $('#composer').requestSubmit(); },
      onState: updateVoiceChips,
      onError: (msg) => { clearInterim($('#prompt')); toast(msg); updateVoiceChips(); },
    });
  }
  updateVoiceChips();
}
function wireVoiceChip(chip, mode) {
  if (!chip) return;
  chip.title = voicePrivacy(mode);
  if (!voice.supported) {
    chip.disabled = true;
    chip.title = es('🎙️ Voice is not supported by this browser — you can still type.', 'Voice is not supported by this browser — you can still type.');
  } else {
    chip.onclick = () => toggleVoiceChip(mode);
  }
}
wireVoiceChip(dictateChip, 'dictate');
wireVoiceChip(voiceChatChip, 'voice');
for (const t of document.querySelectorAll('.tool')) {
  if (t.dataset.tool === 'dictate' || t.dataset.tool === 'voice') continue;
  t.onclick = () => { if (t.dataset.tool === 'tools') openTools(); else toast(`${t.textContent} is available in the desktop app`); };
}
$('#run-suite').onclick = () => toast('Tool suite runs from the desktop app');

// ---- live task progress (console + Guard Feed) ----
async function loadSteps() {
  const sid = state.activeSession;
  if (!state.serverSessions || !sid) { state.steps = null; renderSteps(); return; }
  try { const body = await api(`/api/admin/app/sessions/steps?sessionId=${encodeURIComponent(sid)}`); if (sid === state.activeSession) state.steps = progressModel(body); }
  catch { state.steps = null; }
  renderSteps();
}
async function setStep(item) {
  try { await post('/api/admin/app/sessions/steps/update', { sessionId: state.activeSession, position: item.position, status: item.next }); }
  catch { toast('Step not updated — try again'); }
  await loadSteps(); loadFeedData();
}
function stepList(m, compact) {
  const ol = el('ol', compact ? 'checklist compact' : 'checklist');
  ol.append(...m.items.map((it) => { const li = el('li', it.status); const b = el('button', null, it.icon); b.type = 'button'; b.title = `${it.word} — tap to mark ${it.next}`; b.setAttribute('aria-label', `${it.label}: ${it.word}. Mark ${it.next}.`); if (compact) b.disabled = true; else b.onclick = () => setStep(it); li.append(b, el('span', 'l', it.label), el('span', 'w', it.word)); return li; }));
  return ol;
}
function renderSteps() {
  const box = $('#task-progress'); const feed = $('#feed-progress'); const m = state.steps;
  const can = state.serverSessions && !!state.activeSession && isAdminRole(state.actor?.role);
  box.hidden = !can;
  if (!can) { feed.hidden = true; return; }
  if (!m || !m.total) {
    $('#tp-summary').textContent = es('📝 No plan yet — add the steps this session should take.', 'No plan yet — add the steps this session should take.'); $('#tp-bar').style.width = '0%'; $('#tp-list').replaceChildren(); $('#tp-edit').textContent = 'Add plan'; feed.hidden = true; return;
  }
  $('#tp-edit').textContent = 'Edit plan'; $('#tp-summary').textContent = m.summary; $('#tp-bar').style.width = `${m.pct}%`;
  $('#tp-list').replaceWith(Object.assign(stepList(m, false), { id: 'tp-list' }));
  feed.hidden = false; const h = el('div', 'h-row'); h.append(el('span', 'eyebrow', 'TASK PROGRESS'), el('span', 'sm muted', `${m.done}/${m.total}`));
  const bar = el('div', 'bar'); const fill = el('span'); fill.style.width = `${m.pct}%`; bar.append(fill);
  feed.replaceChildren(h, bar, stepList(m, true));
}
$('#tp-edit').onclick = () => { const f = $('#tp-form'); f.hidden = !f.hidden; if (!f.hidden) { $('#tp-text').value = (state.steps?.items ?? []).map((i) => i.label).join('\n'); $('#tp-text').focus(); } };
$('#tp-cancel').onclick = () => { $('#tp-form').hidden = true; };
$('#tp-form').onsubmit = async (e) => {
  e.preventDefault(); const steps = planFromText($('#tp-text').value);
  if (!steps.length) { toast('Add at least one step'); return; }
  if (state.steps?.total && !confirm('Replace the current plan? Progress on it will be reset.')) return;
  try { await post('/api/admin/app/sessions/steps', { sessionId: state.activeSession, steps }); $('#tp-form').hidden = true; toast('Plan saved', 'ok'); }
  catch { toast('Plan not saved — try again'); }
  await loadSteps(); loadFeedData();
};

// ---- home dashboard ----
async function loadHome() {
  const [u, o] = await Promise.allSettled([api('/api/admin/cora/usage'), api('/api/admin/overview'), loadSessions(), loadFeedData()]);
  if (u.status === 'fulfilled') state.usage = u.value; if (o.status === 'fulfilled') state.overview = o.value;
  const m = homeModel({ sessions: state.sessions, approvals: state.approvals, usage: state.usage, overview: state.overview });
  const usage = $('#home-usage');
  if (!m.usage) usage.replaceChildren(el('p', 'muted sm', 'Usage is not available right now.'));
  else { const bar = el('div', `bar ${m.usage.level}`); const f = el('span'); f.style.width = `${m.usage.pct ?? 0}%`; bar.append(f); usage.replaceChildren(el('div', 'big-line', m.usage.spent), el('div', 'muted sm', m.usage.text), ...(m.usage.pct == null ? [] : [bar]), el('div', 'faint sm', `${m.usage.calls} AI calls so far${m.usage.level === 'over' ? ' · limit reached' : m.usage.level === 'near' ? ' · close to the limit' : ''}`)); }
  const run = $('#home-running');
  run.replaceChildren(...(m.running.length ? m.running.map((r) => { const d = el('div', 'run'); const n = el('div', 'n'); n.append(el('strong', null, r.name), el('span', 'muted sm', `${r.done}/${r.total}`)); const bar = el('div', 'bar'); const f = el('span'); f.style.width = `${r.pct}%`; bar.append(f); d.append(n, bar, el('div', 'muted sm', r.current ? `Now: ${r.current}` : r.failed ? `${r.failed} step failed` : `${r.provider} · waiting`)); d.onclick = () => { state.activeSession = r.id; store.set('activeSession', r.id); state.steps = null; renderSessions(); loadSteps(); location.hash = 'console'; }; d.style.cursor = 'pointer'; return d; }) : [el('p', 'muted sm', m.idleSessions ? `Nothing running. ${m.idleSessions} open session${m.idleSessions === 1 ? '' : 's'}.` : 'Nothing running. Start a session from Chat.')]));
  const ap = $('#home-approvals');
  ap.replaceChildren(...(m.pending.length ? m.pending.map((p) => { const d = el('div', 'pend'); d.append(el('span', 't', p.title)); if (p.canDecide) { const ok = el('button', 'btn primary sm', 'Approve'); ok.onclick = async () => { await decide(p.item, 'approve'); loadHome(); }; const no = el('button', 'btn ghost sm', 'Review'); no.onclick = () => { location.hash = 'approvals'; }; d.append(ok, no); } return d; }) : [el('p', 'muted sm', "You're all caught up.")]));
  $('#home-stats').replaceChildren(...m.stats.map(([k, v]) => { const c = el('div', 'card'); c.append(el('div', 'big', String(v)), el('div', 'eyebrow', k.toUpperCase())); return c; }));
}

// ---- console (Envoy) ----
async function loadConsole() {
  loadOnboarding();
  if (!state.channelId) {
    try { const body = await api('/api/admin/envoy/channels'); const chans = Array.isArray(body.channels) ? body.channels : []; state.channelsLoaded = true; const sel = $('#channel'); const kindTag = (k) => k && k !== 'team' ? ` · ${k}` : ''; sel.replaceChildren(...chans.map((c) => { const o = el('option', null, `${c.title || c.slug || 'Channel'}${kindTag(c.kind)}`); o.value = c.id ?? c.channelId; return o; })); sel.hidden = chans.length < 2; state.channelId = chans[0] ? (chans[0].id ?? chans[0].channelId) : null;
      if (!state.channelId && isAdminRole(state.actor?.role)) { const made = await post('/api/admin/envoy/channels', { slug: 'team', title: 'Team', kind: 'team' }); state.channelId = made.channel?.id ?? null; if (state.channelId) toast('Team channel created', 'ok'); }
    } catch {}
  }
  await loadLog();
  // Poll for new messages every 3 seconds when the page is visible (one timer, not one per visit).
  // The bridge posts replies via the API; without polling the user must
  // manually refresh or switch tabs to see them.
  if (!consolePollTimer) consolePollTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (!state.channelId) return;
    loadLog().catch(() => {});
  }, 3000);
  placeChat();
}
// Wide screens: chat lives in the sliding panel ("wall of sliding glass doors") and is
// reachable from every view. Phones (<= 768px): the panel would sit off-screen, leaving the
// Chat view blank with the composer (and its "+") unreachable, so chat stays inline in the view.
let consolePollTimer = null;
let consoleHome = null;
function placeChat() {
  try {
    const consoleView = document.getElementById('view-console');
    const panelBody = document.getElementById('chat-panel-body');
    const panel = document.getElementById('chat-panel');
    const toggle = document.getElementById('chat-panel-toggle');
    const closeBtn = document.getElementById('chat-panel-close');
    if (!consoleView || !panelBody || !panel || !toggle) return;
    if (!consoleHome) { consoleHome = document.createComment('view-console'); consoleView.before(consoleHome); }
    // The Workspace is the one chat; the session console is an ordinary page now.
    {
      if (consoleView.parentNode !== consoleHome.parentNode) consoleHome.after(consoleView);
      panel.classList.remove('open');
      panel.hidden = true;
      toggle.hidden = true;
      consoleView.hidden = shell.dataset.view !== 'console';
    }
  } catch {}
}
window.matchMedia('(max-width: 900px)').addEventListener?.('change', () => { if (consoleHome) placeChat(); });
async function loadLog() {
  const log = $('#log');
  const sys = (t) => { const d = el('div', 'line sys'); d.append(el('span', 'ts', `[${new Date().toTimeString().slice(0, 8)}] `), document.createTextNode(t)); return d; };
  if (!state.channelId) { log.replaceChildren(sys('helmian cloud console ready'), sys(state.channelsLoaded ? 'no team channel yet — messages will stream here once one is set up' : 'connecting to your team channel…')); return; }
  try {
    const lines = logLines(await api(`/api/admin/envoy/messages?channel_id=${encodeURIComponent(state.channelId)}`), state.actor?.subject);
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    if (!lines.length) { log.replaceChildren(sys('channel connected · say hello below')); return; }
    log.replaceChildren(...lines.map((l) => {
      const d = el('div', 'line');
      // Bridge replies get the Maestro name plus the user's chosen Maestro icon, if any.
      const icon = l.bridge ? agentIconFor(BRIDGE_DISPLAY_NAME) : null;
      const whoText = icon ? `${icon} ${l.who}> ` : `${l.who}> `;
      d.append(el('span', 'ts', l.ts ? `[${l.ts}] ` : ''), el('span', l.mine ? 'me' : 'who', whoText), document.createTextNode(l.text));
      return d;
    }));
    for (const l of lines) {
      if (!l.id || seenMessageIds.has(l.id)) continue;
      seenMessageIds.add(l.id);
      if (!l.mine && voice.voiceMode) voice.speak(l.text);
    }
    if (atBottom) log.scrollTop = log.scrollHeight;
  } catch { log.replaceChildren(sys('console is reconnecting…')); }
}
$('#channel').onchange = (e) => { state.channelId = e.target.value; loadLog(); };
$('#new-channel').onclick = () => {
  if ($('#new-channel-form')) return;
  const form = el('form', 'channel-form');
  form.id = 'new-channel-form';
  const input = el('input', null);
  input.placeholder = 'New channel name...';
  input.maxLength = 120;
  input.setAttribute('aria-label', 'New channel name');
  const kind = el('select', null);
  kind.setAttribute('aria-label', 'Channel kind');
  for (const [v, label] of [['team', 'Team'], ['direct', 'Direct'], ['agent', 'Agent']]) { const o = el('option', null, label); o.value = v; kind.append(o); }
  const create = el('button', 'btn primary sm', 'Create');
  create.type = 'submit';
  const cancel = el('button', 'btn ghost sm', 'Cancel');
  cancel.type = 'button';
  form.append(input, kind, create, cancel);
  $('#log').before(form);
  input.focus();
  cancel.onclick = () => form.remove();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const title = input.value.trim();
    if (!title) { toast('Enter a channel name.'); input.focus(); return; }
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'channel';
    create.disabled = true;
    try {
      const result = await post('/api/admin/envoy/channels', { kind: kind.value || 'team', slug, title });
      form.remove();
      state.channelId = null;
      await loadConsole();
      if (result.channel?.id) {
        state.channelId = result.channel.id;
        const sel = $('#channel');
        if ([...sel.options].some((o) => o.value === result.channel.id)) sel.value = result.channel.id;
        await loadLog();
      }
      toast(result.inserted === false ? `Channel "${result.channel?.title ?? title}" already exists — opened it.` : `Channel "${result.channel?.title ?? title}" created.`, result.inserted === false ? undefined : 'ok');
    } catch { create.disabled = false; toast('Channel not created.'); }
  };
};
// ---- session console "+" picker ----
// The same attach model as the workspace composers (composer-picker.mjs):
// skills by name, connectors from the Integrations registry, plugins from
// the PC bridge's install ledger when the picker model carries that group,
// upload honestly unavailable. The console fetches the same endpoints the
// workspace's loadPickerData does, keeps its OWN attach list (the third
// one), and its send below builds through buildMessageRequest like the
// others — so a console message carries metadata the same way, and with
// nothing attached the payload is exactly what it was before. The model
// is per-agent like the workspace's: the registry facts (the same five
// feeds Integrations renders, probe receipts and runner presence
// included) load once, and each render builds the model for the ACTIVE
// SESSION's provider (its ecosystem group first), or the shared model
// when no session is active.
const consoleAttach = { list: [], webSearch: false, open: false, data: null };
async function loadConsolePickerData() {
  if (consoleAttach.data) return consoleAttach.data;
  const [c, p, pl, tc, pr] = await Promise.allSettled([api('/api/admin/cora/connectors'), api('/api/admin/provider-connections'), api('/api/admin/plugins'), api('/api/admin/tool-connections'), api('/api/admin/envoy/runner/presence')]);
  consoleAttach.data = {
    connectors: c.status === 'fulfilled' ? c.value ?? {} : {}, providers: p.status === 'fulfilled' ? p.value ?? {} : {}, plugins: pl.status === 'fulfilled' ? pl.value ?? {} : {},
    toolConnections: tc.status === 'fulfilled' ? tc.value?.connections ?? [] : null,
    presence: pr.status === 'fulfilled' ? pr.value?.presence ?? [] : null,
  };
  return consoleAttach.data;
}
// The active session's provider, as the session list names it ('Claude',
// 'ChatGPT', 'Grok', 'Gemini') — pickerModel normalizes it to the agent.
function consolePickerAgent() {
  return state.sessions.find((s) => s.id === state.activeSession)?.provider ?? null;
}
function renderConsoleAttachChips() {
  const box = $('#console-attach-chips'); if (!box) return;
  const chips = consoleAttach.list.map((a) => {
    const chip = el('span', `ew-chip ${a.kind}`, a.kind === 'skill' ? `/${a.name}` : a.name);
    const x = el('button', 'ew-chip-x', '×');
    x.type = 'button';
    x.title = `Remove ${a.kind === 'skill' ? `the ${a.name} skill` : a.name}`;
    x.setAttribute('aria-label', `Remove ${a.kind === 'skill' ? `skill ${a.name}` : a.name}`);
    x.onclick = () => { consoleAttach.list = removeAttachment(consoleAttach.list, a); renderConsoleAttachChips(); if (consoleAttach.open) renderConsolePicker(); };
    chip.append(x);
    return chip;
  });
  // The web-search toggle rides the next message like an attachment, so
  // it shows as a chip while it is on — and leaves with the send (or ×).
  if (consoleAttach.webSearch) {
    const chip = el('span', 'ew-chip web-search', 'Web search');
    const x = el('button', 'ew-chip-x', '×');
    x.type = 'button';
    x.title = 'Turn web search off for this message';
    x.setAttribute('aria-label', 'Turn web search off');
    x.onclick = () => { consoleAttach.webSearch = false; renderConsoleAttachChips(); if (consoleAttach.open) renderConsolePicker(); };
    chip.append(x);
    chips.push(chip);
  }
  box.hidden = !chips.length;
  box.replaceChildren(...chips);
}
function closeConsolePicker() {
  consoleAttach.open = false;
  const panel = $('#console-picker'); if (panel) panel.hidden = true;
}
async function toggleConsolePicker() {
  if (consoleAttach.open) { closeConsolePicker(); return; }
  consoleAttach.open = true;
  await renderConsolePicker();
}
async function renderConsolePicker() {
  const panel = $('#console-picker'); if (!panel) return;
  if (!consoleAttach.open) { panel.hidden = true; return; }
  panel.hidden = false;
  if (!consoleAttach.data) await loadConsolePickerData().catch(() => {});
  if (!consoleAttach.open) return; // closed while the registry loaded
  const model = consoleAttach.data ? pickerModel({ ...consoleAttach.data, agent: consolePickerAgent() }) : pickerModel();
  const attached = new Set(consoleAttach.list.map(attachmentKey));
  const groups = [];
  for (const g of model.groups) {
    if (g.id === 'agent') {
      // One of the six agents' own groups: its own connection as a
      // status row, by-name skills, and the bridge plugins it can be
      // handed (mirrors the workspace picker's agent groups).
      const group = el('div', 'ew-picker-group');
      const nameInput = el('input', 'ew-picker-input');
      nameInput.maxLength = 64;
      nameInput.placeholder = 'Skill name — e.g. deploy, or plugin:skill';
      nameInput.setAttribute('aria-label', 'Skill name');
      const note = el('p', 'ew-note');
      const add = el('button', 'ew-btn sm', 'Attach skill');
      add.type = 'button';
      add.onclick = () => {
        const r = addAttachment(consoleAttach.list, { kind: 'skill', name: nameInput.value });
        if (!r.added) { note.textContent = r.reason; return; }
        consoleAttach.list = r.list; note.textContent = '';
        renderConsoleAttachChips(); renderConsolePicker();
      };
      const row = el('div', 'ew-row'); row.append(nameInput, add);
      group.append(el('div', 'ew-subhead', g.title.toUpperCase()), el('p', 'ew-note', g.note), row, note);
      for (const item of g.items) {
        if (item.kind === 'provider') {
          const btn = el('button', 'ew-picker-row');
          btn.type = 'button'; btn.disabled = true;
          btn.title = `${item.name} is the agent you are talking to — this is its own connection`;
          btn.append(el('span', null, item.name), el('span', 'ew-picker-kind', item.kindLabel), el('span', `ew-picker-state ${item.state === 'connected' ? 'on' : 'off'}`, item.stateLabel));
          group.append(btn);
          continue;
        }
        const on = attached.has(`plugin:${item.name}`);
        const btn = el('button', `ew-picker-row${on ? ' on' : ''}`);
        btn.type = 'button';
        btn.title = on ? `Remove ${item.name} from this message` : `Attach ${item.name} to this message`;
        btn.onclick = () => {
          if (on) { consoleAttach.list = removeAttachment(consoleAttach.list, { kind: 'plugin', name: item.name }); renderConsoleAttachChips(); renderConsolePicker(); return; }
          const r = addAttachment(consoleAttach.list, { kind: 'plugin', name: item.name }, { catalog: g.items });
          if (r.added) { consoleAttach.list = r.list; renderConsoleAttachChips(); renderConsolePicker(); }
        };
        btn.append(el('span', null, item.name), el('span', 'ew-picker-kind', item.brings), el('span', `ew-picker-state ${on ? 'on' : 'off'}`, on ? 'Attached' : item.stateLabel));
        group.append(btn);
      }
      groups.push(group);
    } else if (g.id === 'connectors') {
      const group = el('div', 'ew-picker-group');
      group.append(el('div', 'ew-subhead', 'CONNECTORS'));
      if (g.note) group.append(el('p', 'ew-note', g.note));
      if (!g.items.length) group.append(el('p', 'ew-note', 'No connectors in the registry.'));
      for (const item of g.items) {
        const on = attached.has(`connector:${item.key}`);
        const btn = el('button', `ew-picker-row${on ? ' on' : ''}`);
        btn.type = 'button';
        if (!item.connected) btn.disabled = true;
        btn.title = item.connected ? (on ? `Remove ${item.name} from this message` : `Attach ${item.name} to this message — it rides as a note for the agent`) : `${item.name}: ${item.statusText ?? 'Not connected'}`;
        btn.onclick = () => {
          if (on) { consoleAttach.list = removeAttachment(consoleAttach.list, { kind: 'connector', key: item.key }); renderConsoleAttachChips(); renderConsolePicker(); return; }
          const r = addAttachment(consoleAttach.list, { kind: 'connector', key: item.key }, { catalog: g.items });
          if (r.added) { consoleAttach.list = r.list; renderConsoleAttachChips(); renderConsolePicker(); }
        };
        btn.append(el('span', null, item.name), el('span', 'ew-picker-kind', item.kindLabel), el('span', `ew-picker-state ${item.connected ? 'on' : 'off'}`, on ? 'Attached' : item.stateLabel));
        group.append(btn);
      }
      groups.push(group);
    } else if (g.id === 'plugins') {
      const group = el('div', 'ew-picker-group');
      group.append(el('div', 'ew-subhead', 'PLUGINS'), el('p', 'ew-note', g.note));
      if (!g.items.length) group.append(el('p', 'ew-note', 'No plugins installed on your PC bridge yet.'));
      for (const item of g.items) {
        const on = attached.has(`plugin:${item.name}`);
        const btn = el('button', `ew-picker-row${on ? ' on' : ''}`);
        btn.type = 'button';
        btn.title = on ? `Remove ${item.name} from this message` : `Attach ${item.name} to this message`;
        btn.onclick = () => {
          if (on) { consoleAttach.list = removeAttachment(consoleAttach.list, { kind: 'plugin', name: item.name }); renderConsoleAttachChips(); renderConsolePicker(); return; }
          const r = addAttachment(consoleAttach.list, { kind: 'plugin', name: item.name }, { catalog: g.items });
          if (r.added) { consoleAttach.list = r.list; renderConsoleAttachChips(); renderConsolePicker(); }
        };
        btn.append(el('span', null, item.name), el('span', 'ew-picker-kind', item.brings), el('span', `ew-picker-state ${on ? 'on' : 'off'}`, on ? 'Attached' : item.stateLabel));
        group.append(btn);
      }
      groups.push(group);
    } else if (g.id === 'upload') {
      const group = el('div', 'ew-picker-group');
      const up = el('button', 'ew-btn sm', 'Upload a file');
      up.type = 'button'; up.disabled = true; up.title = g.reason;
      group.append(el('div', 'ew-subhead', 'UPLOAD'), up, el('p', 'ew-note', g.reason));
      groups.push(group);
    } else if (g.id === 'web-search') {
      const group = el('div', 'ew-picker-group');
      const on = consoleAttach.webSearch === true;
      const btn = el('button', `ew-picker-row${on ? ' on' : ''}`);
      btn.type = 'button';
      btn.title = on ? 'Web search is on for this message — tap to turn it off' : 'Turn web search on for this message';
      btn.onclick = () => { consoleAttach.webSearch = !on; renderConsoleAttachChips(); renderConsolePicker(); };
      btn.append(el('span', null, 'Web search'), el('span', 'ew-picker-kind', 'per message'), el('span', `ew-picker-state ${on ? 'on' : 'off'}`, on ? 'On' : 'Off'));
      group.append(el('div', 'ew-subhead', 'WEB SEARCH'), el('p', 'ew-note', g.note), btn);
      groups.push(group);
    }
  }
  const head = el('div', 'ew-picker-head');
  const close = el('button', 'ew-icon', '×');
  close.type = 'button'; close.setAttribute('aria-label', 'Close picker');
  close.onclick = () => closeConsolePicker();
  head.append(el('strong', null, 'Add to this message'), el('span', 'ew-spacer'), close);
  panel.replaceChildren(head, ...groups);
}
$('#console-plus').onclick = () => toggleConsolePicker();
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && consoleAttach.open) closeConsolePicker(); });

const prompt = $('#prompt');
prompt.oninput = () => { prompt.style.height = 'auto'; prompt.style.height = `${Math.min(prompt.scrollHeight, 200)}px`; };
prompt.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !narrow()) { e.preventDefault(); $('#composer').requestSubmit(); } };
$('#composer').onsubmit = async (e) => {
  e.preventDefault(); const body = prompt.value.trim(); if (!body) return;
  if (!state.channelId) { toast('No team channel yet — ask the owner to set one up'); return; }
  const req = buildMessageRequest({ channelId: state.channelId, body, idempotencyKey: crypto.randomUUID(), attachments: consoleAttach.list, webSearch: consoleAttach.webSearch });
  $('#send').disabled = true;
  try { await post('/api/admin/envoy/messages', req.payload); prompt.value = ''; prompt.oninput(); consoleAttach.list = []; consoleAttach.webSearch = false; renderConsoleAttachChips(); closeConsolePicker(); await loadLog(); $('#log').scrollTop = 1e9; }
  catch { toast('Not sent — your message is still in the box'); }
  finally { $('#send').disabled = false; }
};

// ---- guard feed ----
async function loadFeedData() {
  const [ev, ap, gf] = await Promise.allSettled([api('/api/admin/events'), api('/api/admin/cora/approvals'), api('/api/admin/guard/findings')]);
  if (ev.status === 'fulfilled') state.events = Array.isArray(ev.value.events) ? ev.value.events : [];
  if (ap.status === 'fulfilled') state.approvals = approvalsModel(ap.value, state.actor?.role).items;
  state.findings = gf.status === 'fulfilled' && Array.isArray(gf.value.findings) ? gf.value.findings : [];
  const pending = state.approvals.filter((a) => !a.decision).length;
  $('#approvals-badge').hidden = pending === 0; $('#approvals-badge').textContent = String(pending);
  refreshUpcomingBadge();
  renderFeed();
}
async function decide(item, decision) {
  try { await post('/api/admin/cora/approvals', { decision, requestKind: item.requestKind, requestReceiptId: item.requestReceiptId, reason: `${decision === 'approve' ? 'Approved' : 'Rejected'} in Helmian app`, idempotencyKey: crypto.randomUUID() }); toast(decision === 'approve' ? 'Approved' : 'Rejected'); }
  catch { toast('Decision not saved — try again'); }
  await loadFeedData(); if (shell.dataset.view === 'approvals') renderApprovals();
}
// Inline copy of web/shared/guard-motion.mjs (desktop parity for the Guard
// feed; /app applies motion only, no toggles).
function guardMotionState(finding, now = Date.now()) {
  const severity = String(finding?.severity ?? 'info').toLowerCase();
  const sightingCount = Number(finding?.sightingCount ?? 0) || 0;
  const acked = !!finding?.acked;
  const tone = severity === 'critical' ? 'red' : severity === 'warning' ? 'yellow' : 'grey';
  if (acked) return { tone, pulse: false, acked: true };
  const firstSeen = finding?.firstSeenAt ? new Date(finding.firstSeenAt).getTime() : NaN;
  const unansweredMin = Number.isNaN(firstSeen) ? 0 : Math.max(0, (now - firstSeen) / 60000);
  if (severity === 'critical') return { tone: 'red', pulse: true, acked: false };
  if (severity === 'warning') {
    const escalated = sightingCount >= 5 || unansweredMin >= 5;
    const pulsing = sightingCount >= 3 || unansweredMin >= 2;
    return { tone: escalated ? 'red' : 'yellow', pulse: escalated || pulsing, acked: false };
  }
  return { tone: 'grey', pulse: false, acked: false };
}
function findingCards() {
  // Guard findings carry server-side ack state; an ack clears the card from
  // the pile (criticals included — owner's call, 2026-11-08).
  return (state.findings ?? []).map((f) => ({
    id: `finding:${f.fingerprint}`,
    severity: f.severity,
    title: f.title,
    body: [f.source, f.sightingCount > 1 ? `Seen ${f.sightingCount} times` : null, f.acked ? `Acknowledged by ${f.ackedBy}` : null].filter(Boolean).join(' · '),
    at: f.lastSeenAt || null,
    ack: !!f.acked,
    finding: f,
  }));
}
async function ackFinding(fingerprint) {
  try { await post('/api/admin/guard/acks', { fingerprint }); toast('Acknowledged'); }
  catch { toast('Acknowledgement not saved — try again'); await loadFeedData(); renderFeed(); return; }
  // The ack is saved on the server; the card also leaves the pile for good
  // via the persisted cleared set — criticals included (owner's call,
  // 2026-11-08: the reds clear on ack like everything else).
  state.cleared.add(`finding:${fingerprint}`); store.set('cleared', [...state.cleared]);
  await loadFeedData(); renderFeed();
}
// Acknowledging an event card removes it from the feed for good: the id
// lands in the persisted cleared set, so a reload (which refetches the
// same events from the server) cannot resurrect it. New events carry new
// ids and still show.
function clearFeedCard(id) {
  state.ack.add(id); state.cleared.add(id);
  store.set('ack', [...state.ack]); store.set('cleared', [...state.cleared]);
  renderFeed();
}
function renderFeed() {
  renderGuardApprovals();
  const filter = $('#feed-filter').value;
  const cards = feedModel({ events: state.events, approvals: state.approvals }, { filter: 'all', showInfo: $('#opt-info').checked, showApprovals: $('#opt-approvals').checked, acknowledged: state.ack, cleared: state.cleared });
  const merged = [...findingCards(), ...cards]
    .filter((c) => !state.cleared.has(c.id))
    .filter((c) => filter === 'all' || c.severity === filter)
    .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  const critical = merged.filter((c) => c.severity === 'critical').length;
  $('#guard-count').hidden = critical === 0; $('#guard-count').textContent = String(critical);
  // Guard panel badge: unacknowledged findings keep the Guard panel noticeable.
  const unacked = (state.findings ?? []).filter((f) => !f.acked).length;
  const tabBadge = $('#guard-panel-count');
  if (tabBadge) { tabBadge.hidden = unacked === 0; tabBadge.textContent = String(unacked); }
  const feed = $('#feed');
  if (!merged.length) feed.replaceChildren(empty('All clear', 'Alerts from your agents show up here.'));
  else feed.replaceChildren(...merged.slice(0, 60).map((c) => {
    const motion = c.finding ? guardMotionState(c.finding) : null;
    const a = el('article', `alert ${c.severity}${c.ack ? ' ack' : ''}${motion ? ` tone-${motion.tone}${motion.pulse ? ' pulse' : ''}` : ''}`);
    const h = el('div', 'h'); h.append(el('span', null, c.title), el('span', 't', c.at ? formatTime(c.at) : '')); a.append(h);
    if (c.body) a.append(el('div', 'b', c.body));
    const actions = el('div', 'actions');
    if (c.severity === 'critical' && c.approval?.canDecide) {
      const ok = el('button', 'btn primary sm', 'Approve'); const no = el('button', 'btn ghost sm', 'Reject');
      ok.onclick = () => decide(c.approval, 'approve');
      no.onclick = () => { if (a.querySelector('.confirm')) return; const cf = el('div', 'confirm'); cf.append(el('div', null, 'Reject this request?')); const r = el('div', 'actions'); const y = el('button', 'btn danger sm', 'Yes, reject'); const n = el('button', 'btn ghost sm', 'Cancel'); y.onclick = () => decide(c.approval, 'reject'); n.onclick = () => cf.remove(); r.append(y, n); cf.append(r); a.append(cf); };
      actions.append(ok, no);
    }
    if (!c.ack && !c.approval) {
      const ack = el('button', 'btn ghost sm', 'Acknowledge');
      ack.onclick = c.finding
        ? () => ackFinding(c.finding.fingerprint)
        : () => clearFeedCard(c.id);
      actions.append(ack);
    }
    if (actions.childElementCount) a.append(actions);
    return a;
  }));
  // Sync to desktop Guard panel (EXE clone)
  try {
    const dpFindings = document.getElementById('guard-findings');
    const dpSummary = document.getElementById('guard-summary');
    const dpFilters = document.getElementById('guard-filters');
    if (dpFindings) {
      const crit = merged.filter((c) => c.severity === 'critical').length;
      const warn = merged.filter((c) => c.severity === 'warning').length;
      if (dpSummary) dpSummary.textContent = `${crit} crit · ${warn} warn · ${merged.length} total`;
      // EXE-style source filter chips: All, Browser, Console, Local (from actual finding sources)
      if (dpFilters && !dpFilters.dataset.wired) {
        dpFilters.dataset.wired = '1';
        dpFilters.onclick = (e) => {
          const btn = e.target.closest('[data-gsource]');
          if (!btn) return;
          state.guardSourceFilter = btn.dataset.gsource;
          for (const b of dpFilters.querySelectorAll('[data-gsource]')) b.classList.toggle('active', b === btn);
          renderFeed();
        };
      }
      if (dpFilters) {
        const srcOf = (c) => String(c.finding?.source || 'local').toLowerCase();
        const sources = ['all', ...new Set(merged.map(srcOf))];
        const active = state.guardSourceFilter || 'all';
        const counts = { all: merged.length };
        for (const c of merged) { const s = srcOf(c); counts[s] = (counts[s] || 0) + 1; }
        dpFilters.replaceChildren(...sources.map((s) => {
          const label = s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1);
          const b = el('button', `chip sm${s === active ? ' active' : ''}`, `${label} (${counts[s] || 0})`);
          b.dataset.gsource = s;
          return b;
        }));
      }
      const srcFilter = state.guardSourceFilter || 'all';
      const visible = merged.filter((c) => srcFilter === 'all' || String(c.finding?.source || 'local').toLowerCase() === srcFilter);
      dpFindings.replaceChildren(...collapseRepeats(visible).slice(0, 30).map(({ card: c, repeat }) => {
        const card = el('div', `guard-card ${c.severity}`);
        const head = el('div', 'guard-card-head');
        // EXE severity icons: ✕ critical, ? unknown, ✓ ok
        const icon = c.severity === 'critical' ? '✕' : c.severity === 'warning' ? '!' : c.severity === 'info' ? '✓' : '?';
        head.append(el('span', `severity ${c.severity}`, `${icon} ${c.severity.toUpperCase()}`));
        const sightings = Number(c.finding?.sightingCount || 0);
        if (sightings > 0 || repeat > 1) head.append(el('span', 'muted sm', `×${sightings || repeat}`));
        if (c.at) head.append(el('span', 'muted sm', formatTime(c.at)));
        // EXE has an Ack button on each card
        if (!c.ack && c.finding?.fingerprint) {
          const ackBtn = el('button', 'btn ghost sm', 'Ack');
          ackBtn.onclick = (e) => { e.stopPropagation(); ackFinding(c.finding.fingerprint); };
          head.append(ackBtn);
        } else if (!c.ack && !c.approval) {
          const ackBtn = el('button', 'btn ghost sm', 'Ack');
          ackBtn.onclick = (e) => { e.stopPropagation(); clearFeedCard(c.id); };
          head.append(ackBtn);
        }
        card.append(head, el('div', 'guard-card-title', c.title));
        if (c.body) card.append(el('div', 'muted sm', String(c.body).slice(0, 200)));
        // Panel parity with the main feed: a critical that is a decidable
        // approval carries its action buttons here too (owner's ask,
        // 2026-11-08) — deciding is what takes care of those reds.
        if (c.severity === 'critical' && c.approval?.canDecide) {
          const acts = el('div', 'actions');
          const ok = el('button', 'btn primary sm', 'Approve'); const no = el('button', 'btn ghost sm', 'Reject');
          ok.onclick = (e) => { e.stopPropagation(); decide(c.approval, 'approve'); };
          no.onclick = (e) => { e.stopPropagation(); if (card.querySelector('.confirm')) return; const cf = el('div', 'confirm'); cf.append(el('div', null, 'Reject this request?')); const r = el('div', 'actions'); const y = el('button', 'btn danger sm', 'Yes, reject'); const n = el('button', 'btn ghost sm', 'Cancel'); y.onclick = () => decide(c.approval, 'reject'); n.onclick = () => cf.remove(); r.append(y, n); cf.append(r); card.append(cf); };
          acts.append(ok, no);
          card.append(acts);
        }
        return card;
      }));
      if (!visible.length) dpFindings.replaceChildren(el('p', 'ew-note', 'All clear. Warnings from your agents and browser land here.'));
    }
  } catch {}
}
$('#feed-filter').onchange = renderFeed; $('#opt-info').onchange = renderFeed; $('#opt-approvals').onchange = renderFeed;
$('#feed-clear').onclick = () => { for (const id of state.ack) state.cleared.add(id); for (const e of state.events) state.cleared.add(`evt:${e.id}`); store.set('cleared', [...state.cleared]); renderFeed(); };
$('#feed-ack-all').onclick = async () => {
  const pending = (state.findings ?? []).filter((f) => !f.acked);
  for (const f of pending) { try { await post('/api/admin/guard/acks', { fingerprint: f.fingerprint }); } catch { /* keep going */ } }
  if (pending.length) toast(pending.length === 1 ? 'Finding acknowledged' : `${pending.length} findings acknowledged`);
  // Ack all clears the pile, not just the findings: every event card and
  // every finding card now in the feed is acknowledged and
  // removed for good via the persisted cleared set, so a reload cannot
  // resurrect them. Pending approvals are decisions, not notices — an ack
  // never clears them.
  const ids = feedAckClearIds({ events: state.events, findings: state.findings });
  if (ids.length) {
    for (const id of ids) { state.ack.add(id); state.cleared.add(id); }
    store.set('ack', [...state.ack]); store.set('cleared', [...state.cleared]);
  }
  await loadFeedData(); renderFeed();
};


// ---- Devices (GET /api/remote/v1/desktops; Herald Remote Control patterns) ----
// /app stays on witty-sawfly-97 (admin OIDC). Remote list needs Herald Clerk Bearer
// until Clerk is unified (docs/APP_PWA_UNIFY_PLAN.md). Empty/401 → Connect phone / enroll.
function remoteNonce() {
  const id = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${id}-${Date.now()}`;
}
// After Clerk unify, Herald accepts the same witty-sawfly-97 session. Load Clerk via
// /api/herald-config and send its session token as Bearer. Falls back silently.
let heraldClerk = null;
async function heraldToken() {
  try {
    if (!heraldClerk) {
      const cfg = await (await fetch('/api/herald-config', { credentials: 'same-origin' })).json();
      const pk = cfg?.accountIdentity?.configured ? cfg.accountIdentity.publishableKey : null;
      if (!pk) return null;
      const { loadClerkBrowser } = await import('/herald/account-runtime.js?v=15');
      heraldClerk = await loadClerkBrowser(pk);
    }
    return (await heraldClerk?.session?.getToken?.()) ?? null;
  } catch { return null; }
}
async function remoteApi(path, init = {}) {
  const token = await heraldToken();
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'x-helmian-nonce': remoteNonce(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || body.error || `HTTP ${res.status}`), { status: res.status, code: body.error, body });
  return body;
}
function renderDevices(model, statusText) {
  const list = $('#devices-list');
  const empty = $('#devices-empty');
  const status = $('#devices-status');
  status.textContent = statusText || '';
  if (!model || model.noDesktops !== false) {
    list.replaceChildren();
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  list.replaceChildren(...model.desktops.map((d) => {
    const card = el('div', 'device-card');
    card.dataset.desktopId = d.desktopId;
    const head = el('div', 'device-head');
    const forget = el('button', 'btn ghost sm', 'Forget');
    forget.type = 'button';
    forget.title = 'Forget this pairing so this Desktop can be paired again';
    forget.onclick = () => forgetDesktop(d, forget);
    head.append(el('strong', null, d.displayName), forget);
    card.append(head);
    if (!d.sessions.length) card.append(el('small', 'muted', 'Paired · no open session'));
    for (const s of d.sessions) {
      const b = el('button', 'device-row');
      b.type = 'button';
      b.dataset.desktopId = d.desktopId;
      b.dataset.sessionId = s.sessionId;
      b.append(el('strong', null, s.name), el('small', null, `${s.projectName} · ${s.state || 'unknown'}`));
      b.onclick = () => { location.href = '/herald/'; toast('Open Remote Control to drive this Desktop'); };
      card.append(b);
    }
    return card;
  }));
}
async function forgetDesktop(desktop, button) {
  if (!confirm(`Forget "${desktop.displayName}"? Remote Control stops for it now. To use it again, pair it from the Desktop app.`)) return;
  button.disabled = true;
  try {
    await remoteApi('/api/remote/v1/desktops', { method: 'POST', body: JSON.stringify(forgetDesktopPayload(desktop.desktopId)) });
    toast('Pairing forgotten. Pair again from the Desktop app.', 'ok');
  } catch (error) {
    toast(error.message || 'Could not forget this Desktop');
  } finally {
    button.disabled = false;
    await loadDevices();
  }
}
async function loadDevices() {
  const empty = $('#devices-empty');
  try {
    const body = await remoteApi('/api/remote/v1/desktops');
    const model = desktopsModel(body);
    renderDevices(model, model.noDesktops
      ? 'No live Desktop on this account yet — Connect phone or enroll below.'
      : 'Tap a session to open Remote Control. Forget unpairs a Desktop so you can pair it again.');
  } catch (error) {
    renderDevices({ empty: true, rows: [] }, error.status === 401 || error.status === 403
      ? 'Your linked PCs can\u2019t be listed from this page yet. You can still link a PC with the code from the Helmian desktop app or spoke below.'
      : (error.status === 503
        ? 'Remote Control is not configured yet.'
        : (error.message || 'Could not load Desktops.')));
    empty.hidden = false;
  }
}
$('#devices-enroll').onsubmit = async (e) => {
  e.preventDefault();
  const code = $('#devices-enroll-code').value.trim();
  if (!/^[0-9]{8}$/.test(code)) { toast('Enter the eight-digit code from the EXE'); return; }
  try {
    await remoteApi('/api/remote/v1/enrollment', {
      method: 'POST',
      body: JSON.stringify({ action: 'confirm', confirmationCode: code }),
    });
    toast('Desktop enrolled', 'ok');
    $('#devices-enroll-code').value = '';
    await loadDevices();
  } catch (error) {
    toast(error.status === 401 || error.status === 403
      ? 'Linking from this page isn\u2019t switched on yet. Try Connect phone, or open Remote Control'
      : (error.message || 'Enrollment failed'));
  }
};

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
async function loadApprovals() { await loadFeedData(); renderApprovals(); loadPcApprovals(); }
// Approve/Deny buttons for one Guard PC approval, wired to the shared decide
// route. Used by both the Approvals panel and the Upcoming queue.
function pcDecideButtons(a, refresh) {
  const row = el('div', 'row-btns left');
  for (const approve of [true, false]) {
    const b = el('button', approve ? 'btn primary sm' : 'btn ghost sm', approve ? 'Approve' : 'Deny');
    b.type = 'button';
    b.onclick = async () => {
      if (approve && !confirm(`Approve on your PC: ${a.summary || a.tool}?`)) return;
      b.disabled = true;
      try {
        const r = await fetch('/api/admin/guard/pc-approvals/decide', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalId: a.approvalId, approve }) });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
        toast(approve ? 'Approved. The AI can run it once.' : 'Denied. Nothing ran.', 'ok');
      } catch (error) { toast(error.message || 'Could not record the decision'); }
      refresh();
    };
    row.append(b);
  }
  return row;
}
// PC actions waiting in Executive Guard (hands connector). Owner-only; hidden when not set up.
async function loadPcApprovals() {
  const panel = $('#pc-approvals-panel');
  if (!panel) return;
  let body;
  try {
    const res = await fetch('/api/admin/guard/pc-approvals', { credentials: 'same-origin' });
    // Never a blank page: say why there is nothing to approve here. Guard's
    // owner-only rule is unchanged; this only explains it.
    if (res.status === 503 || res.status === 403 || res.status === 401) {
      panel.hidden = false;
      $('#pc-approvals-status').textContent = res.status === 503
        ? 'PC approvals are not switched on for this workspace yet. Once your PC is linked, Guard asks you here before anything runs on it.'
        : (res.status === 403
          ? 'PC actions are approved by the PC owner\u2019s account. Sign in with that account to Allow or Deny them.'
          : 'Sign in again to see PC actions waiting for you.');
      $('#pc-approvals').replaceChildren();
      return;
    }
    body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  } catch (error) { panel.hidden = false; $('#pc-approvals-status').textContent = `Guard is unreachable (${error.message}). Nothing will run until it answers.`; $('#pc-approvals').replaceChildren(); return; }
  panel.hidden = false;
  const items = Array.isArray(body.approvals) ? body.approvals : [];
  $('#pc-approvals-status').textContent = items.length ? 'An AI asked to run these on your PC. Nothing runs until you approve.' : 'No PC actions waiting.';
  $('#pc-approvals').replaceChildren(...items.map((a) => {
    const card = el('div', 'card');
    card.append(el('strong', null, a.summary || a.tool || 'PC action'), el('p', 'muted sm', `${a.reason || ''}${a.expiresAt ? ` · expires ${formatTime(a.expiresAt)}` : ''}`));
    card.append(pcDecideButtons(a, loadPcApprovals));
    return card;
  }));
}
// ---- upcoming: the whole Guard queue in one place ----
// Pending approvals are waiting on the human; approved ones are waiting on the
// PC to pick them up before their window closes. Sorted soonest expiry first
// by the proxy, so nothing waits invisibly.
function countdownLabel(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'expired';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `expires in ${mins}m`;
  return `expires in ${Math.floor(mins / 60)}h ${mins % 60}m`;
}
let upcomingTimer = null;
function setUpcomingBadge(total) {
  // The badge lived on the removed Upcoming nav entry (nav-build); the
  // Approvals queue still refreshes it, so it simply no-ops without one.
  const badge = $('#upcoming-badge'); if (badge) { badge.hidden = !total; badge.textContent = String(total || ''); }
}
async function fetchUpcoming() {
  const res = await fetch('/api/admin/guard/pc-upcoming', { credentials: 'same-origin' });
  if (res.status === 503 || res.status === 403 || res.status === 401) return null;
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
async function refreshUpcomingBadge() {
  try { const body = await fetchUpcoming(); setUpcomingBadge(body ? (body.counts?.total || 0) : 0); }
  catch { /* the badge is best-effort; the Upcoming view itself reports Guard problems */ }
}
async function loadUpcoming() {
  const box = $('#upcoming'); const status = $('#upcoming-status'); const expired = $('#upcoming-expired');
  if (!box) return;
  let body;
  try { body = await fetchUpcoming(); }
  catch (error) { status.textContent = `Guard is unreachable (${error.message}). Nothing will run until it answers.`; box.replaceChildren(); expired.hidden = true; return; }
  if (!body) { status.textContent = 'PC approvals are not set up for your account. Only the PC owner sees this queue.'; box.replaceChildren(); expired.hidden = true; setUpcomingBadge(0); return; }
  const queue = Array.isArray(body.queue) ? body.queue : [];
  const nowMs = Date.now();
  const activeQueue = queue.filter((a) => !a.expiresAt || Date.parse(a.expiresAt) > nowMs);
  const expiredQueue = queue.filter((a) => a.expiresAt && Date.parse(a.expiresAt) <= nowMs);
  setUpcomingBadge(activeQueue.length);
  status.textContent = activeQueue.length ? 'Soonest expiry first. Pending items wait on you; approved items are waiting for your PC to run them.' : 'Nothing is waiting right now. When an AI asks to act on your PC, it shows up here.';
  const renderCard = (a) => {
    const card = el('div', 'card');
    const who = [a.tool, a.site, a.deviceId ? `asked by ${a.deviceId}` : ''].filter(Boolean).join(' · ');
    const cd = el('span', null, a.expiresAt ? countdownLabel(a.expiresAt) : '');
    if (a.expiresAt) cd.dataset.expires = a.expiresAt;
    const meta = el('p', 'muted sm');
    meta.append(`${a.status === 'approved' ? 'Approved · waiting for your PC to run it' : 'Waiting on you'}${who ? ` · ${who}` : ''}${a.reason ? ` · ${a.reason}` : ''}${a.expiresAt ? ' · ' : ''}`, cd);
    card.append(el('strong', null, a.summary || a.tool || 'PC action'), meta);
    if (a.status === 'pending') card.append(pcDecideButtons(a, loadUpcoming));
    return card;
  };
  const nodes = activeQueue.map(renderCard);
  if (expiredQueue.length) {
    const details = el('details', 'card muted sm');
    const summary = el('summary', null, `${expiredQueue.length} older expired item${expiredQueue.length === 1 ? '' : 's'} (hidden)`);
    details.append(summary, ...expiredQueue.map(renderCard));
    nodes.push(details);
  }
  box.replaceChildren(...nodes);
  const n = body.counts?.expiredRecent || 0;
  expired.hidden = !n;
  if (n) expired.textContent = `${n} approval${n === 1 ? '' : 's'} expired in the last 24 hours before anyone decided.`;
  if (upcomingTimer) clearInterval(upcomingTimer);
  upcomingTimer = setInterval(() => {
    if (shell.dataset.view !== 'upcoming') return;
    for (const s of document.querySelectorAll('#upcoming [data-expires]')) s.textContent = countdownLabel(s.dataset.expires);
  }, 30000);
}
async function loadActivity() {
  await loadFeedData();
  const box = $('#timeline');
  if (!state.events.length) { box.replaceChildren(empty('No activity yet.', 'Actions from your team and agents will stream here.')); return; }
  box.replaceChildren(...state.events.slice(0, 50).map((e) => { const r = el('div', 'tl'); const w = el('div', 'what'); const pe = plainEvent(e); w.append(el('div', null, pe.title), el('div', 'meta', [pe.body, e.actorRole].filter(Boolean).join(' · '))); r.append(el('div', 'when', formatTime(e.createdAt)), el('div', 'rail'), w); return r; }));
}
async function loadEvidence() {
  await loadFeedData();
  const tb = $('#evidence');
  if (!state.events.length) { const tr = el('tr'); const td = el('td', 'muted', 'No evidence recorded yet.'); td.colSpan = 4; tr.append(td); tb.replaceChildren(tr); }
  else tb.replaceChildren(...state.events.slice(0, 100).map((e) => { const tr = el('tr'); const st = el('span', `status ${String(e.status).toUpperCase() === 'ALLOW' ? 'ok' : 'warn'}`, String(e.status ?? '').toLowerCase()); const td = el('td'); td.append(st); tr.append(el('td', 'muted', formatTime(e.createdAt)), el('td', null, plainEvent(e).title), el('td', 'muted', e.actorRole || ''), td); return tr; }));
  // Handoffs and checkpoints are owner/admin-only reads; members see a note.
  const note = $('#evidence-note');
  const [h, c] = await Promise.allSettled([api('/api/admin/maestro/handoffs?limit=20'), api('/api/admin/maestro/checkpoints?limit=20')]);
  const hb = $('#evidence-handoffs'); const cb = $('#evidence-checkpoints');
  if (h.status === 'fulfilled') {
    const list = Array.isArray(h.value.handoffs) ? h.value.handoffs : [];
    hb.replaceChildren(...(list.length ? list.map((x) => { const card = el('article', 'card'); card.append(el('div', 'title', `#${x.id} · ${x.direction}`), el('div', 'meta', `${x.status} · ${x.projectSlug} · ${formatTime(x.createdAt)}`)); if (x.summary) card.append(el('div', 'sm', x.summary)); return card; }) : [el('p', 'muted sm', 'No handoffs recorded.')]));
  } else hb.replaceChildren();
  if (c.status === 'fulfilled') {
    const list = Array.isArray(c.value.checkpoints) ? c.value.checkpoints : [];
    cb.replaceChildren(...(list.length ? list.map((x) => { const card = el('article', 'card'); card.append(el('div', 'title', `#${x.id} · ${x.coordinatorId}`), el('div', 'meta', `${x.projectSlug} · ${formatTime(x.createdAt)}`), el('div', 'sm', x.workCompleted || ''), el('div', 'meta', `Next safe action: ${x.nextSafeAction || '—'}`)); return card; }) : [el('p', 'muted sm', 'No checkpoints recorded.')]));
  } else cb.replaceChildren();
  const denied = (h.status === 'rejected' && h.reason?.status === 403) || (c.status === 'rejected' && c.reason?.status === 403);
  note.textContent = denied ? 'Handoffs and checkpoints are visible to owners and admins.' : '';
}
let integrationsMod = null; let qrMod = null; let connectFieldsMod = null; let apiKeyFieldsMod = null; let connectorManageMod = null;
async function loadIntegrations() {
  // A loading line lands in the page at once: the view's empty hint
  // ("Nothing connected yet") keys off this box sitting empty, and
  // the reads below take long enough on a cold landing that the hint
  // showed as a false empty state (live exercise, 2026-11-09). The
  // sections render replaces the line when the reads are in.
  const intBox = $('#integrations');
  if (intBox && !intBox.children.length) intBox.replaceChildren(el('p', 'muted sm', 'Loading integrations…'));
  // A Manage-road landing (the composer panel's Manage row) leaves
  // one-shot markers naming the seat and tab it wants. The Manage
  // surface itself only mounts at the END of this function, after
  // the reads below, and its box keeps the previous mount's rows
  // until then — the landing's first paint was the remembered
  // seat's list (live walk, 2026-11-09 ~18:00). Paint the surface's
  // loading line into its box NOW, at landing time, so the first
  // paint is never the remembered seat's rows. The markers are
  // only peeked here: mountConnectorManage still consumes the seat
  // marker, and the tab marker is consumed further down.
  try {
    if (sessionStorage.getItem('helmian.manageSeat') || sessionStorage.getItem('helmian.manageTab')) {
      const mb = $('#connector-manage');
      if (mb) mb.replaceChildren(el('p', 'cm-loading muted sm', 'Loading connectors…'));
    }
  } catch {}
  integrationsMod ??= await import('./integrations-view.mjs');
  connectFieldsMod ??= await import('./connect-fields.mjs');
  apiKeyFieldsMod ??= await import('./api-key-fields.mjs');
  const [c, p, pr, u, o, tc] = await Promise.allSettled([api('/api/admin/cora/connectors'), api('/api/admin/provider-connections'), api('/api/admin/envoy/runner/presence'), api('/api/admin/cora/usage'), api('/api/admin/overview'), api('/api/admin/tool-connections')]);
  const sections = integrationsMod.integrationSections({ connectors: c.value ?? {}, providers: p.value ?? {}, presence: pr.status === 'fulfilled' ? pr.value?.presence ?? [] : null, toolConnections: tc.status === 'fulfilled' ? tc.value?.connections ?? [] : null, usage: u.value ?? null, overview: o.value ?? null });
  const box = $('#integrations');
  box.replaceChildren(...sections.map((sec) => {
    const wrap = el('section', 'int-section'); wrap.dataset.intSection = sec.id; wrap.append(el('h3', 'int-head', sec.title));
    const grid = el('div', 'int-grid'); wrap.append(grid);
    for (const card of sec.cards) grid.append(integrationCard(card));
    return wrap;
  }));
  for (const q of box.querySelectorAll('[data-qr]')) drawQr(q, q.dataset.qr);
  // The per-seat Manage surface (mirror M1) mounts under the account
  // cards: connector-manage.mjs owns its own reads and writes against
  // the connector library routes.
  const manageBox = $('#connector-manage');
  if (manageBox) {
    connectorManageMod ??= await import('./connector-manage.mjs');
    await connectorManageMod.mountConnectorManage(manageBox, { api, el, role: state.actor?.role ?? '' }).catch(() => {});
  }
  // Freshly rendered sections start visible; re-apply the remembered
  // Integrations tab so a re-render never dumps every section back out.
  // A Manage-road landing (the composer panel's Manage row) names its
  // tab in a one-shot marker ('helmian.manageTab', connector-manage's
  // MANAGE_TAB_STORAGE_KEY): it opens on Connectors, and selecting it
  // here persists the choice like any other tab pick.
  let wantedTab = store.get('integrationsTab', 'agents');
  try {
    if (sessionStorage.getItem('helmian.manageTab') === 'connectors') {
      wantedTab = 'connectors';
      sessionStorage.removeItem('helmian.manageTab');
    }
  } catch {}
  selectIntegrationsTab(wantedTab);
  return p.value;
}
function integrationCard(card) {
  if (card.qr && matchMedia('(max-width: 900px) and (pointer: coarse)').matches) card = { ...card, blurb: 'Keep Helmian one tap away on this phone.', statusText: 'Add to Home Screen' };
  const a = el('article', `int-card ${card.qr ? 'wide' : ''}`.trim()); a.dataset.key = card.key;
  const icon = el('span', 'int-icon');
  const INT_SVG = {
    'profile-sync': '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#38BDF8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>',
    pc: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    phone: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>',
    usage: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>',
    keys: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>',
    data: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
  };
  if (card.icon?.img) { const img = el('img'); img.src = card.icon.img; img.alt = ''; img.width = 26; img.height = 26; icon.append(img); }
  else if (card.icon?.tile) { const tile = el('span', 'int-tile', card.icon.tile.glyph); tile.style.setProperty('--ava', card.icon.tile.color); icon.append(tile); }
  else if (card.icon?.mark) icon.append(el('span', `ew-${card.icon.mark === 'github' ? 'gh' : card.icon.mark}-mark`));
  else if (INT_SVG[card.key]) icon.innerHTML = INT_SVG[card.key];
  else icon.textContent = card.icon?.glyph ?? '';
  // R2 resting row (Integrations redesign §2): icon, name and state
  // on one line, ONE button at the right (appended below) — nothing
  // else at rest. The second-line slot carries the account line on a
  // connected AI seat (the working account's exact email, plus the
  // stack count when the seat holds more than one), and on a card
  // with no expansion it carries the one-line description, so no
  // card's words are lost by compacting.
  const text = el('div', 'int-text');
  const line1 = el('div', 'int-line1');
  line1.append(el('div', 'int-name', card.name));
  const state = el('span', `int-state ${card.status}`);
  state.append(el('span', 'int-dot'), el('span', 'int-state-words', card.statusText));
  line1.append(state);
  text.append(line1);
  const expandable = Boolean(card.connect || card.apiKeyConnect || card.changeConnect || card.changeApiKey);
  if (card.accountEmail) text.append(el('div', 'int-sub', `${card.accountEmail}${card.accountCount > 1 ? ` · ${card.accountCount} accounts` : ''}`));
  else if (!expandable) text.append(el('div', 'int-sub', card.blurb));
  const top = el('div', 'int-top'); top.append(icon, text); a.append(top);
  if (card.qr) { const q = el('div', 'int-qr'); q.dataset.qr = card.qr; q.setAttribute('role', 'img'); q.setAttribute('aria-label', 'QR code that opens Helmian on your phone'); const steps = el('ol', 'int-steps'); const onPhone = matchMedia('(max-width: 900px) and (pointer: coarse)').matches; for (const t of onPhone ? ['You are on your phone already.', 'Tap Share, then Add to Home Screen to keep Helmian one tap away.'] : ['Point your phone camera at the code.', 'Sign in with this same account.', 'Tap Share, then Add to Home Screen.']) steps.append(el('li', '', t)); const row = el('div', 'int-qr-row'); row.append(q, steps); a.append(row); }
  // R2: an AI card's whole working surface — the description, the
  // connect fields, the change road — lives in the Manage expansion,
  // opened in place by the resting row's one button (Connect when
  // signed out, Manage when connected). One card open at a time.
  // Nothing about the roads themselves changes: same components, same
  // submit paths, same words — only where they sit.
  if (expandable) {
    const open = el('div', 'int-open'); open.hidden = true;
    open.append(el('div', 'int-blurb', card.blurb));
    // The one connect road (2026-11-01): a not-connected AI card carries
    // the shared email + password fields. A successful store re-reads the
    // page from the connections store — the card's next status is the
    // store's, never the click's.
    if (card.connect && connectFieldsMod) {
      const fields = connectFieldsMod.createConnectFields({ provider: card.connect.provider, post, onStored: () => loadIntegrations() });
      if (fields) open.append(fields);
    }
    // The provider-catalog seats connect with a pasted key instead (one
    // key, or Cloudflare's two pieces): same store, same re-read after a
    // successful save — the card's next status is the store's.
    if (card.apiKeyConnect && apiKeyFieldsMod) {
      const fields = apiKeyFieldsMod.createApiKeyFields({ provider: card.apiKeyConnect.provider, fields: card.apiKeyConnect.fields, post, onStored: () => loadIntegrations() });
      if (fields) open.append(fields);
    }
    // The change road (owner's order, 2026-11-06): a connected card
    // carries a plain button — "New username and password" on a sign-in
    // seat, "New API key" on a key seat — that opens the same fields in
    // change mode. Saving stores the new values over the old ones
    // through the same connect route, and the page then re-reads the
    // store exactly as a first connect does.
    const changeSpec = card.changeConnect && connectFieldsMod
      ? { label: card.changeConnect.label, make: () => connectFieldsMod.createConnectFields({ provider: card.changeConnect.provider, connected: true, change: true, post, onStored: () => loadIntegrations() }) }
      : card.changeApiKey && apiKeyFieldsMod
        ? { label: card.changeApiKey.label, make: () => apiKeyFieldsMod.createApiKeyFields({ provider: card.changeApiKey.provider, fields: card.changeApiKey.fields, connected: true, change: true, post, onStored: () => loadIntegrations() }) }
        : null;
    if (changeSpec) {
      const row = el('div', 'int-actions');
      const b = el('button', 'btn sm', changeSpec.label);
      b.type = 'button';
      let form = null;
      b.onclick = () => {
        if (form) { form.remove(); form = null; return; }
        form = changeSpec.make();
        if (form) open.append(form);
      };
      row.append(b);
      open.append(row);
    }
    const connected = Boolean(card.changeConnect || card.changeApiKey);
    const btn = el('button', `btn sm ${connected ? '' : 'primary'}`.trim(), connected ? 'Manage' : 'Connect');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    btn.onclick = () => {
      const willOpen = open.hidden;
      const scope = a.closest('#integrations') ?? a.parentElement;
      if (scope) {
        for (const other of scope.querySelectorAll('.int-open')) if (other !== open) other.hidden = true;
        for (const other of scope.querySelectorAll('.int-card.open')) if (other !== a) other.classList.remove('open');
        for (const other of scope.querySelectorAll('[aria-expanded="true"]')) if (other !== btn) other.setAttribute('aria-expanded', 'false');
      }
      open.hidden = !willOpen;
      a.classList.toggle('open', willOpen);
      btn.setAttribute('aria-expanded', String(willOpen));
    };
    top.append(btn);
    a.append(open);
  }
  // Cards with no expansion keep their one action in the resting row —
  // the same link or act button the card has always carried (chat and
  // device cards, usage). A connected AI card's model action (Manage)
  // is the expansion above, not the old link to the Agents view: this
  // tab is the home for signing in and accounts (redesign §1).
  if (!expandable && card.action) {
    if (card.action.href) { const link = el('a', `btn sm ${card.status === 'on' ? '' : 'primary'}`.trim(), card.action.label); link.href = card.action.href; top.append(link); }
    else {
      const b = el('button', 'btn sm primary', card.action.label);
      b.type = 'button';
      b.onclick = async () => {
        if (card.action.act === 'sync-profile') {
          b.disabled = true; b.textContent = 'Syncing…';
          await triggerProfileSync();
          b.disabled = false; b.textContent = 'Synced ✓';
          await loadIntegrations();
          return;
        }
        // The help act (pc-help) opens the guidance panel below.
        // There is deliberately no branch here that POSTs a presence
        // claim: a click in a browser cannot verify a connection, and
        // the server now degrades any member presence write to a sync
        // stamp anyway. (Honest-connection fix, 2026-11-01 — the old
        // one-click branch manufactured "connected" out of nothing
        // but the click.)
        const open = a.querySelector('.int-help'); if (open) { open.remove(); return; }
        const [title, lines] = integrationsMod.HELP[card.action.act] ?? ['', []];
        const help = el('div', 'int-help');
        help.append(el('strong', '', title), ...lines.map((t) => el('p', 'muted sm', t)));
        if (card.action.act === 'pc-help') { const g = el('a', 'btn sm', 'Get started'); g.href = '/get-started'; help.append(g); }
        a.append(help);
      };
      top.append(b);
    }
  }
  return a;
}
async function drawQr(node, text) {
  try {
    qrMod ??= (await import('./vendor/qrcode.mjs')).default;
    const q = qrMod(0, 'M'); q.addData(text); q.make();
    const n = q.getModuleCount(); const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `-2 -2 ${n + 4} ${n + 4}`); svg.setAttribute('shape-rendering', 'crispEdges');
    const bg = document.createElementNS(svg.namespaceURI, 'rect'); bg.setAttribute('x', '-2'); bg.setAttribute('y', '-2'); bg.setAttribute('width', String(n + 4)); bg.setAttribute('height', String(n + 4)); bg.setAttribute('fill', '#fff'); svg.append(bg);
    let d = ''; for (let r = 0; r < n; r += 1) for (let c = 0; c < n; c += 1) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); path.setAttribute('fill', '#0b1018'); svg.append(path);
    node.replaceChildren(svg);
  } catch { node.replaceChildren(el('p', 'muted sm', text)); }
}
async function loadInvites() {
  if (!isAdminRole(state.actor?.role)) return;
  $('#invite-panel').hidden = false;
  try {
    const body = await api('/api/admin/organization/invites');
    const list = (body.invites ?? []).filter((i) => i.active);
    $('#invite-list').replaceChildren(...(list.length ? list.map((i) => { const r = row(`Link · used ${i.useCount}/${i.maxUses}`, `expires ${formatTime(i.expiresAt)}`); const off = el('button', 'btn ghost sm', 'Turn off'); off.onclick = async () => { await post('/api/admin/organization/invites/revoke', { id: i.id }).catch(() => {}); loadInvites(); }; r.append(off); return r; }) : [el('p', 'muted sm', 'No active invite links.')]));
  } catch { $('#invite-list').replaceChildren(el('p', 'muted sm', 'Invite links will be available shortly.')); }
}
$('#invite-create').onclick = async () => {
  try { const r = await post('/api/admin/organization/invites', { expiresInDays: 7, maxUses: 25 }); $('#invite-new').hidden = false; $('#invite-url').value = r.invite.url; $('#invite-sms').href = smsInviteHref(r.invite.url); $('#invite-url').select(); loadInvites(); }
  catch { toast('Could not create an invite link — try again'); }
};
$('#invite-copy').onclick = async () => { try { await navigator.clipboard.writeText($('#invite-url').value); toast('Invite link copied', 'ok'); } catch { $('#invite-url').select(); } };
$('#desktop-link').onclick = async () => {
  try { const r = await post('/api/admin/desktop/link/start', { label: 'Helmian desktop' }); const c = $('#desktop-code'); c.hidden = false; c.textContent = r.code; toast('Code is valid for 10 minutes'); }
  catch { toast('Could not create a code — try again'); }
};
// ---- providers (connection status) ----
// Every AI connects on its card on the Integrations page (the owner's
// law, 2026-11-01): the sign-in seats with their account email and
// password (or in the Create Custom Agent dialog), and the
// provider-catalog seats with a pasted key. The seat then works off
// that saved connection. These Settings cards are status
// only — they render the same truth the Integrations page reads, and
// offer no connect road of their own. The old roads that used to live
// here (PC-spoke CLI sign-in instructions, runner-vault API-key
// instructions, plan steering) were removed in the one-road removal
// pass (Bite 12, 2026-11-02).
const PROVIDER_META = [
  { key: 'claude', label: 'Claude' },
  { key: 'openai', label: 'ChatGPT' },
  { key: 'grok', label: 'Grok' },
  { key: 'gemini', label: 'Gemini' },
  { key: 'antigravity', label: 'Antigravity', how: 'none', note: 'Google does not allow other apps to use Antigravity sign-in. Keep using Antigravity in its own app; Helmian can still show its status from the desktop app.' },
  { key: 'xai', label: 'xAI API' },
  { key: 'mistral', label: 'Mistral Le Chat' },
  { key: 'runway', label: 'Runway' },
  { key: 'ollama', label: 'Local Ollama' },
  { key: 'groq', label: 'Groq' },
  { key: 'nvidia', label: 'NVIDIA' },
  { key: 'cloudflare', label: 'Cloudflare' },
  { key: 'openrouter', label: 'OpenRouter' },
];
// The provider-catalog seats connect with a pasted key on their
// Integrations card, not an email and password — their Settings note
// says so instead of pointing at the sign-in road.
const API_KEY_PROVIDER_KEYS = new Set(['groq', 'nvidia', 'cloudflare', 'openrouter']);
// The word "Connected" on these cards comes from the provider
// connections store alone — the same store, and the same rule, the
// Agents page reads (a saved row is the connection). The runner
// presence feed can only add "Synced": it is a device report and a sync
// stamp, and a sync connects nothing, so a presence row on its own
// reads "Synced · Not connected". When the connections read never
// arrives, no "Not connected" is claimed either — the card says so.
// One more state presence can earn (2026-11-01): "Answered". The reply
// path stamps the row when an agent actually posts a reply back, so a
// provider carrying a last-answered time has proven its road works —
// the card says that, and a provider that has never answered does not
// read as connected.
// The names each provider is saved under in that store — the same lists
// app-model.mjs keeps for the Integrations rows.
const PROVIDER_CONNECTION_NAMES = Object.freeze({
  claude: ['anthropic', 'claude'], openai: ['openai'], grok: ['xai', 'grok'], gemini: ['google', 'gemini'],
  xai: ['xai'], mistral: ['mistral'], runway: ['runway'], ollama: ['ollama'],
  groq: ['groq'], nvidia: ['nvidia'], cloudflare: ['cloudflare'], openrouter: ['openrouter'],
});
async function loadProviders() {
  const box = $('#providers-cards');
  let presence = [];
  try { const body = await api('/api/admin/envoy/runner/presence'); presence = Array.isArray(body.presence) ? body.presence : []; }
  catch { presence = null; }
  let connections = null;
  try { const body = await api('/api/admin/provider-connections'); connections = Array.isArray(body.connections) ? body.connections : null; }
  catch { connections = null; }
  const byProvider = new Map((presence || []).map((r) => [String(r.provider).toLowerCase(), r]));
  box.replaceChildren(...PROVIDER_META.map((meta) => {
    const { key, label } = meta;
    const row = byProvider.get(key);
    const conn = connections
      ? connections.find((c) => (PROVIDER_CONNECTION_NAMES[key] ?? [key]).includes(String(c?.providerId ?? c?.provider ?? c?.providerKey ?? '').toLowerCase())) ?? null
      : null;
    const connected = Boolean(conn);
    const card = el('article', 'card');
    const icon = agentIconFor(label);
    card.append(el('div', 'title', icon ? `${icon} ${label}` : label));
    // What may be claimed, in order: a saved connection (the Agents
    // rule) → Connected. A presence row carrying a last-answered stamp
    // → Answered (the agent has replied through this road before). A
    // presence row with the connections read answered → Synced · Not
    // connected. The connections read answered and no row anywhere →
    // Not connected. A presence row alone → Synced. A read that never
    // arrived claims nothing.
    let status;
    if (meta.how === 'none') status = 'Not supported';
    else if (conn) status = 'Connected';
    else if (row?.lastAnsweredAt) status = 'Answered';
    else if (connections && row) status = 'Synced · Not connected';
    else if (connections) status = 'Not connected';
    else if (row) status = 'Synced';
    else status = 'Status unavailable';
    const metaRow = el('div', 'meta');
    metaRow.append(el('span', `status ${connected || status === 'Answered' ? 'ok' : ''}`, status));
    card.append(metaRow);
    if (connected && (conn.updatedAt || conn.updated_at)) card.append(el('div', 'meta muted sm', `since ${formatTime(conn.updatedAt || conn.updated_at)}`));
    if (!connected && row?.updatedAt && (status === 'Synced' || status === 'Synced · Not connected')) card.append(el('div', 'meta muted sm', `synced ${formatTime(row.updatedAt)}`));
    if (!connected && row?.lastAnsweredAt) card.append(el('div', 'meta muted sm', `last answered ${formatTime(row.lastAnsweredAt)}`));
    if (meta.how === 'none') { card.append(el('p', 'muted sm', meta.note)); return card; }
    if (connected) return card;
    // Status only: connecting happens on the Integrations page, with
    // the account's email and password on the provider's card — the
    // one road. (The connect buttons that used to sit here — PC-spoke
    // sign-in, API key, and the one-click presence claim before them —
    // are gone; Bite 12, 2026-11-02.)
    card.append(el('p', 'muted sm', API_KEY_PROVIDER_KEYS.has(key)
      ? 'Connect it on the Integrations page — paste its key right on its card.'
      : 'Connect it on the Integrations page — email and password, right on its card.'));
    return card;
  }));
}

async function triggerProfileSync() {
  const statusEl = $('#sync-profile-status');
  const filesEl = $('#sync-profile-files');
  if (statusEl) statusEl.textContent = 'Syncing rules, flywheel & Guard hooks to all AIs…';
  if (filesEl) { filesEl.hidden = true; filesEl.replaceChildren(); }
  try {
    // The press enqueues a real profile-sync job for this tenant's PC
    // (S1, 2026-11-05). The response carries no file list — the only
    // list this surface may render is the device's own report, polled
    // from the job below. Before S1 this handler rendered the server's
    // hardcoded syncedFiles as if files had been written; none had.
    const r = await post('/api/admin/envoy/runner/presence', { syncProfile: true });
    const jobId = r?.syncJob?.id ?? null;
    if (!jobId) {
      if (statusEl) statusEl.textContent = 'Sync did not start: the server did not queue a job for your PC.';
      toast('Could not sync profile right now');
      return;
    }
    const render = (model) => {
      if (statusEl) statusEl.textContent = model.statusText;
      if (filesEl) {
        if (model.lines.length) {
          filesEl.hidden = false;
          filesEl.replaceChildren(...model.lines.map((line) => el('div', 'sm', `✓ ${line}`)));
        } else {
          filesEl.hidden = true;
          filesEl.replaceChildren();
        }
      }
    };
    render(profileSyncResultModel({ status: 'pending' }));
    // Poll the job until the device reports or the wait gives out. A
    // timeout is NOT a success: the surface keeps saying nothing has
    // been reported, because nothing has.
    const deadline = Date.now() + 120_000;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const s = await api(`/api/admin/envoy/profile-sync?job=${encodeURIComponent(jobId)}`);
      const job = s?.job ?? null;
      const model = profileSyncResultModel(job);
      render(model);
      if (model.state === 'done') {
        toast(`Profile sync reported by your PC: ${job.files?.length ?? 0} file(s) written`, 'ok');
        await loadProviders().catch(() => {});
        return;
      }
      if (model.state === 'failed') {
        toast('Profile sync failed on your PC');
        return;
      }
      if (Date.now() > deadline) {
        if (statusEl) statusEl.textContent = 'Still waiting for your PC — if the bridge is not running, nothing will land. Nothing has been reported yet.';
        return;
      }
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = `Sync failed: ${err.message || 'try again'}`;
    toast('Could not sync profile right now');
  }
}
if ($('#sync-profile-btn')) $('#sync-profile-btn').onclick = () => triggerProfileSync();
if ($('#ew-foot-sync-profile')) $('#ew-foot-sync-profile').onclick = () => triggerProfileSync();

// ---- set up this PC (spoke download + one-time pairing code) ----
function detectOs() {
  const ua = `${navigator.userAgentData?.platform || ''} ${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
  if (ua.includes('android')) return 'android';
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod')) return 'ios';
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('linux') || ua.includes('x11')) return 'linux';
  return 'unknown';
}
if ($('#setup-pc')) $('#setup-pc').onclick = async () => {
  const os = detectOs();
  const note = $('#setup-pc-note');
  const isPhone = os === 'android' || os === 'ios';
  if (os !== 'windows' && !isPhone) {
    note.textContent = os === 'macos' ? 'The Mac spoke is coming soon. Windows is ready now.' : os === 'linux' ? 'The Linux spoke is coming soon. Windows is ready now.' : 'Open this page on the Windows PC you want to set up.';
    return;
  }
  $('#setup-pc-steps').hidden = false;
  note.textContent = '';
  if (os === 'windows') {
    const a = document.createElement('a');
    a.href = '/api/admin/spoke/download?os=windows';
    a.rel = 'noopener';
    document.body.append(a); a.click(); a.remove();
  }
  const codeEl = $('#setup-pc-code');
  codeEl.textContent = 'making code...';
  try {
    const r = await post('/api/admin/spoke/pair-code', {});
    codeEl.textContent = r.code;
    note.textContent = isPhone
      ? 'You are on your phone — enter this 10-minute code in the Helmian Spoke installer on your Windows PC.'
      : 'The code works once and runs out in 10 minutes. Press Set up this PC again for a new one.';
  } catch (error) {
    codeEl.textContent = 'not available';
    note.textContent = error.status === 503 ? 'Pairing codes are not switched on yet. When the installer asks, type your hands passphrase instead.' : 'Could not make a pairing code right now. When the installer asks, type your hands passphrase instead.';
  }
};
if ($('#setup-pc-copy')) $('#setup-pc-copy').onclick = async () => {
  const t = $('#setup-pc-code').textContent;
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(t)) return;
  try { await navigator.clipboard.writeText(t); toast('Code copied', 'ok'); } catch { toast('Copy failed'); }
};

// ---- onboarding checklist (first run) ----
async function loadOnboarding() {
  const box = $('#onboarding');
  if (!box || store.get('onboardingDismissed')) { if (box) box.hidden = true; return; }
  let channels = [], presence = [];
  try { const c = await api('/api/admin/envoy/channels'); channels = Array.isArray(c.channels) ? c.channels : []; } catch {}
  try { const r = await api('/api/admin/envoy/runner/presence'); presence = Array.isArray(r.presence) ? r.presence : []; } catch {}
  const steps = [
    { done: presence.length > 0, label: 'Pair your bridge or runner', hint: 'Settings, then Link desktop app.' },
    { done: channels.length > 0, label: 'Create your team channel', hint: 'Chat, then + Channel.' },
    { done: presence.some((r) => r.connected), label: 'Connect an AI provider', hint: 'Settings, then AI Providers.' },
  ];
  if (steps.every((s) => s.done)) { box.hidden = true; return; }
  box.hidden = false;
  $('#onboarding-list').replaceChildren(...steps.map((s) => {
    const li = el('li', s.done ? 'done' : '');
    const text = el('div', 'grow'); text.append(el('span', 'l', s.label), el('div', 'muted sm', s.hint));
    li.append(el('span', `check${s.done ? ' on' : ''}`, s.done ? '✓' : ''), text);
    return li;
  }));
}
$('#onboarding-dismiss').onclick = () => { store.set('onboardingDismissed', true); $('#onboarding').hidden = true; };


// ---- Envoy Profile (nickname + avatar) ----
const AVATAR_EMOJIS = ['😀','😎','🤖','👾','🐶','🐱','🦊','🐼','🦁','🐯','🦄','🐝','🌟','⚡','🔥','💎','🎯','🚀','🌈','🍕','🎮','🎸','📚','⚽','🎨','🌊','🏔️','🌙','☀️','⭐'];

let selectedAvatar = null;

async function loadProfile() {
  try {
    const profile = await api('/api/admin/profile');
    if (profile.nickname) $('#profile-nickname').value = profile.nickname;
    if (profile.avatarEmoji) {
      selectedAvatar = profile.avatarEmoji;
    }
  } catch (e) {
    // Profile not set yet, that's fine
  }
  renderAvatarPicker();
}

function renderAvatarPicker() {
  const container = $('#profile-avatars');
  if (!container) return;
  // Maestro Library faces lead the picker (face-library bite): the
  // glossy avatar pieces as stills. A pick stores the piece's token in
  // the same avatarEmoji field an emoji pick uses — one save path.
  const libraryButtons = LIBRARY_FACES.map((face) => {
    const token = libraryFaceToken(face.slug);
    const btn = el('button', 'avatar-option avatar-option-lib' + (selectedAvatar === token ? ' selected' : ''), '');
    btn.type = 'button';
    btn.title = face.label;
    btn.setAttribute('aria-label', 'Avatar ' + face.label);
    const img = document.createElement('img');
    img.src = libraryFaceStillUrl(face.slug, 128);
    img.alt = '';
    img.width = 28;
    img.height = 28;
    img.loading = 'lazy';
    btn.append(img);
    btn.onclick = () => {
      selectedAvatar = token;
      renderAvatarPicker();
    };
    return btn;
  });
  container.replaceChildren(...libraryButtons, ...AVATAR_EMOJIS.map(emoji => {
    const btn = el('button', 'avatar-option' + (selectedAvatar === emoji ? ' selected' : ''), emoji);
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Avatar ' + emoji);
    btn.onclick = () => {
      selectedAvatar = emoji;
      renderAvatarPicker();
    };
    return btn;
  }));
}

async function saveProfile() {
  const nickname = $('#profile-nickname').value.trim();
  if (!nickname) {
    toast('Enter a nickname', 'error');
    return;
  }
  try {
    await api('/api/admin/profile', {
      method: 'POST',
      body: JSON.stringify({ nickname, avatarEmoji: selectedAvatar })
    });
    toast('Profile saved', 'ok');
  } catch (e) {
    toast(e?.status === 503 ? 'Profiles aren\u2019t switched on yet. The owner needs to run one database update.' : 'Could not save profile', 'error');
  }
}

async function loadSettings() {
  loadInvites();
  loadProviders();
  loadProfile();
  const saveBtn = $('#profile-save');
  if (saveBtn && !saveBtn.dataset.wired) {
    saveBtn.dataset.wired = '1';
    saveBtn.onclick = saveProfile;
  }
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

async function loadAgents() {
  const [p, s] = await Promise.allSettled([api('/api/admin/provider-connections'), api('/api/admin/app/sessions')]);
  const model = agentsModel(p.value ?? {}, s.value ?? {});
  const cards = $('#agents-cards');
  cards.replaceChildren(...model.agents.map((a) => {
    const card = el('article', 'card');
    const icon = agentIconFor(a.name);
    card.append(el('div', 'title', icon ? `${icon} ${a.name}` : a.name), el('div', 'meta'));
    card.lastChild.append(el('span', `status ${a.connected ? 'ok' : ''}`, a.connected ? 'Connected' : 'Not connected'));
    if (a.connected && a.lifecycle) card.append(el('div', 'meta', a.lifecycle));
    return card;
  }));
  const sess = $('#agents-sessions');
  if (!model.active.length) sess.replaceChildren(el('p', 'muted sm', 'No open sessions. Start one from Chat.'));
  else sess.replaceChildren(...model.active.map((r) => {
    const d = el('div', 'run');
    d.append(el('div', 'n'));
    d.firstChild.append(el('strong', null, r.name), el('span', 'muted sm', r.provider));
    d.onclick = () => { location.hash = 'console'; };
    d.style.cursor = 'pointer';
    return d;
  }));
  const det = $('#agents-detail-list');
  det.replaceChildren(...model.agents.filter((a) => a.connected).flatMap((a) => [
    row(a.name, [a.authMode, a.adapter, a.lifecycle].filter(Boolean).join(' · ') || 'saved'),
  ]));
  if (!det.childElementCount) det.replaceChildren(el('p', 'muted sm', 'No provider details yet. Connect providers from Integrations or the desktop app.'));
}
$('#agents-refresh').onclick = () => Promise.all([loadAgents(), loadAgentSessions()]).then(() => toast('Agents refreshed', 'ok')).catch(() => toast('Could not refresh'));

// ---- Agent sessions (migration 058): named agent rows ----
const SESSION_STATUS_COLORS = { idle: 'grey', active: 'green', warning: 'yellow', error: 'red' };
const SESSION_PROVIDERS = ['maestro', 'claude', 'openai', 'grok', 'gemini'];
const SESSION_TIERS = ['auto', 'fast', 'standard', 'deep'];

async function loadAgentSessions() {
  const sess = $('#agents-sessions');
  try {
    const res = await api('/api/admin/envoy/agents/sessions');
    const sessions = res.sessions ?? [];
    state.agentSessions = sessions;
    renderAgentSessions(sess, sessions);
  } catch (e) {
    sess.replaceChildren(el('p', 'muted sm', 'Could not load sessions.'));
  }
}

function renderAgentSessions(container, sessions) {
  // Header with count and New button
  const head = el('div', 'row-btns left');
  head.style.marginBottom = '12px';
  const count = el('span', 'muted sm', `${sessions.length} session${sessions.length === 1 ? '' : 's'}`);
  const newBtn = el('button', 'btn primary sm', '+ New session');
  newBtn.type = 'button';
  newBtn.onclick = () => showNewSessionDialog();
  head.append(count, newBtn);

  if (!sessions.length) {
    container.replaceChildren(head, el('p', 'muted sm', 'No agent sessions yet. Create one to get started.'));
    return;
  }

  const grid = el('div', 'grid');
  for (const s of sessions) {
    const card = el('article', 'card session-card');
    const color = SESSION_STATUS_COLORS[s.status] ?? 'grey';

    // Header: icon + name + close button
    const header = el('div', 'session-head');
    const icon = agentIconFor(s.name);
    const title = el('div', 'title', icon ? `${icon} ${s.name}` : s.name);
    const closeBtn = el('button', 'btn sm icon-btn', '✕');
    closeBtn.type = 'button';
    closeBtn.title = 'Close session';
    closeBtn.setAttribute('aria-label', 'Close session');
    closeBtn.onclick = (e) => { e.stopPropagation(); closeAgentSession(s.id, s.name); };
    header.append(title, closeBtn);

    // Meta: provider + status + tier
    const meta = el('div', 'meta');
    const dot = el('span', `status-dot ${color}`);
    dot.style.display = 'inline-block';
    dot.style.width = '8px';
    dot.style.height = '8px';
    dot.style.borderRadius = '50%';
    dot.style.marginRight = '6px';
    dot.style.background = color === 'green' ? '#22c55e' : color === 'yellow' ? '#eab308' : color === 'red' ? '#ef4444' : '#9ca3af';
    meta.append(dot, el('span', null, `${s.provider} · ${s.status}`));
    if (s.routingTier && s.routingTier !== 'auto') meta.append(el('span', 'muted sm', ` · ${s.routingTier}`));

    card.append(header, meta);

    // Last message preview
    if (s.lastMessage) {
      const preview = el('div', 'muted sm session-preview');
      preview.textContent = s.lastMessage.length > 120 ? s.lastMessage.slice(0, 117) + '...' : s.lastMessage;
      preview.style.marginTop = '8px';
      card.append(preview);
    }

    grid.append(card);
  }
  container.replaceChildren(head, grid);
  // Sync to desktop Agents panel (EXE clone)
  try {
    const dpList = document.getElementById('agents-list');
    const dpCount = document.getElementById('agents-count');
    if (dpList) {
      if (dpCount) dpCount.textContent = sessions.length;
      dpList.replaceChildren(...sessions.map((s) => {
        const card = el('div', 'agent-card');
        const head = el('div', 'agent-card-head');
        const avatar = el('span', 'room-avatar', (s.name || '?').slice(0, 1).toUpperCase());
        // EXE status colors: GREY idle, GREEN live, YELLOW trouble, RED error
        const statusMap = { idle: 'GREY', active: 'GREEN', warning: 'YELLOW', error: 'RED' };
        const exeStatus = statusMap[String(s.status || 'idle').toLowerCase()] || 'GREY';
        const dot = el('span', `member-status ${exeStatus.toLowerCase()}`);
        const name = el('strong', null, s.name);
        const status = el('span', `muted sm status-${exeStatus.toLowerCase()}`, `${s.provider} - ${exeStatus}`);
        const close = el('button', 'icon-btn sm', '×');
        close.onclick = (e) => { e.stopPropagation(); closeAgentSession(s.id, s.name); };
        head.append(avatar, dot, name, status, close);
        const body = el('div', 'muted sm', s.last_message || 'No messages yet — send from Maestro while this agent is selected.');
        card.append(head, body);
        return card;
      }));
    }
  } catch {}
}

function showNewSessionDialog(defaultProvider) {
  // EXE-style dialog: "New Claude agent. Name it so you can tell it apart in the manager."
  const overlay = el('div', 'dialog-overlay');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000;';
  const dialog = el('div', 'card');
  dialog.style.cssText = 'min-width:340px;max-width:90vw;padding:20px;';

  const providerLabel = el('label', 'muted sm', 'Provider');
  const providerSelect = el('select', 'input');
  providerSelect.style.cssText = 'width:100%;margin:4px 0 12px;';
  for (const p of SESSION_PROVIDERS) {
    const opt = el('option', null, p.charAt(0).toUpperCase() + p.slice(1));
    opt.value = p;
    providerSelect.append(opt);
  }
  if (defaultProvider) providerSelect.value = defaultProvider;
  const title = el('h3', null, `New ${providerSelect.options[providerSelect.selectedIndex].text} agent. Name it so you can tell it apart in the manager.`);
  providerSelect.onchange = () => { title.textContent = `New ${providerSelect.options[providerSelect.selectedIndex].text} agent. Name it so you can tell it apart in the manager.`; };
  dialog.append(title);

  const nameInput = el('input', 'input');
  nameInput.type = 'text';
  nameInput.placeholder = 'e.g. Claude muse';
  nameInput.style.cssText = 'width:100%;margin:4px 0 12px;';
  dialog.append(nameInput);

  dialog.append(el('div', 'muted sm', 'Optional session details · reasoning/model routing'));
  const tierRow = el('div', 'row-btns');
  tierRow.style.cssText = 'display:flex;gap:8px;margin:4px 0 16px;';
  const tierSelect = el('select', 'input');
  tierSelect.style.cssText = 'flex:0 0 120px;';
  for (const t of SESSION_TIERS) {
    const opt = el('option', null, t.charAt(0).toUpperCase() + t.slice(1));
    opt.value = t;
    tierSelect.append(opt);
  }
  const detailInput = el('input', 'input');
  detailInput.type = 'text';
  detailInput.placeholder = 'Details…';
  detailInput.style.cssText = 'flex:1;';
  tierRow.append(tierSelect, detailInput);
  dialog.append(tierRow);

  const btnRow = el('div', 'row-btns');
  const cancelBtn = el('button', 'btn sm', 'Cancel');
  cancelBtn.type = 'button';
  cancelBtn.onclick = () => overlay.remove();
  const createBtn = el('button', 'btn primary sm', 'Start session');
  createBtn.type = 'button';
  createBtn.onclick = async () => {
    const name = nameInput.value.trim();
    if (!name) { toast('Give the session a name', 'error'); return; }
    try {
      await api('/api/admin/envoy/agents/sessions', {
        method: 'POST',
        body: JSON.stringify({ name, provider: providerSelect.value, routingTier: tierSelect.value }),
      });
      overlay.remove();
      toast('Session created', 'ok');
      loadAgentSessions();
    } catch (e) {
      toast('Could not create session', 'error');
    }
  };
  btnRow.append(cancelBtn, createBtn);
  dialog.append(btnRow);
  overlay.append(dialog);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  document.body.append(overlay);
  nameInput.focus();
}

async function closeAgentSession(id, name) {
  if (!confirm(`Close session "${name}"?`)) return;
  try {
    await api('/api/admin/envoy/agents/sessions', {
      method: 'DELETE',
      body: JSON.stringify({ id }),
    });
    toast('Session closed', 'ok');
    loadAgentSessions();
  } catch (e) {
    toast('Could not close session', 'error');
  }
}


async function loadCreate() {
  const status = $('#create-status');
  const box = $('#create-history');
  try {
    const body = await api('/api/admin/cora/artifacts');
    const model = createModel(body);
    if (model.empty) box.replaceChildren(empty(es('✨ No requests yet — describe what you want to create.', 'No requests yet — describe what you want to create.')));
    else {
      const wrap = el('div', 'create-hist');
      wrap.replaceChildren(...model.receipts.map((r) => {
        const b = el('button', 'hist-row');
        b.type = 'button';
        b.append(el('strong', null, r.title), el('small', null, `${r.type} · ${r.status}${r.sources ? ` · ${r.sources} source${r.sources === 1 ? '' : 's'}` : ''}`));
        b.onclick = () => {
          $('#create-detail-list').replaceChildren(
            row('Title', r.title),
            row('Type', r.type),
            row('Status', r.status),
            row('Department', r.department || '—'),
            row('Receipt', r.id || '—'),
            row('Objective', r.objective || '—'),
          );
          $('#create-details').open = true;
          status.textContent = 'Showing details for this request. Generation still happens on the desktop app.';
        };
        return b;
      }));
      box.replaceChildren(wrap);
    }
    if (!status.textContent) status.textContent = model.empty ? '' : `${model.receipts.length} request${model.receipts.length === 1 ? '' : 's'} on file.`;
  } catch (error) {
    box.replaceChildren(empty('Could not load Create history', error.status === 403 ? 'Organization membership is required.' : 'Try again in a moment.'));
  }
}
$('#create-refresh').onclick = () => { $('#create-status').textContent = 'Refreshing…'; loadCreate().then(() => toast('History refreshed', 'ok')).catch(() => toast('Could not refresh')); };
$('#create-form').onsubmit = async (e) => {
  e.preventDefault();
  const prompt = $('#create-prompt').value.trim();
  if (!prompt) { toast('Describe what you want to create'); return; }
  const title = prompt.split(/\n/)[0].slice(0, 240);
  const payload = createIntentPayload({
    title,
    objective: prompt,
    type: $('#create-type').value,
    department: $('#create-department').value,
    sourcesText: $('#create-sources').value,
    stage: 'draft',
  });
  $('#create-review').disabled = true;
  $('#create-status').textContent = 'Recording review…';
  try {
    const result = await post('/api/admin/cora/artifacts', payload);
    $('#create-prompt').value = '';
    $('#create-status').textContent = result.replayed
      ? 'That request was already on file.'
      : 'Review recorded. Open the desktop Create panel to approve and generate.';
    toast('Review recorded', 'ok');
    await loadCreate();
  } catch (error) {
    $('#create-status').textContent = error.status === 403
      ? 'You need organization access to record a Create request.'
      : (error.message || 'Could not record review');
    toast('Review not recorded');
  } finally {
    $('#create-review').disabled = false;
  }
};

// ---- workbench panel: Browser (validated launcher) ----
function clientValidBrowserUrl(value) {
  // Basic client-side mirror of the server policy; the server is authoritative.
  const candidate = String(value ?? '').trim();
  if (!candidate || candidate.length > 4096) return 'Enter a public HTTPS website address.';
  const withScheme = candidate.includes('://') ? candidate : `https://${candidate}`;
  let url;
  try { url = new URL(withScheme); } catch { return 'Helmian Browser opens public HTTPS websites only.'; }
  if (url.protocol !== 'https:' || !url.hostname) return 'Helmian Browser opens public HTTPS websites only.';
  if (url.username || url.password) return 'Website addresses containing embedded credentials are refused.';
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return 'Local and private-network websites are outside the Browser boundary.';
  return null;
}
$('#browser-form').onsubmit = async (e) => {
  e.preventDefault();
  const status = $('#browser-status');
  const wrap = $('#browser-viewport-wrap');
  const viewport = $('#browser-viewport');
  const clientError = clientValidBrowserUrl($('#browser-url').value);
  if (clientError) { status.textContent = clientError; return; }
  status.textContent = 'Checking…';
  try {
    const result = await post('/api/admin/browser/navigate', { url: $('#browser-url').value.trim() });
    const embedUrl = toEmbeddableUrl(result.url);
    // YouTube homepage and channel pages block iframe embedding.
    // If it's YouTube without a video ID, don't show a broken iframe.
    try {
      const u = new URL(result.url);
      const host = u.hostname.toLowerCase();
      const isYouTube = host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com' || host === 'youtu.be';
      if (isYouTube && embedUrl === result.url) {
        status.textContent = 'YouTube blocks embedding this page. Paste a video link, or open it outside Helmian.';
        viewport.dataset.externalUrl = result.url;
        wrap.hidden = false;
        viewport.src = 'about:blank';
        return;
      }
    } catch {}
    if (result.embedHtml && embedUrl === result.url) {
      viewport.removeAttribute('src');
      viewport.srcdoc = result.embedHtml;
    } else {
      viewport.removeAttribute('srcdoc');
      viewport.src = embedUrl;
    }
    wrap.hidden = false;
    viewport.dataset.externalUrl = result.url;
    status.textContent = 'Loaded inside Helmian. Recorded in the audit trail.';
  } catch (error) {
    status.textContent = error.body?.message || error.message || 'That address was not accepted.';
  }
};
$('#browser-open-external').onclick = () => {
  const url = $('#browser-viewport').dataset.externalUrl;
  if (url) window.open(url, '_blank', 'noopener');
};

// YouTube watch pages refuse framing, but the /embed/ player is made for it.
function toEmbeddableUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const shortId = (s) => (s && /^[\w-]{11}$/.test(s) ? s : null);
    if (host === 'www.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com') {
      const id = shortId(u.searchParams.get('v'))
        || (u.pathname.startsWith('/shorts/') ? shortId(u.pathname.split('/')[2]) : null)
        || (u.pathname.startsWith('/embed/') ? shortId(u.pathname.split('/')[2]) : null);
      if (id) return `https://www.youtube.com/embed/${id}`;
    }
    if (host === 'youtu.be') {
      const id = shortId(u.pathname.split('/')[1]);
      if (id) return `https://www.youtube.com/embed/${id}`;
    }
  } catch { /* fall through to the original URL */ }
  return url;
}

// ---- workbench panel: Canvas (per-project scratchpad + decision log) ----
function renderDecisionLog(decisions, unavailable) {
  const list = $('#canvas-decisions');
  list.replaceChildren();
  if (unavailable) {
    list.append(el('li', 'muted sm', es('📝 The decision log is not available yet — ask your admin to run the database migrations.', 'The decision log is not available yet — ask your admin to run the database migrations.')));
    return;
  }
  if (!decisions.length) {
    list.append(el('li', 'muted sm', es('📝 No decisions recorded yet — they will appear here.', 'No decisions recorded yet — they will appear here.')));
    return;
  }
  for (const d of decisions) {
    const item = el('li', 'decision-entry');
    item.append(el('div', null, d.decisionText ?? ''));
    const meta = el('div', 'muted sm', d.recordedAt ? formatTime(d.recordedAt) : '');
    item.append(meta);
    list.append(item);
  }
}
async function loadCanvas() {
  const status = $('#canvas-status');
  const projectKey = state.activeProjectKey;
  $('#canvas-project').textContent = projectKey ?? '';
  const body = $('#canvas-body');
  $('#canvas-decision-input').placeholder = es('📝 Record a decision…', 'Record a decision…');
  if (!projectKey) {
    body.hidden = true;
    status.textContent = es('🎨 Pick a project first — the canvas is saved per project.', 'Pick a project first — the canvas is saved per project.');
    return;
  }
  body.hidden = false;
  status.textContent = 'Loading…';
  try {
    const data = await api(`/api/admin/workspace/canvas?projectKey=${encodeURIComponent(projectKey)}`);
    if (state.activeProjectKey !== projectKey) return;
    $('#canvas-note').value = data.noteText ?? '';
    renderDecisionLog(data.decisions ?? [], !!data.decisionsUnavailable);
    status.textContent = data.canvasUnavailable
      ? 'Canvas storage is not available yet.'
      : (data.updatedAt ? `Saved ${formatTime(data.updatedAt)} · no provider call` : 'Empty canvas — no provider call.');
  } catch {
    status.textContent = 'Could not load the canvas — try again in a moment.';
  }
}
$('#canvas-save').onclick = async () => {
  const projectKey = state.activeProjectKey;
  const status = $('#canvas-status');
  if (!projectKey) { status.textContent = es('🎨 Pick a project first — the canvas is saved per project.', 'Pick a project first — the canvas is saved per project.'); return; }
  status.textContent = 'Saving…';
  try {
    await api('/api/admin/workspace/canvas', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectKey, noteText: $('#canvas-note').value }) });
    status.textContent = 'Saved · no provider call';
    toast('Canvas saved');
  } catch (error) {
    status.textContent = error.status === 404 ? 'That project no longer exists.' : 'Not saved — try again.';
  }
};
$('#canvas-decision-record').onclick = async () => {
  const projectKey = state.activeProjectKey;
  const status = $('#canvas-status');
  const input = $('#canvas-decision-input');
  if (!projectKey) { status.textContent = es('🎨 Pick a project first — the canvas is saved per project.', 'Pick a project first — the canvas is saved per project.'); return; }
  const decisionText = input.value.trim();
  if (!decisionText) { status.textContent = es('📝 Write the decision first, then record it.', 'Write the decision first, then record it.'); return; }
  status.textContent = 'Recording…';
  try {
    await api('/api/admin/workspace/canvas/decisions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectKey, decisionText }) });
    input.value = '';
    status.textContent = 'Decision recorded · no provider call';
    await loadCanvas();
  } catch (error) {
    status.textContent = error.status === 404 ? 'That project no longer exists.' : error.status === 503 ? 'The decision log is not available yet.' : 'Not recorded — try again.';
  }
};

// ---- workbench panel: Preview (receipt gallery, metadata only) ----
function previewTitle(descriptor) {
  if (descriptor && typeof descriptor === 'object') {
    for (const key of ['title', 'name', 'label', 'artifact']) {
      if (typeof descriptor[key] === 'string' && descriptor[key].trim()) return descriptor[key].trim();
    }
  }
  return 'Artifact';
}
async function loadPreview() {
  const box = $('#preview-list');
  box.replaceChildren(el('p', 'muted sm', 'Loading…'));
  try {
    const body = await api('/api/admin/runs/ledger?limit=50');
    const runs = (Array.isArray(body.runs) ? body.runs : []).filter((r) => r.kind === 'artifact_execution' && r.outcome === 'completed');
    if (!runs.length) {
      box.replaceChildren(empty(es('👁 Nothing generated yet — finished runs will appear here.', 'Nothing generated yet — finished runs will appear here.')));
      return;
    }
    box.replaceChildren(...runs.map((r) => {
      const card = el('article', 'preview-card');
      card.append(el('div', 't', previewTitle(r.descriptor)));
      card.append(el('div', 'meta', `Completed ${formatTime(r.completedAt || r.createdAt)}${r.reportedBy ? ` · reported by ${r.reportedBy}` : ''}`));
      if (r.descriptor && typeof r.descriptor === 'object') {
        const dl = el('dl');
        for (const [k, v] of Object.entries(r.descriptor).slice(0, 12)) dl.append(el('dt', null, k), el('dd', null, String(v)));
        card.append(dl);
      }
      if (r.scriptContentHash) card.append(el('div', 'hash', `script sha256: ${r.scriptContentHash}`));
      card.append(el('div', 'meta', `receipt ${r.receipt}`));
      return card;
    }));
  } catch (error) {
    box.replaceChildren(empty('Preview receipts are not available.', error.status === 403 ? 'Owners and admins can see artifact receipts.' : 'Try again in a moment.'));
  }
}
$('#preview-refresh').onclick = () => loadPreview().catch(() => {});

// Desktop view = the Envoy workspace (channels | chat | agents | workbench).
// The module owns its own DOM wiring; app.js hands it the shared context.
let workspaceModule = null;
async function loadDesktop() {
  wireRail();
  workspaceModule ??= await import('./envoy-workspace.js');
  await loadFeedData().catch(() => {});
  await workspaceModule.mountWorkspace({
    api, post, toast, state,
    openTools,
    wireVoice: wireMaestroVoiceChips,
    wireCliVoice: wireCliVoiceChips,
    // Spoken replies for the Envoy room (bite 2d): envoy calls this for
    // new non-mine messages; the shared controller speaks only in voice
    // mode. The view gate keeps exactly one surface speaking — while
    // the session console is up, its own poll (loadLog) is the speaker
    // and Envoy stays silent.
    voiceSpeak: (text, seat, ref) => (shell.dataset.view === 'console' ? false : voice.speak(text, seat, ref)),
    renderFeed,
    loadFeedData,
    ackAll: () => document.getElementById('feed-ack-all')?.click(),
    loadGuardPreview,
    loadGuardCreateList,
    benchTab: state.pendingBenchTab ?? null,
  });
  state.pendingBenchTab = null;
  wireGuardCreate();
}

// Left nav: unpinned it rests as an icon rail that peeks open on hover or
// keyboard focus (the .peek styles live in envoy.css, desktop pointers
// only); the pin button on the rail itself keeps it expanded. The pin
// choice is remembered. Touch uses the pin — there is no hover to catch.
function wireRail() {
  const sidebar = document.getElementById('sidebar');
  const shellEl = document.querySelector('.shell');
  const btn = document.getElementById('rail-pin');
  if (!sidebar || !shellEl || sidebar.dataset.railWired) return;
  sidebar.dataset.railWired = '1';
  const setRail = (on) => {
    sidebar.classList.toggle('rail', on); shellEl.classList.toggle('sidebar-rail', on);
    if (btn) { btn.setAttribute('aria-pressed', String(!on)); btn.title = on ? 'Pin navigation open' : 'Unpin navigation (folds to the icon rail)'; }
  };
  // First visit starts unpinned at EVERY width (Troy's final word,
  // 2026-11-08): the rail is the rest state, hover opens it, and the
  // pin is the user's own choice to keep it open. A stored choice
  // still wins over this default.
  let pinned = store.get('navPinned', false);
  setRail(!pinned);
  if (btn) btn.onclick = () => { pinned = !pinned; store.set('navPinned', pinned); setRail(!pinned); };
  // "More" (visible at rest in rail mode only, envoy.css) is the hint that
  // sections are folded away; it takes the same way out as the pin button.
  const more = document.getElementById('rail-more');
  if (more && btn) more.onclick = () => btn.click();
  sidebar.addEventListener('mouseenter', () => sidebar.classList.add('peek'));
  sidebar.addEventListener('mouseleave', () => sidebar.classList.remove('peek'));
  sidebar.addEventListener('focusin', () => sidebar.classList.add('peek'));
  sidebar.addEventListener('focusout', (e) => { if (!sidebar.contains(e.relatedTarget)) sidebar.classList.remove('peek'); });
}

function wireGuardCreate() {
  const gCreateForm = document.getElementById('guard-create-form');
  if (!gCreateForm || gCreateForm.dataset.wired) return;
  gCreateForm.dataset.wired = '1';
  gCreateForm.onsubmit = async (e) => {
    e.preventDefault();
    const input = document.getElementById('guard-create-prompt');
    const prompt = input.value.trim();
    if (!prompt) { toast('Describe what you want to create'); return; }
    const status = document.getElementById('guard-create-status');
    status.textContent = 'Recording…';
    try {
      const payload = createIntentPayload({ title: prompt.split(/\n/)[0].slice(0, 240), objective: prompt, type: 'other', department: '', sourcesText: '', stage: 'draft' });
      const result = await post('/api/admin/cora/artifacts', payload);
      input.value = '';
      status.textContent = result.replayed ? 'That request was already on file.' : 'Review recorded.';
      toast('Review recorded', 'ok');
      loadGuardCreateList();
    } catch (error) {
      status.textContent = error.message || 'Could not record review';
    }
  };
}

function insertMaestroDictation(text) {
  const box = document.getElementById('maestro-input');
  if (!box) return;
  const start = box.selectionStart ?? box.value.length;
  const end = box.selectionEnd ?? box.value.length;
  const before = box.value.slice(0, start);
  const after = box.value.slice(end);
  // Spoken mentions (mention-buttons bite): this function is the room
  // composer's DICTATION insert path — its only callers are the voice
  // handlers (onTranscript / onSubmit) — so the spoken-mention mapping
  // lives here and typed text never sees it. The chunk opens a mention
  // only when the insert point is itself a message start or a sentence
  // boundary; mid-sentence inserts keep the dictated words as spoken.
  const mapped = mapSpokenMentions(text, SPOKEN_MENTION_TAGS, {
    leadingBoundary: before.trim() === '' || /[.!?…]\s*$/.test(before) || /\n\s*$/.test(before),
  });
  const sep = before && !/[\s\n]$/.test(before) ? ' ' : '';
  box.value = before + sep + mapped + after;
  const pos = before.length + sep.length + mapped.length;
  box.setSelectionRange(pos, pos);
  // Same path typed text takes (bite 2b): envoy's input listener on
  // this box grows it and refreshes the slash menu + crew targeting.
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.focus();
}

function updateMaestroVoiceChips() {
  for (const [id, mode] of [['maestro-dictate', 'dictate'], ['maestro-voice', 'voice']]) {
    const chip = document.getElementById(id);
    if (!chip) continue;
    const active = voice.voiceMode && voice.mode === mode;
    chip.classList.toggle('recording', active);
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  const toggle = document.getElementById('maestro-voicetoggle');
  if (toggle) toggle.textContent = voice.voiceMode ? 'voice: on' : 'voice: off';
}

function toggleMaestroVoice(mode) {
  clearInterim(document.getElementById('maestro-input'));
  if (voice.voiceMode && voice.mode === mode) {
    voice.setVoiceMode(false, { onState: updateMaestroVoiceChips });
  } else {
    if (voice.voiceMode) voice.setVoiceMode(false, {});
    if (!store.get('voicePrivacySeen', false)) { toast(voicePrivacy(mode)); store.set('voicePrivacySeen', true); }
    voice.setVoiceMode(true, {
      mode,
      onInterim: (text) => renderInterim(document.getElementById('maestro-input'), text),
      onTranscript: (text) => {
        const box = document.getElementById('maestro-input');
        clearInterim(box);
        insertMaestroDictation(text);
        if (checkMaestroForSendCommand() && box?.value.trim()) { const f = document.getElementById('maestro-form'); if (f) f.requestSubmit(); }
      },
      onSubmit: (text) => { clearInterim(document.getElementById('maestro-input')); if (text) insertMaestroDictation(text); const f = document.getElementById('maestro-form'); if (document.getElementById('maestro-input').value.trim() && f) f.requestSubmit(); },
      onState: updateMaestroVoiceChips,
      onError: (msg) => { clearInterim(document.getElementById('maestro-input')); toast(msg); updateMaestroVoiceChips(); },
    });
    // Voice-on catch-up (catch-up bite): the room speaks the newest
    // seat reply that landed before voice chat was switched on —
    // the owner's ask-everybody-then-listen move. The workspace
    // module owns the pick; dictate never catches up.
    if (mode === 'voice') workspaceModule?.speakCatchUp?.();
  }
  updateMaestroVoiceChips();
}

function wireMaestroVoiceChips() {
  for (const [id, mode] of [['maestro-dictate', 'dictate'], ['maestro-voice', 'voice']]) {
    const chip = document.getElementById(id);
    if (!chip || chip.dataset.wired) continue;
    chip.dataset.wired = '1';
    chip.title = voicePrivacy(mode);
    if (!voice.supported) {
      chip.disabled = true;
      chip.title = 'Voice is not supported by this browser — you can still type.';
    } else {
      chip.onclick = () => toggleMaestroVoice(mode);
    }
  }
  const toggle = document.getElementById('maestro-voicetoggle');
  if (toggle && !toggle.dataset.wired) {
    toggle.dataset.wired = '1';
    toggle.title = 'Toggle voice mode';
    toggle.onclick = () => toggleMaestroVoice(voice.voiceMode ? 'dictate' : 'voice');
  }
  const slash2 = document.getElementById('maestro-slash2');
  if (slash2 && !slash2.dataset.wired) {
    slash2.dataset.wired = '1';
    slash2.onclick = () => {
      const input = document.getElementById('maestro-input');
      if (!input) return;
      if (!input.value.startsWith('/')) input.value = '/' + input.value;
      input.focus();
    };
  }
}

// Voice for the Workspace agent CLI pane (#ew-cli-*): the same voice
// engine as the chat composer, dictation lands in the CLI prompt box.
function insertCliDictation(text) {
  const box = document.getElementById('ew-cli-input');
  if (!box) return;
  const start = box.selectionStart ?? box.value.length;
  const end = box.selectionEnd ?? box.value.length;
  const before = box.value.slice(0, start);
  const after = box.value.slice(end);
  const sep = before && !/[\s\n]$/.test(before) ? ' ' : '';
  box.value = before + sep + text + after;
  const pos = before.length + sep.length + text.length;
  box.setSelectionRange(pos, pos);
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.focus();
}

function updateCliVoiceChips() {
  for (const [id, mode] of [['ew-cli-dictate', 'dictate'], ['ew-cli-voice', 'voice']]) {
    const chip = document.getElementById(id);
    if (!chip) continue;
    const active = voice.voiceMode && voice.mode === mode;
    chip.classList.toggle('recording', active);
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function toggleCliVoice(mode) {
  clearInterim(document.getElementById('ew-cli-input'));
  const onState = () => { updateCliVoiceChips(); updateMaestroVoiceChips(); };
  if (voice.voiceMode && voice.mode === mode) {
    voice.setVoiceMode(false, { onState });
  } else {
    if (voice.voiceMode) voice.setVoiceMode(false, {});
    if (!store.get('voicePrivacySeen', false)) { toast(voicePrivacy(mode)); store.set('voicePrivacySeen', true); }
    voice.setVoiceMode(true, {
      mode,
      onInterim: (text) => renderInterim(document.getElementById('ew-cli-input'), text),
      onTranscript: (text) => {
        const box = document.getElementById('ew-cli-input');
        clearInterim(box);
        insertCliDictation(text);
        if (checkCliForSendCommand() && box?.value.trim()) { const f = document.getElementById('ew-cli-form'); if (f) f.requestSubmit(); }
      },
      onSubmit: (text) => { clearInterim(document.getElementById('ew-cli-input')); if (text) insertCliDictation(text); const f = document.getElementById('ew-cli-form'); if (document.getElementById('ew-cli-input')?.value.trim() && f) f.requestSubmit(); },
      onState,
      onError: (msg) => { clearInterim(document.getElementById('ew-cli-input')); toast(msg); updateCliVoiceChips(); },
    });
  }
  updateCliVoiceChips();
  updateMaestroVoiceChips();
}

function wireCliVoiceChips() {
  for (const [id, mode] of [['ew-cli-dictate', 'dictate'], ['ew-cli-voice', 'voice']]) {
    const chip = document.getElementById(id);
    if (!chip || chip.dataset.wired) continue;
    chip.dataset.wired = '1';
    chip.title = voicePrivacy(mode);
    if (!voice.supported) {
      chip.disabled = true;
      chip.title = 'Voice is not supported by this browser — you can still type.';
    } else {
      chip.onclick = () => toggleCliVoice(mode);
    }
  }
}

async function loadGuardPreview() {
  const status = document.getElementById('guard-preview-status');
  const list = document.getElementById('guard-preview-list');
  status.textContent = 'Loading…';
  try {
    const body = await api('/api/admin/runs/ledger?limit=50');
    const runs = (Array.isArray(body.runs) ? body.runs : []).filter((r) => r.kind === 'artifact_execution' && r.outcome === 'completed');
    status.textContent = runs.length ? `${runs.length} finished.` : 'Nothing generated yet.';
    list.replaceChildren(...runs.slice(0, 20).map((r) => {
      const card = el('div', 'guard-card');
      card.append(el('strong', 'sm', previewTitle(r.descriptor)), el('div', 'muted sm', `${r.kind} · ${r.outcome}`));
      return card;
    }));
  } catch { status.textContent = 'Could not load previews.'; }
}

async function loadGuardCreateList() {
  const list = document.getElementById('guard-create-list');
  const status = document.getElementById('guard-create-status');
  try {
    const body = await api('/api/admin/cora/artifacts');
    const model = createModel(body);
    if (!status.textContent) status.textContent = model.empty ? 'No requests yet.' : `${model.receipts.length} on file.`;
    list.replaceChildren(...model.receipts.slice(0, 15).map((r) => {
      const card = el('div', 'guard-card');
      card.append(el('strong', 'sm', r.title), el('div', 'muted sm', `${r.type} · ${r.status}`));
      return card;
    }));
  } catch { if (!list.children.length) status.textContent = 'Could not load.'; }
}

const loaders = { home: loadHome, desktop: loadDesktop, console: () => Promise.all([loadConsole(), loadSteps()]), overview: loadOverview, workspace: loadProjects, devices: loadDevices, settings: loadSettings, activity: loadActivity, evidence: loadEvidence, approvals: loadApprovals, upcoming: loadUpcoming, integrations: loadIntegrations, agents: () => Promise.all([loadAgents(), loadAgentSessions()]), release: loadRelease };
const panelLoaders = { browser: null, canvas: loadCanvas, preview: loadPreview, create: loadCreate };

// ---- empty states: a new account sees what to do next, never a bare title ----
function wireEmptyHints() {
  for (const hint of document.querySelectorAll('.empty-hint[data-empty-for]')) {
    const target = document.getElementById(hint.dataset.emptyFor);
    if (!target) continue;
    const update = () => { hint.hidden = target.children.length > 0 || target.textContent.trim() !== ''; };
    update();
    new MutationObserver(update).observe(target, { childList: true, subtree: true, characterData: true });
  }
}
wireEmptyHints();

// ---- bottom-corner account menu (sidebar foot; model: account-menu.mjs) ----
const acctBtn = $('#account-menu-btn');
const acctMenu = $('#account-menu');
const acctPanel = $('#account-panel');
const acctPanelBody = $('#account-panel-body');
// Bumped on every panel open/close: an async panel draw that lands after
// the person has moved on (another panel, or closed) must not overwrite
// what is on screen now.
let acctPanelSeq = 0;
function closeAccountMenu() { acctMenu.hidden = true; acctBtn.setAttribute('aria-expanded', 'false'); }
function closeAccountPanel() { acctPanelSeq++; acctPanel.hidden = true; }
function openAccountPanel(title) {
  acctPanelSeq++;
  $('#account-panel-title').textContent = title;
  acctPanel.hidden = false;
  closeAccountMenu();
}
acctBtn.onclick = (e) => {
  e.stopPropagation();
  closeWorkspaceMenu();
  if (acctMenu.hidden) { acctMenu.hidden = false; acctBtn.setAttribute('aria-expanded', 'true'); }
  else closeAccountMenu();
};
document.addEventListener('click', (e) => { if (!e.target.closest('.acct-wrap')) closeAccountMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeAccountMenu(); closeAccountPanel(); } });
$('#account-panel-close').onclick = closeAccountPanel;

// ---- workspace switcher (sidebar foot, above the account block) ----
// The server contract (src/cloud/live-admin.mjs, live on main):
// GET /api/admin/workspace/memberships answers { memberships:
// [{ tenantId, name, role, selected }] } in created order, its
// selected row resolved by the same deriver the session read uses;
// POST /api/admin/workspace/select { tenantId } records the pick in
// the signed helmian_tenant cookie and answers the picked row, or
// refuses 403 WORKSPACE_SELECTION_MEMBERSHIP_REQUIRED and sets no
// cookie. Until the memberships read lands, the button carries the
// name and role boot() renders from the session actor — the same
// values the account block below shows; the read then replaces them
// with the selected row's own name and role. Stored names are shown
// exactly as returned; a missing name falls back the way
// workspaceName() does (a tenant UUID is never shown to a person).
const wsBtn = $('#workspace-switch-btn');
const wsMenu = $('#workspace-menu');
const wsMenuList = $('#workspace-menu-list');
const wsMenuNote = $('#workspace-menu-note');
const wsState = { memberships: null, failed: false, switching: false };
function closeWorkspaceMenu() { if (!wsMenu) return; wsMenu.hidden = true; wsBtn.setAttribute('aria-expanded', 'false'); }
function wsDisplayName(row, actor = state.actor) {
  const named = String(row?.name ?? '').trim();
  if (named) return named;
  return row?.tenantId && actor?.tenantId === row.tenantId ? workspaceName(actor) : friendlyWorkspace(row?.tenantId);
}
function selectedWorkspaceStoredName() {
  const rows = Array.isArray(wsState.memberships) ? wsState.memberships : null;
  const named = String(rows?.find((r) => r.selected)?.name ?? '').trim();
  return named || null;
}
// The room's header title names the workspace you are in: while the
// desktop view is showing, the topbar title carries the selected
// membership's stored name once the memberships read has landed.
// With no stored name the view's own title stands ("Workspace").
function syncWorkspaceViewTitle() {
  if (document.querySelector('.nav-item.active')?.dataset.view !== 'desktop') return;
  const named = selectedWorkspaceStoredName();
  if (named) $('#view-title').textContent = named;
}
function renderWorkspaceButton(actor = state.actor) {
  if (!wsBtn) return;
  const rows = Array.isArray(wsState.memberships) ? wsState.memberships : null;
  const selected = rows?.find((r) => r.selected) ?? null;
  if (selected) { $('#workspace-name').textContent = wsDisplayName(selected, actor); $('#workspace-role').textContent = String(selected.role ?? '').trim(); syncWorkspaceViewTitle(); return; }
  if (!rows || !rows.length) { $('#workspace-name').textContent = workspaceName(actor ?? {}); $('#workspace-role').textContent = String(actor?.role ?? '').trim(); }
  syncWorkspaceViewTitle();
}
function renderWorkspaceMenu() {
  wsMenuNote.hidden = true; wsMenuNote.textContent = '';
  const rows = wsState.memberships;
  if (!Array.isArray(rows)) {
    wsMenuList.replaceChildren(el('p', 'ws-note muted sm', wsState.failed ? 'Your workspaces could not be loaded. Close this and try again.' : 'Loading…'));
    return;
  }
  if (!rows.length) { wsMenuList.replaceChildren(el('p', 'ws-note muted sm', 'No workspaces on your memberships.')); return; }
  wsMenuList.replaceChildren(...rows.map((row) => {
    const b = el('button', row.selected ? 'ws-item selected' : 'ws-item');
    b.type = 'button'; b.setAttribute('role', 'menuitem');
    if (row.selected) b.setAttribute('aria-current', 'true');
    if (wsState.switching) b.disabled = true;
    b.append(el('span', 'ws-item-check', row.selected ? '✓' : ''), el('span', 'ws-item-name', wsDisplayName(row)), el('span', 'ws-item-role faint sm', String(row.role ?? '').trim()));
    b.onclick = () => { void pickWorkspace(row); };
    return b;
  }));
}
async function loadWorkspaceMemberships() {
  try {
    const body = await api('/api/admin/workspace/memberships');
    wsState.memberships = Array.isArray(body.memberships) ? body.memberships : [];
    wsState.failed = false;
  } catch { wsState.failed = true; }
  renderWorkspaceButton();
  if (wsMenu && !wsMenu.hidden) renderWorkspaceMenu();
}
async function pickWorkspace(row) {
  if (wsState.switching) return;
  // The selected row — and a lone membership, whose only row is the
  // selected one — just closes the menu: no pointless POST.
  if (row.selected || (Array.isArray(wsState.memberships) && wsState.memberships.length === 1)) { closeWorkspaceMenu(); return; }
  wsState.switching = true; renderWorkspaceMenu();
  try {
    await post('/api/admin/workspace/select', { tenantId: row.tenantId });
    // The pick lives in the cookie the select answer set. Every
    // surface — the session actor, projects, the Envoy room —
    // resolved its workspace at boot, and the app has no in-place
    // session re-resolve; its own road for a changed session state
    // is a reload (the signup road and the deploy watch reload the
    // same way), so the whole view re-resolves on the pick.
    location.reload();
  } catch (err) {
    wsState.switching = false; renderWorkspaceMenu();
    wsMenuNote.textContent = err?.status === 403 ? "That workspace isn't on your memberships" : 'Could not switch workspaces. Try again.';
    wsMenuNote.hidden = false;
  }
}
wsBtn.onclick = (e) => {
  e.stopPropagation();
  closeAccountMenu();
  if (wsMenu.hidden) { renderWorkspaceMenu(); wsMenu.hidden = false; wsBtn.setAttribute('aria-expanded', 'true'); if (!Array.isArray(wsState.memberships)) loadWorkspaceMemberships(); }
  else closeWorkspaceMenu();
};
document.addEventListener('click', (e) => { if (!e.target.closest('.ws-wrap')) closeWorkspaceMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeWorkspaceMenu(); });
function initWorkspaceSwitcher(actor) {
  renderWorkspaceButton(actor);
  loadWorkspaceMemberships();
}

async function clerkUser() {
  // The shell's lazy Clerk load (Devices section): asking it for a
  // session token also settles its user. Not configured / signed out →
  // null, and the identity panel says so in plain words.
  await heraldToken().catch(() => null);
  if (heraldClerk && !heraldClerk.user && typeof heraldClerk.addListener === 'function') {
    // ClerkJS restores its session asynchronously around load(): a
    // signed-in user can land a beat after the load resolves. Give
    // that settle one bounded chance — the listener fires when the
    // client state changes — before reporting the identity as
    // unavailable; never wait on it forever.
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); try { unsub?.(); } catch {} resolve(); };
      const timer = setTimeout(finish, 2500);
      let unsub = null;
      try { unsub = heraldClerk.addListener(finish); } catch { finish(); }
    });
  }
  return heraldClerk?.user ?? null;
}

function renderAccountSettings() {
  openAccountPanel('Settings');
  const seq = acctPanelSeq;
  const draw = (user, phase) => {
    if (seq !== acctPanelSeq || acctPanel.hidden) return;
    const m = accountIdentityModel(state.actor ?? {}, user, { identityUnavailable: phase === 'unavailable' });
    if (user) { $('#account-name').textContent = m.headline; $('#account-avatar').textContent = m.initial; }
    const kv = el('div', 'kv');
    for (const r of m.rows) kv.append(row(r.label, r.value));
    const parts = [kv];
    // The panel never presents the workspace + role rows as the final
    // answer while the identity is still loading — and when the load
    // settles without a user it says so, in plain words.
    if (phase === 'pending') parts.push(el('p', 'muted sm', 'Loading your signed-in details…'));
    else if (m.notice) parts.push(el('p', 'muted sm', m.notice));
    const foot = el('div', 'row-btns left'); foot.style.marginTop = '12px';
    const open = el('a', 'btn sm', 'Open the Settings page'); open.href = '#settings';
    open.onclick = () => closeAccountPanel();
    foot.append(open);
    parts.push(foot);
    acctPanelBody.replaceChildren(...parts);
  };
  draw(null, 'pending');
  clerkUser()
    .then((user) => draw(user, user ? 'ready' : 'unavailable'))
    .catch(() => draw(null, 'unavailable'));
}

function renderAccountShortcuts() {
  openAccountPanel('Keyboard shortcuts');
  const list = el('div');
  for (const s of SHORTCUTS) {
    const d = el('div', 'acct-shortcut');
    d.append(el('kbd', null, s.keys), el('span', 'what', s.action), el('span', 'faint sm', s.where));
    list.append(d);
  }
  acctPanelBody.replaceChildren(list);
}

async function renderAccountDownloads() {
  openAccountPanel('Download apps');
  acctPanelBody.replaceChildren(el('p', 'muted sm', 'Checking for the latest installer…'));
  let release = null;
  try { release = await (await fetch('/api/latest-release', { credentials: 'same-origin' })).json(); } catch {}
  const list = el('div');
  for (const d of downloadsModel(release)) {
    const line = el('div', 'acct-dl');
    line.append(el('span', 'plat', d.platform));
    if (d.ready) {
      const a = el('a', 'btn primary sm', 'Download'); a.href = d.url;
      line.append(el('span', 'note muted sm', d.version ? `${d.name} · ${d.version}` : d.name), a);
    } else {
      line.append(el('span', 'note muted sm', d.note));
    }
    list.append(line);
  }
  if (!acctPanel.hidden) acctPanelBody.replaceChildren(list);
}

function renderAccountReport() {
  openAccountPanel('Report an issue');
  const form = el('form', 'acct-issue');
  const subLabel = el('label', null, 'What is it about?');
  const subject = el('input'); subject.type = 'text'; subject.maxLength = 120; subject.placeholder = 'Short summary';
  subLabel.append(subject);
  const detLabel = el('label', null, 'What happened?');
  const details = el('textarea'); details.maxLength = 4000; details.placeholder = 'What you did, what you expected, and what happened instead.';
  detLabel.append(details);
  const note = el('p', 'muted sm', 'This opens your email app, addressed to the Helmian team. Nothing is sent until you press send there.');
  const send = el('button', 'btn primary', 'Open email to send'); send.type = 'submit';
  form.append(subLabel, detLabel, note, send);
  form.onsubmit = (e) => {
    e.preventDefault();
    location.href = reportIssueHref({ subject: subject.value, details: details.value, page: location.hash || location.pathname });
    closeAccountPanel();
  };
  acctPanelBody.replaceChildren(form);
  subject.focus();
}

for (const b of acctMenu.querySelectorAll('[data-acct-item]')) {
  b.onclick = () => {
    const item = b.dataset.acctItem;
    if (item === 'settings') renderAccountSettings();
    else if (item === 'shortcuts') renderAccountShortcuts();
    else if (item === 'downloads') renderAccountDownloads();
    else if (item === 'report') renderAccountReport();
  };
}

// One-time Meet Maestro ceremony (Troy's design, 2026-11-09): a
// brand-new workspace meets Maestro once, before its channels.
// The gate lives in maestro-activation.mjs and fails soft — any
// error at all and the app simply opens, because the ceremony
// never blocks a workspace.
async function maestroActivationGate(actor) {
  try {
    const mod = await import('./maestro-activation.mjs');
    await mod.runMaestroActivationGate({ role: actor?.role });
  } catch { /* fail soft: proceed without the ceremony */ }
}

// ---- boot ----
async function boot() {
  let model;
  try { const res = await fetch('/api/admin/session?scope=member', { credentials: 'same-origin' }); model = sessionModel(res.status, await res.json().catch(() => ({}))); }
  catch { model = sessionModel(0); }
  if (!model.member) {
    shell.classList.add('signed-out'); $('#signed-out').hidden = false; $('#view-title').textContent = 'Helmian';
    if (model.signedIn) {
      const n = $('#membership-note'); n.hidden = false;
      // Fresh self-serve accounts (Create account) have no workspace yet: create the
      // free trial workspace once, then reload into the app. Invited users never get
      // here because the join link adds them to the inviting team first.
      if (!sessionStorage.getItem('helmian-signup-tried')) {
        sessionStorage.setItem('helmian-signup-tried', '1');
        n.textContent = 'Setting up your free workspace…';
        try {
          const res = await fetch('/api/admin/signup', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
          if (res.ok) { location.reload(); return; }
        } catch {}
      }
      n.textContent = 'You are signed in, but your workspace could not be set up yet. Refresh to try again, or open an invite link from your team.';
      sessionStorage.removeItem('helmian-signup-tried');
    }
    return;
  }
  state.actor = model.actor;
  await maestroActivationGate(model.actor);
  wireRail();
  $('#svc-dot').classList.add('live'); $('#svc-text').textContent = 'Connected';
  { const ws = workspaceName(model.actor); $('#account').textContent = ws === 'your workspace' ? `Signed in · ${model.actor.role}` : `${ws} · ${model.actor.role}`; $('#account-name').textContent = ws === 'your workspace' ? 'Account' : ws; $('#account-avatar').textContent = $('#account-name').textContent.charAt(0).toUpperCase(); }
  initWorkspaceSwitcher(model.actor);
  $('#admin-link').hidden = !isAdminRole(model.actor.role);
  renderSessions(); loadSessions();
  loadEmojiMode().catch(() => {});
  loadAgentIcons().catch(() => {});
  if (new URLSearchParams(location.search).get('joined') === '1') { toast(`Welcome to ${workspaceName(model.actor)}!`, 'ok'); history.replaceState(null, '', location.pathname + location.hash); }
  const initialView = viewFromHash(location.hash, { phone: narrow() });
  show(initialView);
  if (hashIsGuard()) openGuardPanel();
  if (!PANEL_VIEWS.includes(initialView)) selectPanelTab(store.get('panelTab', 'browser'));
  loadProjects(); loadSteps(); loadFeedData();
  // The heartbeat also re-reads the PC actions panel while the owner is on
  // the Approvals view: a Guard ask raised on the PC (via the hands hub)
  // appears here within one beat — and leaves again once it is decided on
  // any surface — instead of only ever loading when the view is opened.
  setInterval(() => { if (document.visibilityState !== 'visible' || !$('#opt-auto').checked) return; loadFeedData(); loadSteps(); if (shell.dataset.view === 'console') loadLog(); if (shell.dataset.view === 'home') loadHome(); if (shell.dataset.view === 'approvals') loadPcApprovals(); }, 6000);
}
boot();

// Installable PWA (scope /app/). Herald keeps its own /herald/ worker until the merge lands.
// Long-open tabs: the service worker is sound (network-first, no-cache
// revalidation), but it only speaks on the NEXT load — a tab that stays
// open keeps running the app.js it loaded with. On 2026-11-08 a tab ran
// a pre-fix build all evening that way. The lever here is a nudge, not a
// takeover: when an update is noticed, show the small "A new version is
// ready" notice with its Reload button, ONCE per update, and let the
// human tap it. This code never reloads on its own (the previous watch
// reloaded silently whenever nothing was being typed) and the notice
// never takes focus, so typing is never interrupted — it just sits
// there until it is tapped or the tab is closed.
// Two voices carry the same news: (a) the deploy watch below — the
// shell ETags change when a deploy lands; (b) the service worker — a
// new worker taking over (controllerchange), or an update found while
// the app is open (updatefound). Whichever speaks first shows the
// notice; the latch keeps the other from showing it again.
// The watch set is EVERY first-party file the desk loads — shell, desk
// module, its imports, the shell's dynamic imports, and both stylesheets.
// envoy-workspace.js was missing from this set until 2026-11-05, so a
// deploy that changed only the desk itself (most fixes) never reached
// an open desk: Troy had to hard-refresh to see new work. A file that
// disappears in a deploy reads as 'gone', which also counts as a change.
const DEPLOY_WATCH = ['/app', '/app/app.js', '/app/envoy-workspace.js', '/app/account-menu.mjs', '/app/app-model.mjs', '/app/avatars.mjs', '/app/composer-picker.mjs', '/app/connector-panel.mjs', '/app/connector-menu.mjs', '/app/slash-menu.mjs', '/app/connect-fields.mjs', '/app/emoji-map.mjs', '/app/face-library.mjs', '/app/integrations-view.mjs', '/app/api-key-fields.mjs', '/app/maestro-activation.mjs', '/app/connector-manage.mjs', '/app/vendor/qrcode.mjs', '/app/app.css', '/app/envoy.css'];
(() => {
  let nudgedFor = null; // the update the notice is already up for — one showing per update
  const showUpdateNudge = (key) => {
    if (nudgedFor !== null) return;
    const nudge = $('#update-nudge');
    if (!nudge) return;
    nudgedFor = key;
    nudge.hidden = false;
  };
  const reloadBtn = $('#update-reload');
  if (reloadBtn) reloadBtn.addEventListener('click', () => location.reload());

  let known = null;
  const one = async (u) => { const r = await fetch(u, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' }); return r.ok ? (r.headers.get('etag') ?? 'noetag') : 'gone'; };
  const etag = async () => { try { const tags = await Promise.all(DEPLOY_WATCH.map(one)); return tags.join('|'); } catch { return null; } };
  const check = async () => {
    const now = await etag(); if (!now) return;
    if (!known) { known = now; return; }
    if (now === known) return;
    showUpdateNudge(now);
  };
  check();
  setInterval(check, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });

  if ('serviceWorker' in navigator) {
    // Only a takeover after this page was ALREADY controlled is an
    // update; the first install claiming a fresh page is not, and must
    // not produce a notice on a first visit.
    const hadController = !!navigator.serviceWorker.controller;
    if (hadController) {
      navigator.serviceWorker.addEventListener('controllerchange', () => showUpdateNudge('sw-takeover'));
    }
    addEventListener('load', () => {
      navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).then((reg) => {
        if (!hadController) return;
        if (reg.waiting) showUpdateNudge('sw-waiting');
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed') showUpdateNudge('sw-update');
          });
        });
      }).catch(() => {});
    });
  }
})();
