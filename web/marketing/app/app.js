import { VIEW_TITLES, viewFromHash, isAdminRole, sessionModel, projectsModel, filterProjects, approvalsModel, messagesModel, metricsModel, postureModel } from './app-model.mjs';

const $ = (s) => document.querySelector(s);
const shell = $('#shell');
const state = { actor: null, projects: [], channelId: null, mode: 'plan', timer: null };
const narrow = () => window.matchMedia('(max-width: 860px)').matches;

async function api(path, init = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.code || body.error || `HTTP ${res.status}`), { status: res.status, body });
  return body;
}
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function empty(glyph, title, sub) { const d = el('div', 'empty'); d.append(el('div', 'empty-glyph', glyph), el('p', null, title)); if (sub) d.append(el('p', 'faint', sub)); return d; }

// ---- shell chrome ----
function setSidebar(open) { shell.classList.toggle('sidebar-open', open); $('#sidebar-toggle').setAttribute('aria-expanded', String(open)); syncScrim(); }
function setGuard(open) {
  if (narrow()) shell.classList.toggle('guard-open', open); else shell.classList.toggle('guard-closed', !open);
  $('#guard-toggle').setAttribute('aria-expanded', String(open)); syncScrim();
}
function syncScrim() { $('#scrim').hidden = !(narrow() && (shell.classList.contains('sidebar-open') || shell.classList.contains('guard-open'))); }
$('#sidebar-toggle').onclick = () => { if (narrow()) setSidebar(!shell.classList.contains('sidebar-open')); else shell.classList.toggle('side-closed'); };
$('#guard-toggle').onclick = () => setGuard(narrow() ? !shell.classList.contains('guard-open') : shell.classList.contains('guard-closed'));
$('#guard-close').onclick = () => setGuard(false);
$('#scrim').onclick = () => { setSidebar(false); shell.classList.remove('guard-open'); syncScrim(); };
if (narrow()) shell.classList.add('guard-closed');

function show(view) {
  if (!state.actor) return;
  shell.dataset.view = view;
  for (const p of document.querySelectorAll('[data-view-panel]')) p.hidden = p.dataset.viewPanel !== view;
  for (const b of document.querySelectorAll('[data-view]')) if (b.classList.contains('nav-item') || b.classList.contains('tab')) b.classList.toggle('active', b.dataset.view === view);
  $('#view-title').textContent = VIEW_TITLES[view];
  if (narrow()) setSidebar(false);
  loaders[view]?.().catch(() => {});
}
for (const b of document.querySelectorAll('.nav-item[data-view], .tab[data-view]')) b.onclick = () => { if (location.hash !== `#${b.dataset.view}`) location.hash = b.dataset.view; else show(b.dataset.view); };
window.addEventListener('hashchange', () => show(viewFromHash(location.hash)));

// ---- data views ----
async function loadProjects() {
  const box = $('#projects');
  try {
    state.projects = projectsModel(await api('/api/admin/workspace/projects')).projects;
    renderShelf();
    box.replaceChildren();
    if (!state.projects.length) { box.append(empty('◇', 'No projects yet.', 'Projects your team adds will show up here.')); return; }
    for (const p of state.projects) { const i = el('article', 'item'); i.append(el('div', 'title', p.name), el('div', 'meta', `${p.key} · ${p.branch}${p.lifecycle !== 'active' ? ` · ${p.lifecycle}` : ''}`)); box.append(i); }
  } catch { box.replaceChildren(empty('◇', 'Projects are unavailable right now.', 'Pull to refresh or try again shortly.')); }
}
function renderShelf() {
  const list = filterProjects(state.projects, $('#project-filter').value);
  $('#project-shelf').replaceChildren(...list.map((p) => { const li = el('li', null, p.name); li.title = p.key; li.onclick = () => { location.hash = 'projects'; }; return li; }));
  $('#project-shelf-empty').hidden = list.length > 0;
}
$('#project-filter').oninput = renderShelf;

async function loadApprovals() {
  const box = $('#approvals');
  try {
    const model = approvalsModel(await api('/api/admin/cora/approvals'), state.actor?.role);
    $('#guard-decisions').textContent = String(model.pending);
    const badge = $('#approvals-badge'); badge.hidden = model.pending === 0; badge.textContent = String(model.pending);
    box.replaceChildren();
    if (model.empty) { box.append(empty('✓', "You're all caught up.", 'Nothing is waiting for a decision.')); return; }
    for (const item of model.items) {
      const card = el('article', 'item');
      card.append(el('div', 'title', item.summary || item.requestKind), el('div', 'meta', item.decision ? `${item.decision}` : 'Waiting for a decision'));
      if (item.canDecide) {
        const row = el('div', 'actions');
        for (const decision of ['approve', 'reject']) {
          const b = el('button', decision === 'approve' ? 'btn primary' : 'btn warn', decision === 'approve' ? 'Approve' : 'Reject');
          b.type = 'button';
          b.onclick = async () => {
            row.querySelectorAll('button').forEach((x) => { x.disabled = true; });
            try { await api('/api/admin/cora/approvals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision, requestKind: item.requestKind, requestReceiptId: item.requestReceiptId, reason: `${decision === 'approve' ? 'Approved' : 'Rejected'} in Helmian app`, idempotencyKey: crypto.randomUUID() }) }); }
            finally { await loadApprovals(); }
          };
          row.append(b);
        }
        card.append(row);
      }
      box.append(card);
    }
  } catch { box.replaceChildren(empty('✓', 'Approvals are unavailable right now.', 'Try again shortly.')); }
}

async function loadOverview() {
  try {
    const body = await api('/api/admin/overview');
    $('#metrics').replaceChildren(...metricsModel(body).map(([k, v]) => { const m = el('div', 'metric'); m.append(el('div', 'eyebrow', k.toUpperCase()), el('div', 'value', String(v))); return m; }));
    $('#posture').replaceChildren(...postureModel(body).map(([k, v]) => { const r = el('div', 'row'); r.append(el('span', 'soft', k), el('span', null, v)); return r; }));
  } catch { $('#metrics').replaceChildren(empty('⌁', 'Overview is unavailable right now.')); }
}

async function loadActivity() {
  const box = $('#activity');
  try {
    const body = await api('/api/admin/events');
    const events = Array.isArray(body.events) ? body.events : [];
    box.replaceChildren();
    if (!events.length) { box.append(empty('◫', 'No activity yet.', 'Recent actions and results will appear here.')); return; }
    for (const e of events.slice(0, 50)) { const i = el('article', 'item'); i.append(el('div', 'title', String(e.action || e.eventType || e.kind || 'Event').replaceAll('_', ' ')), el('div', 'meta', [e.actorSubject || e.actor, e.createdAt || e.at].filter(Boolean).join(' · '))); box.append(i); }
  } catch { box.replaceChildren(empty('◫', 'No activity yet.', 'Recent actions and results will appear here.')); }
}

// ---- chat (Envoy) ----
async function loadChannels() {
  const sel = $('#channel');
  try {
    const body = await api('/api/admin/envoy/channels');
    const channels = Array.isArray(body.channels) ? body.channels : [];
    sel.replaceChildren(...channels.map((c) => { const o = el('option', null, c.name || c.displayName || c.channelKey || 'Channel'); o.value = c.id ?? c.channelId; return o; }));
    sel.hidden = channels.length < 2;
    state.channelId = channels[0] ? (channels[0].id ?? channels[0].channelId) : null;
  } catch { state.channelId = null; }
  await loadMessages();
}
async function loadMessages() {
  const box = $('#messages');
  const form = $('#composer');
  if (!state.channelId) { box.replaceChildren(empty('▣', 'No conversation yet.', 'Your team chat will appear here once a channel is set up.')); form.hidden = true; return; }
  form.hidden = false;
  try {
    const model = messagesModel(await api(`/api/admin/envoy/messages?channel_id=${encodeURIComponent(state.channelId)}`), state.actor?.subject);
    if (model.empty) { box.replaceChildren(empty('▣', 'Start the conversation.', 'Messages you send appear here for your team.')); return; }
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.replaceChildren(...model.messages.map((m) => { const d = el('div', `msg${m.mine ? ' me' : ''}`); d.append(el('div', 'who', [m.who, m.at].filter(Boolean).join(' · ')), el('div', null, m.body)); return d; }));
    if (atBottom) box.scrollTop = box.scrollHeight;
  } catch { box.replaceChildren(empty('▣', 'Conversation is unavailable right now.', 'Try again shortly.')); }
}
$('#channel').onchange = (e) => { state.channelId = e.target.value; loadMessages(); };
const input = $('#composer-input');
input.oninput = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; };
input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !narrow()) { e.preventDefault(); $('#composer').requestSubmit(); } };
$('#composer').onsubmit = async (e) => {
  e.preventDefault();
  const body = input.value.trim(); if (!body || !state.channelId) return;
  $('#send').disabled = true;
  try { await api('/api/admin/envoy/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channelId: state.channelId, body, idempotencyKey: crypto.randomUUID() }) }); input.value = ''; input.oninput(); await loadMessages(); $('#messages').scrollTop = 1e9; }
  catch { /* keep the draft so nothing is lost */ }
  finally { $('#send').disabled = false; }
};
for (const p of document.querySelectorAll('.pill')) p.onclick = () => { state.mode = p.dataset.mode; document.querySelectorAll('.pill').forEach((x) => x.classList.toggle('active', x === p)); };

const loaders = { console: loadChannels, overview: loadOverview, projects: loadProjects, approvals: loadApprovals, activity: loadActivity };

// ---- boot ----
async function boot() {
  let model;
  try { const res = await fetch('/api/admin/session', { credentials: 'same-origin' }); model = sessionModel(res.status, await res.json().catch(() => ({}))); }
  catch { model = sessionModel(0); }
  const pill = $('#status-pill');
  if (!model.member) {
    $('#signed-out').hidden = false; shell.classList.add('signed-out');
    $('#status-text').textContent = model.signedIn ? 'Not a member' : 'Signed out';
    if (model.signedIn) { const n = $('#membership-note'); n.hidden = false; n.textContent = 'You are signed in, but this account has not been added to an Organization yet. Ask the owner to invite you.'; }
    return;
  }
  state.actor = model.actor;
  pill.classList.add('live'); $('#status-text').textContent = 'CLOUD LIVE'; pill.title = `Signed in · ${model.actor.tenantId}`;
  $('#account').textContent = `${model.actor.tenantId} · ${model.actor.role}`;
  $('#settings-account').textContent = model.actor.subject; $('#settings-org').textContent = model.actor.tenantId; $('#settings-role').textContent = model.actor.role;
  const admin = isAdminRole(model.actor.role);
  $('#admin-link').hidden = !admin; $('#settings-admin').hidden = !admin; $('#signout').hidden = false;
  show(viewFromHash(location.hash));
  loadProjects(); loadApprovals();
  state.timer = setInterval(() => { if (document.visibilityState === 'visible' && shell.dataset.view === 'console') loadMessages(); }, 5000);
}
boot();
