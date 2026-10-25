// Envoy workspace for the Desktop view: channels | chat | agent CLI | agents | workbench.
// app.js calls mountWorkspace(ctx) each time the Desktop view opens; wiring
// happens once, data refreshes every time.
import { CHARACTERS, COLORS, avatarFor, defaultChoice, sanitizeChoice } from './avatars.mjs';
import { addSession, sessionsFromServer } from './app-model.mjs';
import { addAttachment, attachmentKey, buildMessageRequest, fileRefusalReason, pickerModel, removeAttachment } from './composer-picker.mjs';
import { moveSlashHighlight, slashInsertValue, slashMenuModel } from './slash-menu.mjs';

const AGENTS = ['maestro', 'claude', 'openai', 'grok', 'gemini'];
const NAMES = { maestro: 'Maestro', claude: 'Claude', openai: 'ChatGPT', grok: 'Grok', gemini: 'Gemini' };
const AVATAR = { maestro: 'maestro', claude: 'claude', openai: 'chatgpt', grok: 'grok', gemini: 'gemini' };
const ALIAS = { maestro: 'maestro', manager: 'maestro', claude: 'claude', chatgpt: 'openai', openai: 'openai', gpt: 'openai', grok: 'grok', xai: 'grok', gemini: 'gemini' };
const QUICK = [
  ['Helmian demo video', 'https://www.youtube.com/watch?v=OC2Y82gv6co'],
  ['Helmian demo video', 'https://www.youtube.com/watch?v=_yUtw9YOzy8'],
  ['Helmian demo video', 'https://www.youtube.com/watch?v=r3vWiOC3bKw'],
  ['Wikipedia', 'https://en.wikipedia.org/wiki/Main_Page'],
  ['OpenStreetMap', 'https://www.openstreetmap.org/'],
];
const STARTER_CANVAS = `<!doctype html>
<html><head><style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; display: grid; place-items: center; min-height: 100vh; }
  .card { padding: 28px 32px; border-radius: 16px; background: #1e293b; box-shadow: 0 10px 40px rgba(0,0,0,.4); }
  h1 { margin: 0 0 6px; font-size: 26px; } p { margin: 0; color: #94a3b8; }
</style></head>
<body><div class="card"><h1>Canvas</h1><p>Edit the code on the left. Agents' HTML replies open here too.</p></div></body></html>`;

const $ = (id) => document.getElementById(id);
const ls = { get: (k, d) => { try { const v = localStorage.getItem(`ew.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(`ew.${k}`, JSON.stringify(v)); } catch {} } };
const narrow = () => window.matchMedia('(max-width: 900px)').matches;
function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return n;
}
const avatarImg = (p) => h('img', { src: `/assets/agents/${AVATAR[p] ?? 'maestro'}.png`, alt: '', width: 30, height: 30 });
const clock = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
const dayLabel = (iso) => { const d = new Date(iso); const t = new Date(); if (d.toDateString() === t.toDateString()) return 'Today'; const y = new Date(t); y.setDate(t.getDate() - 1); if (d.toDateString() === y.toDateString()) return 'Yesterday'; return d.toLocaleDateString([], { month: 'short', day: 'numeric' }); };

export function mentions(text) {
  const out = new Set(); let all = false;
  for (const m of String(text ?? '').matchAll(/(^|[^\w@])@([a-z][a-z0-9_-]{1,20})\b/gi)) {
    const w = m[2].toLowerCase();
    if (['all', 'everyone', 'here'].includes(w)) { all = true; continue; }
    const p = ALIAS[w.replace(/\d+$/, '')]; if (p) out.add(p);
  }
  return { all, providers: [...out] };
}

// Same routing as the server (src/cloud/envoy-agents.mjs) for the "working" light.
export function addressed(message, roster) {
  if (!roster.length) return [];
  const { all, providers } = mentions(message.body);
  if (message.authorKind === 'agent') return message.authorSubject === 'agent:maestro' ? roster.filter((p) => p !== 'maestro' && (all || providers.includes(p))) : [];
  if (message.authorKind !== 'human') return [];
  if (all) return roster;
  if (providers.length) return roster.filter((p) => providers.includes(p));
  return roster.includes('maestro') ? ['maestro'] : roster;
}

const providerOnline = (p, online) => (p === 'maestro' ? online.size > 0 : online.has(p));

export function agentStates(messages, roster, online, now = Date.now(), route = addressed) {
  const out = {};
  for (const p of roster) {
    const mine = messages.filter((m) => m.authorSubject === `agent:${p}`);
    const last = mine.at(-1) ?? null;
    const lastAsk = [...messages].reverse().find((m) => route(m, roster).includes(p));
    const answered = lastAsk && messages.some((m) => m.authorSubject === `agent:${p}` && m.idempotencyKey === `reply:${lastAsk.id}`);
    const fresh = lastAsk && now - new Date(lastAsk.createdAt).getTime() < 10 * 60_000;
    const isOnline = providerOnline(p, online);
    out[p] = { state: !isOnline ? 'offline' : (fresh && !answered ? 'working' : 'idle'), last: last?.body ?? '' };
  }
  return out;
}

// The server's agent-work window (src/cloud/envoy-mesh.mjs agentWork): a
// routed message stays waiting for its agent for 30 minutes, until the
// reply lands. The roster light above is a 10-minute recency view; this is
// the server's own definition of pending work, mirrored over the same
// server-fed lists so the in-thread cue and the fast poll track pending
// work itself — never a local timer's guess.
export const AGENT_WORK_WINDOW_MS = 30 * 60_000;
export const FAST_POLL_MS = 800;
export const CALM_POLL_MS = 2500;

// Providers (roster order) with a routed message still unanswered: posted
// inside the work window, after the provider joined, with no reply:<id>
// from that provider yet. Offline providers are excluded — nobody is
// coming, so the channel must not claim an answer is on its way.
export function pendingAgentWork(messages, roster, joined = {}, online = new Set(), now = Date.now()) {
  const answered = new Set();
  for (const m of messages) if (String(m.idempotencyKey ?? '').startsWith('reply:')) answered.add(`${m.authorSubject}|${String(m.idempotencyKey).slice(6)}`);
  const due = new Set();
  for (const m of messages) {
    if (now - new Date(m.createdAt).getTime() > AGENT_WORK_WINDOW_MS) continue;
    for (const p of addressed(m, roster)) {
      if (answered.has(`agent:${p}|${m.id}`)) continue;
      const j = joined[p];
      if (j && new Date(m.createdAt).getTime() < Date.parse(j)) continue;
      if (providerOnline(p, online)) due.add(p);
    }
  }
  return roster.filter((p) => due.has(p));
}

// ---------- the Maestro desk (the manager seat) ----------
// The desk is one channel per tenant (slug 'maestro-desk', title
// 'Maestro', kind 'team'), created lazily by the server
// (POST /api/admin/envoy/maestro-desk) the first time the manager
// enters the seat. Its mesh config carries desk:true and a roster with
// no 'maestro' on it: in the desk, Maestro is the human sending, and a
// send is a dispatch — @all broadcasts to every agent on the desk,
// @name picks the named agents, and an unnamed send reaches the whole
// desk. These helpers mirror the server's desk routing
// (src/cloud/envoy-agents.mjs: agentsToAnswer with desk:true) the way
// `addressed` mirrors the ordinary rules.
export const MAESTRO_DESK_SLUG = 'maestro-desk';

export function isDeskChannel(channel) {
  return Boolean(channel) && channel.slug === MAESTRO_DESK_SLUG;
}

export function deskChannelFor(channels) {
  return (channels ?? []).find((c) => isDeskChannel(c)) ?? null;
}

// The desk roster in AGENTS order with 'maestro' removed — Maestro is
// never a dispatch target, because in the desk Maestro is the sender.
export function deskRoster(providers) {
  const have = new Set(providers ?? []);
  return AGENTS.filter((p) => p !== 'maestro' && have.has(p));
}

// Who a manager's desk message dispatches to, in desk roster order.
// Agent-authored and system messages dispatch nobody here (the server
// keeps the ordinary rules for those in the desk too).
export function deskTargets(message, roster) {
  const team = deskRoster(roster);
  if (!team.length || message?.authorKind !== 'human') return [];
  const { all, providers } = mentions(message.body);
  if (all) return team;
  if (providers.length) return team.filter((p) => providers.includes(p));
  return team;
}

// The desk's pending-work mirror (pendingAgentWork with desk routing):
// same 30-minute work window, joined and reply rules, over deskTargets.
export function deskPending(messages, roster, joined = {}, online = new Set(), now = Date.now()) {
  const team = deskRoster(roster);
  const answered = new Set();
  for (const m of messages) if (String(m.idempotencyKey ?? '').startsWith('reply:')) answered.add(`${m.authorSubject}|${String(m.idempotencyKey).slice(6)}`);
  const due = new Set();
  for (const m of messages) {
    if (now - new Date(m.createdAt).getTime() > AGENT_WORK_WINDOW_MS) continue;
    for (const p of deskTargets(m, team)) {
      if (answered.has(`agent:${p}|${m.id}`)) continue;
      const j = joined[p];
      if (j && new Date(m.createdAt).getTime() < Date.parse(j)) continue;
      if (providerOnline(p, online)) due.add(p);
    }
  }
  return team.filter((p) => due.has(p));
}

// Private agent rooms: every agent has its own channel (kind 'agent',
// slug agent-<provider>) where its one-to-one conversation lives, away
// from the shared channels. The Agent Chat pane reads and writes that
// room instead of filtering the open channel: in the room there is
// nothing else — the room seats exactly one agent, so its whole
// non-system stream is the conversation. Rooms are created lazily by
// the server (POST /api/admin/envoy/agent-room) the first time a room
// is opened.
export function agentRoomThread(messages) {
  return (messages ?? []).filter((m) => m.authorKind !== 'system');
}

// The room channel for one provider in the loaded channel list, or null
// until the server has created it.
export function agentRoomFor(channels, provider) {
  if (!provider) return null;
  return (channels ?? []).find((c) => c.kind === 'agent' && c.slug === `agent-${provider}`) ?? null;
}

// Pending work in the open channel, from the live server-fed state.
function currentWorking() {
  const agents = ws.config?.agents ?? [];
  const joined = Object.fromEntries(agents.map((a) => [a.provider, a.joinedAt]));
  const roster = agents.map((a) => a.provider);
  if (inMaestroMode()) return deskPending(ws.messages, roster, joined, ws.online);
  return pendingAgentWork(ws.messages, roster, joined, ws.online);
}

// Message text -> DOM: code fences, links (open in the workbench browser), @mentions, Claim:.
export function renderBody(text, { onLink, onCanvas } = {}) {
  const frag = document.createDocumentFragment();
  const parts = String(text ?? '').split(/```(\w+)?\n?([\s\S]*?)```/g);
  for (let i = 0; i < parts.length; i += 3) {
    inline(parts[i], frag, onLink);
    if (i + 2 < parts.length) {
      const lang = (parts[i + 1] || '').toLowerCase(); const code = parts[i + 2] ?? '';
      frag.append(h('pre', {}, h('code', { text: code })));
      if (onCanvas && (lang === 'html' || /<\/?(html|body|div|section|style)\b/i.test(code))) frag.append(h('div', { class: 'ew-code-actions' }, h('button', { type: 'button', class: 'ew-btn ghost sm', onclick: () => onCanvas(code) }, 'Open in Canvas')));
    }
  }
  return frag;
}
function inline(text, into, onLink) {
  const re = /(https?:\/\/[^\s<>"')\]]+)|(@[A-Za-z][A-Za-z0-9_-]{1,20})|(^|\n)(Claim:)/g;
  let at = 0; let m;
  while ((m = re.exec(text))) {
    into.append(text.slice(at, m.index));
    if (m[1]) into.append(h('button', { type: 'button', class: 'link', title: 'Open in the workbench browser', onclick: () => onLink?.(m[1]) }, m[1]));
    else if (m[2]) into.append(h('span', { class: 'mention' }, m[2]));
    else { into.append(m[3]); into.append(h('span', { class: 'claim' }, m[4])); }
    at = re.lastIndex;
  }
  into.append(text.slice(at));
}

const ws = { avatars: ls.get('avatars', {}), pendingAvatar: null, wired: false, ctx: null, channels: [], channelId: null, mode: ls.get('netMode', 'envoy') === 'discord' ? 'discord' : 'envoy', config: null, configured: false, discordBot: null, messages: [], sig: null, cueSig: null, online: new Set(), timer: null, slowTimer: null, agentsPinned: ls.get('agentsPinned', {}), linkPoll: null, cli: { provider: 'maestro', pending: null, sessions: [], server: false, activeId: ls.get('cliSession', null), threadSig: null, roomId: null, roomFor: null, roomMessages: [], roomSig: null, roomJoined: {}, roomPromise: null }, attach: { channel: [], cli: [] }, pickerFor: null, pickerData: null, slash: { commands: null, loaded: false, loading: null, openFor: null, index: 0, dismissedFor: null }, desk: { handoffs: null, checkpoints: null, denied: false, promise: null } };

// ---------- avatars (saved on this device) ----------
const isPlain = () => ws.ctx?.state?.emojiMode === 'plain';
function chatAvatar(c, cls = '') {
  const a = avatarFor(sanitizeChoice(ws.avatars[c?.id]), c?.title || c?.slug);
  return h('span', { class: `ew-ava ${a.kind} ${cls}`.trim(), style: a.kind === 'plain' ? `--ava:${a.color}` : null, 'aria-hidden': 'true' }, a.glyph);
}
function saveAvatar(id, choice) { const v = sanitizeChoice(choice); if (!id || !v) return; ws.avatars[id] = v; ls.set('avatars', ws.avatars); }
// Characters or simple letter icons; the switch remembers the person's preference.
function avatarPicker(choice, title, onPick) {
  let look = choice?.k === 'plain' ? 'plain' : 'char';
  const wrap = h('div', { class: 'ew-ava-pick' });
  const draw = () => {
    const seg = h('div', { class: 'ew-seg', role: 'radiogroup', 'aria-label': 'Avatar style' },
      ...[['char', 'Characters'], ['plain', 'Simple']].map(([k, label]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(look === k), class: look === k ? 'on' : '', onclick: () => { look = k; if ((choice?.k ?? 'char') !== k) { choice = defaultChoice(title(), k === 'plain' ? 'plain' : 'playful'); onPick(choice); } draw(); } }, label)));
    const grid = h('div', { class: look === 'char' ? 'ew-ava-grid' : 'ew-ava-grid plain', role: 'radiogroup', 'aria-label': look === 'char' ? 'Pick a character' : 'Pick a colour' },
      ...(look === 'char'
        ? CHARACTERS.map(([id, glyph, label]) => h('button', { type: 'button', role: 'radio', class: `ew-ava char${choice?.id === id ? ' on' : ''}`, 'aria-checked': String(choice?.id === id), 'aria-label': label, title: label, onclick: () => { choice = { k: 'char', id }; onPick(choice); draw(); } }, glyph))
        : COLORS.map((color, i) => h('button', { type: 'button', role: 'radio', class: `ew-ava plain${choice?.c === i ? ' on' : ''}`, style: `--ava:${color}`, 'aria-checked': String(choice?.c === i), 'aria-label': `Colour ${i + 1}`, title: `Colour ${i + 1}`, onclick: () => { choice = { k: 'plain', c: i }; onPick(choice); draw(); } }, avatarFor({ k: 'plain', c: i }, title()).glyph))));
    wrap.replaceChildren(seg, grid);
  };
  draw();
  return wrap;
}
function openAvatarModal() {
  const c = ws.channels.find((x) => x.id === ws.channelId); if (!c) return;
  let pick = sanitizeChoice(ws.avatars[c.id]) ?? defaultChoice(c.title || c.slug, 'plain'); // matches what the list shows today
  openModal(`Look for #${c.title || c.slug}`, [
    h('p', { class: 'muted sm' }, 'Pick a character, or switch to Simple for a plain letter icon. Saved on this device.'),
    avatarPicker(pick, () => c.title || c.slug, (v) => { pick = v; }),
    h('div', { class: 'ew-row' }, h('span', { class: 'ew-spacer' }), h('button', { type: 'button', class: 'ew-btn primary sm', onclick: () => { saveAvatar(c.id, pick); renderChannels(); renderHeadAvatar(); closeModal(); } }, 'Save')),
  ]);
}
function renderHeadAvatar() {
  const b = $('ew-chat-ava'); if (!b) return;
  const c = ws.channels.find((x) => x.id === ws.channelId);
  b.replaceChildren(c ? chatAvatar(c) : h('span', { class: 'ew-hash' }, '#'));
}
function renderNewChannelAvatar() {
  const box = $('ew-new-avatar'); if (!box) return;
  const name = () => $('ew-new-channel-name').value.trim() || 'New chat';
  ws.pendingAvatar = defaultChoice(name(), isPlain() ? 'plain' : 'playful');
  box.replaceChildren(avatarPicker(ws.pendingAvatar, name, (v) => { ws.pendingAvatar = v; }));
}

// ---------- swipe (phones): edge swipes open sheets, swipes close them ----------
function wireSwipe() {
  const root = $('ew'); let t0 = null;
  root.addEventListener('touchstart', (e) => { if (!narrow() || e.touches.length !== 1) { t0 = null; return; } const p = e.touches[0]; t0 = { x: p.clientX, y: p.clientY, at: Date.now() }; }, { passive: true });
  root.addEventListener('touchend', (e) => {
    if (!t0 || !narrow()) return; const p = e.changedTouches[0]; const dx = p.clientX - t0.x; const dy = p.clientY - t0.y; const start = t0; t0 = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5 || Date.now() - start.at > 800) return;
    const open = document.querySelector('.ew-pane.sheet-open');
    if (open) { const left = open.id === 'ew-channels'; if ((left && dx < 0) || (!left && dx > 0)) closeSheets(); return; }
    if ($('ew-modal').classList.contains('open')) return;
    if (start.x < 32 && dx > 0) setPane('channels', true);
    else if (start.x > window.innerWidth - 32 && dx < 0) setPane('guard', true);
  }, { passive: true });
}

function setPane(name, open, { user = false } = {}) {
  const pane = $(`ew-${name}`); if (!pane) return;
  // Hide always wins over Expand: leaving bench-max on while the bench
  // collapses strands an invisible-but-full-width bench, a zeroed chat and
  // every restore control inside the dead pane (only a reload recovered).
  if (name === 'bench' && !open && $('ew').classList.contains('bench-max')) {
    $('ew').classList.remove('bench-max');
    const maxBtn = $('ew-bench-max');
    if (maxBtn) { maxBtn.textContent = '⤢'; maxBtn.title = 'Expand'; maxBtn.setAttribute('aria-label', 'Expand workbench'); }
  }
  if (narrow()) {
    pane.classList.toggle('sheet-open', open);
    const anySheet = document.querySelector('.ew-pane.sheet-open');
    $('ew-scrim').classList.toggle('open', Boolean(anySheet));
  } else {
    pane.classList.toggle('collapsed', !open);
    if (name === 'channels') $('ew').classList.toggle('no-channels', !open);
    const split = document.querySelector(`.ew-split[data-split="${name}"]`);
    if (split) split.classList.toggle('hidden', !open);
    if (user && name !== 'agents') ls.set(`open.${name}`, open);
  }
  for (const b of document.querySelectorAll(`[data-toggle="${name}"]`)) b.setAttribute('aria-pressed', String(open));
  syncSplitterAria(name);
}
// Keep a separator's aria-valuenow honest across collapse/restore: 0 while
// the pane is collapsed, its remembered width when it comes back.
function syncSplitterAria(name) {
  const split = document.querySelector(`.ew-split[data-split="${name}"]`);
  if (!split) return;
  const open = paneOpen(name);
  const w = open ? (ls.get('widths', {})[name] ?? Math.round($(`ew-${name}`)?.getBoundingClientRect().width ?? 0)) : 0;
  split.setAttribute('aria-valuenow', String(Math.round(w)));
}
const paneOpen = (name) => { const p = $(`ew-${name}`); return narrow() ? p.classList.contains('sheet-open') : !p.classList.contains('collapsed'); };
function closeSheets() { for (const p of document.querySelectorAll('.ew-pane.sheet-open')) p.classList.remove('sheet-open'); $('ew-scrim').classList.remove('open'); for (const b of document.querySelectorAll('[data-toggle]')) b.setAttribute('aria-pressed', 'false'); }

function applyLayout() {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(ls.get('widths', {}))) if (v > 120 && v < 1400) root.style.setProperty(`--ew-${k}`, `${v}px`);
  if (narrow()) { for (const p of ['channels', 'cli', 'agents', 'guard', 'bench']) { $(`ew-${p}`).classList.remove('collapsed'); } closeSheets(); return; }
  setPane('channels', ls.get('open.channels', true));
  setPane('cli', ls.get('open.cli', true));
  setPane('guard', ls.get('open.guard', true));
  setPane('bench', ls.get('open.bench', window.innerWidth >= 1680));
  syncAgentsPane();
}
function syncAgentsPane() {
  if (narrow()) return;
  const count = ws.config?.agents?.length ?? 0;
  const pinned = ws.agentsPinned[ws.channelId];
  // Agents pane opens in agent chats and folds away elsewhere, unless the user chose.
  setPane('agents', pinned === undefined ? false : pinned);
}

// Splitter floors per pane. The CSS min-widths in envoy.css match these
// exactly — when the two disagreed (JS clamped at 180, CSS floored the
// workbench at 320) the drag had dead travel in both directions. Releasing
// a drag below SNAP collapses the pane instead of parking it at the floor;
// the pre-drag width stays in the var, so reopening restores it.
const PANE_MIN = { channels: 132, cli: 150, agents: 150, guard: 150, bench: 200 };
const PANE_MAX = 900;
const SNAP = 76;
// Sized panes in DOM order (the chat sits between channels and cli but is
// not sized — it is the flexible pane every drag trades space with).
const PANE_ORDER = ['channels', 'cli', 'agents', 'guard', 'bench'];

// Pure drag geometry, exported for tests. A drag must move the pane edge
// 1:1 with the pointer, so the dragged pane's growth is bounded by what
// the REST OF THE ROW can yield — the flexible chat down to its floor,
// then each other sized pane down to its own floor — never by the
// container's already-free space. The old clamp measured exactly that
// free space, and in a full row it is ~0: a +300px drag on channels
// landed +76px. widths/floors cover every open sized pane (rendered
// widths; floors from PANE_MIN); splitsW is the visible separators'
// total width. Returns the full width map for the row at the clamped
// target: growth is taken from the other panes farthest from the dragged
// one first, so the panes next to the pointer stay put longest.
// Shrinking changes only the dragged pane — the freed space falls to
// the chat on its own.
export function dragLayout({ widths, floors, chatFloor = 380, containerW, splitsW = 0, name, target, maxCap = PANE_MAX }) {
  const out = { ...widths };
  const others = Object.keys(widths).filter((n) => n !== name);
  const floorSum = others.reduce((sum, n) => sum + floors[n], 0);
  const maxAbs = containerW - splitsW - chatFloor - floorSum;
  const width = Math.max(floors[name], Math.min(maxCap, maxAbs, target));
  out[name] = width;
  let need = width - widths[name];
  if (need > 0) {
    // The flexible chat absorbs first, down to its floor; only the
    // remainder is taken from the sized panes.
    const chatNow = containerW - splitsW - Object.values(widths).reduce((sum, w) => sum + w, 0);
    need -= Math.max(0, chatNow - chatFloor);
    const byDistance = others.sort((a, b) => Math.abs(PANE_ORDER.indexOf(b) - PANE_ORDER.indexOf(name)) - Math.abs(PANE_ORDER.indexOf(a) - PANE_ORDER.indexOf(name)));
    for (const n of byDistance) {
      if (need <= 0) break;
      const give = Math.min(Math.max(0, out[n] - floors[n]), need);
      out[n] -= give; need -= give;
    }
  }
  return { widths: out, width };
}

function wireSplitters() {
  const ew = $('ew');
  const setVar = (name, w) => document.documentElement.style.setProperty(`--ew-${name}`, `${Math.round(w)}px`);
  // Flex-shrink decouples a pane's rendered width from its --ew-* var
  // whenever the row is over-full (the default layout already is at laptop
  // widths), which made drags move the var while the eye tracked a shrunken
  // width, and made pointer-up persist a third number. Freezing writes every
  // open pane's rendered width into its var first; while .ew.dragging pins
  // flex-shrink to 0, var == rendered width for the whole drag.
  // Freeze ONLY the dragged pane's var: writing every open pane's rendered
  // width into its inline var permanently opts them all out of the
  // responsive defaults (inline vars beat the <1280px media query), so one
  // drag on a wide monitor crushed the chat on smaller windows forever.
  // The .ew.dragging CSS already pins flex-shrink for the rest.
  const freeze = (only) => {
    const widths = {};
    for (const p of document.querySelectorAll('.ew-pane')) { const n = p.id.replace('ew-', ''); if (n !== only) continue; if (PANE_MIN[n] && !p.classList.contains('collapsed')) widths[n] = Math.round(p.getBoundingClientRect().width); }
    for (const [n, w] of Object.entries(widths)) setVar(n, w);
    return widths;
  };
  // A drag trades space with the whole row (see dragLayout): snapshot
  // every open sized pane's rendered width (read-only — unlike freeze,
  // nothing is written here), which panes already carry an inline var
  // (so an aborted drag restores the exact prior state), the chat's CSS
  // floor and the visible separators' total width.
  const snapshot = () => {
    const widths = {}; const floors = {}; const inline = {};
    for (const p of document.querySelectorAll('.ew-pane')) {
      const n = p.id.replace('ew-', '');
      if (!PANE_MIN[n] || p.classList.contains('collapsed')) continue;
      const w = Math.round(p.getBoundingClientRect().width);
      if (w <= 0) continue; // bench-max zeroes panes with !important — outside the row right now
      widths[n] = w; floors[n] = PANE_MIN[n];
      inline[n] = document.documentElement.style.getPropertyValue(`--ew-${n}`);
    }
    let splitsW = 0;
    for (const s of document.querySelectorAll('.ew-split:not(.hidden)')) splitsW += 5;
    const chatFloor = parseFloat(getComputedStyle($('ew-chat')).minWidth) || 380;
    return { widths, floors, inline, splitsW, chatFloor, containerW: ew.clientWidth };
  };
  const restore = (snap, except = null) => {
    for (const n of Object.keys(snap.widths)) {
      if (n === except) continue;
      if (snap.inline[n]) setVar(n, snap.widths[n]);
      else document.documentElement.style.removeProperty(`--ew-${n}`);
    }
  };
  const persist = (name, w) => { const widths = ls.get('widths', {}); widths[name] = Math.round(w); ls.set('widths', widths); const s = document.querySelector(`.ew-split[data-split="${name}"]`); if (s) s.setAttribute('aria-valuenow', String(Math.round(w))); };
  for (const split of document.querySelectorAll('.ew-split')) {
    const name = split.dataset.split;
    const pane = $(`ew-${name}`);
    const sign = name === 'channels' ? 1 : -1;
    // Separator ARIA: range from the same tables the drag clamps to, and a
    // starting value from the applied width — not silence until first drag.
    split.setAttribute('aria-valuemin', String(PANE_MIN[name]));
    split.setAttribute('aria-valuemax', String(PANE_MAX));
    split.setAttribute('aria-valuenow', String(Math.round(ls.get('widths', {})[name] ?? pane.getBoundingClientRect().width)));
    split.addEventListener('pointerdown', (e) => {
      if (narrow()) return;
      e.preventDefault(); split.setPointerCapture(e.pointerId);
      const start = e.clientX; const startW = freeze(name)[name] ?? Math.round(pane.getBoundingClientRect().width);
      if (!startW) return; // the pane is zeroed out (bench-max) — nothing to drag
      const snap = snapshot(); const min = PANE_MIN[name];
      split.classList.add('dragging'); ew.classList.add('dragging');
      let raw = startW; let done = false; let applied = { ...snap.widths };
      const move = (ev) => {
        raw = startW + sign * (ev.clientX - start);
        const lay = dragLayout({ ...snap, name, target: raw });
        // Only panes whose width actually changes get their var written:
        // on a roomy screen a drag still touches nobody else (S2).
        for (const [n, w] of Object.entries(lay.widths)) if (w !== applied[n]) { setVar(n, w); applied[n] = w; }
        split.setAttribute('aria-valuenow', String(Math.round(lay.width)));
        // The collapse hint arms as soon as the pointer passes the pane's
        // floor, not only in the last stretch of dead travel below SNAP.
        pane.classList.toggle('will-collapse', raw < min);
      };
      const finish = (commit) => {
        if (done) return; done = true;
        split.classList.remove('dragging'); ew.classList.remove('dragging'); pane.classList.remove('will-collapse');
        split.removeEventListener('pointermove', move); split.removeEventListener('pointerup', up); split.removeEventListener('pointercancel', cancel);
        if (!commit) { restore(snap); return; }
        if (raw < SNAP) {
          // Slide-to-collapse: the pre-drag width stays in the var (and in
          // storage) as the remembered width reopening restores; any
          // neighbour that yielded during the drag gets its width back.
          restore(snap, name);
          setVar(name, startW);
          if (name === 'agents') { ws.agentsPinned[ws.channelId] = false; ls.set('agentsPinned', ws.agentsPinned); }
          setPane(name, false, { user: true });
          return;
        }
        persist(name, applied[name]);
        // A neighbour that actually yielded keeps its new width — the
        // user's own drag took that space. Untouched neighbours are
        // neither written nor persisted, so their responsive defaults
        // and remembered widths survive (S2).
        for (const n of Object.keys(applied)) if (n !== name && applied[n] !== snap.widths[n]) persist(n, applied[n]);
      };
      const up = () => finish(true);
      const cancel = () => finish(false);
      split.addEventListener('pointermove', move); split.addEventListener('pointerup', up); split.addEventListener('pointercancel', cancel);
    });
    const resetWidth = () => { document.documentElement.style.removeProperty(`--ew-${name}`); const w = ls.get('widths', {}); delete w[name]; ls.set('widths', w); split.setAttribute('aria-valuenow', String(Math.round(pane.getBoundingClientRect().width))); };
    split.addEventListener('dblclick', resetWidth);
    split.addEventListener('keydown', (e) => {
      // Keyboard parity with the pointer: Home collapses (slide-under),
      // End/Enter resets to the default width, like the dblclick reset.
      if (e.key === 'Home') {
        e.preventDefault();
        if (name === 'agents') { ws.agentsPinned[ws.channelId] = false; ls.set('agentsPinned', ws.agentsPinned); }
        setPane(name, false, { user: true });
        return;
      }
      if (e.key === 'End' || e.key === 'Enter') { e.preventDefault(); resetWidth(); return; }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const startW = freeze(name)[name] ?? Math.round(pane.getBoundingClientRect().width);
      if (!startW) return; // zeroed out (bench-max), same as the pointer path
      const snap = snapshot();
      ew.classList.add('dragging');
      const lay = dragLayout({ ...snap, name, target: startW + sign * (e.key === 'ArrowRight' ? 24 : -24) });
      for (const [n, w] of Object.entries(lay.widths)) if (w !== snap.widths[n]) setVar(n, w);
      persist(name, lay.width);
      for (const n of Object.keys(lay.widths)) if (n !== name && lay.widths[n] !== snap.widths[n]) persist(n, lay.widths[n]);
      split.setAttribute('aria-valuenow', String(Math.round(lay.width)));
      ew.classList.remove('dragging');
    });
  }
}

// ---------- channels ----------
async function loadChannels() {
  const { api, post, state } = ws.ctx;
  const body = await api('/api/admin/envoy/channels');
  ws.channels = Array.isArray(body.channels) ? body.channels : [];
  if (!ws.channels.length && ['owner', 'admin'].includes(state.actor?.role)) {
    const made = await post('/api/admin/envoy/channels', { slug: 'team', title: 'Team', kind: 'team' });
    if (made.channel) ws.channels = [made.channel];
  }
  const meta = ls.get('chanMeta', {});
  for (const c of ws.channels) if (meta[c.id]) { c._agents = meta[c.id].a; c._discord = meta[c.id].d; }
  // The open channel is remembered per network mode: Envoy restores its
  // own last channel (the legacy 'channel' key is its fallback), Discord
  // mode restores its last linked channel.
  const saved = ls.get(`netChannel.${ws.mode}`, null) ?? (ws.mode === 'envoy' ? ls.get('channel', null) : null);
  const pool = modeChannels();
  if (!pool.some((c) => c.id === ws.channelId)) ws.channelId = pool.some((c) => c.id === saved) ? saved : pool[0]?.id ?? null;
  renderChannels();
}
function currentTitle() { const c = ws.channels.find((x) => x.id === ws.channelId); return c?.title || c?.slug || 'channel'; }
const openChannel = () => ws.channels.find((c) => c.id === ws.channelId) ?? null;
// Manager mode is a place, not a toggle: the desk channel is open.
const inMaestroMode = () => isDeskChannel(openChannel());
function openNewChannel() {
  setPane('channels', true);
  $('ew-new-channel').hidden = false; $('ew-add-channel').hidden = true; renderNewChannelAvatar(); $('ew-new-channel-name').focus();
}
// ---------- network flip: Envoy ⇄ Discord ----------
// One chat surface, two networks (Troy's ruling + the Slack/Discord UX
// research): a labelled two-segment switch at the top of the channels
// pane — both names always visible, never icon-only — swaps the channel
// list and the chat context with identical geometry. Linked channels
// are distinguishable only through the per-channel config the client
// already loads (the channels API carries no Discord field): _discord
// is set from that config and cached in chanMeta, the same source the
// old DISCORD section below the Envoy list always used.
const linkedChannels = () => ws.channels.filter((c) => c._discord);
const modeChannels = () => (ws.mode === 'discord' ? linkedChannels() : ws.channels);
function renderNetSwitch() {
  const envoy = $('ew-net-envoy'); const discord = $('ew-net-discord'); if (!envoy || !discord) return;
  const dOn = ws.mode === 'discord';
  envoy.classList.toggle('on', !dOn); envoy.setAttribute('aria-selected', String(!dOn));
  discord.classList.toggle('on', dOn); discord.setAttribute('aria-selected', String(dOn));
  // Inactive-side badge: the one count the data model honestly has is
  // the linked-channel count (no unread/mention counts exist client-
  // side), so it rides the Discord segment while Envoy is active, in a
  // neutral chip — never the red mention style it does not mean.
  const n = linkedChannels().length;
  const chip = $('ew-net-discord-count');
  chip.hidden = dOn || n === 0;
  chip.textContent = String(n);
  discord.title = n ? `Discord — ${n} linked channel${n === 1 ? '' : 's'}` : 'Discord';
}
// Anti-mis-send strip directly above the composer: names the network
// and channel a message will land in, in both modes.
function renderNetStrip() {
  const strip = $('ew-net-strip'); if (!strip) return;
  const ch = ws.channels.find((c) => c.id === ws.channelId);
  const title = ch?.title || ch?.slug || 'channel';
  const dOn = ws.mode === 'discord';
  strip.classList.toggle('discord', dOn);
  $('ew-chat').classList.toggle('net-discord', dOn);
  if (!dOn && isDeskChannel(ch)) {
    strip.textContent = "You're dispatching as Maestro · the desk — replies come back under each agent's own name";
    return;
  }
  strip.textContent = dOn
    ? (ch ? `You're posting to Discord · #${ws.config?.discord?.channelName || title}` : "You're in Discord · no channel linked yet")
    : `You're posting to Envoy · #${title}`;
}
function setComposer(on) {
  const box = $('maestro-input'); const btn = $('maestro-send');
  if (box) box.disabled = !on;
  if (btn) btn.disabled = !on;
}
const discordEmptyText = () => ws.discordBot?.configured
  ? 'No channels are linked to Discord yet. Flip to Envoy, open a channel and use Link Discord to mirror it here.'
  : 'The Helmian Discord bot is not connected yet. Once it is, linked channels mirror here.';
// ---------- entering and leaving the seat ----------
// The desk channel is resolved once: from the channel list when it
// already exists, otherwise the server creates it (and seeds its
// dispatch config) on first entry — the rooms pattern.
async function ensureMaestroDesk() {
  const known = deskChannelFor(ws.channels);
  if (known) return known.id;
  if (ws.desk.promise) return ws.desk.promise;
  ws.desk.promise = (async () => {
    try {
      const body = await ws.ctx.post('/api/admin/envoy/maestro-desk', {});
      if (body.channel) {
        const i = ws.channels.findIndex((c) => c.id === body.channel.id);
        if (i >= 0) ws.channels[i] = { ...ws.channels[i], ...body.channel }; else ws.channels = [...ws.channels, body.channel];
        renderChannels();
        return body.channel.id;
      }
    } catch { /* the seat row stays the way in until a retry lands */ }
    return null;
  })();
  try { return await ws.desk.promise; } finally { ws.desk.promise = null; }
}
async function enterMaestroSeat() {
  const id = await ensureMaestroDesk();
  if (id) await selectChannel(id);
  else ws.ctx.toast('The desk is not reachable yet. Try again.');
}
async function leaveMaestroSeat() {
  const next = ws.channels.find((c) => !isDeskChannel(c) && c.kind !== 'agent');
  if (next) await selectChannel(next.id);
  else ws.ctx.toast('Create a channel to leave the seat.');
}
async function setNetMode(mode) {
  if (mode !== 'envoy' && mode !== 'discord') return;
  if (ws.mode === mode) { renderNetSwitch(); return; }
  if (ws.channelId) ls.set(`netChannel.${ws.mode}`, ws.channelId);
  ws.mode = mode; ls.set('netMode', mode);
  // Channel creation is an Envoy-side act; hide its affordances here.
  $('ew-new-channel').hidden = true;
  $('ew-add-channel').hidden = mode === 'discord';
  const pool = modeChannels();
  const saved = ls.get(`netChannel.${mode}`, null);
  const target = pool.some((c) => c.id === saved) ? saved : pool[0]?.id ?? null;
  renderNetSwitch(); renderChannels(); renderNetStrip();
  if (target) { await selectChannel(target); return; }
  // Discord mode with nothing linked: honest empty state, no fake chat.
  ws.channelId = null; ws.config = null; ws.messages = []; ws.sig = null;
  renderChannels(); renderHeader(); renderNetStrip();
  $('ew-channel-title').textContent = 'Discord';
  $('ew-link-discord').hidden = true;
  $('ew-messages').replaceChildren(h('div', { class: 'ew-empty' }, discordEmptyText()));
  setComposer(false);
}

function renderChannels() {
  const list = $('ew-channel-list');
  const row = (c) => h('button', { type: 'button', class: `ew-channel${c.kind === 'agent' ? ' room' : ''}${c.id === ws.channelId ? ' active' : ''}`, 'data-id': c.id, onclick: () => selectChannel(c.id) },
    chatAvatar(c, 'sm'), h('span', { class: 'name' }, c.title || c.slug),
    h('span', { class: 'tags' }, c._discord ? h('span', { class: 'ew-mini discord', title: 'Linked to Discord' }) : null, c._agents ? h('span', { class: 'ew-mini agents', title: `${c._agents} agent(s)` }) : null, c.kind === 'agent' ? h('span', { class: 'ew-mini room', title: 'Private agent room' }) : null));
  renderNetSwitch();
  list.setAttribute('aria-label', ws.mode === 'discord' ? 'Discord channels' : 'Envoy channels');
  $('ew-add-channel').hidden = ws.mode === 'discord' || !$('ew-new-channel').hidden;
  const linked = linkedChannels();
  const bot = ws.discordBot;
  if (ws.mode === 'discord') {
    list.replaceChildren(
      h('div', { class: 'ew-src-head' }, h('span', { class: 'ew-discord-mark', 'aria-hidden': 'true' }), 'DISCORD'),
      ...(linked.length ? linked.map(row) : [h('p', { class: 'ew-note' }, bot?.configured ? 'No channels linked yet. Flip to Envoy, open a channel and use Link Discord to mirror it here.' : 'Bot not connected yet. Linked channels mirror here.')])
    );
    return;
  }
  // The seat sits above the channel list under its own head: it is not
  // a channel you chat in, it is the manager's desk. Until the server
  // has created it, the row is the way in (entering creates it).
  const desk = deskChannelFor(ws.channels);
  const seatRow = desk
    ? h('button', { type: 'button', class: `ew-channel seat${desk.id === ws.channelId ? ' active' : ''}`, 'data-id': desk.id, onclick: () => selectChannel(desk.id) },
      h('span', { class: 'ew-avatar seat-ava' }, avatarImg('maestro')), h('span', { class: 'name' }, 'Maestro'),
      h('span', { class: 'tags' }, h('span', { class: 'ew-mini seat', title: 'Your manager seat' })))
    : h('button', { type: 'button', class: 'ew-channel seat enter', onclick: () => enterMaestroSeat() },
      h('span', { class: 'ew-avatar seat-ava' }, avatarImg('maestro')), h('span', { class: 'name' }, 'Maestro'),
      h('span', { class: 'tags' }, h('span', { class: 'ew-mini seat', title: 'Enter your manager seat' })));
  // Agent rooms (kind 'agent') get their own section: they are private
  // one-to-one rooms, not shared channels, and the list says so.
  const regular = ws.channels.filter((c) => c.kind !== 'agent' && !isDeskChannel(c));
  const rooms = ws.channels.filter((c) => c.kind === 'agent');
  list.replaceChildren(
    h('div', { class: 'ew-src-head' }, h('img', { src: '/assets/agents/maestro.png', alt: '', width: 14, height: 14 }), 'MAESTRO'),
    seatRow,
    h('div', { class: 'ew-src-head' }, h('img', { src: '/assets/agents/maestro.png', alt: '', width: 14, height: 14 }), 'ENVOY'),
    ...(regular.length ? regular.map(row) : [h('p', { class: 'ew-note' }, 'No channels yet.')]),
    ...(rooms.length ? [h('div', { class: 'ew-src-head' }, h('span', { class: 'ew-room-mark', 'aria-hidden': 'true' }), 'AGENT ROOMS'), ...rooms.map(row)] : []),
    h('div', { class: 'ew-src-head' }, h('span', { class: 'ew-discord-mark', 'aria-hidden': 'true' }), 'DISCORD'),
    ...(linked.length ? linked.map(row) : [h('p', { class: 'ew-note' }, bot?.configured ? 'No channels linked yet. Use Link Discord in a chat.' : 'Bot not connected yet. Linked channels mirror here.')]),
    h('div', { class: 'ew-src-head' }, h('span', { class: 'ew-gh-mark', 'aria-hidden': 'true' }), 'GITHUB'),
    h('p', { class: 'ew-note' }, 'Repo activity is not wired in yet. ', h('a', { href: '#integrations' }, 'Integrations'))
  );
}
async function selectChannel(id) {
  if (!id) return;
  ws.channelId = id; ls.set('channel', id); ls.set(`netChannel.${ws.mode}`, id); ws.sig = null; ws.messages = [];
  setComposer(true);
  renderChannels();
  $('ew-messages').replaceChildren(h('div', { class: 'ew-empty' }, 'Loading…'));
  if (narrow()) closeSheets();
  await Promise.allSettled([loadConfig(), loadMessages()]);
  if (inMaestroMode()) loadDeskLists();
  $('maestro-input').focus({ preventScroll: true });
}

// ---------- config: agents + Discord ----------
async function loadConfig() {
  if (!ws.channelId) return;
  const id = ws.channelId;
  try {
    const body = await ws.ctx.api(`/api/admin/envoy/channel-config?channel_id=${encodeURIComponent(id)}`);
    if (id !== ws.channelId) return;
    ws.config = body.config ?? { agents: [] }; ws.configured = Boolean(body.configured); ws.discordBot = body.discordBot ?? null;
  } catch { ws.config = { agents: [], discord: null }; ws.configured = false; }
  const ch = ws.channels.find((c) => c.id === id);
  if (ch) { ch._agents = ws.config.agents.length; ch._discord = Boolean(ws.config.discord); const seen = ls.get('chanMeta', {}); seen[ch.id] = { a: ch._agents, d: ch._discord }; ls.set('chanMeta', seen); }
  renderHeader(); renderAgents(); renderChannels(); syncAgentsPane();
  // A roster or join change can start (or end) pending work without any
  // new message arriving; keep the in-thread cue honest.
  if (ws.messages.length && currentWorking().join(',') !== ws.cueSig) renderMessages();
}
function renderHeader() {
  const ch = ws.channels.find((c) => c.id === ws.channelId);
  const title = ch?.title || ch?.slug || 'channel';
  $('ew-channel-title').textContent = title; renderHeadAvatar();
  // The placeholder names the destination channel in both modes; the
  // long @agent hint is an Envoy-side extra and stays there.
  $('maestro-input').placeholder = ws.mode === 'discord' ? `Message #${title}` : (ws.config?.agents?.length && !narrow() ? `Message #${title} · @ an agent or let Maestro route it` : `Message #${title}`);
  const badge = $('ew-discord-badge');
  const d = ws.config?.discord;
  badge.hidden = !(d || ws.config?.pendingLink);
  badge.className = `ew-badge ${d ? 'discord' : 'pending'}`;
  badge.textContent = d ? `Discord #${d.channelName || d.channelId}` : 'Discord link pending';
  const admin = ['owner', 'admin'].includes(ws.ctx.state.actor?.role);
  const link = $('ew-link-discord');
  link.querySelector('.lbl').textContent = d ? 'Discord linked' : 'Link Discord';
  link.hidden = !admin && !d;
  $('ew-agent-count').textContent = String(ws.config?.agents?.length ?? 0);
  $('ew-discord-status-text').textContent = ws.discordBot?.configured ? (d ? `linked to #${d.channelName || d.channelId}` : 'ready to link') : 'bot not set up yet';
  renderNetStrip();
  renderMaestroMode();
}
// The seat's on-screen state. While the desk is open the chat pane is
// unmistakably in manager mode: a banner over the thread, the desk
// styling on the pane, the desk panel in the Agents pane, and composer
// copy that says "dispatch" — because that is what a send here is.
// Leaving the desk restores the ordinary channel furniture exactly.
function renderMaestroMode() {
  const on = inMaestroMode();
  const banner = $('ew-maestro-banner'); if (banner) banner.hidden = !on;
  $('ew-chat').classList.toggle('maestro-mode', on);
  const panel = $('ew-desk'); if (panel) panel.hidden = !on;
  const hint = $('ew-composer-hint');
  if (on) {
    $('maestro-input').placeholder = 'Dispatch to your agents — @name for one, @all for everyone; no name reaches everyone';
    if (hint) hint.textContent = 'Enter to dispatch · Shift+Enter for a new line';
    $('ew-link-discord').hidden = true;
    $('ew-discord-badge').hidden = true;
  } else if (hint) {
    hint.textContent = 'Enter to send · Shift+Enter for a new line';
  }
}
// The desk surface: the manager's existing handoff and checkpoint lists
// (the Session console's Evidence endpoints), shown beside the thread
// while the seat is occupied. Failures stay honest: owner/admin-only
// lists say so instead of pretending to be empty.
function renderDeskLists() {
  const hBox = $('ew-desk-handoffs'); const cBox = $('ew-desk-checkpoints'); const note = $('ew-desk-note');
  if (!hBox || !cBox || !note) return;
  const item = (title, sub) => h('div', { class: 'ew-desk-item' }, h('strong', {}, title), sub ? h('span', { class: 'meta' }, sub) : null);
  if (ws.desk.denied) {
    note.textContent = 'Handoffs and checkpoints are visible to owners and admins.';
    hBox.replaceChildren(); cBox.replaceChildren();
    return;
  }
  note.textContent = '';
  hBox.replaceChildren(...(ws.desk.handoffs === null ? [h('p', { class: 'ew-note' }, 'Loading…')]
    : ws.desk.handoffs.length ? ws.desk.handoffs.map((x) => item(String(x.title ?? x.id ?? 'Handoff'), [x.state, x.owner].filter(Boolean).join(' · ')))
    : [h('p', { class: 'ew-note' }, 'No handoffs recorded.')]));
  cBox.replaceChildren(...(ws.desk.checkpoints === null ? [h('p', { class: 'ew-note' }, 'Loading…')]
    : ws.desk.checkpoints.length ? ws.desk.checkpoints.map((x) => item(String(x.title ?? x.id ?? 'Checkpoint'), [x.state, x.agent].filter(Boolean).join(' · ')))
    : [h('p', { class: 'ew-note' }, 'No checkpoints recorded.')]));
}
async function loadDeskLists() {
  if (!inMaestroMode()) return;
  const [hRes, cRes] = await Promise.allSettled([ws.ctx.api('/api/admin/maestro/handoffs'), ws.ctx.api('/api/admin/maestro/checkpoints')]);
  ws.desk.denied = (hRes.status === 'rejected' && hRes.reason?.status === 403) || (cRes.status === 'rejected' && cRes.reason?.status === 403);
  if (hRes.status === 'fulfilled') ws.desk.handoffs = Array.isArray(hRes.value?.handoffs) ? hRes.value.handoffs : [];
  if (cRes.status === 'fulfilled') ws.desk.checkpoints = Array.isArray(cRes.value?.checkpoints) ? cRes.value.checkpoints : [];
  renderDeskLists();
}
function renderAgents() {
  const desk = inMaestroMode();
  const raw = (ws.config?.agents ?? []).map((a) => a.provider);
  // In the desk the roster is the dispatch team: 'maestro' is never on
  // it (Maestro is the sender), and the working lights use desk routing.
  const roster = desk ? deskRoster(raw) : raw;
  const states = agentStates(ws.messages, roster, ws.online, Date.now(), desk ? deskTargets : addressed);
  $('ew-agents-summary').textContent = desk
    ? (roster.length ? `${roster.length} on the desk` : 'the desk is empty')
    : (roster.length ? `${roster.length} in this channel` : 'none in this channel');
  $('ew-agent-cards').replaceChildren(...roster.map((p) => {
    const s = states[p];
    const label = s.state === 'offline' ? 'OFFLINE' : s.state === 'working' ? 'WORKING' : 'IDLE';
    return h('div', { class: 'ew-agent', role: 'button', tabindex: 0, title: desk ? `Dispatch to @${NAMES[p]}` : `Mention @${NAMES[p]} in the channel`, onclick: () => insertMention(NAMES[p]), onkeydown: (e) => { if (e.key === 'Enter') insertMention(NAMES[p]); } },
      avatarImg(p), h('strong', {}, NAMES[p]),
      h('button', { type: 'button', class: 'ew-icon remove', title: desk ? `Remove ${NAMES[p]} from the desk` : `Remove ${NAMES[p]} from this channel`, 'aria-label': `Remove ${NAMES[p]}`, onclick: (e) => { e.stopPropagation(); changeAgent('remove-agent', p); } }, '×'),
      h('span', { class: `ew-state ${s.state}` }, label),
      h('span', { class: 'last' }, s.state === 'offline' ? 'Offline. Start the Helmian bridge on your PC to bring it online.' : (s.last ? s.last.replace(/\s+/g, ' ').slice(0, 120) : 'Waiting for a message')));
  }));
  if (!roster.length) $('ew-agent-cards').append(h('p', { class: 'ew-note' }, desk ? 'No agents on the desk yet. Add one below — everyone on the desk receives your dispatches.' : 'No agents in this channel. Add one below to make it an agent chat.'));
  $('ew-agent-add').replaceChildren(...AGENTS.filter((p) => !roster.includes(p) && (!desk || p !== 'maestro')).map((p) => h('button', { type: 'button', class: 'ew-pill', title: desk ? `Add ${NAMES[p]} to the desk — it receives your dispatches` : `Add ${NAMES[p]} to this channel — it answers here`, onclick: () => changeAgent('add-agent', p) }, avatarImg(p), `+ ${NAMES[p]}`)));
  // Channel composer mention pills: agents in this channel are @mention pills; the rest add in one click.
  // In the desk, @all is the broadcast pill and shows whenever anyone is seated.
  $('ew-mention-pills').replaceChildren(...((desk ? roster.length >= 1 : roster.length > 1) ? [h('button', { type: 'button', class: 'ew-pill all', onclick: () => insertMention('all') }, '@all')] : []),
    ...roster.map((p) => h('button', { type: 'button', class: 'ew-pill', title: `Mention @${NAMES[p]}`, onclick: () => insertMention(NAMES[p]) }, avatarImg(p), NAMES[p])),
    ...AGENTS.filter((p) => !roster.includes(p) && (!desk || p !== 'maestro')).map((p) => h('button', { type: 'button', class: 'ew-pill add', title: `Add ${NAMES[p]} to #${currentTitle()}`, onclick: () => changeAgent('add-agent', p) }, avatarImg(p), `+ ${NAMES[p]}`)));
  $('ew-mention-pills').hidden = false;
}
async function changeAgent(action, provider) {
  try {
    const body = await ws.ctx.post('/api/admin/envoy/channel-config', { action, channelId: ws.channelId, provider });
    ws.config = body.config; ws.configured = true;
    if (action === 'add-agent') { delete ws.agentsPinned[ws.channelId]; ls.set('agentsPinned', ws.agentsPinned); }
    await loadConfig(); await loadMessages();
  } catch (e) { ws.ctx.toast(e?.body?.code === 'ENVOY_ROLE_FORBIDDEN' ? 'Auditors cannot change agents.' : 'Could not change agents. Try again.'); }
}
function insertMention(name) {
  const box = $('maestro-input');
  const tag = `@${name} `;
  if (!box.value.includes(tag.trim())) box.value = `${tag}${box.value}`.replace(/\s+$/, ' ');
  box.focus(); box.setSelectionRange(box.value.length, box.value.length); grow();
  if (narrow()) closeSheets();
}

// ---------- composer "+" picker: skills, connectors, plugins, upload ----------
// One picker for both composers (channel + agent chat); the pure model in
// composer-picker.mjs decides what can be attached and how it travels.
const PICKER_IDS = {
  channel: { panel: 'ew-picker', chips: 'ew-attach-chips' },
  cli: { panel: 'ew-cli-picker', chips: 'ew-cli-attach-chips' },
};
async function loadPickerData() {
  if (ws.pickerData) return ws.pickerData;
  const [c, p, pl] = await Promise.allSettled([ws.ctx.api('/api/admin/cora/connectors'), ws.ctx.api('/api/admin/provider-connections'), ws.ctx.api('/api/admin/plugins')]);
  ws.pickerData = pickerModel({ connectors: c.status === 'fulfilled' ? c.value ?? {} : {}, providers: p.status === 'fulfilled' ? p.value ?? {} : {}, plugins: pl.status === 'fulfilled' ? pl.value ?? {} : {} });
  return ws.pickerData;
}
function renderAttachChips(which) {
  const box = $(PICKER_IDS[which].chips); if (!box) return;
  const list = ws.attach[which];
  box.hidden = !list.length;
  box.replaceChildren(...list.map((a) => h('span', { class: `ew-chip ${a.kind}` },
    a.kind === 'skill' ? `/${a.name}` : a.name,
    h('button', { type: 'button', class: 'ew-chip-x', title: `Remove ${a.kind === 'skill' ? `the ${a.name} skill` : a.name}`, 'aria-label': `Remove ${a.kind === 'skill' ? `skill ${a.name}` : a.name}`, onclick: () => { ws.attach[which] = removeAttachment(ws.attach[which], a); renderAttachChips(which); if (ws.pickerFor === which) renderPicker(which); } }, '×'))));
}
function closePicker() {
  ws.pickerFor = null;
  for (const { panel } of Object.values(PICKER_IDS)) { const p = $(panel); if (p) p.hidden = true; }
}
async function togglePicker(which) {
  if (ws.pickerFor === which) { closePicker(); return; }
  ws.pickerFor = which;
  const other = which === 'channel' ? 'cli' : 'channel';
  const op = $(PICKER_IDS[other].panel); if (op) op.hidden = true;
  await renderPicker(which);
}
async function renderPicker(which) {
  const panel = $(PICKER_IDS[which].panel); if (!panel) return;
  if (ws.pickerFor !== which) { panel.hidden = true; return; }
  panel.hidden = false;
  const model = ws.pickerData ?? await loadPickerData().catch(() => pickerModel());
  if (ws.pickerFor !== which) return; // closed while the registry loaded
  const attached = new Set(ws.attach[which].map(attachmentKey));
  const groups = [];
  for (const g of model.groups) {
    if (g.id === 'skills') {
      const nameInput = h('input', { class: 'ew-picker-input', maxlength: 64, placeholder: 'Skill name — e.g. deploy, or plugin:skill', 'aria-label': 'Skill name' });
      const note = h('p', { class: 'ew-note' });
      const add = h('button', { type: 'button', class: 'ew-btn sm', onclick: () => {
        const r = addAttachment(ws.attach[which], { kind: 'skill', name: nameInput.value });
        if (!r.added) { note.textContent = r.reason; return; }
        ws.attach[which] = r.list; note.textContent = '';
        renderAttachChips(which); renderPicker(which);
      } }, 'Attach skill');
      groups.push(h('div', { class: 'ew-picker-group' }, h('div', { class: 'ew-subhead' }, 'SKILLS'), h('p', { class: 'ew-note' }, g.note), h('div', { class: 'ew-row' }, nameInput, add), note));
    } else if (g.id === 'connectors') {
      const rows = g.items.map((item) => {
        const on = attached.has(`connector:${item.key}`);
        return h('button', { type: 'button', class: `ew-picker-row${on ? ' on' : ''}`, disabled: item.connected ? null : true, title: item.connected ? (on ? `Remove ${item.name} from this message` : `Attach ${item.name} to this message`) : `${item.name} is not connected`, onclick: () => {
          if (on) { ws.attach[which] = removeAttachment(ws.attach[which], { kind: 'connector', key: item.key }); renderAttachChips(which); renderPicker(which); return; }
          const r = addAttachment(ws.attach[which], { kind: 'connector', key: item.key }, { catalog: g.items });
          if (r.added) { ws.attach[which] = r.list; renderAttachChips(which); renderPicker(which); }
        } }, h('span', {}, item.name), h('span', { class: 'ew-picker-kind' }, item.kindLabel), h('span', { class: `ew-picker-state ${item.connected ? 'on' : 'off'}` }, on ? 'Attached' : item.connected ? 'Connected' : 'Not connected'));
      });
      groups.push(h('div', { class: 'ew-picker-group' }, h('div', { class: 'ew-subhead' }, 'CONNECTORS'), ...(rows.length ? rows : [h('p', { class: 'ew-note' }, 'No connectors in the registry.')])));
    } else if (g.id === 'plugins') {
      const rows = g.items.map((item) => {
        const on = attached.has(`plugin:${item.name}`);
        return h('button', { type: 'button', class: `ew-picker-row${on ? ' on' : ''}`, title: on ? `Remove ${item.name} from this message` : `Attach ${item.name} to this message`, onclick: () => {
          if (on) { ws.attach[which] = removeAttachment(ws.attach[which], { kind: 'plugin', name: item.name }); renderAttachChips(which); renderPicker(which); return; }
          const r = addAttachment(ws.attach[which], { kind: 'plugin', name: item.name }, { catalog: g.items });
          if (r.added) { ws.attach[which] = r.list; renderAttachChips(which); renderPicker(which); }
        } }, h('span', {}, item.name), h('span', { class: 'ew-picker-kind' }, item.brings), h('span', { class: `ew-picker-state ${on ? 'on' : 'off'}` }, on ? 'Attached' : 'Installed'));
      });
      groups.push(h('div', { class: 'ew-picker-group' }, h('div', { class: 'ew-subhead' }, 'PLUGINS'), h('p', { class: 'ew-note' }, g.note), ...(rows.length ? rows : [h('p', { class: 'ew-note' }, 'No plugins installed on your PC bridge yet.')])));
    } else if (g.id === 'upload') {
      const note = h('p', { class: 'ew-note' }, g.note);
      const fileInput = h('input', { type: 'file', class: 'ew-file-input', 'aria-label': 'Choose a file to attach to this message' });
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file) return;
        // Refuse on name/type/size before reading a single byte.
        const refusal = fileRefusalReason({ name: file.name, mediaType: file.type || '', size: file.size });
        if (refusal) { note.textContent = refusal; return; }
        try {
          const data = await readFileAsBase64(file);
          const r = addAttachment(ws.attach[which], { kind: 'file', name: file.name, mediaType: file.type || '', size: file.size, data });
          if (!r.added) { note.textContent = r.reason; return; }
          ws.attach[which] = r.list;
          renderAttachChips(which); renderPicker(which);
        } catch { note.textContent = 'That file could not be read.'; }
      });
      groups.push(h('div', { class: 'ew-picker-group' }, h('div', { class: 'ew-subhead' }, 'UPLOAD'), fileInput, note));
    }
  }
  panel.replaceChildren(
    h('div', { class: 'ew-picker-head' }, h('strong', {}, 'Add to this message'), h('span', { class: 'ew-spacer' }), h('button', { type: 'button', class: 'ew-icon', 'aria-label': 'Close picker', onclick: () => closePicker() }, '×')),
    ...groups);
}

// ---------- composer "/" menu: the workspace's slash commands ----------
// One menu for both composers (channel + agent chat); the pure model in
// slash-menu.mjs decides when it opens and what it lists. The list is the
// served workspace's real command registry (GET /api/admin/commands) —
// the same set the bridge will expand — fetched lazily on the first "/"
// and cached for the mount. Picking a row only inserts "/name " into
// the input; sending is always the human's own Enter.
const SLASH_IDS = {
  channel: { input: 'maestro-input', menu: 'ew-slash-menu' },
  cli: { input: 'ew-cli-input', menu: 'ew-cli-slash-menu' },
};
const SLASH_ORIGIN_LABEL = { workspace: 'workspace', personal: 'personal', plugin: 'plugin' };
async function loadSlashCommands() {
  if (ws.slash.loaded) return ws.slash.commands;
  if (!ws.slash.loading) {
    ws.slash.loading = ws.ctx.api('/api/admin/commands')
      .then((body) => { ws.slash.commands = Array.isArray(body?.commands) ? body.commands : []; ws.slash.loaded = true; })
      .catch(() => { ws.slash.commands = null; })
      .finally(() => { ws.slash.loading = null; });
  }
  await ws.slash.loading;
  return ws.slash.commands;
}
function currentSlashModel(which) {
  const box = $(SLASH_IDS[which].input); if (!box) return null;
  if (ws.slash.dismissedFor === box.value) return null;
  return slashMenuModel({ commands: ws.slash.commands ?? [], loaded: ws.slash.loaded, value: box.value });
}
function closeSlashMenu() {
  ws.slash.openFor = null; ws.slash.index = 0;
  for (const { menu } of Object.values(SLASH_IDS)) { const m = $(menu); if (m) m.hidden = true; }
}
async function refreshSlashMenu(which) {
  const box = $(SLASH_IDS[which].input); if (!box) return;
  if (!ws.slash.loaded) {
    if (!slashMenuModel({ commands: [], loaded: true, value: box.value })) { closeSlashMenu(); return; }
    await loadSlashCommands();
  }
  if (ws.slash.dismissedFor !== null && ws.slash.dismissedFor !== box.value) ws.slash.dismissedFor = null;
  renderSlashMenu(which);
}
function renderSlashMenu(which) {
  const menu = $(SLASH_IDS[which].menu); if (!menu) return;
  const model = currentSlashModel(which);
  if (!model) { if (ws.slash.openFor === which) closeSlashMenu(); else menu.hidden = true; return; }
  const opening = ws.slash.openFor !== which;
  ws.slash.openFor = which;
  if (opening || ws.slash.index >= model.rows.length) ws.slash.index = 0;
  const rows = model.rows.map((c, i) => h('button', {
    type: 'button', role: 'option', 'aria-selected': String(i === ws.slash.index),
    class: `ew-picker-row ew-slash-row${i === ws.slash.index ? ' on' : ''}`,
    onmousedown: (e) => { e.preventDefault(); pickSlashCommand(which, c.name); },
  }, h('span', { class: 'ew-slash-name' }, `/${c.name}`), h('span', { class: 'ew-picker-kind' }, c.description ?? ''), h('span', { class: 'ew-picker-state off' }, SLASH_ORIGIN_LABEL[c.origin] ?? c.origin ?? '')));
  menu.replaceChildren(...(rows.length ? rows : [h('p', { class: 'ew-note' }, model.empty === 'no-commands' ? 'No commands in this workspace yet. Add markdown files to .helmion/commands/ and they will show up here.' : 'No matching command.')]));
  menu.hidden = false;
}
function pickSlashCommand(which, name) {
  const box = $(SLASH_IDS[which].input); if (!box) return;
  box.value = slashInsertValue(name);
  ws.slash.dismissedFor = null;
  closeSlashMenu();
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
  (which === 'channel' ? grow : growCli)();
}
// True when the key belonged to the open menu (and has been handled, so
// the composer's own Enter-to-send must not also fire). Registered
// before the send keydown handlers for that reason.
function slashKeydown(which, e) {
  if (ws.slash.openFor !== which) return false;
  const model = currentSlashModel(which);
  if (!model) { closeSlashMenu(); return false; }
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopImmediatePropagation();
    ws.slash.dismissedFor = $(SLASH_IDS[which].input)?.value ?? null;
    closeSlashMenu();
    return true;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); e.stopImmediatePropagation();
    ws.slash.index = moveSlashHighlight(ws.slash.index, e.key === 'ArrowDown' ? 1 : -1, model.rows.length);
    renderSlashMenu(which);
    return true;
  }
  if ((e.key === 'Enter' || e.key === 'Tab') && model.rows.length) {
    e.preventDefault(); e.stopImmediatePropagation();
    pickSlashCommand(which, model.rows[ws.slash.index]?.name ?? model.rows[0].name);
    return true;
  }
  return false;
}

// A picked file → its base64 payload (the metadata carries the bytes
// inline; see composer-picker.mjs). Resolves with the part after the
// data-URL comma; the picker model verifies it decodes to the file's
// exact size before anything is attached.
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.onload = () => {
      const text = String(reader.result ?? '');
      const comma = text.indexOf(',');
      resolve(comma >= 0 ? text.slice(comma + 1) : text);
    };
    reader.readAsDataURL(file);
  });
}

// ---------- messages ----------
async function loadMessages() {
  const id = ws.channelId; if (!id) { $('ew-messages').replaceChildren(h('div', { class: 'ew-empty' }, ws.mode === 'discord' ? discordEmptyText() : 'No channel yet. Ask the workspace owner to create one.')); setComposer(false); renderCliThread(); return; }
  const body = await ws.ctx.api(`/api/admin/envoy/messages?channel_id=${encodeURIComponent(id)}&limit=100`);
  if (id !== ws.channelId) return;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const sig = messages.map((m) => m.id).join(',');
  if (sig === ws.sig) {
    renderAgents(); renderCliThread();
    // No new messages, but pending work can still start or expire on
    // server state alone (a reply window lapsing, an agent coming online):
    // redraw the thread if the in-thread working cue changed.
    if (currentWorking().join(',') !== ws.cueSig) renderMessages();
    return;
  }
  ws.sig = sig; ws.messages = messages;
  renderMessages(); renderAgents(); renderCliThread();
}
function whoOf(m) {
  const me = ws.ctx.state.actor?.subject;
  if (m.authorKind === 'human' && m.authorSubject === me) return { name: 'You', kind: 'me' };
  if (m.agentProvider || m.authorSubject?.startsWith('agent:')) return { name: m.authorName || 'Agent', kind: 'agent', provider: m.agentProvider || m.authorSubject.slice(6) };
  if (m.authorSubject?.endsWith(':bridge')) return { name: 'Maestro', kind: 'agent', provider: 'maestro' };
  if (m.source === 'discord') return { name: m.authorName || 'Discord member', kind: 'discord' };
  return { name: m.authorName || 'Member', kind: 'human' };
}
// The line under a manager's desk send naming who it dispatched to —
// the same computation the server routes with (deskTargets), so the
// desk never claims a dispatch the server did not make.
function deskDispatchLine(m) {
  const team = deskRoster((ws.config?.agents ?? []).map((a) => a.provider));
  if (!team.length) return h('div', { class: 'ew-dispatch' }, 'No agents on the desk — add agents from the Agents pane to dispatch.');
  const targets = deskTargets(m, team);
  if (!targets.length) return h('div', { class: 'ew-dispatch' }, 'That named nobody on the desk — no agent was dispatched.');
  return h('div', { class: 'ew-dispatch' }, targets.length === team.length ? 'Dispatched to everyone on the desk' : `Dispatched to ${targets.map((p) => NAMES[p]).join(' · ')}`);
}
function renderMessages() {
  const box = $('ew-messages');
  const desk = inMaestroMode();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const out = []; let prev = null; let prevDay = '';
  const onLink = (url) => { openBench('browser'); navigate(url); };
  const onCanvas = (code) => { openBench('canvas'); setCanvas(code); };
  for (const m of ws.messages) {
    const day = dayLabel(m.createdAt);
    if (day !== prevDay) { out.push(h('div', { class: 'ew-day' }, day)); prevDay = day; prev = null; }
    if (m.authorKind === 'system') { out.push(h('div', { class: 'ew-notice' }, h('span', {}, m.body))); prev = null; continue; }
    const who = whoOf(m);
    const cont = prev && prev.authorSubject === m.authorSubject && new Date(m.createdAt) - new Date(prev.createdAt) < 5 * 60_000;
    const avatar = who.kind === 'agent' ? h('div', { class: 'ew-avatar' }, avatarImg(who.provider)) : h('div', { class: `ew-avatar${who.kind === 'discord' ? ' discord' : ''}` }, who.name.slice(0, 1).toUpperCase());
    const src = who.kind === 'agent' ? h('span', { class: 'ew-src agent' }, 'AGENT') : who.kind === 'discord' ? h('span', { class: 'ew-src discord' }, 'DISCORD') : null;
    // In the desk, a manager send carries its dispatch line; agent
    // replies render as themselves, under their own names, as anywhere.
    const dispatch = desk && m.authorKind === 'human' ? deskDispatchLine(m) : null;
    out.push(h('div', { class: `ew-msg${cont ? ' cont' : ''}${m._pending ? ' pending' : ''}`, 'data-id': m.id }, avatar,
      h('div', {}, h('div', { class: 'ew-meta' }, h('strong', { class: who.kind === 'agent' ? 'agent' : '' }, who.name), src, h('time', { datetime: m.createdAt }, clock(m.createdAt))),
        h('div', { class: 'ew-body' }, renderBody(m.body, { onLink, onCanvas })), dispatch)));
    prev = m;
  }
  // In-thread working cue: one row per agent with pending work in this
  // channel, sitting where its reply will land. Driven entirely by the
  // server-fed lists via currentWorking() — it appears when work becomes
  // pending and clears when the reply posts or the work window lapses.
  const working = currentWorking();
  ws.cueSig = working.join(',');
  for (const p of working) {
    out.push(h('div', { class: 'ew-msg ew-answering', role: 'status' },
      h('div', { class: 'ew-avatar' }, avatarImg(p)),
      h('div', {}, h('div', { class: 'ew-body ew-answering-body' },
        h('span', { class: 'ew-working-dot', 'aria-hidden': 'true' }),
        `${NAMES[p]} is answering…`))));
  }
  if (!ws.messages.length) out.push(h('div', { class: 'ew-empty' }, desk
    ? 'This is your desk. Send a dispatch — @name for one agent, @all for everyone, or name nobody and it goes to everyone on the desk.'
    : (ws.config?.agents?.length ? 'Say hello. Maestro answers messages nobody is named in.' : 'No messages yet. Say hello, or add an agent to make this an agent chat.')));
  box.replaceChildren(...out);
  if (atBottom || ws.messages.at(-1)?._pending || ws.messages.at(-1)?.authorSubject === ws.ctx.state.actor?.subject) box.scrollTop = box.scrollHeight;
}
const grow = () => { const t = $('maestro-input'); t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 200)}px`; };
async function send(e) {
  e?.preventDefault?.();
  const box = $('maestro-input'); const body = box.value.trim();
  if (!body || !ws.channelId) return;
  const key = crypto.randomUUID();
  const req = buildMessageRequest({ channelId: ws.channelId, body, idempotencyKey: key, attachments: ws.attach.channel });
  const btn = $('maestro-send'); btn.disabled = true;
  ws.messages = [...ws.messages, { id: `pending-${key}`, authorKind: 'human', authorSubject: ws.ctx.state.actor?.subject, body: req.payload.body, createdAt: new Date().toISOString(), _pending: true }];
  renderMessages();
  box.value = ''; grow(); closeSlashMenu();
  try { await ws.ctx.post('/api/admin/envoy/messages', req.payload); ws.attach.channel = []; renderAttachChips('channel'); closePicker(); ws.sig = null; await loadMessages(); }
  catch { box.value = body; grow(); ws.messages = ws.messages.filter((m) => !m._pending); renderMessages(); ws.ctx.toast('Not sent. Your message is back in the box.'); }
  finally { btn.disabled = false; }
}

// ---------- agent chat pane: sessions + prompt composer ----------
// The agent chat pane: the human's conversation with one picked agent,
// shown on its own inside the pane. Sessions reuse the Session console's plumbing
// (/api/admin/app/sessions — the same create/list payloads as app.js's
// #session-form, with the same local fallback); prompts post through the
// same envoy messages endpoint the console composer uses, into the picked
// agent's private room (see the rooms block below) — the room seats
// exactly that agent, so no @mention routing is needed there.
// Maestro is the router, not a session provider (the server offers
// Claude/ChatGPT/Grok/Gemini); Maestro's room is the one-to-one with
// Maestro itself.
const CLI_KEY_BY_PROVIDER = { Claude: 'claude', ChatGPT: 'openai', Grok: 'grok', Gemini: 'gemini' };
function cliTarget() {
  const s = ws.cli.sessions.find((x) => x.id === ws.cli.activeId);
  if (s) return { key: CLI_KEY_BY_PROVIDER[s.provider] ?? 'maestro', session: s };
  return { key: ws.cli.provider, session: null };
}
function renderCliChips() {
  const active = cliTarget().key;
  $('ew-cli-chips').replaceChildren(...AGENTS.map((p) => h('button', { type: 'button', class: `ew-pill${p === active ? ' on' : ''}`, title: p === 'maestro' ? 'Maestro routes to the others' : `Show your conversation with ${NAMES[p]}`, onclick: () => pickCliProvider(p) }, avatarImg(p), NAMES[p])));
}
function renderCliTo() {
  const { key, session } = cliTarget();
  $('ew-cli-to').textContent = session ? `${session.provider} · your private room with ${NAMES[key]}` : `${NAMES[key]} · your private room`;
  $('ew-cli-input').placeholder = key === 'maestro' ? 'Prompt...' : `Prompt ${NAMES[key]}...`;
}
function renderCliSessions() {
  const box = $('ew-cli-sessions');
  if (!ws.cli.sessions.length) { box.replaceChildren(h('p', { class: 'ew-note' }, 'No sessions yet. Pick an agent above to start one.')); return; }
  box.replaceChildren(...ws.cli.sessions.map((s) => {
    const key = CLI_KEY_BY_PROVIDER[s.provider] ?? 'maestro';
    const prog = s.progress && s.progress.total ? `${s.progress.done}/${s.progress.total} steps${s.progress.current ? ` · now: ${s.progress.current}` : ''}` : clock(s.createdAt);
    return h('button', { type: 'button', class: `ew-cli-session${s.id === ws.cli.activeId ? ' active' : ''}`, title: `${s.name} (${s.provider})`, onclick: () => selectCliSession(s.id) },
      avatarImg(key), h('strong', {}, s.name), h('span', { class: 'meta' }, `${s.provider} · ${prog}`));
  }));
}
// ---------- private agent rooms ----------
// The pane's conversation lives in the picked agent's own room. The room
// id is resolved once per provider: from the channel list when the room
// already exists, otherwise the server creates it lazily on first open.
function setCliRoom(key, channel) {
  const id = channel?.id ?? null;
  if (ws.cli.roomFor === key && ws.cli.roomId === id) return;
  ws.cli.roomFor = key; ws.cli.roomId = id; ws.cli.roomMessages = []; ws.cli.roomSig = null; ws.cli.roomJoined = {};
  if (id) void loadCliRoomConfig();
}
async function ensureCliRoom(key) {
  const known = agentRoomFor(ws.channels, key);
  if (known) { setCliRoom(key, known); return known.id; }
  if (ws.cli.roomFor === key && ws.cli.roomId) return ws.cli.roomId;
  if (ws.cli.roomPromise) return ws.cli.roomPromise;
  ws.cli.roomPromise = (async () => {
    try {
      const body = await ws.ctx.post('/api/admin/envoy/agent-room', { provider: key });
      if (body.channel) {
        const i = ws.channels.findIndex((c) => c.id === body.channel.id);
        if (i >= 0) ws.channels[i] = { ...ws.channels[i], ...body.channel }; else ws.channels = [...ws.channels, body.channel];
        renderChannels();
        if (cliTarget().key === key) setCliRoom(key, body.channel);
        return body.channel.id;
      }
    } catch { /* the pane keeps its opening note until a send retries */ }
    return null;
  })();
  try { return await ws.cli.roomPromise; } finally { ws.cli.roomPromise = null; }
}
async function openCliRoom() {
  const { key } = cliTarget();
  const id = await ensureCliRoom(key);
  if (id) await loadCliRoom();
  else renderCliThread();
}
// The room's roster (exactly one agent, joined when the room was made) —
// fetched once per room; it drives the in-thread answering cue.
async function loadCliRoomConfig() {
  const id = ws.cli.roomId; if (!id) return;
  try {
    const body = await ws.ctx.api(`/api/admin/envoy/channel-config?channel_id=${encodeURIComponent(id)}`);
    if (id !== ws.cli.roomId) return;
    ws.cli.roomJoined = Object.fromEntries((body.config?.agents ?? []).map((a) => [a.provider, a.joinedAt]));
  } catch { ws.cli.roomJoined = {}; }
  renderCliThread();
}
async function loadCliRoom() {
  const id = ws.cli.roomId;
  if (!id) { renderCliThread(); return; }
  try {
    const body = await ws.ctx.api(`/api/admin/envoy/messages?channel_id=${encodeURIComponent(id)}&limit=100`);
    if (id !== ws.cli.roomId) return;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const sig = messages.map((m) => m.id).join(',');
    if (sig !== ws.cli.roomSig) { ws.cli.roomSig = sig; ws.cli.roomMessages = messages; }
  } catch { /* keep the last good room state */ }
  renderCliThread();
}
// Pending work inside the picked agent's room (the server's agent-work
// rules over the room's own messages), for the fast-poll decision.
function roomWorking() {
  const { key } = cliTarget();
  if (!key || ws.cli.roomFor !== key || !ws.cli.roomId) return [];
  return pendingAgentWork(ws.cli.roomMessages, [key], ws.cli.roomJoined, ws.online);
}

// The pane's own conversation stream: the picked agent's room, rendered
// where the human is looking instead of inside a shared channel.
// Signature-guarded like the message list, so calm polls don't rebuild it.
function renderCliThread() {
  const box = $('ew-cli-thread'); if (!box) return;
  const { key } = cliTarget();
  const inRoom = ws.cli.roomFor === key && Boolean(ws.cli.roomId);
  const list = inRoom ? agentRoomThread(ws.cli.roomMessages) : [];
  const showing = inRoom ? roomWorking() : [];
  const sig = `${key}|${ws.cli.roomId ?? ''}|${list.map((m) => m.id).join(',')}|${showing.join(',')}`;
  if (sig === ws.cli.threadSig) return;
  ws.cli.threadSig = sig;
  if (!list.length && !showing.length) {
    box.replaceChildren(h('p', { class: 'ew-note' }, inRoom
      ? `Nothing with ${NAMES[key]} yet — send a prompt below and the conversation shows up here, in ${NAMES[key]}'s own room.`
      : `Opening your room with ${NAMES[key]}…`));
    return;
  }
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const onLink = (url) => { openBench('browser'); navigate(url); };
  const onCanvas = (code) => { openBench('canvas'); setCanvas(code); };
  const out = [];
  let prev = null;
  for (const m of list) {
    const who = whoOf(m);
    const cont = prev && prev.authorSubject === m.authorSubject && new Date(m.createdAt) - new Date(prev.createdAt) < 5 * 60_000;
    const avatar = who.kind === 'agent' ? h('div', { class: 'ew-avatar' }, avatarImg(who.provider)) : h('div', { class: 'ew-avatar' }, who.name.slice(0, 1).toUpperCase());
    const src = who.kind === 'agent' ? h('span', { class: 'ew-src agent' }, 'AGENT') : null;
    out.push(h('div', { class: `ew-msg${cont ? ' cont' : ''}${m._pending ? ' pending' : ''}` }, avatar,
      h('div', {}, h('div', { class: 'ew-meta' }, h('strong', { class: who.kind === 'agent' ? 'agent' : '' }, who.name), src, h('time', { datetime: m.createdAt }, clock(m.createdAt))),
        h('div', { class: 'ew-body' }, renderBody(m.body, { onLink, onCanvas })))));
    prev = m;
  }
  for (const p of showing) {
    out.push(h('div', { class: 'ew-msg ew-answering', role: 'status' },
      h('div', { class: 'ew-avatar' }, avatarImg(p)),
      h('div', {}, h('div', { class: 'ew-body ew-answering-body' },
        h('span', { class: 'ew-working-dot', 'aria-hidden': 'true' }),
        `${NAMES[p]} is answering…`))));
  }
  box.replaceChildren(...out);
  if (atBottom) box.scrollTop = box.scrollHeight;
}
function selectCliSession(id) {
  const s = ws.cli.sessions.find((x) => x.id === id); if (!s) return;
  ws.cli.activeId = id; ls.set('cliSession', id);
  ws.cli.provider = CLI_KEY_BY_PROVIDER[s.provider] ?? ws.cli.provider;
  if (ws.ctx.state) ws.ctx.state.activeSession = id;
  renderCliChips(); renderCliSessions(); renderCliTo(); renderCliThread();
  void openCliRoom();
  $('ew-cli-input').focus({ preventScroll: true });
}
function pickCliProvider(p) {
  ws.cli.provider = p; ws.cli.activeId = null; ls.set('cliSession', null);
  renderCliChips(); renderCliSessions(); renderCliTo(); renderCliThread();
  void openCliRoom();
  if (p === 'maestro') { $('ew-cli-session-form').hidden = true; $('ew-cli-input').focus({ preventScroll: true }); return; }
  ws.cli.pending = p;
  const input = $('ew-cli-session-name');
  $('ew-cli-session-form').hidden = false;
  input.value = `${NAMES[p]} session`; input.select(); input.focus();
}
async function loadCliSessions() {
  try {
    const body = await ws.ctx.api('/api/admin/app/sessions');
    ws.cli.sessions = sessionsFromServer(body); ws.cli.server = true;
  } catch { ws.cli.server = false; ws.cli.sessions = ls.get('cliSessions', []); }
  // Adopt the shared active session (sidebar / Session console) when listed.
  const shared = ws.ctx.state?.activeSession;
  if (shared && ws.cli.sessions.some((s) => s.id === shared)) ws.cli.activeId = shared;
  if (!ws.cli.sessions.some((s) => s.id === ws.cli.activeId)) ws.cli.activeId = null;
  renderCliChips(); renderCliSessions(); renderCliTo(); renderCliThread();
}
async function createCliSession(name) {
  const provider = NAMES[ws.cli.pending] ?? 'Claude';
  try {
    const r = await ws.ctx.post('/api/admin/app/sessions', { name, provider, idempotencyKey: crypto.randomUUID() });
    await loadCliSessions();
    if (r.session?.id) selectCliSession(r.session.id);
  } catch {
    // Same offline fallback as the Session console: keep the session locally.
    ws.cli.sessions = addSession(ws.cli.sessions, { name, provider });
    ls.set('cliSessions', ws.cli.sessions);
    ws.cli.activeId = ws.cli.sessions[0]?.id ?? null; ls.set('cliSession', ws.cli.activeId);
    renderCliChips(); renderCliSessions(); renderCliTo();
  }
  ws.ctx.toast('Session started', 'ok');
}
const growCli = () => { const t = $('ew-cli-input'); t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 200)}px`; };
async function sendCli(e) {
  e?.preventDefault?.();
  const box = $('ew-cli-input'); const raw = box.value.trim();
  if (!raw) return;
  const { key } = cliTarget();
  // The prompt lands in the picked agent's own room — no @tag needed:
  // the room seats exactly that agent, so everything in it is for them.
  // The room is created lazily here if this is the first prompt ever.
  const roomId = await ensureCliRoom(key);
  if (!roomId) { ws.ctx.toast(`Could not open your room with ${NAMES[key]}. Your prompt is still in the box.`); return; }
  const req = buildMessageRequest({ channelId: roomId, body: raw, idempotencyKey: crypto.randomUUID(), attachments: ws.attach.cli });
  const btn = $('ew-cli-send'); btn.disabled = true;
  try {
    await ws.ctx.post('/api/admin/envoy/messages', req.payload);
    box.value = ''; growCli(); closeSlashMenu(); ws.attach.cli = []; renderAttachChips('cli'); if (ws.pickerFor === 'cli') closePicker();
    await loadCliRoom();
  } catch { ws.ctx.toast('Not sent. Your prompt is still in the box.'); }
  finally { btn.disabled = false; }
}

// ---------- Discord link ----------
function openModal(title, body) { $('ew-modal-title').textContent = title; $('ew-modal-body').replaceChildren(...body); $('ew-modal').classList.add('open'); }
function closeModal() { $('ew-modal').classList.remove('open'); if (ws.linkPoll) { clearInterval(ws.linkPoll); ws.linkPoll = null; } }
async function linkDiscord() {
  const d = ws.config?.discord;
  const admin = ['owner', 'admin'].includes(ws.ctx.state.actor?.role);
  const ch = ws.channels.find((c) => c.id === ws.channelId);
  if (d) {
    openModal('Discord link', [
      h('p', {}, `#${ch?.title} mirrors with Discord #${d.channelName || d.channelId}${d.guildName ? ` in ${d.guildName}` : ''}. Messages and agent replies go both ways.`),
      admin ? h('div', { class: 'ew-row' }, h('span', { class: 'ew-spacer' }), h('button', { type: 'button', class: 'ew-btn ghost', onclick: async () => { try { await ws.ctx.post('/api/admin/envoy/channel-config', { action: 'unlink-discord', channelId: ws.channelId }); closeModal(); await loadConfig(); await loadMessages(); } catch { ws.ctx.toast('Could not unlink.'); } } }, 'Unlink')) : null,
    ]);
    return;
  }
  if (!admin) return;
  let res;
  try { res = await ws.ctx.post('/api/admin/envoy/channel-config', { action: 'link-discord', channelId: ws.channelId }); }
  catch { ws.ctx.toast('Could not start the Discord link.'); return; }
  const bot = ws.discordBot;
  const copy = h('button', { type: 'button', class: 'ew-btn sm', onclick: async () => { try { await navigator.clipboard.writeText(res.linkCommand); ws.ctx.toast('Copied', 'ok'); } catch {} } }, 'Copy command');
  const status = h('p', { class: 'muted sm' }, 'Waiting for the command in Discord… (code works for 15 minutes)');
  openModal('Link Discord', [
    h('ol', { class: 'ew-steps' },
      h('li', {}, bot?.inviteUrl ? h('span', {}, 'Add the Helmian bot to your Discord server: ', h('a', { href: bot.inviteUrl, target: '_blank', rel: 'noopener' }, 'Add to Discord'), ' (once per server).') : h('span', {}, 'The Helmian Discord bot is not set up on this workspace yet, so the code will wait until it is.')),
      h('li', {}, 'In the Discord channel you want to link, send:'),
    ),
    h('div', { class: 'ew-code' }, res.linkCommand),
    h('div', { class: 'ew-row' }, copy, h('span', { class: 'ew-spacer' })),
    status,
  ]);
  ws.linkPoll = setInterval(async () => {
    await loadConfig();
    if (ws.config?.discord) { clearInterval(ws.linkPoll); ws.linkPoll = null; status.textContent = `Linked to Discord #${ws.config.discord.channelName || ws.config.discord.channelId}.`; status.className = 'sm'; await loadMessages(); setTimeout(closeModal, 1500); }
  }, 3000);
}

// ---------- workbench ----------
function openBench(tab) {
  if (!paneOpen('bench')) setPane('bench', true, { user: true });
  selectTab(tab);
}
const BENCH_TABS = ['browser', 'create', 'canvas', 'preview'];
function selectTab(name) {
  if (!BENCH_TABS.includes(name)) name = 'browser';
  for (const t of document.querySelectorAll('#ew-bench .ew-tab')) { const on = t.dataset.tab === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on)); }
  for (const p of document.querySelectorAll('#ew-bench .ew-tabpane')) { const on = p.dataset.tabpane === name; p.hidden = !on; p.classList.toggle('active', on); }
  ls.set('tab', name);
  if (name === 'preview') ws.ctx.loadGuardPreview?.();
  if (name === 'create') ws.ctx.loadGuardCreateList?.();
  if (name === 'canvas') renderCanvas();
}

// Browser: our own history stack (a cross-origin frame cannot be stepped back from outside).
const nav = { stack: [], index: -1 };
function youtubeEmbed(url) {
  try {
    const u = new URL(url); const host = u.hostname.toLowerCase(); const ok = (s) => (s && /^[\w-]{11}$/.test(s) ? s : null);
    let id = null;
    if (['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(host)) id = ok(u.searchParams.get('v')) || (u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/embed/') ? ok(u.pathname.split('/')[2]) : null);
    if (host === 'youtu.be') id = ok(u.pathname.split('/')[1]);
    return id ? `https://www.youtube-nocookie.com/embed/${id}?rel=0` : null;
  } catch { return null; }
}
function toAddress(input) {
  const v = String(input ?? '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v.replace(/^http:/i, 'https:');
  if (/^[\w-]+(\.[\w-]+)+(\/|$|\?|#|:)/.test(v)) return `https://${v}`;
  return `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(v)}`;
}
async function navigate(input, { push = true } = {}) {
  const status = $('ew-browser-status');
  const address = toAddress(input);
  if (!address) return;
  $('ew-browser-url').value = address;
  status.textContent = 'Checking address…';
  let url;
  try { url = (await ws.ctx.post('/api/admin/browser/navigate', { url: address })).url; }
  catch (e) { status.textContent = e?.body?.message || 'That address was not accepted. Only public HTTPS sites open here.'; return; }
  const yt = youtubeEmbed(url);
  if (new URL(url).origin === location.origin) { status.textContent = 'Helmian pages open in their own tab. Use ↗.'; window.open(url, '_blank', 'noopener'); return; }
  const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } })();
  const frame = $('ew-browser-frame');
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(host) && !yt) {
    status.textContent = 'YouTube only allows video pages inside other apps. Paste a video link, or use ↗.';
  } else {
    frame.hidden = false; $('ew-browser-start').hidden = true;
    frame.src = yt ?? url;
    status.textContent = `${host} · recorded in the audit trail. Blank page? The site blocks embedding; use ↗.`;
  }
  if (push) { nav.stack = nav.stack.slice(0, nav.index + 1); nav.stack.push(url); nav.index = nav.stack.length - 1; }
  $('ew-browser-url').value = url;
  syncBrowserButtons();
}
function syncBrowserButtons() {
  const has = nav.index >= 0;
  $('ew-browser-back').disabled = nav.index <= 0;
  $('ew-browser-fwd').disabled = nav.index >= nav.stack.length - 1;
  for (const id of ['ew-browser-reload', 'ew-browser-external', 'ew-browser-close']) $(id).disabled = !has;
}
function closePage() {
  const frame = $('ew-browser-frame'); frame.src = 'about:blank'; frame.hidden = true;
  $('ew-browser-start').hidden = false; $('ew-browser-url').value = ''; $('ew-browser-status').textContent = '';
  nav.stack = []; nav.index = -1; syncBrowserButtons();
}

// Canvas: code on the left, live render on the right (HTML and CSS; scripts stay off).
let canvasTimer = null;
const canvasKey = () => `canvas.${ws.ctx.state.activeProjectKey || 'default'}`;
function renderCanvas() {
  const code = $('ew-canvas-code');
  if (!code.dataset.loaded) { code.value = ls.get(canvasKey(), STARTER_CANVAS); code.dataset.loaded = '1'; }
  $('ew-canvas-live').srcdoc = code.value;
}
function setCanvas(code) { $('ew-canvas-code').value = code; $('ew-canvas-code').dataset.loaded = '1'; ls.set(canvasKey(), code); renderCanvas(); }

function wire() {
  ws.wired = true;
  wireSplitters();
  for (const b of document.querySelectorAll('#ew [data-collapse]')) b.addEventListener('click', () => { const n = b.dataset.collapse; if (narrow()) { closeSheets(); return; } if (n === 'agents') { ws.agentsPinned[ws.channelId] = false; ls.set('agentsPinned', ws.agentsPinned); } setPane(n, false, { user: true }); });
  for (const b of document.querySelectorAll('#ew [data-open]')) b.addEventListener('click', () => setPane(b.dataset.open, true));
  for (const b of document.querySelectorAll('#ew [data-toggle]')) b.addEventListener('click', () => {
    const n = b.dataset.toggle; const open = !paneOpen(n);
    if (narrow()) closeSheets();
    if (n === 'agents' && !narrow()) { ws.agentsPinned[ws.channelId] = open; ls.set('agentsPinned', ws.agentsPinned); }
    setPane(n, open, { user: true });
  });
  $('ew-scrim').addEventListener('click', closeSheets);
  $('ew-bench-max').addEventListener('click', () => { const on = $('ew').classList.toggle('bench-max'); $('ew-bench-max').textContent = on ? '⤡' : '⤢'; $('ew-bench-max').title = on ? 'Restore' : 'Expand'; $('ew-bench-max').setAttribute('aria-label', on ? 'Restore workbench' : 'Expand workbench'); });
  for (const t of document.querySelectorAll('#ew-bench .ew-tab')) t.addEventListener('click', () => selectTab(t.dataset.tab));
  $('ew-add-channel').addEventListener('click', openNewChannel);
  $('ew-net-envoy').addEventListener('click', () => setNetMode('envoy'));
  $('ew-net-discord').addEventListener('click', () => setNetMode('discord'));
  renderNetSwitch(); renderNetStrip();
  $('ew-chat-ava').addEventListener('click', openAvatarModal);
  wireSwipe();
  $('ew-new-channel-cancel').addEventListener('click', () => { $('ew-new-channel').hidden = true; $('ew-add-channel').hidden = false; });
  $('ew-new-channel').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('ew-new-channel-name').value.trim(); if (!title) return;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'channel';
    try {
      const made = await ws.ctx.post('/api/admin/envoy/channels', { slug, title, kind: 'team' });
      $('ew-new-channel').hidden = true; $('ew-add-channel').hidden = false; $('ew-new-channel-name').value = '';
      if (made.channel?.id && made.inserted !== false) saveAvatar(made.channel.id, ws.pendingAvatar);
      await loadChannels(); ws.channelId = made.channel?.id ?? ws.channelId;
      await selectChannel(ws.channelId);
    } catch { ws.ctx.toast('Channel not created.'); }
  });
  $('maestro-form').addEventListener('submit', send);
  const box = $('maestro-input');
  box.addEventListener('input', () => { grow(); refreshSlashMenu('channel'); });
  box.addEventListener('keydown', (e) => { slashKeydown('channel', e); });
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !narrow()) { e.preventDefault(); send(); } });
  $('maestro-plus').addEventListener('click', () => togglePicker('channel'));
  $('ew-cli-plus').addEventListener('click', () => togglePicker('cli'));
  // Agent CLI pane
  renderCliChips(); renderCliSessions(); renderCliTo();
  $('ew-cli-new').addEventListener('click', () => pickCliProvider(ws.cli.provider === 'maestro' ? 'claude' : ws.cli.provider));
  $('ew-cli-session-cancel').addEventListener('click', () => { $('ew-cli-session-form').hidden = true; });
  $('ew-cli-session-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('ew-cli-session-name').value.trim(); if (!name) return;
    $('ew-cli-session-form').hidden = true;
    await createCliSession(name);
    $('ew-cli-input').focus({ preventScroll: true });
  });
  $('ew-cli-form').addEventListener('submit', sendCli);
  const cliBox = $('ew-cli-input');
  cliBox.addEventListener('input', () => { growCli(); refreshSlashMenu('cli'); });
  cliBox.addEventListener('keydown', (e) => { slashKeydown('cli', e); });
  cliBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !narrow()) { e.preventDefault(); sendCli(); } });
  ws.ctx.wireCliVoice?.();
  $('ew-link-discord').addEventListener('click', linkDiscord);
  $('ew-maestro-exit').addEventListener('click', leaveMaestroSeat);
  $('ew-modal-close').addEventListener('click', closeModal);
  $('ew-modal').addEventListener('click', (e) => { if (e.target === $('ew-modal')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (ws.pickerFor) closePicker(); else if ($('ew-modal').classList.contains('open')) closeModal(); else closeSheets(); } });
  // Browser
  $('ew-browser-form').addEventListener('submit', (e) => { e.preventDefault(); navigate($('ew-browser-url').value); });
  $('ew-browser-back').addEventListener('click', () => { if (nav.index > 0) { nav.index -= 1; navigate(nav.stack[nav.index], { push: false }); } });
  $('ew-browser-fwd').addEventListener('click', () => { if (nav.index < nav.stack.length - 1) { nav.index += 1; navigate(nav.stack[nav.index], { push: false }); } });
  $('ew-browser-reload').addEventListener('click', () => { const f = $('ew-browser-frame'); const s = f.src; f.src = 'about:blank'; setTimeout(() => { f.src = s; }, 30); });
  $('ew-browser-external').addEventListener('click', () => { const u = nav.stack[nav.index]; if (u) window.open(u, '_blank', 'noopener'); });
  $('ew-browser-close').addEventListener('click', closePage);
  $('ew-browser-quick').replaceChildren(...QUICK.map(([label, url]) => h('button', { type: 'button', onclick: () => navigate(url) }, label, h('span', {}, url.replace(/^https:\/\/(www\.)?/, '')))));
  syncBrowserButtons();
  // Canvas
  for (const b of document.querySelectorAll('[data-cmode]')) b.addEventListener('click', () => { for (const x of document.querySelectorAll('[data-cmode]')) x.classList.toggle('active', x === b); $('ew-canvas-body').className = `ew-canvas-body ${b.dataset.cmode}`; });
  $('ew-canvas-code').addEventListener('input', () => { clearTimeout(canvasTimer); $('ew-canvas-saved').textContent = ''; canvasTimer = setTimeout(() => { ls.set(canvasKey(), $('ew-canvas-code').value); $('ew-canvas-live').srcdoc = $('ew-canvas-code').value; $('ew-canvas-saved').textContent = 'Saved on this device'; }, 350); });
  $('ew-canvas-share').addEventListener('click', () => { const code = $('ew-canvas-code').value.slice(0, 3900); $('maestro-input').value = `\`\`\`html\n${code}\n\`\`\``; grow(); $('maestro-input').focus(); });
  // Guard
  $('guard-ackall').addEventListener('click', () => ws.ctx.ackAll?.());
  $('ew-guard-refresh').addEventListener('click', async () => { await ws.ctx.loadFeedData?.(); ws.ctx.renderFeed?.(); });
  ws.ctx.wireVoice?.();
  window.matchMedia('(max-width: 900px)').addEventListener?.('change', applyLayout);
}

async function loadPresence() {
  try { const body = await ws.ctx.api('/api/admin/envoy/runner/presence'); ws.online = new Set((body.presence ?? []).filter((p) => p.connected !== false).map((p) => { const n = String(p.provider ?? p.providerName ?? '').toLowerCase(); return n === 'xai' ? 'grok' : n; })); }
  catch { ws.online = new Set(); }
}

export async function mountWorkspace(ctx) {
  ws.ctx = ctx;
  if (!ws.wired) wire();
  applyLayout();
  selectTab(ls.get('tab', 'browser'));
  if (ctx.benchTab) { openBench(ctx.benchTab); ctx.benchTab = null; }
  ws.ctx.renderFeed?.();
  await loadChannels().catch(() => { $('ew-messages').replaceChildren(h('div', { class: 'ew-empty' }, 'Envoy is reconnecting…')); });
  await Promise.allSettled([loadPresence(), loadConfig(), loadMessages(), loadCliSessions()]);
  if (inMaestroMode()) loadDeskLists();
  await openCliRoom().catch(() => {});
  clearInterval(ws.timer); clearTimeout(ws.timer); clearInterval(ws.slowTimer);
  const visible = () => document.visibilityState === 'visible' && document.getElementById('shell')?.dataset.view === 'desktop';
  // Adaptive message poll: while any agent has pending work in the open
  // channel (currentWorking, the server's agent-work rules mirrored
  // client-side), poll fast so the reply lands the moment it posts; with
  // nothing pending, fall back to the calm interval. The generation
  // counter retires a chain whose mount has been superseded, so remounts
  // never stack pollers.
  const gen = (ws.pollGen = (ws.pollGen ?? 0) + 1);
  const tick = async () => {
    if (gen !== ws.pollGen) return;
    if (visible()) { await loadMessages().catch(() => {}); await loadCliRoom().catch(() => {}); }
    if (gen !== ws.pollGen) return;
    ws.timer = setTimeout(tick, (currentWorking().length || roomWorking().length) ? FAST_POLL_MS : CALM_POLL_MS);
  };
  ws.timer = setTimeout(tick, CALM_POLL_MS);
  ws.slowTimer = setInterval(() => { if (visible()) { loadPresence(); loadConfig(); if (inMaestroMode()) loadDeskLists(); } }, 15000);
}
