import { VIEW_TITLES, viewTitles, isPlainEmojiMode, ADVANCED_VIEWS, PANEL_VIEWS, PANEL_TABS, viewFromHash, isAdminRole, sessionModel, projectsModel, filterProjects, projectKeyFromName, approvalsModel, logLines, BRIDGE_DISPLAY_NAME, feedModel, humanAction, formatTime, maskSecret, integrationsModel, agentsModel, createModel, createIntentPayload, metricsModel, postureModel, addSession, plainEvent, sessionsFromServer, PROVIDERS, progressModel, planFromText, homeModel, smsInviteHref, desktopsModel } from './app-model.mjs';

const $ = (s) => document.querySelector(s);
const shell = $('#shell');
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(`helmian.app.${k}`)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(`helmian.app.${k}`, JSON.stringify(v)); } catch {} } };
const state = { serverSessions: false, actor: null, projects: [], channelId: null, sessions: store.get('sessions', []), activeSession: store.get('activeSession', null), events: [], approvals: [], ack: new Set(store.get('ack', [])), cleared: new Set(store.get('cleared', [])), pendingProvider: null, steps: null, usage: null, overview: null, emojiMode: store.get('emojiMode', 'playful'), agentIcons: {} };
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
function setNavLabel(btn, label) {
  for (const node of [...btn.childNodes]) if (node.nodeType === 3) node.remove();
  btn.prepend(document.createTextNode(label));
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
  if (shelfEmpty) shelfEmpty.textContent = es('🗂️ Nothing here yet — start your first project.', 'Nothing here yet — start your first project.');
  renderAgentIcons();
  const current = document.querySelector('.nav-item.active')?.dataset.view;
  if (current) $('#view-title').textContent = titles[current] ?? '';
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

// ---- independent collapsible panels: Guard + Workbench (desktop EXE parity) ----
function setPanelCollapsed(which, collapsed) {
  const panel = which === 'guard' ? $('#guard-panel') : $('#workbench');
  const btn = which === 'guard' ? $('#guard-collapse') : $('#workbench-collapse');
  if (!panel || !btn) return;
  panel.classList.toggle('collapsed', collapsed);
  const label = which === 'guard' ? 'Guard' : 'workbench';
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${label} panel`);
  btn.textContent = collapsed ? '+' : '–';
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

// ---- views ----
function show(view) {
  if (!state.actor) return;
  if (PANEL_VIEWS.includes(view)) {
    // Browser, Canvas, Preview, Create live in the right workbench panel now
    // (BROWSE-001); keep chat visible and select the tab instead.
    selectPanelTab(view, { openDrawer: true });
    view = 'console';
  }
  shell.dataset.view = view;
  for (const p of document.querySelectorAll('[data-view-panel]')) p.hidden = p.dataset.viewPanel !== view;
  for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('active', b.dataset.view === view);
  $('#view-title').textContent = viewTitles(state.emojiMode)[view];
  const adv = $('#advanced-nav');
  if (adv) adv.open = ADVANCED_VIEWS.includes(view);
  if (narrow()) drawer('sidebar', false);
  loaders[view]?.().catch(() => {});
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
function renderSessions() {
  const ul = $('#sessions');
  if (!state.sessions.length) { ul.replaceChildren(el('li', 'faint sm', 'No sessions yet')); ul.firstChild.style.cursor = 'default'; }
  else ul.replaceChildren(...state.sessions.map((s) => { const li = el('li', s.id === state.activeSession ? 'active' : null); li.append(el('span', 'dot'), el('span', null, s.name), el('span', 'prov', s.provider)); if (state.serverSessions) { const x = el('button', 'x', '×'); x.type = 'button'; x.title = 'Close session'; x.onclick = async (ev) => { ev.stopPropagation(); try { await post('/api/admin/app/sessions/archive', { id: s.id }); } catch {} loadSessions(); }; li.append(x); } li.onclick = () => { state.activeSession = s.id; store.set('activeSession', s.id); state.steps = null; renderSessions(); loadSteps(); location.hash = 'console'; }; return li; }));
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
// Inline copy of web/shared/voice-dictation.mjs (web/shared/ is not
// URL-served; same pattern as the inlined guard-motion copy). Voice mode:
// a toggle enabling a full voice loop. Dictation inserts into #prompt; a
// final transcript ending with "send it" submits the composer; agent
// replies are spoken aloud. Toggle off stops everything.
//
// TTS: Kokoro (fully local) is the primary engine; the ~300MB model
// lazy-loads on the first spoken reply via the import map in index.html.
// speechSynthesis is the automatic fallback.
// Default Kokoro voice preset (a voice setting UI comes later).
const KOKORO_VOICE = 'af_heart';
const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_SAMPLE_RATE = 24000;
function createVoiceController({ Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition, synthesis = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance, kokoroLoader = null, makeAudioContext = null } = {}) {
  const supported = typeof Recognition === 'function';
  const canSpeak = typeof synthesis?.speak === 'function' && typeof Utterance === 'function';
  let recognition = null;
  let listening = false;
  let voiceMode = false;
  let voiceKind = 'dictate'; // 'dictate' (text only) or 'voice' (two-way)
  let handlers = {};
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
      if (!voiceMode) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      const text = Array.from(event.results ?? []).filter((result) => result.isFinal).map((result) => result?.[0]?.transcript ?? '').join(' ').trim();
      if (!text) return;
      const cmd = sendCommand(text);
      if (cmd === undefined) handlers.onTranscript?.(text);
      else handlers.onSubmit?.(cmd ?? ''); // null = bare "send it": submit the composer as-is
    };
    recognition.onerror = (event) => {
      if (event?.error === 'aborted') return;
      handlers.onError?.(ERROR_MESSAGES[event?.error] ?? 'Dictation stopped before a usable transcript was produced.');
    };
    recognition.onend = () => { listening = false; recognition = null; const hidden = typeof document !== 'undefined' && document.hidden; if (voiceMode && !hidden) startTurn(); else if (!voiceMode) handlers.onState?.('idle'); };
    recognition.start();
  }
  function setVoiceMode(on, next = {}) {
    if (!supported) { next.onError?.('Voice mode is not supported by this browser. You can still type or paste a message.'); return false; }
    if (on && !voiceMode) { voiceMode = true; voiceKind = next.mode === 'voice' ? 'voice' : 'dictate'; handlers = next; startTurn(); return true; }
    if (!on && voiceMode) { voiceMode = false; voiceKind = 'dictate'; handlers = {}; stopTurn(); cancelSpeech(); next.onState?.('idle'); return true; }
    return false;
  }
  // Pause the mic while the tab is hidden: speech meant for another tab must
  // never be transcribed, and "send it" must never fire from a hidden tab.
  // Resumes automatically when the tab is visible again.
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      try {
        if (document.hidden) { stopTurn(); cancelSpeech(); }
        else if (voiceMode && !listening) { startTurn(); }
      } catch {}
    });
  }
  // ---- Legacy speechSynthesis engine (fallback) ----
  // Long replies are chunked: Chrome's speechSynthesis truncates long
  // utterances, so a reply goes out as sentence-sized pieces chained via
  // onend. A new reply clears the queue; toggle-off cancels everything.
  const synthQueue = [];
  let synthSpeaking = false;
  function pumpSynth() {
    if (synthSpeaking || synthQueue.length === 0 || !canSpeak) return;
    const utter = new Utterance(synthQueue.shift());
    synthSpeaking = true;
    utter.onend = () => { synthSpeaking = false; pumpSynth(); };
    utter.onerror = () => { synthSpeaking = false; pumpSynth(); };
    try { synthesis.speak(utter); }
    catch { synthSpeaking = false; }
  }
  const synthEngine = {
    // Speak pre-chunked text. interrupt=false appends without silencing
    // what is playing (used when Kokoro hands a reply over mid-stream).
    speakChunks(chunks, { interrupt = true } = {}) {
      if (!canSpeak || !chunks.length) return false;
      let wasSpeaking = false;
      if (interrupt) {
        try { wasSpeaking = !!synthesis.speaking; } catch {}
        try { synthesis.cancel(); } catch {}
        synthQueue.length = 0;
        synthSpeaking = false;
      }
      synthQueue.push(...chunks);
      // Chrome quirk: cancel() takes effect asynchronously, so a speak()
      // issued in the same tick can be swallowed. Only delay when we actually
      // interrupted playing audio; the common case stays synchronous.
      if (interrupt && wasSpeaking) setTimeout(pumpSynth, 150);
      else pumpSynth();
      return true;
    },
    cancel() {
      synthQueue.length = 0;
      synthSpeaking = false;
      if (!canSpeak) return;
      try { synthesis.cancel(); } catch {}
    },
  };

  // ---- Kokoro engine (primary where Web Audio exists) ----
  let kokoro = null;          // loaded KokoroTTS instance
  let kokoroFailedAt = 0;     // timestamp of last Kokoro failure; retry after 60s
  const KOKORO_RETRY_MS = 60000;
  let playToken = 0;          // cancel() bumps it; late audio is ignored
  let activeSource = null;    // currently playing AudioBufferSourceNode
  let audioCtx = null;
  const kokoroQueue = [];     // [{ text, token }]
  let kokoroPlaying = false;

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

  function defaultKokoroLoader() {
    // Resolves via the import map in index.html; the ~300MB model downloads
    // once, on first use, and is cached by the browser afterwards.
    return import('kokoro-js').then((mod) => mod.KokoroTTS.from_pretrained(KOKORO_MODEL, {
      dtype: 'q8',
      device: (typeof navigator !== 'undefined' && navigator.gpu) ? 'webgpu' : 'wasm',
    }));
  }

  async function ensureKokoro() {
    if (kokoro) return kokoro;
    kokoro = await (kokoroLoader ?? defaultKokoroLoader)();
    return kokoro;
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
  // speechSynthesis instead.
  function kokoroFallback(failedItem) {
    const chunks = [];
    if (failedItem) chunks.push(failedItem.text);
    for (const item of kokoroQueue.splice(0)) chunks.push(item.text);
    if (chunks.length) synthEngine.speakChunks(chunks, { interrupt: false });
  }

  async function pumpKokoro() {
    if (kokoroPlaying || kokoroQueue.length === 0) return;
    const item = kokoroQueue.shift();
    kokoroPlaying = true;
    let out;
    try {
      const engine = await ensureKokoro();
      out = await engine.generate(item.text, { voice: KOKORO_VOICE });
    } catch (err) {
      kokoroPlaying = false;
      kokoroFailedAt = Date.now();
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
      console.warn('[voice] Kokoro playback failed, falling back:', err?.message ?? err);
      kokoroFallback(item);
      return;
    }
    activeSource = src;
    src.onended = () => {
      kokoroPlaying = false;
      if (activeSource === src) activeSource = null;
      pumpKokoro();
    };
    try { src.start(); }
    catch { kokoroPlaying = false; if (activeSource === src) activeSource = null; pumpKokoro(); }
  }

  function kokoroCancel() {
    playToken += 1; // orphan any in-flight generation
    kokoroQueue.length = 0;
    kokoroPlaying = false;
    if (activeSource) {
      try { activeSource.stop(); } catch {}
      activeSource = null;
    }
  }

  const tts = {
    speak(text) {
      const clean = stripSpeechMarkup(text);
      if (!clean) return false;
      const chunks = chunkForSpeech(clean);
      if (!chunks.length) return false;
      // A new reply replaces anything in progress, on either engine.
      synthEngine.cancel();
      kokoroCancel();
      if (canTryKokoro()) {
        for (const c of chunks) kokoroQueue.push({ text: c, token: playToken });
        void pumpKokoro();
        return true;
      }
      return synthEngine.speakChunks(chunks);
    },
    cancel() {
      synthEngine.cancel();
      kokoroCancel();
    },
  };

  function speak(text) {
    if (!voiceMode || voiceKind !== 'voice') return false; // dictate mode never speaks
    return tts.speak(text);
  }
  function cancelSpeech() {
    tts.cancel();
  }
  return { get supported() { return supported; }, get canSpeak() { return canSpeak; }, get voiceMode() { return voiceMode; }, get mode() { return voiceKind; }, get listening() { return listening; }, setVoiceMode, speak, cancelSpeech };
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
const dictateChip = document.querySelector('.tool[data-tool="dictate"]');
const voiceChatChip = document.querySelector('.tool[data-tool="voice"]');
const voice = createVoiceController();
const seenMessageIds = new Set();
const voicePrivacy = (mode) => mode === 'voice'
  ? es(
    '🎙️ Voice chat: talk, say "send it" to submit, and replies are spoken aloud in a natural voice. First use downloads a one-time ~300MB voice model, use WiFi. Dictation uses your browser\u2019s speech service — in Chrome, audio is sent to Google for transcription. Tap Voice chat again to turn it off.',
    'Voice chat: talk, say "send it" to submit, and replies are spoken aloud in a natural voice. First use downloads a one-time ~300MB voice model, use WiFi. Dictation uses your browser\u2019s speech service — in Chrome, audio is sent to Google for transcription. Tap Voice chat again to turn it off.'
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
function updateVoiceChips() {
  for (const [chip, mode] of [[dictateChip, 'dictate'], [voiceChatChip, 'voice']]) {
    if (!chip) continue;
    const active = voice.voiceMode && voice.mode === mode;
    chip.classList.toggle('recording', active);
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}
function toggleVoiceChip(mode) {
  if (voice.voiceMode && voice.mode === mode) {
    voice.setVoiceMode(false, { onState: updateVoiceChips });
  } else {
    if (voice.voiceMode) voice.setVoiceMode(false, {});
    if (!store.get('voicePrivacySeen', false)) { toast(voicePrivacy(mode)); store.set('voicePrivacySeen', true); }
    voice.setVoiceMode(true, {
      mode,
      onTranscript: (text) => {
        insertDictation(text);
        if (checkComposerForSendCommand() && $('#prompt').value.trim()) $('#composer').requestSubmit();
      },
      onSubmit: (text) => { if (text) insertDictation(text); if ($('#prompt').value.trim()) $('#composer').requestSubmit(); },
      onState: updateVoiceChips,
      onError: (msg) => { toast(msg); updateVoiceChips(); },
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
  t.onclick = () => toast(t.dataset.tool === 'tools' ? 'Tools and connectors open from Integrations' : `${t.textContent} is available in the desktop app`);
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
    try { const body = await api('/api/admin/envoy/channels'); const chans = Array.isArray(body.channels) ? body.channels : []; const sel = $('#channel'); const kindTag = (k) => k && k !== 'team' ? ` · ${k}` : ''; sel.replaceChildren(...chans.map((c) => { const o = el('option', null, `${c.title || c.slug || 'Channel'}${kindTag(c.kind)}`); o.value = c.id ?? c.channelId; return o; })); sel.hidden = chans.length < 2; state.channelId = chans[0] ? (chans[0].id ?? chans[0].channelId) : null;
      if (!state.channelId && isAdminRole(state.actor?.role)) { const made = await post('/api/admin/envoy/channels', { slug: 'team', title: 'Team', kind: 'team' }); state.channelId = made.channel?.id ?? null; if (state.channelId) toast('Team channel created', 'ok'); }
    } catch {}
  }
  await loadLog();
  // Poll for new messages every 3 seconds when the page is visible.
  // The bridge posts replies via the API; without polling the user must
  // manually refresh or switch tabs to see them.
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (!state.channelId) return;
    loadLog().catch(() => {});
  }, 3000);
}
async function loadLog() {
  const log = $('#log');
  const sys = (t) => { const d = el('div', 'line sys'); d.append(el('span', 'ts', `[${new Date().toTimeString().slice(0, 8)}] `), document.createTextNode(t)); return d; };
  if (!state.channelId) { log.replaceChildren(sys('helmian cloud console ready'), sys(`signed in · ${state.actor.tenantId}`), sys('no team channel yet — messages will stream here once one is set up')); return; }
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
  const [ev, ap, gf] = await Promise.allSettled([api('/api/admin/events'), api('/api/admin/cora/approvals'), api('/api/admin/guard/findings')]);
  if (ev.status === 'fulfilled') state.events = Array.isArray(ev.value.events) ? ev.value.events : [];
  if (ap.status === 'fulfilled') state.approvals = approvalsModel(ap.value, state.actor?.role).items;
  state.findings = gf.status === 'fulfilled' && Array.isArray(gf.value.findings) ? gf.value.findings : [];
  const pending = state.approvals.filter((a) => !a.decision).length;
  $('#approvals-badge').hidden = pending === 0; $('#approvals-badge').textContent = String(pending);
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
  // Guard findings carry server-side ack state; criticals are never hidden by ack.
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
  catch { toast('Acknowledgement not saved — try again'); }
  await loadFeedData(); renderFeed();
}
function renderFeed() {
  const filter = $('#feed-filter').value;
  const cards = feedModel({ events: state.events, approvals: state.approvals }, { filter: 'all', showInfo: $('#opt-info').checked, showApprovals: $('#opt-approvals').checked, acknowledged: state.ack, cleared: state.cleared });
  const merged = [...findingCards(), ...cards]
    .filter((c) => filter === 'all' || c.severity === filter)
    .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  const critical = merged.filter((c) => c.severity === 'critical').length;
  $('#guard-count').hidden = critical === 0; $('#guard-count').textContent = String(critical);
  // Guard panel badge: unacknowledged findings keep the Guard panel noticeable.
  const unacked = (state.findings ?? []).filter((f) => !f.acked).length;
  const tabBadge = $('#guard-panel-count');
  if (tabBadge) { tabBadge.hidden = unacked === 0; tabBadge.textContent = String(unacked); }
  const feed = $('#feed');
  if (!merged.length) { feed.replaceChildren(empty('All clear', 'Alerts from your agents show up here.')); return; }
  feed.replaceChildren(...merged.slice(0, 60).map((c) => {
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
    if (!c.ack && c.severity !== 'info') {
      const ack = el('button', 'btn ghost sm', 'Acknowledge');
      ack.onclick = c.finding
        ? () => ackFinding(c.finding.fingerprint)
        : () => { state.ack.add(c.id); store.set('ack', [...state.ack]); renderFeed(); };
      actions.append(ack);
    }
    if (actions.childElementCount) a.append(actions);
    return a;
  }));
}
$('#feed-filter').onchange = renderFeed; $('#opt-info').onchange = renderFeed; $('#opt-approvals').onchange = renderFeed;
$('#feed-clear').onclick = () => { for (const id of state.ack) state.cleared.add(id); for (const e of state.events) state.cleared.add(`evt:${e.id}`); store.set('cleared', [...state.cleared]); renderFeed(); };
$('#feed-ack-all').onclick = async () => {
  const pending = (state.findings ?? []).filter((f) => !f.acked);
  for (const f of pending) { try { await post('/api/admin/guard/acks', { fingerprint: f.fingerprint }); } catch { /* keep going */ } }
  if (pending.length) toast(pending.length === 1 ? 'Finding acknowledged' : `${pending.length} findings acknowledged`);
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
      const { loadClerkBrowser } = await import('/herald/account-runtime.js');
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
  if (!model || model.empty) {
    list.replaceChildren();
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  list.replaceChildren(...model.rows.map((row) => {
    const b = el('button', 'device-row');
    b.type = 'button';
    b.dataset.desktopId = row.desktopId;
    b.dataset.sessionId = row.sessionId;
    b.append(el('strong', null, row.displayName), el('small', null, `${row.projectName} · ${row.name} · ${row.state || 'unknown'}`));
    b.onclick = () => { location.href = '/herald/'; toast('Open Remote Control to drive this Desktop'); };
    return b;
  }));
}
async function loadDevices() {
  const empty = $('#devices-empty');
  try {
    const body = await remoteApi('/api/remote/v1/desktops');
    const model = desktopsModel(body);
    renderDevices(model, model.empty
      ? 'No live Desktop on this account yet — Connect phone or enroll below.'
      : 'Tap a Desktop to open Remote Control.');
  } catch (error) {
    renderDevices({ empty: true, rows: [] }, error.status === 401 || error.status === 403
      ? 'Desktop list needs Clerk unify (owner checklist). You can still Connect phone or enroll below.'
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
      ? 'Enrollment needs Clerk unify — try Connect phone, or open Remote Control'
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
async function loadApprovals() { await loadFeedData(); renderApprovals(); }
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
async function loadIntegrations() {
  const [c, p] = await Promise.allSettled([api('/api/admin/cora/connectors'), api('/api/admin/provider-connections')]);
  const list = integrationsModel(c.value ?? {}, p.value ?? {});
  $('#integrations').replaceChildren(...list.map((i) => { const card = el('article', 'card'); card.append(el('div', 'title', i.name), el('div', 'meta', i.kind), el('div', 'meta')); card.lastChild.append(el('span', `status ${i.connected ? 'ok' : ''}`, i.connected ? 'Connected' : 'Not connected')); return card; }));
  return p.value;
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
// ---- providers (runner vault presence) ----
const PROVIDER_META = [
  ['gemini', 'Gemini'],
  ['claude', 'Claude'],
  ['openai', 'ChatGPT'],
  ['grok', 'Grok'],
  ['xai', 'xAI'],
];
async function loadProviders() {
  const box = $('#providers-cards');
  let presence = [];
  try { const body = await api('/api/admin/envoy/runner/presence'); presence = Array.isArray(body.presence) ? body.presence : []; }
  catch { box.replaceChildren(el('p', 'muted sm', 'Provider status is unavailable right now.')); return; }
  const byProvider = new Map(presence.map((r) => [String(r.provider).toLowerCase(), r]));
  box.replaceChildren(...PROVIDER_META.map(([key, label]) => {
    const row = byProvider.get(key);
    const connected = row?.connected === true;
    const card = el('article', 'card');
    const icon = agentIconFor(label);
    card.append(el('div', 'title', icon ? `${icon} ${label}` : label));
    const meta = el('div', 'meta');
    meta.append(el('span', `status ${connected ? 'ok' : ''}`, connected ? 'Connected' : 'Not connected'));
    card.append(meta);
    if (connected && row?.updatedAt) card.append(el('div', 'meta muted sm', `since ${formatTime(row.updatedAt)}`));
    if (!connected) {
      const btn = el('button', 'btn primary sm', 'Connect');
      btn.type = 'button';
      btn.onclick = () => {
        if (card.querySelector('.connect-help')) { card.querySelector('.connect-help').remove(); return; }
        const help = el('div', 'connect-help');
        help.append(el('p', 'muted sm', 'Your key never touches the cloud. On your runner or PC, run:'));
        const code = el('code', 'code', `node bin/runner-vault.mjs store ${key}`);
        const copy = el('button', 'btn ghost sm', 'Copy command');
        copy.type = 'button';
        copy.onclick = async () => { try { await navigator.clipboard.writeText(code.textContent); toast('Command copied', 'ok'); } catch { toast('Copy failed'); } };
        help.append(code, copy);
        help.append(el('p', 'muted sm', 'Paste your key when asked (input is hidden), then restart the bridge. Status updates on next start.'));
        card.append(help);
      };
      const actions = el('div', 'row-btns left');
      actions.append(btn);
      card.append(actions);
    }
    return card;
  }));
}

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
    li.append(el('strong', null, s.done ? '✓ ' : '', s.label), el('div', 'muted sm', s.hint));
    return li;
  }));
}
$('#onboarding-dismiss').onclick = () => { store.set('onboardingDismissed', true); $('#onboarding').hidden = true; };

async function loadSettings() {
  loadInvites();
  loadProviders();
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
  newBtn.onclick = showNewSessionDialog;
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
}

function showNewSessionDialog() {
  // Simple dialog using native prompt-style overlay
  const overlay = el('div', 'dialog-overlay');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000;';
  const dialog = el('div', 'card');
  dialog.style.cssText = 'min-width:320px;max-width:90vw;padding:20px;';
  dialog.append(el('h3', null, 'New agent session'));

  const nameLabel = el('label', 'muted sm', 'Name');
  const nameInput = el('input', 'input');
  nameInput.type = 'text';
  nameInput.placeholder = 'e.g. Claude helper';
  nameInput.style.cssText = 'width:100%;margin:4px 0 12px;';

  const providerLabel = el('label', 'muted sm', 'Provider');
  const providerSelect = el('select', 'input');
  providerSelect.style.cssText = 'width:100%;margin:4px 0 12px;';
  for (const p of SESSION_PROVIDERS) {
    const opt = el('option', null, p);
    opt.value = p;
    providerSelect.append(opt);
  }

  const tierLabel = el('label', 'muted sm', 'Routing');
  const tierSelect = el('select', 'input');
  tierSelect.style.cssText = 'width:100%;margin:4px 0 16px;';
  for (const t of SESSION_TIERS) {
    const opt = el('option', null, t.charAt(0).toUpperCase() + t.slice(1));
    opt.value = t;
    tierSelect.append(opt);
  }

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

  dialog.append(nameLabel, nameInput, providerLabel, providerSelect, tierLabel, tierSelect, btnRow);
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
    viewport.src = toEmbeddableUrl(result.url);
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

const loaders = { home: loadHome, console: () => Promise.all([loadConsole(), loadSteps()]), overview: loadOverview, workspace: loadProjects, devices: loadDevices, settings: loadSettings, activity: loadActivity, evidence: loadEvidence, approvals: loadApprovals, integrations: loadIntegrations, agents: () => Promise.all([loadAgents(), loadAgentSessions()]), release: loadRelease };
const panelLoaders = { browser: null, canvas: loadCanvas, preview: loadPreview, create: loadCreate };

// ---- boot ----
async function boot() {
  let model;
  try { const res = await fetch('/api/admin/session?scope=member', { credentials: 'same-origin' }); model = sessionModel(res.status, await res.json().catch(() => ({}))); }
  catch { model = sessionModel(0); }
  if (!model.member) {
    shell.classList.add('signed-out'); $('#signed-out').hidden = false; $('#view-title').textContent = 'Helmian';
    if (model.signedIn) { const n = $('#membership-note'); n.hidden = false; n.textContent = 'You are signed in, but this account has not been added to an Organization yet. Ask the owner to invite you.'; }
    return;
  }
  state.actor = model.actor;
  $('#svc-dot').classList.add('live'); $('#svc-text').textContent = es('🟢 Cloud service · Connected - live', 'Cloud service · Connected - live');
  $('#account').textContent = `${model.actor.tenantId} · ${model.actor.role}`;
  $('#admin-link').hidden = !isAdminRole(model.actor.role); $('#signout').hidden = false;
  renderSessions(); loadSessions();
  loadEmojiMode().catch(() => {});
  loadAgentIcons().catch(() => {});
  if (new URLSearchParams(location.search).get('joined') === '1') { toast(`Welcome to ${model.actor.tenantId}!`, 'ok'); history.replaceState(null, '', location.pathname + location.hash); }
  const initialView = viewFromHash(location.hash, { phone: narrow() });
  show(initialView);
  if (hashIsGuard()) openGuardPanel();
  if (!PANEL_VIEWS.includes(initialView)) selectPanelTab(store.get('panelTab', 'browser'));
  loadProjects(); loadSteps(); loadFeedData();
  setInterval(() => { if (document.visibilityState !== 'visible' || !$('#opt-auto').checked) return; loadFeedData(); loadSteps(); if (shell.dataset.view === 'console') loadLog(); if (shell.dataset.view === 'home') loadHome(); }, 6000);
}
boot();

// Installable PWA (scope /app/). Herald keeps its own /herald/ worker until the merge lands.
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => {}));
