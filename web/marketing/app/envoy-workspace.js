// Envoy workspace for the Desktop view: channels | chat | agent CLI | agents | workbench.
// app.js calls mountWorkspace(ctx) each time the Desktop view opens; wiring
// happens once, data refreshes every time.
import { CHARACTERS, COLORS, avatarFor, defaultChoice, sanitizeChoice } from './avatars.mjs';
import { addSession, sessionsFromServer } from './app-model.mjs';
import { addAttachment, attachmentKey, buildMessageRequest, fileRefusalReason, pickerModel, removeAttachment } from './composer-picker.mjs';
import { moveSlashHighlight, slashInsertValue, slashMenuModel } from './slash-menu.mjs';
import { createConnectFields } from './connect-fields.mjs';
import { AGENT_FACE_DEFAULTS, EMOJI_MAP, emojiAssetSlug, emojiAssetUrl } from './emoji-map.mjs';

const AGENTS = ['maestro', 'claude', 'openai', 'grok', 'gemini', 'mistral', 'qwen', 'groq', 'nvidia', 'cloudflare', 'openrouter'];
const NAMES = { maestro: 'Maestro', claude: 'Claude', openai: 'ChatGPT', grok: 'Grok', gemini: 'Gemini', mistral: 'Mistral', qwen: 'Qwen', groq: 'Groq', nvidia: 'NVIDIA', cloudflare: 'Cloudflare', openrouter: 'OpenRouter' };
const AVATAR = { maestro: 'maestro', claude: 'claude', openai: 'chatgpt', grok: 'grok', gemini: 'gemini' };
const ALIAS = { maestro: 'maestro', manager: 'maestro', claude: 'claude', chatgpt: 'openai', openai: 'openai', gpt: 'openai', grok: 'grok', xai: 'grok', gemini: 'gemini', mistral: 'mistral', lechat: 'mistral', runway: 'runway', qwen: 'qwen', ollama: 'qwen', groq: 'groq', nvidia: 'nvidia', nim: 'nvidia', cloudflare: 'cloudflare', workersai: 'cloudflare', openrouter: 'openrouter' };
export const CUSTOM_AGENT_EMOJIS = ['🤖', '🦀', '🧐', '🤠', '🔥', '🧠', '⚡', '🛡️', '🎯', '🚀', '🦊', '🦉', '🐝', '🛠️', '📊', '🎨', '😀', '😎', '🤓', '🥷', '🧙', '🦾', '🐉', '🌟'];
export const CUSTOM_PROVIDER_OPTIONS = [
  ['claude', 'Claude (Anthropic)'],
  ['openai', 'ChatGPT (OpenAI)'],
  ['grok', 'Grok (xAI)'],
  ['mistral', 'Mistral (Le Chat)'],
  ['gemini', 'Gemini (Google)'],
  ['runway', 'Runway (Gen-4 Media)'],
  ['ollama', 'Local Ollama (Free on PC)'],
];
const CUSTOM_PROVIDER_LABELS = Object.fromEntries(CUSTOM_PROVIDER_OPTIONS);
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

// Same routing as the server (src/cloud/envoy-agents.mjs) for pending-work routing.
// Ordinary channels (Maestro Bite 2): only an explicit address earns a
// turn — @name / @all — and an unnamed message is pending for nobody.
// 'maestro' is never a target: Maestro is the human's seat, not an
// agent, and agent-authored messages dispatch nobody.
export function addressed(message, roster) {
  const team = (roster ?? []).filter((p) => p !== 'maestro');
  if (!team.length) return [];
  if (message.authorKind !== 'human') return [];
  const { all, providers } = mentions(message.body);
  if (all) return team;
  if (providers.length) return team.filter((p) => providers.includes(p));
  return [];
}

// Presence rides under engine names for two seats (the qwen seat
// reports as 'ollama', grok may report as 'xai') — the same names the
// activity feed maps. A roster seat is online when ANY of its names
// is in the presence set; matching only the roster name left Qwen
// OFFLINE forever while she answered (her presence name is 'ollama').
const providerOnline = (p, online) => activityProviderNames(p).some((n) => online.has(n));

export function agentStates(messages, roster, online, now = Date.now(), route = addressed) {
  // Presence only: connected or not, from the presence feed (the `online`
  // set). This used to also derive a 'working' state from the age of the
  // last routed message (fresh within 10 minutes and unanswered) — a
  // guess that lit seats WORKING when no job was running. Removed on
  // Troy's order (2026-11-04): the desk shows no work state it cannot
  // prove; real seat activity arrives with the runner activity feed.
  const out = {};
  for (const p of roster) {
    const mine = messages.filter((m) => m.authorSubject === `agent:${p}`);
    const last = mine.at(-1) ?? null;
    const isOnline = providerOnline(p, online);
    out[p] = { state: !isOnline ? 'offline' : 'idle', last: last?.body ?? '' };
  }
  return out;
}

// The desk derives NO work state from message age. The client mirror of
// the server's agent-work window (pendingAgentWork/deskPending, with
// AGENT_WORK_WINDOW_MS and FAST_POLL_MS) was deleted with the activity
// desk bite (2026-11-04): the in-thread "answering" cue and the roster
// WORKING light it fed lit seats that had no job running, and Troy's
// order was that the desk show no work state it cannot prove. The
// server's own agentWork rule still lives in src/cloud/envoy-mesh.mjs;
// what a seat is doing renders only from the runner activity feed (see
// the activity helpers at the desk anchor below).
export const CALM_POLL_MS = 2500;

// The workspace's honest asleep banner: when the server says this
// tenant's agents cannot answer yet (no subscription connected, or no
// computer running them), the chat says so in plain words instead of
// letting messages sit in silence. Null = nothing to show.
export function agentStateBanner(agentState) {
  if (!agentState || agentState.state !== 'asleep' || !agentState.line) return null;
  return String(agentState.line);
}

// The room mirror of the server's room routing: a private room seats
// exactly one agent, so an unnamed prompt there is that agent's work —
// the room itself is the address. Named/@all keep the ordinary shape.
export function roomAddressed(message, roster) {
  const team = (roster ?? []).filter((p) => p !== 'maestro');
  if (!team.length || message.authorKind !== 'human') return [];
  const { all, providers } = mentions(message.body);
  if (all) return team;
  if (providers.length) return team.filter((p) => providers.includes(p));
  return team;
}

// ---------- the Maestro desk (the manager seat) ----------
// The desk is one channel per tenant (slug 'maestro-desk', title
// 'Maestro', kind 'team'), created lazily by the server
// (POST /api/admin/envoy/maestro-desk) the first time the manager
// enters the seat. Its mesh config carries desk:true and a roster with
// no 'maestro' on it: in the desk, Maestro is the human sending, and a
// send is a dispatch — @all broadcasts to every agent on the desk,
// @name picks the named agents, and an unnamed send reaches the whole
// desk. These functions mirror the server's desk routing
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

// ---------- live seat activity (the runner activity feed) ----------
// The presence GET also carries `activity`: the worker's real per-job
// events ({ provider, channelId, stage, detail, at, expiresAt } —
// sql/067 + src/cloud/runner-presence.mjs), one per thing a seat
// actually did. This feed is the ONLY source of work state the desk
// renders: a seat shows a row while its newest unexpired event for the
// open channel is live, and for a few seconds after a terminal event
// (done / failed) lands. No event, no row — message age, roster
// membership and online state prove nothing about work and are never
// consulted here. (The age-derived computation that fed the old
// "answering" cue was removed 2026-11-04 on Troy's order.)
export const ACTIVITY_STAGE_WORDS = Object.freeze({
  started: 'starting',
  working: 'working on it',
  'file-placed': 'placing files on the PC',
  published: 'published a page',
  done: 'finished',
  failed: 'hit a problem',
});
const ACTIVITY_TERMINAL_STAGES = new Set(['done', 'failed']);
// How long a terminal row lingers after its event lands — long enough
// to be seen, short enough that a finished seat never looks busy.
export const ACTIVITY_TERMINAL_SHOW_MS = 10_000;
// The fast refresh cadence while any displayed seat has live activity.
// (The pre-kill FAST_POLL_MS value, kept as an internal constant: the
// exported name went away with the age-derived mirror it served.)
const ACTIVITY_POLL_MS = 800;

// Activity rides under presence names (the qwen seat reports as
// 'ollama', grok may report as 'xai') — the same mapping loadPresence
// applies to the online set, in the desk vocabulary's direction.
export function activityProviderNames(provider) {
  const names = [provider];
  if (provider === 'qwen') names.push('ollama');
  if (provider === 'grok') names.push('xai');
  return names;
}

// The desk-vocabulary provider for a feed event's provider name.
function activityDeskProvider(name) {
  if (name === 'ollama') return 'qwen';
  if (name === 'xai') return 'grok';
  return name;
}

// The newest unexpired event for one seat in one channel, or null.
export function latestActivity(activity, provider, channelId, now = Date.now()) {
  const names = activityProviderNames(provider);
  let best = null;
  for (const event of activity ?? []) {
    if (!event || event.channelId !== channelId || !names.includes(event.provider)) continue;
    if (!(new Date(event.expiresAt).getTime() > now)) continue;
    if (!best || new Date(event.at).getTime() > new Date(best.at).getTime()) best = event;
  }
  return best;
}

export function activityElapsed(event, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - new Date(event.at).getTime()) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function activityCueText(name, event, now = Date.now()) {
  const words = ACTIVITY_STAGE_WORDS[event.stage] ?? 'working on it';
  return `${name} · ${words} · ${activityElapsed(event, now)}`;
}

// The event one seat may show in one channel, or null when it has
// nothing provable to show: no unexpired event, or a terminal event
// whose brief showing has passed. An older working event underneath a
// terminal one never resurrects the seat — the newest event decides.
export function activityCue(activity, provider, channelId, now = Date.now()) {
  const event = latestActivity(activity, provider, channelId, now);
  if (!event) return null;
  if (ACTIVITY_TERMINAL_STAGES.has(event.stage) && now - new Date(event.at).getTime() > ACTIVITY_TERMINAL_SHOW_MS) return null;
  return event;
}

// Every seat with something to show in a channel, in display order:
// the built-in seats in AGENTS order, then custom agents in config
// order. The seat set comes from the feed itself (reverse-mapped), so
// a seat shows its real work even off the roster — and a seat with no
// event never shows at all.
export function activityCues(activity, channelId, customAgents = [], now = Date.now()) {
  const present = new Set();
  for (const event of activity ?? []) {
    if (event && event.channelId === channelId) present.add(activityDeskProvider(String(event.provider ?? '')));
  }
  // A seat that is both built-in and a legacy custom agent in the same
  // room (qwen, since the Qwen channel fix) is ordered once, at its
  // built-in position — never cued twice.
  const order = [...new Set([...AGENTS.filter((p) => p !== 'maestro'), ...(customAgents ?? []).map((a) => a.handle).filter(Boolean)])];
  const out = [];
  for (const p of order) {
    if (!present.has(p)) continue;
    const event = activityCue(activity, p, channelId, now);
    if (event) out.push({ provider: p, event });
  }
  return out;
}

export function activityName(provider, customAgents = []) {
  if (NAMES[provider]) return NAMES[provider];
  const custom = (customAgents ?? []).find((a) => a.handle === provider);
  return custom?.name ?? provider;
}

// Any displayable activity in a channel — drives the fast refresh
// cadence while a seat is visibly working there.
export function activityLive(activity, channelId, customAgents = [], now = Date.now()) {
  return activityCues(activity, channelId, customAgents, now).length > 0;
}

// ---------- seat avatar motion (emoji bite 4) ----------
// Motion is a RENDERING of the same feed, never a state of its own:
// a seat's avatar moves only while its newest unexpired event for the
// viewed channel is a working stage, and stops the moment the stage
// turns terminal or the event expires — the class rides the same
// poll-driven renders the cue text does, so no timers exist here.
// Working stages bounce (the seat is visibly busy); 'published' —
// its reply landing — gets the talking bobble. The gate is the
// desk's own emojiStill(): plain emoji mode and prefers-reduced-
// motion systems get the still frame and no motion class at all,
// and envoy.css repeats the reduced-motion gate on the animation
// itself. The animated asset's own internal (SMIL) motion is a
// separate layer and untouched by this one.
export function activityMotionKind(stage) {
  if (stage === 'published') return 'talk';
  if (stage === 'started' || stage === 'working' || stage === 'file-placed') return 'bounce';
  return null;
}
export function activityMotionClass(stage, still = emojiStill()) {
  if (still) return '';
  const kind = activityMotionKind(stage);
  return kind ? `ew-ava-${kind}` : '';
}
// The stage a seat's avatar may move to in one channel right now:
// its live cue's stage, or null — a terminal cue's brief linger
// ("finished" / "hit a problem") is still, and an expired or absent
// event never moves anything.
export function activityMotionStage(activity, provider, channelId, now = Date.now()) {
  const event = activityCue(activity, provider, channelId, now);
  if (!event || ACTIVITY_TERMINAL_STAGES.has(event.stage)) return null;
  return event.stage;
}

// One seat's activity row, in the message stream where its reply will
// land — same shape as the cue the kill removed, fed by events instead.
function activityRow(provider, event, customAgents = [], now = Date.now()) {
  const custom = (customAgents ?? []).find((a) => a.handle === provider);
  const motion = activityMotionClass(event.stage);
  const avatar = custom
    ? h('div', { class: `ew-avatar emoji-ava${motion ? ` ${motion}` : ''}` }, emojiNode(custom.emoji || '🤖'))
    : seatAvatar(provider, event.stage);
  return h('div', { class: 'ew-msg ew-answering', role: 'status' },
    avatar,
    h('div', {}, h('div', { class: 'ew-body ew-activity-body' },
      h('span', { class: 'ew-working-dot', 'aria-hidden': 'true' }),
      activityCueText(activityName(provider, customAgents), event, now))));
}

// The rendered-activity signature: provider + stage + elapsed second
// per visible cue, for the open channel and the open room. When it
// changes — a stage moved, a cue appeared or cleared, or a live clock
// ticked into a new second — the two message views re-render; when it
// doesn't, polls leave the DOM alone.
let activityViewSig = '';
function activityViewSignature(now = Date.now()) {
  const parts = [];
  for (const c of activityCues(ws.activity, ws.channelId, ws.config?.customAgents, now)) parts.push(`ch:${c.provider}:${c.event.stage}:${activityElapsed(c.event, now)}`);
  if (ws.cli.roomId) for (const c of activityCues(ws.activity, ws.cli.roomId, ws.config?.customAgents, now)) parts.push(`rm:${c.provider}:${c.event.stage}:${activityElapsed(c.event, now)}`);
  return parts.join(',');
}
function syncActivityViews() {
  const sig = activityViewSignature();
  if (sig === activityViewSig) return;
  activityViewSig = sig;
  renderMessages();
  renderCliThread();
  syncAgentCardMotion();
}

// The Agents-panel cards are rebuilt on roster/config changes, not on
// the activity tick — so their avatars' motion (emoji bite 4) is
// synced in place from the same signature change that re-renders the
// message views: class toggles on the avatar shell only, no rebuild,
// and only while the signature actually moved.
function syncAgentCardMotion() {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
  for (const card of document.querySelectorAll('#ew-agent-cards .ew-agent[data-provider]')) {
    const ava = card.querySelector('.ew-avatar');
    if (!ava) continue;
    const cls = activityMotionClass(activityMotionStage(ws.activity, card.getAttribute('data-provider'), ws.channelId));
    ava.classList.toggle('ew-ava-bounce', cls === 'ew-ava-bounce');
    ava.classList.toggle('ew-ava-talk', cls === 'ew-ava-talk');
  }
}

// Message text -> DOM: code fences, links, @mentions, Claim:.
// Links render as buttons wired to onLink: the desk sends them to the
// workbench browser; agent replies send them to a full tab instead (see
// the render loops). Markdown links ([label](url)) render as one button
// carrying the label — the form agent file deliveries arrive in.
// Helmian's own emoji art (emoji-map.mjs): a mapped emoji renders as its
// asset, an unmapped one keeps the platform glyph — Unicode stays the data.
// Pictograph runs match whole (ZWJ/flag/keycap sequences included; the
// asset lookup declines those) so a sequence is never split in two.
const EMOJI_RUN_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3)(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}]|\u200D(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}])*)*/gu;
// "plain" emoji mode and reduced-motion systems get the static first frame.
const emojiStill = () => isPlain() || (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
function emojiNode(run) {
  const slug = emojiAssetSlug(run);
  if (!slug) return run;
  return h('img', { class: 'hx-emoji', src: emojiAssetUrl(slug, { still: emojiStill() }), alt: run, title: run, loading: 'lazy' });
}
function appendText(into, str) {
  if (!str) return;
  let at = 0; let m; EMOJI_RUN_RE.lastIndex = 0;
  while ((m = EMOJI_RUN_RE.exec(str))) {
    if (m.index > at) into.append(str.slice(at, m.index));
    into.append(emojiNode(m[0]));
    at = EMOJI_RUN_RE.lastIndex;
  }
  if (at < str.length) into.append(str.slice(at));
}

// ---------- faces (emoji bite 5) ----------
// The built-in seats' faces: one character per seat per workspace,
// stored server-side (route /api/admin/envoy/agent-faces) so the
// whole room sees the same face — the shape a custom agent's face
// already has on its record (Qwen's crab). ws.faces is the server's
// effective map (the workspace's stored choice over the shipped
// default); before it loads, the shipped defaults from the emoji map
// render — the same values the server answers — so a seat never
// flashes the stock picture and then swaps. A provider with no face
// at all (Maestro, the human's seat) keeps the stock PNG.
export function seatFaceFor(faces, provider) {
  const stored = faces?.[provider];
  if (typeof stored === 'string' && emojiAssetSlug(stored)) return stored;
  return AGENT_FACE_DEFAULTS[provider] ?? null;
}
const seatFace = (provider) => seatFaceFor(ws.faces, provider);
// Avatar nodes for a built-in seat: the face — bite-1 art through
// emojiNode, so plain mode and reduced motion get the still frame —
// in the same .ew-avatar.emoji-ava shell custom agents wear, or the
// stock picture when the seat has no face. `motionStage` is the
// seat's live activity stage for the viewed channel (emoji bite 4):
// it only ever adds the motion class for that stage, or nothing.
function seatAvatar(provider, motionStage = null) {
  const face = seatFace(provider);
  const motion = activityMotionClass(motionStage);
  const cls = `ew-avatar${face ? ' emoji-ava' : ''}${motion ? ` ${motion}` : ''}`;
  return face ? h('div', { class: cls }, emojiNode(face)) : h('div', { class: cls }, avatarImg(provider));
}
function seatFaceImg(provider) {
  const face = seatFace(provider);
  return face ? emojiNode(face) : avatarImg(provider);
}

function renderFaceViews() { renderAgents(); renderMessages(); renderCliChips(); renderCliSessions(); renderCliThread(); }

async function loadFaces() {
  try {
    const body = await ws.ctx.api('/api/admin/envoy/agent-faces');
    const next = body?.faces ?? null;
    const changed = JSON.stringify(next) !== JSON.stringify(ws.faces);
    ws.faces = next;
    if (changed) renderFaceViews();
  } catch { /* the shipped defaults render until the map loads */ }
}

// The picker's shared shape with the custom-agent create modal: the
// curated face set as a grid of bite-1 art.
function faceGrid(label, picked, onPick) {
  const grid = h('div', { class: 'ew-emoji-grid', role: 'radiogroup', 'aria-label': label });
  const draw = () => {
    grid.replaceChildren(...CUSTOM_AGENT_EMOJIS.map((em) => h('button', {
      type: 'button', class: `ew-emoji-btn${picked() === em ? ' on' : ''}`, 'aria-checked': String(picked() === em),
      onclick: () => { onPick(em); draw(); },
    }, emojiNode(em))));
  };
  draw();
  return grid;
}

function openSeatFaceModal(provider) {
  if (!provider || !(provider in AGENT_FACE_DEFAULTS)) return;
  let picked = seatFace(provider);
  openModal(`${NAMES[provider]}'s face`, [
    h('p', { class: 'muted sm' }, `${NAMES[provider]}'s face shows on their messages, their Agents card and their activity rows — for everyone in this workspace.`),
    h('div', { class: 'ew-row' }, faceGrid(`Pick a face for ${NAMES[provider]}`, () => picked, (em) => { picked = em; })),
    h('div', { class: 'ew-row' },
      h('button', { type: 'button', class: 'ew-btn ghost sm', onclick: () => saveSeatFace(provider, null) }, 'Reset to default'),
      h('span', { class: 'ew-spacer' }),
      h('button', { type: 'button', class: 'ew-btn ghost sm', onclick: closeModal }, 'Cancel'),
      h('button', { type: 'button', class: 'ew-btn primary sm', onclick: () => saveSeatFace(provider, picked) }, 'Save')),
  ]);
}

async function saveSeatFace(provider, emoji) {
  try {
    const body = await ws.ctx.post('/api/admin/envoy/agent-faces', { provider, emoji });
    ws.faces = body?.faces ?? ws.faces;
    closeModal();
    renderFaceViews();
    ws.ctx.toast(`${NAMES[provider]}'s face ${emoji ? 'updated' : 'reset'}`, 'ok');
  } catch (e) {
    ws.ctx.toast(e?.body?.code === 'ENVOY_FACE_FORBIDDEN' ? 'Only the owner or an admin can change a seat face.' : 'Could not save the face. Try again.');
  }
}

// ---------- the member's own face ----------
// The desk's identity corner: the member's name and face at the foot
// of the channels pane, one click from their face control. The face
// itself lives on the member's profile record (Settings > Envoy
// profile, helmion.user_profiles.avatar_emoji), so it is the same
// face everywhere, and their messages carry it back down (authorEmoji
// on the message rows) for every client to render.
function myFace() {
  const em = ws.profile?.avatarEmoji;
  return typeof em === 'string' && em ? em : null;
}

async function loadProfile() {
  try {
    const body = await ws.ctx.api('/api/admin/profile');
    ws.profile = { nickname: body?.nickname ?? null, avatarEmoji: body?.avatarEmoji ?? null };
  } catch { ws.profile = null; }
  renderMeFace();
}

function renderMeFace() {
  const box = document.getElementById('ew-me-face');
  if (!box) return;
  const face = myFace();
  const name = ws.profile?.nickname || 'You';
  box.replaceChildren(
    face ? h('div', { class: 'ew-avatar emoji-ava' }, emojiNode(face)) : h('div', { class: 'ew-avatar' }, name.slice(0, 1).toUpperCase()),
    h('span', { class: 'name' }, name),
    h('button', { type: 'button', class: 'ew-btn ghost sm', onclick: openMyFaceModal }, face ? 'Change face' : 'Pick a face'),
  );
}

function openMyFaceModal() {
  let picked = myFace();
  openModal('Your face', [
    h('p', { class: 'muted sm' }, 'Your face shows next to your name here and on your messages, for everyone in this workspace.'),
    h('div', { class: 'ew-row' }, faceGrid('Pick your face', () => picked, (em) => { picked = em; })),
    h('div', { class: 'ew-row' },
      h('button', { type: 'button', class: 'ew-btn ghost sm', onclick: () => saveMyFace(null) }, 'No face — use my initial'),
      h('span', { class: 'ew-spacer' }),
      h('button', { type: 'button', class: 'ew-btn ghost sm', onclick: closeModal }, 'Cancel'),
      h('button', { type: 'button', class: 'ew-btn primary sm', onclick: () => saveMyFace(picked) }, 'Save')),
  ]);
}

async function saveMyFace(emoji) {
  try {
    await ws.ctx.post('/api/admin/profile', { avatarEmoji: emoji ?? '' });
    ws.profile = { ...(ws.profile ?? {}), avatarEmoji: emoji };
    closeModal();
    renderMeFace();
    ws.sig = null;
    await loadMessages();
    ws.ctx.toast(emoji ? 'Your face is set' : 'Your face is cleared', 'ok');
  } catch { ws.ctx.toast('Could not save your face. Try again.'); }
}

export function renderBody(text, { onLink, onCanvas, linkTitle } = {}) {
  const frag = document.createDocumentFragment();
  const parts = String(text ?? '').split(/```(\w+)?\n?([\s\S]*?)```/g);
  for (let i = 0; i < parts.length; i += 3) {
    inline(parts[i], frag, onLink, linkTitle);
    if (i + 2 < parts.length) {
      const lang = (parts[i + 1] || '').toLowerCase(); const code = parts[i + 2] ?? '';
      frag.append(h('pre', {}, h('code', { text: code })));
      if (onCanvas && (lang === 'html' || /<\/?(html|body|div|section|style)\b/i.test(code))) frag.append(h('div', { class: 'ew-code-actions' }, h('button', { type: 'button', class: 'ew-btn ghost sm', onclick: () => onCanvas(code) }, 'Open in Canvas')));
    }
  }
  return frag;
}
function inline(text, into, onLink, linkTitle) {
  const re = /(\[([^\]\n]+)\]\((https?:\/\/[^\s<>"')]+)\))|(https?:\/\/[^\s<>"')\]]+)|(@[A-Za-z][A-Za-z0-9_-]{1,20})|(^|\n)(Claim:)/g;
  let at = 0; let m;
  while ((m = re.exec(text))) {
    appendText(into, text.slice(at, m.index));
    // The click closure must capture this match's URL in its own binding:
    // m is the shared loop variable and is null by the time any click lands
    // (the exec loop's final call), so closing over m[3]/m[4] threw on click
    // and no link ever opened.
    if (m[3]) { const url = m[3]; into.append(h('button', { type: 'button', class: 'link', title: linkTitle ?? url, onclick: () => onLink?.(url) }, m[2])); }
    else if (m[4]) { const url = m[4]; into.append(h('button', { type: 'button', class: 'link', title: linkTitle ?? 'Open in the workbench browser', onclick: () => onLink?.(url) }, url)); }
    else if (m[5]) into.append(h('span', { class: 'mention' }, m[5]));
    else { into.append(m[6]); into.append(h('span', { class: 'claim' }, m[7])); }
    at = re.lastIndex;
  }
  appendText(into, text.slice(at));
}

const ws = { avatars: ls.get('avatars', {}), pendingAvatar: null, wired: false, ctx: null, channels: [], channelId: null, mode: ls.get('netMode', 'envoy') === 'discord' ? 'discord' : 'envoy', config: null, configured: false, discordBot: null, slackBot: null, messages: [], sig: null, online: new Set(), activity: [], agentState: null, faces: null, profile: null, timer: null, slowTimer: null, agentsPinned: ls.get('agentsPinned', {}), linkPoll: null, cli: { provider: 'claude', pending: null, sessions: [], server: false, activeId: ls.get('cliSession', null), threadSig: null, roomId: null, roomFor: null, roomMessages: [], roomSig: null, roomJoined: {}, roomPromise: null }, attach: { channel: [], cli: [] }, webSearch: { channel: false, cli: false }, pickerFor: null, pickerFacts: null, reactions: { channelId: null, byId: {}, mine: {} }, reactionsStamp: 0, reactionPopFor: null, slash: { commands: null, loaded: false, loading: null, openFor: null, index: 0, dismissedFor: null }, desk: { handoffs: null, checkpoints: null, denied: false, promise: null } };

// ---------- avatars (saved on this device) ----------
const isPlain = () => ws.ctx?.state?.emojiMode === 'plain';
function chatAvatar(c, cls = '') {
  // The channel's face lives on its server config (emoji bite 5) so
  // every member and device sees the same look; this device's saved
  // choice is only the fallback for a channel whose config has none.
  const a = avatarFor(sanitizeChoice(c?.avatar) ?? sanitizeChoice(ws.avatars[c?.id]), c?.title || c?.slug);
  return h('span', { class: `ew-ava ${a.kind} ${cls}`.trim(), style: a.kind === 'plain' ? `--ava:${a.color}` : null, 'aria-hidden': 'true' }, a.kind === 'char' ? emojiNode(a.glyph) : a.glyph);
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
        ? CHARACTERS.map(([id, glyph, label]) => h('button', { type: 'button', role: 'radio', class: `ew-ava char${choice?.id === id ? ' on' : ''}`, 'aria-checked': String(choice?.id === id), 'aria-label': label, title: label, onclick: () => { choice = { k: 'char', id }; onPick(choice); draw(); } }, emojiNode(glyph)))
        : COLORS.map((color, i) => h('button', { type: 'button', role: 'radio', class: `ew-ava plain${choice?.c === i ? ' on' : ''}`, style: `--ava:${color}`, 'aria-checked': String(choice?.c === i), 'aria-label': `Colour ${i + 1}`, title: `Colour ${i + 1}`, onclick: () => { choice = { k: 'plain', c: i }; onPick(choice); draw(); } }, avatarFor({ k: 'plain', c: i }, title()).glyph))));
    wrap.replaceChildren(seg, grid);
  };
  draw();
  return wrap;
}
function openAvatarModal() {
  const c = ws.channels.find((x) => x.id === ws.channelId); if (!c) return;
  let pick = sanitizeChoice(c.avatar) ?? sanitizeChoice(ws.avatars[c.id]) ?? defaultChoice(c.title || c.slug, 'plain'); // the server's look first, then this device's, then the default
  openModal(`Look for #${c.title || c.slug}`, [
    h('p', { class: 'muted sm' }, 'Pick a character, or switch to Simple for a plain letter icon. Saved for the whole workspace.'),
    avatarPicker(pick, () => c.title || c.slug, (v) => { pick = v; }),
    h('div', { class: 'ew-row' }, h('span', { class: 'ew-spacer' }), h('button', { type: 'button', class: 'ew-btn primary sm', onclick: async () => {
      saveAvatar(c.id, pick); // this device's cache, as before
      try {
        const body = await ws.ctx.post('/api/admin/envoy/channel-config', { action: 'set-channel-avatar', channelId: c.id, avatar: pick });
        if (body.config) { ws.config = body.config; ws.configured = true; }
        const ch = ws.channels.find((x) => x.id === c.id); if (ch) ch.avatar = pick;
      } catch { ws.ctx.toast('Saved on this device — the workspace copy did not save.'); }
      renderChannels(); renderHeadAvatar(); closeModal();
    } }, 'Save')),
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
  for (const b of document.querySelectorAll(`[data-toggle="${name}"]`)) { b.setAttribute('aria-pressed', String(open)); if (b.classList.contains('ew-mnav-btn')) b.classList.toggle('on', open); }
  if (narrow()) { const mc = $('ew-mnav-chat'); if (mc) mc.classList.toggle('on', !document.querySelector('.ew-pane.sheet-open')); }
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
function closeSheets() { for (const p of document.querySelectorAll('.ew-pane.sheet-open')) p.classList.remove('sheet-open'); $('ew-scrim').classList.remove('open'); for (const b of document.querySelectorAll('[data-toggle]')) b.setAttribute('aria-pressed', 'false'); const mc = $('ew-mnav-chat'); if (mc) mc.classList.add('on'); }

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
// Per-channel link flags for the channel list: the channels API now
// carries each channel's Discord / Slack link itself (server truth from
// the channel's config row — the same rows the bridges read), so the
// flags are right for every channel from this one read, including a
// room this browser has never opened. The chanMeta cache only fills
// the agent count, and only stands in for a link flag when an older
// server did not send the field at all. Pure; unit tested.
export function applyChannelLinks(channels, meta = {}) {
  for (const c of channels) {
    const cached = meta[c.id];
    if (cached) c._agents = cached.a;
    c._discord = 'discord' in c ? Boolean(c.discord) : Boolean(cached?.d);
    c._slack = 'slack' in c ? Boolean(c.slack) : Boolean(cached?.s);
  }
  return channels;
}
async function loadChannels() {
  const { api, post, state } = ws.ctx;
  const body = await api('/api/admin/envoy/channels');
  ws.channels = Array.isArray(body.channels) ? body.channels : [];
  // Bot status rides the channels read, so it is known at boot — the
  // Discord panel no longer needs an open channel's config to learn it.
  if (body.discordBot) ws.discordBot = body.discordBot;
  if (body.slackBot) ws.slackBot = body.slackBot;
  if (!ws.channels.length && ['owner', 'admin'].includes(state.actor?.role)) {
    const made = await post('/api/admin/envoy/channels', { slug: 'team', title: 'Team', kind: 'team' });
    if (made.channel) ws.channels = [made.channel];
  }
  applyChannelLinks(ws.channels, ls.get('chanMeta', {}));
  // The open channel is remembered per network mode: Envoy restores its
  // own last channel (the legacy 'channel' key is its fallback), Discord
  // mode restores its last linked channel.
  const urlChannel = (() => { try { return new URLSearchParams(location.search).get('channel'); } catch { return null; } })();
  const saved = (urlChannel && ws.channels.some((c) => c.id === urlChannel || c.slug === urlChannel) ? (ws.channels.find((c) => c.id === urlChannel || c.slug === urlChannel)?.id ?? null) : null) ?? ls.get(`netChannel.${ws.mode}`, null) ?? (ws.mode === 'envoy' ? ls.get('channel', null) : null);
  const pool = modeChannels();
  if (!pool.some((c) => c.id === ws.channelId)) ws.channelId = pool.some((c) => c.id === saved) ? saved : pool[0]?.id ?? null;
  renderChannels();
}
function currentTitle() { const c = ws.channels.find((x) => x.id === ws.channelId); return c?.title || c?.slug || 'channel'; }
const openChannel = () => ws.channels.find((c) => c.id === ws.channelId) ?? null;
// The desk channel is open.
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
// are distinguishable through the link fields the channels API now
// carries per channel (applyChannelLinks above turns them into the
// _discord flag); the open channel's config load still refreshes its
// own flag and the chanMeta cache.
export const linkedChannels = (channels = ws.channels) => channels.filter((c) => c._discord);
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
// and channel a message will land in, in both modes. The wording is a
// pure function of the mode, the open channel and its Discord link, so
// it is unit tested without a DOM. In Discord mode the channel name
// comes from the channel's own link (carried by the channels API),
// falling back to the open channel's loaded config, then its title.
export function netStripText({ mode, channel, config = null } = {}) {
  const title = channel?.title || channel?.slug || 'channel';
  if (mode !== 'discord' && isDeskChannel(channel)) {
    return "You're dispatching as Maestro · the desk — replies come back under each agent's own name";
  }
  return mode === 'discord'
    ? (channel ? `You're posting to Discord · #${channel.discord?.channelName || config?.discord?.channelName || title}` : "You're in Discord · no channel linked yet")
    : `You're posting to Envoy · #${title}`;
}
function renderNetStrip() {
  const strip = $('ew-net-strip'); if (!strip) return;
  const ch = ws.channels.find((c) => c.id === ws.channelId);
  const dOn = ws.mode === 'discord';
  strip.classList.toggle('discord', dOn);
  $('ew-chat').classList.toggle('net-discord', dOn);
  strip.textContent = netStripText({ mode: ws.mode, channel: ch, config: ws.config });
}
function setComposer(on) {
  const box = $('maestro-input'); const btn = $('maestro-send');
  if (box) box.disabled = !on;
  if (btn) btn.disabled = !on;
}
export const discordEmptyText = (bot = ws.discordBot) => bot?.configured
  ? 'No channels are linked to Discord yet. Flip to Envoy, open a channel and use Link Discord to mirror it here.'
  : 'The Helmian Discord bot is not connected yet. Once it is, linked channels mirror here.';
// ---------- opening the desk channel ----------
// The desk channel is resolved once: from the channel list when it
// already exists, otherwise the server creates it (and seeds its
// dispatch config) the first time it is opened — the rooms pattern.
// Opening it is ordinary channel selection (fun pass F4): there is
// no seat to enter or leave.
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
async function openDeskChannel() {
  const id = await ensureMaestroDesk();
  if (id) await selectChannel(id);
  else ws.ctx.toast('The desk is not reachable yet. Try again.');
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
  $('ew-link-slack').hidden = true;
  $('ew-messages').replaceChildren(h('div', { class: 'ew-empty' }, discordEmptyText()));
  setComposer(false);
}

function renderChannels() {
  const list = $('ew-channel-list');
  const row = (c) => h('button', { type: 'button', class: `ew-channel${c.kind === 'agent' ? ' room' : ''}${c.id === ws.channelId ? ' active' : ''}`, 'data-id': c.id, onclick: () => selectChannel(c.id) },
    chatAvatar(c, 'sm'), h('span', { class: 'name' }, c.title || c.slug),
    h('span', { class: 'tags' }, c._discord ? h('span', { class: 'ew-mini discord', title: 'Linked to Discord' }) : null, c._slack ? h('span', { class: 'ew-mini slack', title: 'Linked to Slack' }) : null, c._agents ? h('span', { class: 'ew-mini agents', title: `${c._agents} agent(s)` }) : null, c.kind === 'agent' ? h('span', { class: 'ew-mini room', title: 'Private agent room' }) : null));
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
  // The desk sits above the channel list under its own head: it is
  // the manager's desk channel. Until the server has created it, the
  // row still opens it (opening creates it) — the same row either way.
  const desk = deskChannelFor(ws.channels);
  const seatRow = desk
    ? h('button', { type: 'button', class: `ew-channel seat${desk.id === ws.channelId ? ' active' : ''}`, 'data-id': desk.id, onclick: () => selectChannel(desk.id) },
      h('span', { class: 'ew-avatar seat-ava' }, avatarImg('maestro')), h('span', { class: 'name' }, 'Maestro'),
      h('span', { class: 'tags' }, h('span', { class: 'ew-mini seat', title: 'Your manager seat' })))
    : h('button', { type: 'button', class: 'ew-channel seat', onclick: () => openDeskChannel() },
      h('span', { class: 'ew-avatar seat-ava' }, avatarImg('maestro')), h('span', { class: 'name' }, 'Maestro'),
      h('span', { class: 'tags' }, h('span', { class: 'ew-mini seat', title: 'Your manager seat' })));
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
    h('div', { class: 'ew-src-head' },
      h('span', { class: 'ew-room-mark', 'aria-hidden': 'true' }),
      'CUSTOM AGENTS',
      h('button', { type: 'button', id: 'ew-left-create-agent', class: 'ew-icon sm', title: 'Create a custom agent (+)', 'aria-label': 'Create custom agent', style: 'margin-left:auto;', onclick: (e) => { e.stopPropagation(); openCreateAgentModal(); } }, '+')
    ),
    ...((ws.config?.customAgents ?? []).length
      ? (ws.config.customAgents).map((ca) => h('button', {
          type: 'button',
          class: 'ew-channel custom-agent-row',
          title: `${ca.name} (@${ca.handle})${ca.jobTitle ? ' · ' + ca.jobTitle : ''}`,
          onclick: () => insertMention(ca.handle),
        },
        h('span', { class: 'ew-avatar emoji-ava' }, emojiNode(ca.emoji || '🤖')),
        h('span', { class: 'name' }, ca.name),
        h('span', { class: 'tags' }, h('span', { class: 'ew-mini custom-tag' }, `@${ca.handle}`))))
      : [h('p', { class: 'ew-note' }, 'Click + to create a custom agent with a face, name, and real job.')]),
    h('div', { class: 'ew-src-head' }, h('span', { class: 'ew-discord-mark', 'aria-hidden': 'true' }), 'DISCORD'),
    ...(linked.length ? linked.map(row) : [h('p', { class: 'ew-note' }, bot?.configured ? 'No channels linked yet. Use Link Discord in a chat.' : 'Bot not connected yet. Linked channels mirror here.')]),
    h('div', { class: 'ew-src-head' },
      h('span', { class: 'ew-gh-mark', 'aria-hidden': 'true' }),
      'GITHUB',
      h('button', { type: 'button', class: 'ew-icon sm', title: 'Link a GitHub repository to this channel', 'aria-label': 'Link GitHub repository', style: 'margin-left:auto;', onclick: (e) => { e.stopPropagation(); if (narrow()) closeSheets(); linkGithub(); } }, '+')
    ),
    ws.config?.github?.repo
      ? h('button', { type: 'button', class: 'ew-channel', title: `Linked to ${ws.config.github.repo} — click to manage`, onclick: () => { if (narrow()) closeSheets(); linkGithub(); } },
          h('span', { class: 'ew-gh-mark', 'aria-hidden': 'true' }),
          h('span', { class: 'name' }, ws.config.github.repo),
          h('span', { class: 'tags' }, h('span', { class: 'ew-ca-tag' }, 'Linked')))
      : h('button', { type: 'button', class: 'ew-channel', title: 'Connect a GitHub repository to stream commits, PRs & issues into this channel', onclick: () => { if (narrow()) closeSheets(); linkGithub(); } },
          h('span', { class: 'ew-gh-mark', 'aria-hidden': 'true' }),
          h('span', { class: 'name' }, '+ Link GitHub repo'))
  );
}
async function selectChannel(id) {
  if (!id) return;
  ws.channelId = id; ls.set('channel', id); ls.set(`netChannel.${ws.mode}`, id); ws.sig = null; ws.messages = [];
  ws.reactions = { channelId: null, byId: {}, mine: {} }; ws.reactionsStamp = 0; closeReactionPicker();
  setComposer(true);
  renderChannels();
  $('ew-messages').replaceChildren(h('div', { class: 'ew-empty' }, 'Loading…'));
  if (narrow()) closeSheets();
  await Promise.allSettled([loadConfig(), loadMessages()]);
  if (inMaestroMode()) loadDeskLists();
  $('maestro-input').focus({ preventScroll: true });
}

// ---------- config: agents + Discord + Slack ----------
// The chat-head furniture for one mirror link (Discord or Slack),
// derived purely from the channel config + bot status so it is testable
// without a DOM. The badge's class is the network's own name, lowercase.
// `pending` is passed only by the Discord call site: the config carries
// ONE pendingLink field shared by both link flows, so the client cannot
// tell whose code is outstanding — Discord's badge has always carried
// the pending state, and Slack's must not claim it too.
export function mirrorLinkHeader({ link = null, pending = false, bot = null, admin = false, label = 'Discord' } = {}) {
  const name = link ? (link.channelName || link.channelId) : null;
  return {
    badgeHidden: !(link || pending),
    badgeClass: link ? label.toLowerCase() : 'pending',
    badgeText: link ? `${label} #${name}` : `${label} link pending`,
    buttonLabel: link ? `${label} linked` : `Link ${label}`,
    buttonHidden: !admin && !link,
    statusText: bot?.configured ? (link ? `linked to #${name}` : 'ready to link') : 'bot not set up yet',
  };
}
export function githubLinkHeader({ github = null, admin = false } = {}) {
  const repo = github?.repo || null;
  return {
    badgeHidden: !repo,
    badgeClass: 'github',
    badgeText: repo ? `GitHub ${repo}` : '',
    buttonLabel: repo ? 'GitHub linked' : 'Link GitHub',
    buttonHidden: !admin && !repo,
    statusText: repo ? `linked to ${repo}` : 'ready to link',
  };
}
export function debateHeaderState({ debateMode = 'off', maxRoundTurns = 10 } = {}) {
  const active = debateMode === 'free-willy';
  return {
    active,
    badgeHidden: !active,
    badgeText: active ? `Free-Willy Debate (${maxRoundTurns} turns)` : '',
    buttonLabel: active ? 'Debate: ON' : 'Free-Willy',
    stopHidden: !active,
  };
}
async function loadConfig() {
  if (!ws.channelId) return;
  const id = ws.channelId;
  try {
    const body = await ws.ctx.api(`/api/admin/envoy/channel-config?channel_id=${encodeURIComponent(id)}`);
    if (id !== ws.channelId) return;
    ws.config = body.config ?? { agents: [] }; ws.configured = Boolean(body.configured); ws.discordBot = body.discordBot ?? null; ws.slackBot = body.slackBot ?? null;
  } catch {
    // A failed refresh must not blank the room: keep the last good
    // config (roster, debate state, turn cap) and seed the empty
    // fallback only when nothing has loaded yet. The old catch swapped
    // in { agents: [] } on any error, and the renderers below turned
    // that into "none in this channel", '+' add-pills, a vanished
    // debate badge, and a modal turn field reading the fallback 12.
    if (!ws.config) { ws.config = { agents: [], discord: null, slack: null }; ws.configured = false; }
  }
  const ch = ws.channels.find((c) => c.id === id);
  if (ch) { ch._agents = ws.config.agents.length; ch._discord = Boolean(ws.config.discord); ch._slack = Boolean(ws.config.slack); if ('avatar' in (ws.config ?? {})) ch.avatar = ws.config.avatar; const seen = ls.get('chanMeta', {}); seen[ch.id] = { a: ch._agents, d: ch._discord, s: ch._slack }; ls.set('chanMeta', seen); }
  renderHeader(); renderAgents(); renderChannels(); syncAgentsPane();
}
function renderHeader() {
  const ch = ws.channels.find((c) => c.id === ws.channelId);
  const title = ch?.title || ch?.slug || 'channel';
  $('ew-channel-title').textContent = title; renderHeadAvatar();
  // The placeholder names the destination channel in both modes; the
  // long @agent hint is an Envoy-side extra and stays there.
  $('maestro-input').placeholder = ws.mode === 'discord' ? `Message #${title}` : (ws.config?.agents?.length && !narrow() ? `Message #${title} · @ an agent to get an answer` : `Message #${title}`);
  const badge = $('ew-discord-badge');
  const d = ws.config?.discord;
  const admin = ['owner', 'admin'].includes(ws.ctx.state.actor?.role);
  const dh = mirrorLinkHeader({ link: d, pending: Boolean(ws.config?.pendingLink), bot: ws.discordBot, admin, label: 'Discord' });
  badge.hidden = dh.badgeHidden;
  badge.className = `ew-badge ${dh.badgeClass}`;
  badge.textContent = dh.badgeText;
  const link = $('ew-link-discord');
  link.querySelector('.lbl').textContent = dh.buttonLabel;
  link.hidden = dh.buttonHidden;
  const sBadge = $('ew-slack-badge');
  const s = ws.config?.slack;
  const sh = mirrorLinkHeader({ link: s, bot: ws.slackBot, admin, label: 'Slack' });
  sBadge.hidden = sh.badgeHidden;
  sBadge.className = `ew-badge ${sh.badgeClass}`;
  sBadge.textContent = sh.badgeText;
  const sLink = $('ew-link-slack');
  sLink.querySelector('.lbl').textContent = sh.buttonLabel;
  sLink.hidden = sh.buttonHidden;
  const ghBadge = $('ew-github-badge');
  const ghLink = $('ew-link-github');
  const gh = githubLinkHeader({ github: ws.config?.github, admin });
  if (ghBadge) { ghBadge.hidden = gh.badgeHidden; ghBadge.textContent = gh.badgeText; }
  if (ghLink) { const l = ghLink.querySelector('.lbl'); if (l) l.textContent = gh.buttonLabel; ghLink.hidden = gh.buttonHidden; }
  const ghStatus = $('ew-github-status-text');
  if (ghStatus) ghStatus.textContent = gh.statusText;
  const deb = debateHeaderState({ debateMode: ws.config?.debateMode, maxRoundTurns: ws.config?.maxRoundTurns });
  const debBadge = $('ew-debate-badge');
  const debBtn = $('ew-debate-toggle');
  const debStop = $('ew-debate-stop');
  if (debBadge) { debBadge.hidden = deb.badgeHidden; debBadge.textContent = deb.badgeText; }
  if (debBtn) { const l = debBtn.querySelector('.lbl'); if (l) l.textContent = deb.buttonLabel; debBtn.setAttribute('aria-pressed', String(deb.active)); }
  if (debStop) debStop.hidden = deb.stopHidden;
  $('ew-agent-count').textContent = String((ws.config?.agents?.length ?? 0));
  $('ew-discord-status-text').textContent = dh.statusText;
  $('ew-slack-status-text').textContent = sh.statusText;
  renderNetStrip();
  renderMaestroMode();
}
// The desk's on-screen state (fun pass F4): the desk channel wears
// no costume — no banner over the thread, no mode styling on the
// pane, no seat to leave. What this still owns is the desk panel in
// the Agents pane (handoffs and checkpoints, shown only while the
// desk is open) and the one plain composer hint that says how a desk
// send is addressed. Everything else about the open desk is ordinary
// channel furniture, rendered by the ordinary paths.
function renderMaestroMode() {
  const on = inMaestroMode();
  const panel = $('ew-desk'); if (panel) panel.hidden = !on;
  const hint = $('ew-composer-hint');
  if (hint) hint.textContent = on ? '@name for one agent, no name for everyone' : 'Enter to send · Shift+Enter for a new line';
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
  const customList = ws.config?.customAgents ?? [];
  const roster = deskRoster(raw);
  const states = agentStates(ws.messages, roster, ws.online, Date.now(), desk ? deskTargets : addressed);
  const totalCount = roster.length + customList.length;
  $('ew-agents-summary').textContent = desk
    ? (totalCount ? `${totalCount} on the desk` : 'the desk is empty')
    : (totalCount ? `${totalCount} in this channel` : 'none in this channel');
  const canFace = ['owner', 'admin'].includes(ws.ctx.state.actor?.role);
  const builtinCards = roster.map((p) => {
    const s = states[p];
    const label = s.state === 'offline' ? 'OFFLINE' : 'IDLE';
    return h('div', { class: 'ew-agent', 'data-provider': p, role: 'button', tabindex: 0, title: desk ? `Dispatch to @${NAMES[p]}` : `Mention @${NAMES[p]} in the channel`, onclick: () => insertMention(NAMES[p]), onkeydown: (e) => { if (e.key === 'Enter') insertMention(NAMES[p]); } },
      seatAvatar(p, activityMotionStage(ws.activity, p, ws.channelId)), h('strong', {}, NAMES[p]),
      h('span', { class: 'ew-agent-btns' },
        ...(canFace ? [h('button', { type: 'button', class: 'ew-icon face', title: `Change ${NAMES[p]}'s face`, 'aria-label': `Change ${NAMES[p]}'s face`, onclick: (e) => { e.stopPropagation(); openSeatFaceModal(p); } }, emojiNode(seatFace(p) ?? '🤖'))] : []),
        h('button', { type: 'button', class: 'ew-icon remove', title: desk ? `Remove ${NAMES[p]} from the desk` : `Remove ${NAMES[p]} from this channel`, 'aria-label': `Remove ${NAMES[p]}`, onclick: (e) => { e.stopPropagation(); changeAgent('remove-agent', p); } }, '×')),
      h('span', { class: `ew-state ${s.state}` }, label),
      h('span', { class: 'last' }, s.state === 'offline' ? 'Offline. Start the Helmian bridge on your PC to bring it online.' : (s.last ? s.last.replace(/\s+/g, ' ').slice(0, 120) : 'Waiting for a message')));
  });
  const customCards = customList.map((ca) => {
    const engineOnline = ws.online.has(ca.provider) || ca.provider === 'ollama';
    const state = engineOnline ? 'idle' : 'offline';
    const provLabel = CUSTOM_PROVIDER_LABELS[ca.provider] || ca.provider;
    const caMotion = activityMotionClass(activityMotionStage(ws.activity, ca.handle, ws.channelId));
    return h('div', { class: 'ew-agent custom-agent-card', 'data-provider': ca.handle, role: 'button', tabindex: 0, title: `Mention @${ca.handle} (${ca.jobTitle || provLabel})`, onclick: () => insertMention(ca.handle), onkeydown: (e) => { if (e.key === 'Enter') insertMention(ca.handle); } },
      h('div', { class: `ew-avatar emoji-ava${caMotion ? ` ${caMotion}` : ''}` }, emojiNode(ca.emoji || '🤖')),
      h('strong', {}, `${ca.name} (@${ca.handle})`),
      h('button', { type: 'button', class: 'ew-icon remove', title: `Retire @${ca.handle}`, 'aria-label': `Retire @${ca.handle}`, onclick: (e) => { e.stopPropagation(); removeCustomAgent(ca.handle); } }, '×'),
      h('span', { class: `ew-state ${state}` }, engineOnline ? 'READY' : 'CONNECT SEAT'),
      h('span', { class: 'last' }, `${ca.jobTitle ? ca.jobTitle + ' · ' : ''}${provLabel}`));
  });
  $('ew-agent-cards').replaceChildren(...builtinCards, ...customCards);
  if (!totalCount) $('ew-agent-cards').append(h('p', { class: 'ew-note' }, desk ? 'No agents on the desk yet. Add one below or click + Create Agent.' : 'No agents in this channel. Add one below or click + Create Agent to build your team.'));
  $('ew-agent-add').replaceChildren(
    ...AGENTS.filter((p) => !roster.includes(p) && p !== 'maestro').map((p) => h('button', { type: 'button', class: 'ew-pill', title: desk ? `Add ${NAMES[p]} to the desk — it receives your dispatches` : `Add ${NAMES[p]} to this channel — it answers here`, onclick: () => changeAgent('add-agent', p) }, seatFaceImg(p), `+ ${NAMES[p]}`)),
    h('button', { type: 'button', class: 'ew-pill create-custom', title: 'Create a custom agent with emoji, name, job & AI provider', onclick: openCreateAgentModal }, '✨ + Custom Agent')
  );
  $('ew-mention-pills').replaceChildren(...((desk ? totalCount >= 1 : totalCount > 1) ? [h('button', { type: 'button', class: 'ew-pill all', onclick: () => insertMention('all') }, '@all')] : []),
    ...roster.map((p) => h('button', { type: 'button', class: 'ew-pill', title: `Mention @${NAMES[p]}`, onclick: () => insertMention(NAMES[p]) }, seatFaceImg(p), NAMES[p])),
    ...customList.map((ca) => h('button', { type: 'button', class: 'ew-pill custom-pill', title: `Mention @${ca.handle}${ca.jobTitle ? ' · ' + ca.jobTitle : ''}`, onclick: () => insertMention(ca.handle) }, emojiNode(ca.emoji || '🤖'), `@${ca.handle}`)),
    ...AGENTS.filter((p) => !roster.includes(p) && p !== 'maestro').map((p) => h('button', { type: 'button', class: 'ew-pill add', title: `Add ${NAMES[p]} to #${currentTitle()}`, onclick: () => changeAgent('add-agent', p) }, seatFaceImg(p), `+ ${NAMES[p]}`)));
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

// ---------- composer "+" picker: agents, connectors, plugins, upload, web search ----------
// One picker for both composers (channel + agent chat); the pure model in
// composer-picker.mjs decides what can be attached and how it travels.
// The model is AGENTS FIRST: the registry facts load once, and each
// render builds the model for the agent that composer is talking to
// (that agent's own group leads the six), or with no agent in context
// (the desk, an unaddressed channel), where no group leads.
const PICKER_IDS = {
  channel: { panel: 'ew-picker', chips: 'ew-attach-chips' },
  cli: { panel: 'ew-cli-picker', chips: 'ew-cli-attach-chips' },
};

// Which agent a composer is talking to, in workspace agent keys — or
// null for the shared picker. Pure, so it is unit tested: the Agent Chat
// pane talks to its picked agent ('maestro' is the human's own seat, so
// it gets the shared model); a private room talks to the room's agent; a
// channel talks to the agent its draft addresses (@name), and the desk —
// where Maestro dispatches to everyone — always keeps the shared model.
export function pickerAgentContext({ which, cliProvider = null, channel = null, draft = '' } = {}) {
  if (which === 'cli') return cliProvider && cliProvider !== 'maestro' ? cliProvider : null;
  if (!channel || isDeskChannel(channel)) return null;
  if (channel.kind === 'agent') {
    const p = String(channel.slug ?? '').replace(/^agent-/, '');
    return AGENTS.includes(p) && p !== 'maestro' ? p : null;
  }
  const { providers } = mentions(draft);
  return providers.find((p) => p !== 'maestro') ?? null;
}

async function loadPickerData() {
  if (ws.pickerFacts) return ws.pickerFacts;
  const [c, p, pl, tc, pr] = await Promise.allSettled([ws.ctx.api('/api/admin/cora/connectors'), ws.ctx.api('/api/admin/provider-connections'), ws.ctx.api('/api/admin/plugins'), ws.ctx.api('/api/admin/tool-connections'), ws.ctx.api('/api/admin/envoy/runner/presence')]);
  ws.pickerFacts = {
    connectors: c.status === 'fulfilled' ? c.value ?? {} : {}, providers: p.status === 'fulfilled' ? p.value ?? {} : {}, plugins: pl.status === 'fulfilled' ? pl.value ?? {} : {},
    toolConnections: tc.status === 'fulfilled' ? tc.value?.connections ?? [] : null,
    presence: pr.status === 'fulfilled' ? pr.value?.presence ?? [] : null,
  };
  return ws.pickerFacts;
}

function currentPickerModel(which) {
  const agent = pickerAgentContext({
    which,
    cliProvider: ws.cli.provider,
    channel: openChannel(),
    draft: $(which === 'cli' ? 'ew-cli-input' : 'maestro-input')?.value ?? '',
  });
  return pickerModel({ ...ws.pickerFacts, agent });
}
function renderAttachChips(which) {
  const box = $(PICKER_IDS[which].chips); if (!box) return;
  const list = ws.attach[which];
  const chips = list.map((a) => h('span', { class: `ew-chip ${a.kind}` },
    a.kind === 'skill' ? `/${a.name}` : a.name,
    h('button', { type: 'button', class: 'ew-chip-x', title: `Remove ${a.kind === 'skill' ? `the ${a.name} skill` : a.name}`, 'aria-label': `Remove ${a.kind === 'skill' ? `skill ${a.name}` : a.name}`, onclick: () => { ws.attach[which] = removeAttachment(ws.attach[which], a); renderAttachChips(which); if (ws.pickerFor === which) renderPicker(which); } }, '×')));
  // The web-search toggle rides the next message like an attachment, so
  // it shows as a chip while it is on — and leaves with the send (or ×).
  if (ws.webSearch[which]) {
    chips.push(h('span', { class: 'ew-chip web-search' },
      'Web search',
      h('button', { type: 'button', class: 'ew-chip-x', title: 'Turn web search off for this message', 'aria-label': 'Turn web search off', onclick: () => { ws.webSearch[which] = false; renderAttachChips(which); if (ws.pickerFor === which) renderPicker(which); } }, '×')));
  }
  box.hidden = !chips.length;
  box.replaceChildren(...chips);
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
  if (!ws.pickerFacts) await loadPickerData().catch(() => {});
  if (ws.pickerFor !== which) return; // closed while the registry loaded
  const model = ws.pickerFacts ? currentPickerModel(which) : pickerModel();
  const attached = new Set(ws.attach[which].map(attachmentKey));
  const groups = [];
  for (const g of model.groups) {
    if (g.id === 'agent') {
      // One of the six agents' own groups: its own connection as a
      // status row (never an attachment), its by-name skills, and the
      // bridge plugins it can be handed — each with its truthful state
      // from the model.
      const nameInput = h('input', { class: 'ew-picker-input', maxlength: 64, placeholder: 'Skill name — e.g. deploy, or plugin:skill', 'aria-label': 'Skill name' });
      const note = h('p', { class: 'ew-note' });
      const add = h('button', { type: 'button', class: 'ew-btn sm', onclick: () => {
        const r = addAttachment(ws.attach[which], { kind: 'skill', name: nameInput.value });
        if (!r.added) { note.textContent = r.reason; return; }
        ws.attach[which] = r.list; note.textContent = '';
        renderAttachChips(which); renderPicker(which);
      } }, 'Attach skill');
      const rows = g.items.map((item) => {
        if (item.kind === 'provider') {
          return h('button', { type: 'button', class: 'ew-picker-row', disabled: true, title: `${item.name} is the agent you are talking to — this is its own connection` },
            h('span', {}, item.name), h('span', { class: 'ew-picker-kind' }, item.kindLabel), h('span', { class: `ew-picker-state ${item.state === 'connected' ? 'on' : 'off'}` }, item.stateLabel));
        }
        const on = attached.has(`plugin:${item.name}`);
        return h('button', { type: 'button', class: `ew-picker-row${on ? ' on' : ''}`, title: on ? `Remove ${item.name} from this message` : `Attach ${item.name} to this message`, onclick: () => {
          if (on) { ws.attach[which] = removeAttachment(ws.attach[which], { kind: 'plugin', name: item.name }); renderAttachChips(which); renderPicker(which); return; }
          const r = addAttachment(ws.attach[which], { kind: 'plugin', name: item.name }, { catalog: g.items });
          if (r.added) { ws.attach[which] = r.list; renderAttachChips(which); renderPicker(which); }
        } }, h('span', {}, item.name), h('span', { class: 'ew-picker-kind' }, item.brings), h('span', { class: `ew-picker-state ${on ? 'on' : 'off'}` }, on ? 'Attached' : item.stateLabel));
      });
      groups.push(h('div', { class: 'ew-picker-group' }, h('div', { class: 'ew-subhead' }, g.title.toUpperCase()), h('p', { class: 'ew-note' }, g.note), h('div', { class: 'ew-row' }, nameInput, add), note, ...rows));
    } else if (g.id === 'connectors') {
      const rows = g.items.map((item) => {
        const on = attached.has(`connector:${item.key}`);
        return h('button', { type: 'button', class: `ew-picker-row${on ? ' on' : ''}`, disabled: item.connected ? null : true, title: item.connected ? (on ? `Remove ${item.name} from this message` : `Attach ${item.name} to this message — it rides as a note for the agent`) : `${item.name}: ${item.statusText ?? 'Not connected'}`, onclick: () => {
          if (on) { ws.attach[which] = removeAttachment(ws.attach[which], { kind: 'connector', key: item.key }); renderAttachChips(which); renderPicker(which); return; }
          const r = addAttachment(ws.attach[which], { kind: 'connector', key: item.key }, { catalog: g.items });
          if (r.added) { ws.attach[which] = r.list; renderAttachChips(which); renderPicker(which); }
        } }, h('span', {}, item.name), h('span', { class: 'ew-picker-kind' }, item.kindLabel), h('span', { class: `ew-picker-state ${item.connected ? 'on' : 'off'}` }, on ? 'Attached' : item.stateLabel));
      });
      groups.push(h('div', { class: 'ew-picker-group' }, h('div', { class: 'ew-subhead' }, 'CONNECTORS'), ...(g.note ? [h('p', { class: 'ew-note' }, g.note)] : []), ...(rows.length ? rows : [h('p', { class: 'ew-note' }, 'No connectors in the registry.')])));
    } else if (g.id === 'plugins') {
      const rows = g.items.map((item) => {
        const on = attached.has(`plugin:${item.name}`);
        return h('button', { type: 'button', class: `ew-picker-row${on ? ' on' : ''}`, title: on ? `Remove ${item.name} from this message` : `Attach ${item.name} to this message`, onclick: () => {
          if (on) { ws.attach[which] = removeAttachment(ws.attach[which], { kind: 'plugin', name: item.name }); renderAttachChips(which); renderPicker(which); return; }
          const r = addAttachment(ws.attach[which], { kind: 'plugin', name: item.name }, { catalog: g.items });
          if (r.added) { ws.attach[which] = r.list; renderAttachChips(which); renderPicker(which); }
        } }, h('span', {}, item.name), h('span', { class: 'ew-picker-kind' }, item.brings), h('span', { class: `ew-picker-state ${on ? 'on' : 'off'}` }, on ? 'Attached' : item.stateLabel));
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
    } else if (g.id === 'web-search') {
      const on = ws.webSearch[which] === true;
      const row = h('button', { type: 'button', class: `ew-picker-row${on ? ' on' : ''}`, title: on ? 'Web search is on for this message — tap to turn it off' : 'Turn web search on for this message', onclick: () => {
        ws.webSearch[which] = !on;
        renderAttachChips(which); renderPicker(which);
      } }, h('span', {}, 'Web search'), h('span', { class: 'ew-picker-kind' }, 'per message'), h('span', { class: `ew-picker-state ${on ? 'on' : 'off'}` }, on ? 'On' : 'Off'));
      groups.push(h('div', { class: 'ew-picker-group' }, h('div', { class: 'ew-subhead' }, 'WEB SEARCH'), h('p', { class: 'ew-note' }, g.note), row));
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
    loadReactions(); // throttled — a reaction lands without any message change
    return;
  }
  ws.sig = sig; ws.messages = messages;
  renderMessages(); renderAgents(); renderCliThread();
  loadReactions({ force: true });
}
function whoOf(m) {
  const me = ws.ctx.state.actor?.subject;
  if (m.authorKind === 'human' && m.authorSubject === me) return { name: 'You', kind: 'me', authorEmoji: m.authorEmoji ?? null };
  if (m.agentProvider || m.authorSubject?.startsWith('agent:')) {
    const handle = m.authorSubject?.startsWith('agent:') ? m.authorSubject.slice(6) : m.agentProvider;
    const custom = m.metadata?.customAgent || (ws.config?.customAgents ?? []).find((a) => a.handle === handle) || null;
    return { name: m.authorName || custom?.name || 'Agent', kind: 'agent', provider: m.agentProvider || handle, custom };
  }
  if (m.authorSubject?.endsWith(':bridge')) return { name: 'PC bridge', kind: 'agent', provider: null };
  if (m.source === 'discord') return { name: m.authorName || 'Discord member', kind: 'discord' };
  if (m.source === 'slack') return { name: m.authorName || 'Slack member', kind: 'slack' };
  return { name: m.authorName || 'Member', kind: 'human', authorEmoji: m.authorEmoji ?? null };
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
  // Agent replies open their links in a full tab: a build reveal is one
  // click at full size and the desk stays put (navigate() gives Helmian's
  // own pages the same treatment). Other links keep the bench browser.
  const onAgentLink = (url) => { window.open(url, '_blank', 'noopener'); };
  const onCanvas = (code) => { openBench('canvas'); setCanvas(code); };
  // Seat motion for this render (emoji bite 4): each seat's live,
  // non-terminal stage in this channel, from the same cues whose
  // activity rows land below — a working seat's face moves wherever
  // it stands in the stream, and stills the moment its stage turns.
  const cues = activityCues(ws.activity, ws.channelId, ws.config?.customAgents);
  const liveMotion = new Map();
  for (const c of cues) if (!ACTIVITY_TERMINAL_STAGES.has(c.event.stage)) liveMotion.set(c.provider, c.event.stage);
  for (const m of ws.messages) {
    const day = dayLabel(m.createdAt);
    if (day !== prevDay) { out.push(h('div', { class: 'ew-day' }, day)); prevDay = day; prev = null; }
    if (m.authorKind === 'system') { out.push(h('div', { class: 'ew-notice' }, h('span', {}, m.body))); prev = null; continue; }
    const who = whoOf(m);
    const cont = prev && prev.authorSubject === m.authorSubject && new Date(m.createdAt) - new Date(prev.createdAt) < 5 * 60_000;
    const motionCls = who.kind === 'agent' ? activityMotionClass(liveMotion.get(who.custom ? who.custom.handle : who.provider)) : '';
    const avatar = who.kind === 'agent'
      ? (who.custom ? h('div', { class: `ew-avatar emoji-ava${motionCls ? ` ${motionCls}` : ''}` }, emojiNode(who.custom.emoji || '🤖')) : seatAvatar(who.provider, liveMotion.get(who.provider) ?? null))
      : (who.authorEmoji ? h('div', { class: 'ew-avatar emoji-ava' }, emojiNode(who.authorEmoji)) : h('div', { class: `ew-avatar${who.kind === 'discord' ? ' discord' : who.kind === 'slack' ? ' slack' : ''}` }, who.name.slice(0, 1).toUpperCase()));
    const slackChannel = who.kind === 'slack' && m.metadata?.source?.channelName ? ` · #${m.metadata.source.channelName}` : '';
    const src = who.kind === 'agent'
      ? h('span', { class: 'ew-src agent' }, who.custom?.jobTitle ? `AGENT · ${who.custom.jobTitle}` : 'AGENT')
      : who.kind === 'discord' ? h('span', { class: 'ew-src discord' }, 'DISCORD') : who.kind === 'slack' ? h('span', { class: 'ew-src slack' }, `SLACK${slackChannel}`) : null;
    // In the desk, a manager send carries its dispatch line; agent
    // replies render as themselves, under their own names, as anywhere.
    const dispatch = desk && m.authorKind === 'human' ? deskDispatchLine(m) : null;
    out.push(h('div', { class: `ew-msg${cont ? ' cont' : ''}${m._pending ? ' pending' : ''}`, 'data-id': m.id }, avatar,
      h('div', {}, h('div', { class: 'ew-meta' }, h('strong', { class: who.kind === 'agent' ? 'agent' : '' }, who.name), src, h('time', { datetime: m.createdAt }, clock(m.createdAt))),
        h('div', { class: 'ew-body' }, renderBody(m.body, who.kind === 'agent' ? { onLink: onAgentLink, linkTitle: 'Open in a new tab', onCanvas } : { onLink, onCanvas })),
        h('div', { class: 'ew-reactions' }, ...reactionChipKids(m.id)), dispatch),
      m._pending ? null : reactionAddButton(m)));
    prev = m;
  }
  // Real runner activity rows (activity desk bite): one per seat whose
  // newest unexpired event for this channel is live, sitting where its
  // reply will land. Events or nothing — the age-derived "X is
  // answering…" cue that stood here was removed 2026-11-04 on Troy's
  // order; it lit seats from message age alone, job or no job.
  for (const cue of cues) out.push(activityRow(cue.provider, cue.event, ws.config?.customAgents));
  if (!ws.messages.length) out.push(h('div', { class: 'ew-empty' }, desk
    ? 'This is your desk. Send a dispatch — @name for one agent, @all for everyone, or name nobody and it goes to everyone on the desk.'
    : (ws.config?.agents?.length ? 'Say hello. Name an agent with @ to get an answer — a message that names nobody is just posted, for people.' : 'No messages yet. Say hello, or add an agent to make this an agent chat.')));
  box.replaceChildren(...out);
  if (atBottom || ws.messages.at(-1)?._pending || ws.messages.at(-1)?.authorSubject === ws.ctx.state.actor?.subject) box.scrollTop = box.scrollHeight;
}

// ---------- message reactions (emoji bites 2 + 3) ----------
// Bite 2's store owns the data (route /api/admin/envoy/message-reactions:
// a bulk GET summary per message, a POST toggle that answers with the
// message's full new summary). Unicode stays the data there too — the
// store keeps bite 1's SLUG, the desk renders the slug's own art, and a
// slug this build ships no art for never renders as a broken image.
// Live updates: the desk has no Ably client (the server's `reaction`
// mirror event has no subscriber here), so agent reactions land via the
// message poll — loadMessages refreshes the summaries on a throttle
// even when the message list itself did not change.
const REACTIONS_REFRESH_MS = 5000;
const REACTION_CHARS = Object.freeze(Object.fromEntries(Object.entries(EMOJI_MAP).map(([ch, slug]) => [slug, ch])));
export function reactionChar(slug) { return REACTION_CHARS[slug] ?? null; }
export function reactionActorLabel(actors = []) {
  return (actors ?? []).map((a) => a?.name || (a?.provider ? (NAMES[a.provider] ?? a.provider) : null) || (a?.kind === 'agent' ? 'Agent' : 'Member')).join(', ');
}
// One message's chip model from a bite-2 summary entry list: server
// order preserved, unknown slugs and empty counts dropped, the slugs
// the signed-in member has on flagged as mine.
export function reactionChipModel(summary = [], mine = []) {
  const mineSet = new Set(mine ?? []);
  const out = [];
  for (const e of summary ?? []) {
    const char = reactionChar(e?.emoji);
    if (!char || !(e?.count > 0)) continue;
    out.push({ slug: e.emoji, char, count: e.count, mine: mineSet.has(e.emoji), actors: reactionActorLabel(e.actors) });
  }
  return out;
}
// Fold a POST toggle response into the stored summaries: the response
// carries the message's full new summary plus the caller's own state
// for the toggled slug, so both maps move in one step. Pure — the
// input state is not mutated.
export function mergeReactionPost(state, body) {
  const byId = { ...(state?.byId ?? {}) };
  const mine = { ...(state?.mine ?? {}) };
  if (body?.messageId) {
    byId[body.messageId] = Array.isArray(body.reactions) ? body.reactions : (byId[body.messageId] ?? []);
    const cur = new Set(mine[body.messageId] ?? []);
    if (body.emoji) { if (body.reacted) cur.add(body.emoji); else cur.delete(body.emoji); }
    mine[body.messageId] = [...cur];
  }
  return { byId, mine };
}
const reactionFace = (slug) => h('img', { class: 'hx-emoji ew-rchip-face', src: emojiAssetUrl(slug, { still: emojiStill() }), alt: '', 'aria-hidden': 'true', loading: 'lazy' });
function reactionChipKids(messageId) {
  if (ws.reactions.channelId !== ws.channelId) return [];
  return reactionChipModel(ws.reactions.byId[messageId], ws.reactions.mine[messageId]).map((c) => h('button', {
    type: 'button', class: `ew-rchip${c.mine ? ' mine' : ''}`,
    title: c.actors || 'Reaction', 'aria-pressed': String(c.mine),
    'aria-label': `${c.char} reaction, ${c.count} ${c.count === 1 ? 'person' : 'people'}${c.mine ? ', including you' : ''} — activate to ${c.mine ? 'remove yours' : 'add yours'}`,
    onclick: () => toggleReaction(messageId, c.slug),
  }, reactionFace(c.slug), h('span', { class: 'ew-rchip-count' }, String(c.count))));
}
function reactionAddButton(m) {
  return h('button', { type: 'button', class: 'ew-react-add', title: 'Add a reaction', 'aria-label': 'Add a reaction', 'aria-haspopup': 'dialog',
    onclick: (e) => openReactionPicker(m.id, e.currentTarget) },
    emojiNode('🙂'), h('span', { class: 'ew-react-plus', 'aria-hidden': 'true' }, '+'));
}
// Patch every visible message's chip row in place from the store —
// the message DOM itself is never rebuilt for a reaction change.
function syncReactionChips() {
  const box = $('ew-messages'); if (!box) return;
  for (const el of box.querySelectorAll('.ew-msg[data-id]')) {
    const row = el.querySelector('.ew-reactions');
    if (row) row.replaceChildren(...reactionChipKids(el.dataset.id));
  }
}
async function loadReactions({ force = false } = {}) {
  const channelId = ws.channelId; if (!channelId) return;
  const now = Date.now();
  if (!force && ws.reactions.channelId === channelId && now - ws.reactionsStamp < REACTIONS_REFRESH_MS) return;
  const ids = ws.messages.map((m) => m.id).filter((id) => id && !id.startsWith('pending-'));
  if (!ids.length) return;
  ws.reactionsStamp = now;
  try {
    const body = await ws.ctx.api(`/api/admin/envoy/message-reactions?channel_id=${encodeURIComponent(channelId)}&message_ids=${encodeURIComponent(ids.join(','))}`);
    if (channelId !== ws.channelId) return;
    ws.reactions = { channelId, byId: body.reactions ?? {}, mine: body.mine ?? {} };
    syncReactionChips();
  } catch { /* reactions decorate the message list — a failed read keeps the last good chips and never toasts */ }
}
async function toggleReaction(messageId, slug) {
  const channelId = ws.channelId; if (!channelId || !messageId || !slug) return;
  try {
    const body = await ws.ctx.post('/api/admin/envoy/message-reactions', { channelId, messageId, emoji: slug });
    if (channelId !== ws.channelId) return;
    const merged = mergeReactionPost(ws.reactions, body);
    ws.reactions = { channelId, byId: merged.byId, mine: merged.mine };
    syncReactionChips();
  } catch { ws.ctx.toast('That reaction did not land.'); }
}
// The bite-1 emoji grid (ew-emoji-grid / ew-emoji-btn, the same art and
// classes as the agent-face grid) as a pick-one popover anchored to the
// message's add control. One instance, reused; closes on pick, Escape,
// or an outside press.
let reactionPop = null;
function closeReactionPicker() {
  ws.reactionPopFor = null;
  if (reactionPop) reactionPop.hidden = true;
}
function openReactionPicker(messageId, anchor) {
  if (ws.reactionPopFor === messageId && reactionPop && !reactionPop.hidden) { closeReactionPicker(); return; }
  ws.reactionPopFor = messageId;
  if (!reactionPop) {
    reactionPop = h('div', { class: 'ew-react-pop', role: 'dialog', 'aria-label': 'Pick a reaction', hidden: true });
    document.body.append(reactionPop);
    document.addEventListener('pointerdown', (e) => { if (reactionPop && !reactionPop.hidden && !reactionPop.contains(e.target)) closeReactionPicker(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeReactionPicker(); });
  }
  const mine = new Set(ws.reactions.mine[messageId] ?? []);
  const grid = h('div', { class: 'ew-emoji-grid ew-react-grid', role: 'group', 'aria-label': 'Emoji' },
    ...Object.entries(EMOJI_MAP).map(([ch, slug]) => h('button', { type: 'button', class: `ew-emoji-btn${mine.has(slug) ? ' on' : ''}`, title: slug, 'aria-label': `React with ${slug}`, 'aria-pressed': String(mine.has(slug)), onclick: () => { closeReactionPicker(); toggleReaction(messageId, slug); } }, emojiNode(ch))));
  reactionPop.replaceChildren(
    h('div', { class: 'ew-react-pop-head' }, h('span', {}, 'React'), h('button', { type: 'button', class: 'ew-chip-x', 'aria-label': 'Close reaction picker', onclick: closeReactionPicker }, '×')),
    grid);
  reactionPop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = Math.min(324, window.innerWidth - 16);
  reactionPop.style.width = `${w}px`;
  const popH = reactionPop.offsetHeight;
  reactionPop.style.top = `${r.bottom + 6 + popH <= window.innerHeight ? r.bottom + 6 : Math.max(8, r.top - 6 - popH)}px`;
  reactionPop.style.left = `${Math.min(Math.max(8, r.left), window.innerWidth - w - 8)}px`;
}
const grow = () => { const t = $('maestro-input'); t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 200)}px`; };
async function send(e) {
  e?.preventDefault?.();
  const box = $('maestro-input'); const body = box.value.trim();
  if (!body || !ws.channelId) return;
  const key = crypto.randomUUID();
  const req = buildMessageRequest({ channelId: ws.channelId, body, idempotencyKey: key, attachments: ws.attach.channel, webSearch: ws.webSearch.channel });
  const btn = $('maestro-send'); btn.disabled = true;
  ws.messages = [...ws.messages, { id: `pending-${key}`, authorKind: 'human', authorSubject: ws.ctx.state.actor?.subject, body: req.payload.body, createdAt: new Date().toISOString(), _pending: true }];
  renderMessages();
  box.value = ''; grow(); closeSlashMenu();
  try { await ws.ctx.post('/api/admin/envoy/messages', req.payload); ws.attach.channel = []; ws.webSearch.channel = false; renderAttachChips('channel'); closePicker(); ws.sig = null; await loadMessages(); loadPresence().catch(() => {}); }
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
// Maestro has no chip and no room here: Maestro is the human's manager
// seat (the channel list), never a chat agent (Bite 2).
const CLI_KEY_BY_PROVIDER = { Claude: 'claude', ChatGPT: 'openai', Grok: 'grok', Gemini: 'gemini' };
function cliTarget() {
  const s = ws.cli.sessions.find((x) => x.id === ws.cli.activeId);
  if (s) return { key: CLI_KEY_BY_PROVIDER[s.provider] ?? 'claude', session: s };
  return { key: ws.cli.provider, session: null };
}
function renderCliChips() {
  const active = cliTarget().key;
  $('ew-cli-chips').replaceChildren(...AGENTS.filter((p) => p !== 'maestro').map((p) => h('button', { type: 'button', class: `ew-pill${p === active ? ' on' : ''}`, title: `Show your conversation with ${NAMES[p]}`, onclick: () => pickCliProvider(p) }, seatFaceImg(p), NAMES[p])));
}
function renderCliTo() {
  const { key, session } = cliTarget();
  $('ew-cli-to').textContent = session ? `${session.provider} · your private room with ${NAMES[key]}` : `${NAMES[key]} · your private room`;
  $('ew-cli-input').placeholder = `Prompt ${NAMES[key]}...`;
}
function renderCliSessions() {
  const box = $('ew-cli-sessions');
  if (!ws.cli.sessions.length) { box.replaceChildren(h('p', { class: 'ew-note' }, 'No sessions yet. Pick an agent above to start one.')); return; }
  box.replaceChildren(...ws.cli.sessions.map((s) => {
    const key = CLI_KEY_BY_PROVIDER[s.provider] ?? 'claude';
    const prog = s.progress && s.progress.total ? `${s.progress.done}/${s.progress.total} steps${s.progress.current ? ` · now: ${s.progress.current}` : ''}` : clock(s.createdAt);
    return h('button', { type: 'button', class: `ew-cli-session${s.id === ws.cli.activeId ? ' active' : ''}`, title: `${s.name} (${s.provider})`, onclick: () => selectCliSession(s.id) },
      seatFaceImg(key), h('strong', {}, s.name), h('span', { class: 'meta' }, `${s.provider} · ${prog}`));
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
// fetched once per room.
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
// The room's live activity renders inside renderCliThread below, from
// the same runner activity feed as the desk's (see the activity
// helpers above). The age-derived roomWorking() that fed this pane's
// "answering" cue and the fast-poll decision was removed 2026-11-04 on
// Troy's order, together with the cue itself; the fast-poll decision
// now reads the feed (see the mount poll).

// The pane's own conversation stream: the picked agent's room, rendered
// where the human is looking instead of inside a shared channel.
// Signature-guarded like the message list, so calm polls don't rebuild it.
function renderCliThread() {
  const box = $('ew-cli-thread'); if (!box) return;
  const { key } = cliTarget();
  const inRoom = ws.cli.roomFor === key && Boolean(ws.cli.roomId);
  const list = inRoom ? agentRoomThread(ws.cli.roomMessages) : [];
  const cue = inRoom ? activityCue(ws.activity, key, ws.cli.roomId) : null;
  const sig = `${key}|${ws.cli.roomId ?? ''}|${list.map((m) => m.id).join(',')}|${cue ? `${cue.stage}:${activityElapsed(cue)}` : ''}`;
  if (sig === ws.cli.threadSig) return;
  ws.cli.threadSig = sig;
  // The room seat's avatar motion (emoji bite 4): its live cue stage
  // for this room, terminal linger excluded — same feed, same gate
  // as the channel stream.
  const roomMotion = cue && !ACTIVITY_TERMINAL_STAGES.has(cue.stage) ? cue.stage : null;
  if (!list.length) {
    box.replaceChildren(...(cue
      ? [activityRow(key, cue, ws.config?.customAgents)]
      : [h('p', { class: 'ew-note' }, inRoom
        ? `Nothing with ${NAMES[key]} yet — send a prompt below and the conversation shows up here, in ${NAMES[key]}'s own room.`
        : `Opening your room with ${NAMES[key]}…`)]));
    return;
  }
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const onLink = (url) => { openBench('browser'); navigate(url); };
  // Agent replies open their links in a full tab: a build reveal is one
  // click at full size and the desk stays put (navigate() gives Helmian's
  // own pages the same treatment). Other links keep the bench browser.
  const onAgentLink = (url) => { window.open(url, '_blank', 'noopener'); };
  const onCanvas = (code) => { openBench('canvas'); setCanvas(code); };
  const out = [];
  let prev = null;
  for (const m of list) {
    const who = whoOf(m);
    const cont = prev && prev.authorSubject === m.authorSubject && new Date(m.createdAt) - new Date(prev.createdAt) < 5 * 60_000;
    const threadMotionCls = who.kind === 'agent' ? activityMotionClass((who.custom ? who.custom.handle : who.provider) === key ? roomMotion : null) : '';
    const avatar = who.kind === 'agent' ? (who.custom ? h('div', { class: `ew-avatar emoji-ava${threadMotionCls ? ` ${threadMotionCls}` : ''}` }, emojiNode(who.custom.emoji || '🤖')) : seatAvatar(who.provider, who.provider === key ? roomMotion : null)) : (who.authorEmoji ? h('div', { class: 'ew-avatar emoji-ava' }, emojiNode(who.authorEmoji)) : h('div', { class: 'ew-avatar' }, who.name.slice(0, 1).toUpperCase()));
    const src = who.kind === 'agent' ? h('span', { class: 'ew-src agent' }, 'AGENT') : null;
    out.push(h('div', { class: `ew-msg${cont ? ' cont' : ''}${m._pending ? ' pending' : ''}` }, avatar,
      h('div', {}, h('div', { class: 'ew-meta' }, h('strong', { class: who.kind === 'agent' ? 'agent' : '' }, who.name), src, h('time', { datetime: m.createdAt }, clock(m.createdAt))),
        h('div', { class: 'ew-body' }, renderBody(m.body, who.kind === 'agent' ? { onLink: onAgentLink, linkTitle: 'Open in a new tab', onCanvas } : { onLink, onCanvas })))));
    prev = m;
  }
  // The room seat's real activity (activity desk bite): its newest
  // unexpired event for this room renders here, or nothing at all —
  // the age-derived "answering" cue that stood here was removed
  // 2026-11-04 on Troy's order.
  if (cue) out.push(activityRow(key, cue, ws.config?.customAgents));
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
  const req = buildMessageRequest({ channelId: roomId, body: raw, idempotencyKey: crypto.randomUUID(), attachments: ws.attach.cli, webSearch: ws.webSearch.cli });
  const btn = $('ew-cli-send'); btn.disabled = true;
  try {
    await ws.ctx.post('/api/admin/envoy/messages', req.payload);
    box.value = ''; growCli(); closeSlashMenu(); ws.attach.cli = []; ws.webSearch.cli = false; renderAttachChips('cli'); if (ws.pickerFor === 'cli') closePicker();
    await loadCliRoom();
    loadPresence().catch(() => {});
  } catch { ws.ctx.toast('Not sent. Your prompt is still in the box.'); }
  finally { btn.disabled = false; }
}

// ---------- Discord + Slack link ----------
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
async function linkSlack() {
  const s = ws.config?.slack;
  const admin = ['owner', 'admin'].includes(ws.ctx.state.actor?.role);
  const ch = ws.channels.find((c) => c.id === ws.channelId);
  if (s) {
    openModal('Slack link', [
      h('p', {}, `#${ch?.title} mirrors with Slack #${s.channelName || s.channelId}${s.teamName ? ` in ${s.teamName}` : ''}. Messages and agent replies go both ways.`),
      admin ? h('div', { class: 'ew-row' }, h('span', { class: 'ew-spacer' }), h('button', { type: 'button', class: 'ew-btn ghost', onclick: async () => { try { await ws.ctx.post('/api/admin/envoy/channel-config', { action: 'unlink-slack', channelId: ws.channelId }); closeModal(); await loadConfig(); await loadMessages(); } catch { ws.ctx.toast('Could not unlink.'); } } }, 'Unlink')) : null,
    ]);
    return;
  }
  if (!admin) return;
  let res;
  try { res = await ws.ctx.post('/api/admin/envoy/channel-config', { action: 'link-slack', channelId: ws.channelId }); }
  catch { ws.ctx.toast('Could not start the Slack link.'); return; }
  const bot = ws.slackBot;
  const copy = h('button', { type: 'button', class: 'ew-btn sm', onclick: async () => { try { await navigator.clipboard.writeText(res.linkCommand); ws.ctx.toast('Copied', 'ok'); } catch {} } }, 'Copy command');
  const status = h('p', { class: 'muted sm' }, 'Waiting for the message in Slack… (code works for 15 minutes)');
  openModal('Link Slack', [
    h('ol', { class: 'ew-steps' },
      h('li', {}, bot?.configured ? h('span', {}, 'Make sure the Helmian app is installed in your Slack workspace and added to the channel you want to link.') : h('span', {}, 'The Helmian Slack bot is not set up on this workspace yet, so the code will wait until it is.')),
      h('li', {}, 'In the Slack channel you want to link, post:'),
    ),
    h('div', { class: 'ew-code' }, res.linkCommand),
    h('div', { class: 'ew-row' }, copy, h('span', { class: 'ew-spacer' })),
    h('p', { class: 'muted sm' }, 'The code itself is the key: anyone who can post in that channel can use it, so keep it private until it expires.'),
    status,
  ]);
  ws.linkPoll = setInterval(async () => {
    await loadConfig();
    if (ws.config?.slack) { clearInterval(ws.linkPoll); ws.linkPoll = null; status.textContent = `Linked to Slack #${ws.config.slack.channelName || ws.config.slack.channelId}.`; status.className = 'sm'; await loadMessages(); setTimeout(closeModal, 1500); }
  }, 3000);
}

async function removeCustomAgent(handle) {
  if (!handle || !ws.channelId) return;
  try {
    const body = await ws.ctx.post('/api/admin/envoy/channel-config', { action: 'remove-custom-agent', channelId: ws.channelId, handle });
    ws.config = body.config;
    await loadConfig(); await loadMessages();
    ws.ctx.toast(`Retired @${handle}`, 'ok');
  } catch (e) {
    ws.ctx.toast(e?.body?.code === 'ENVOY_ROLE_FORBIDDEN' ? 'Auditors cannot retire agents.' : 'Could not retire agent.');
  }
}

// The create-agent dialog's connect step (owner's law, 2026-11-01):
// the shared ConnectFields component for the provider currently picked
// — an email field and a password field right in the dialog. The dialog
// calls this again on every provider switch, so the fields always name
// the provider they will connect.
export function dialogConnectFields(provider, post, doc) {
  return createConnectFields({ provider, post, doc });
}

// The create-custom-agent request body. There is no seat-mode choice to
// send: authMode carries the one road's single value, 'password_session'
// (the auth mode sql/063 defined), whatever the dialog showed before.
export function customAgentCreateBody({ channelId, handle, name, emoji, provider, jobTitle, jobPrompt }) {
  return {
    action: 'create-custom-agent',
    channelId,
    agent: { handle, name, emoji, provider, authMode: 'password_session', jobTitle, jobPrompt },
  };
}

function openCreateAgentModal() {
  if (!ws.channelId) { ws.ctx.toast('Select a channel first.'); return; }
  let pickedEmoji = '🦀';
  const emojiInput = h('input', { class: 'ew-input sm ew-emoji-input', maxlength: 4, value: pickedEmoji, 'aria-label': 'Custom emoji' });
  const emojiGrid = h('div', { class: 'ew-emoji-grid', role: 'radiogroup', 'aria-label': 'Pick an agent face' });
  const drawEmojis = () => {
    emojiGrid.replaceChildren(...CUSTOM_AGENT_EMOJIS.map((em) => h('button', {
      type: 'button',
      class: `ew-emoji-btn${pickedEmoji === em ? ' on' : ''}`,
      'aria-checked': String(pickedEmoji === em),
      onclick: () => { pickedEmoji = em; emojiInput.value = em; drawEmojis(); },
    }, emojiNode(em))));
  };
  emojiInput.addEventListener('input', () => { const v = emojiInput.value.trim(); if (v) { pickedEmoji = v; drawEmojis(); } });
  drawEmojis();

  const nameInput = h('input', { id: 'ew-ca-name', placeholder: 'e.g. Rusty, Security Auditor, Buzz', maxlength: 40, required: true, 'aria-label': 'Agent name' });
  const handleInput = h('input', { id: 'ew-ca-handle', placeholder: 'e.g. rusty', maxlength: 24, required: true, 'aria-label': 'Agent @handle' });
  let handleTouched = false;
  handleInput.addEventListener('input', () => { handleTouched = true; });
  nameInput.addEventListener('input', () => {
    if (!handleTouched) {
      handleInput.value = nameInput.value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+/g, '-').slice(0, 20);
    }
  });

  const jobTitleInput = h('input', { id: 'ew-ca-job-title', placeholder: 'e.g. Senior Rust Borrow-Checker & Architect', maxlength: 80, 'aria-label': 'Job title' });
  const jobPromptInput = h('textarea', { id: 'ew-ca-job-prompt', rows: 3, placeholder: 'Define this agent\'s real job, personality, rules, and mission. They live and work by these instructions in this channel.', maxlength: 1200, 'aria-label': 'Job instructions' });
  const providerSelect = h('select', { id: 'ew-ca-provider', 'aria-label': 'AI provider' },
    ...CUSTOM_PROVIDER_OPTIONS.map(([val, label]) => h('option', { value: val }, label)));
  // The connect step: ConnectFields for the provider currently picked,
  // re-rendered on every provider switch. This replaces the old link
  // that sent the person to another page — the fields ARE the
  // connection, here.
  const connectBox = h('div', { class: 'ew-ca-connect', id: 'ew-ca-connect' });
  const renderConnectFields = () => {
    const fields = dialogConnectFields(providerSelect.value, (path, data) => ws.ctx.post(path, data));
    connectBox.replaceChildren(...(fields ? [fields] : []));
  };
  providerSelect.addEventListener('change', renderConnectFields);
  renderConnectFields();

  const statusNote = h('p', { class: 'muted sm ew-ca-note' }, 'Runs on the account you connect with your email and password.');

  const form = h('form', { class: 'ew-modal-form ew-ca-form', onsubmit: async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    const handle = handleInput.value.trim().toLowerCase().replace(/^@+/, '');
    if (!name || !handle) { statusNote.textContent = 'Enter a name and @handle.'; return; }
    try {
      const body = await ws.ctx.post('/api/admin/envoy/channel-config', customAgentCreateBody({
        channelId: ws.channelId,
        handle,
        name,
        emoji: emojiInput.value.trim() || pickedEmoji || '🤖',
        provider: providerSelect.value,
        jobTitle: jobTitleInput.value.trim(),
        jobPrompt: jobPromptInput.value.trim(),
      }));
      ws.config = body.config;
      closeModal();
      await loadConfig(); await loadMessages();
      ws.ctx.toast(`Created ${emojiInput.value.trim() || pickedEmoji} ${name} (@${handle})`, 'ok');
    } catch (err) {
      statusNote.textContent = err?.body?.message || 'Could not create custom agent. Check the @handle and try again.';
    }
  } },
    h('div', { class: 'ew-field' }, h('span', { class: 'ew-field-label' }, '1. Pick a smiley face or emoji'), h('div', { class: 'ew-row' }, emojiGrid, emojiInput)),
    h('div', { class: 'ew-grid-2' },
      h('label', { class: 'ew-field' }, h('span', { class: 'ew-field-label' }, '2. Agent name'), nameInput),
      h('label', { class: 'ew-field' }, h('span', { class: 'ew-field-label' }, '@handle (mention tag)'), handleInput)
    ),
    h('label', { class: 'ew-field' }, h('span', { class: 'ew-field-label' }, '3. Job title (badge shown in chat)'), jobTitleInput),
    h('label', { class: 'ew-field' }, h('span', { class: 'ew-field-label' }, '4. Real job instructions & system mission'), jobPromptInput),
    h('label', { class: 'ew-field' }, h('span', { class: 'ew-field-label' }, '5. AI Provider'), providerSelect),
    h('div', { class: 'ew-field' }, h('span', { class: 'ew-field-label' }, '6. Connect the account — email and password'), connectBox),
    statusNote,
    h('div', { class: 'ew-modal-actions' }, h('span', { class: 'ew-spacer' }), h('button', { type: 'button', class: 'ew-btn ghost', onclick: closeModal }, 'Cancel'), h('button', { type: 'submit', class: 'ew-btn primary' }, 'Spawn Agent'))
  );

  openModal('Create Custom Agent', [
    h('p', {}, 'Give your agent a face, a name, a real job, and pick which AI brain it runs on.'),
    form,
  ]);
  nameInput.focus();
}

async function stopDebateNow() {
  if (!ws.channelId) return;
  try {
    const body = await ws.ctx.post('/api/admin/envoy/channel-config', { action: 'stop-debate', channelId: ws.channelId });
    ws.config = body.config;
    renderHeader();
    await loadMessages();
    ws.ctx.toast('Free-Willy debate stopped.', 'ok');
  } catch {
    ws.ctx.toast('Could not stop debate.');
  }
}

function openDebateModal() {
  if (!ws.channelId) return;
  const currentOn = ws.config?.debateMode === 'free-willy';
  const currentTurns = ws.config?.maxRoundTurns ?? 10;
  const turnsInput = h('input', { type: 'number', min: 1, max: 50, value: String(currentTurns), style: 'width:84px;', 'aria-label': 'Max agent turns per round' });
  const save = async (mode) => {
    try {
      const body = await ws.ctx.post('/api/admin/envoy/channel-config', {
        action: 'set-debate-mode',
        channelId: ws.channelId,
        debateMode: mode,
        maxRoundTurns: Number.parseInt(turnsInput.value, 10) || 10,
      });
      ws.config = body.config;
      closeModal();
      await loadConfig(); await loadMessages();
      ws.ctx.toast(mode === 'free-willy' ? '🔥 Free-Willy Debate Mode is ON' : 'Debate mode set to @mention only', 'ok');
    } catch {
      ws.ctx.toast('Could not update debate mode.');
    }
  };
  openModal('🔥 Free-Willy Multi-Agent Debate Mode', [
    h('p', {}, 'When Free-Willy mode is ON, every agent in this channel (up to 50 built-in and custom agents) can jump in on a human message AND debate, critique, or build on each other\'s replies automatically.'),
    h('label', { class: 'ew-field' }, 'Max agent turns per human prompt (1–50 safety cap)', turnsInput),
    h('div', { class: 'ew-row' },
      currentOn ? h('button', { type: 'button', class: 'ew-btn danger sm', onclick: async () => { closeModal(); await stopDebateNow(); } }, '⏹ Stop Debate Now') : null,
      h('span', { class: 'ew-spacer' }),
      currentOn ? h('button', { type: 'button', class: 'ew-btn ghost sm', onclick: () => save('off') }, 'Turn Off (@mention only)') : null,
      h('button', { type: 'button', class: 'ew-btn primary sm', onclick: () => save('free-willy') }, currentOn ? 'Update Turn Limit' : '🔥 Turn On Free-Willy Mode')
    ),
  ]);
}

async function linkGithub() {
  if (!ws.channelId) return;
  const gh = ws.config?.github;
  const admin = ['owner', 'admin'].includes(ws.ctx.state.actor?.role);
  const ch = ws.channels.find((c) => c.id === ws.channelId);
  const webhookUrl = `${location.origin}/api/admin/webhooks/github`;
  const copyWebhook = h('button', { type: 'button', class: 'ew-btn ghost sm', onclick: async () => { try { await navigator.clipboard.writeText(webhookUrl); ws.ctx.toast('Webhook URL copied', 'ok'); } catch {} } }, 'Copy webhook URL');
  if (gh?.repo) {
    openModal('GitHub Repository Link', [
      h('p', {}, `#${ch?.title || 'channel'} is linked to GitHub repository ${gh.repo} (${gh.branch || 'all branches'}). Pushes, pull requests, merges, and issues stream right into this channel.`),
      h('div', { class: 'ew-field' }, 'GitHub Webhook URL (for repo settings)', h('div', { class: 'ew-code sm' }, webhookUrl)),
      h('div', { class: 'ew-row' }, copyWebhook, h('span', { class: 'ew-spacer' }),
        admin ? h('button', { type: 'button', class: 'ew-btn ghost sm', onclick: async () => {
          try { await ws.ctx.post('/api/admin/envoy/channel-config', { action: 'unlink-github', channelId: ws.channelId }); closeModal(); await loadConfig(); await loadMessages(); } catch { ws.ctx.toast('Could not unlink GitHub repo.'); }
        } }, 'Unlink repo') : null),
    ]);
    return;
  }
  if (!admin) { ws.ctx.toast('Only workspace owners and admins can link a GitHub repository.'); return; }
  const repoInput = h('input', { id: 'ew-gh-repo', placeholder: 'owner/repo (e.g. helmianlabs/helmian)', maxlength: 140, required: true, 'aria-label': 'GitHub repository owner/repo' });
  const quickRepos = h('div', { class: 'ew-row', style: 'flex-wrap:wrap;gap:6px;margin-bottom:8px;' },
    ...['helmianlabs/helmian', 'troy83352/faith-n-light-live', 'troy83352/dairyforge', 'troy83352/forge-tms'].map((r) =>
      h('button', { type: 'button', class: 'ew-btn ghost sm', onclick: () => { repoInput.value = r; } }, r)
    )
  );
  const branchInput = h('input', { id: 'ew-gh-branch', placeholder: 'main (leave blank for all branches)', maxlength: 80, 'aria-label': 'Branch filter' });
  const form = h('form', { class: 'ew-modal-form', onsubmit: async (e) => {
    e.preventDefault();
    const repo = repoInput.value.trim();
    if (!repo) return;
    try {
      await ws.ctx.post('/api/admin/envoy/channel-config', { action: 'link-github', channelId: ws.channelId, repo, branch: branchInput.value.trim() || '*' });
      closeModal();
      await loadConfig(); await loadMessages();
      ws.ctx.toast(`Linked GitHub ${repo}`, 'ok');
    } catch (err) {
      ws.ctx.toast(err?.body?.message || 'Enter a valid owner/repo (e.g. octocat/hello-world).');
    }
  } },
    h('label', { class: 'ew-field' }, 'GitHub Repository (owner/repo — click a quick repo or type any owner/repo)', quickRepos, repoInput),
    h('label', { class: 'ew-field' }, 'Branch filter (optional)', branchInput),
    h('div', { class: 'ew-field' }, 'Webhook endpoint (paste in GitHub → Settings → Webhooks)', h('div', { class: 'ew-code sm' }, webhookUrl)),
    h('div', { class: 'ew-row' }, copyWebhook, h('span', { class: 'ew-spacer' }), h('button', { type: 'button', class: 'ew-btn ghost sm', onclick: closeModal }, 'Cancel'), h('button', { type: 'submit', class: 'ew-btn primary sm' }, 'Link GitHub Repo'))
  );
  openModal('Link GitHub Repository', [
    h('p', { class: 'muted sm' }, 'Stream commits, pull requests, merges, and issues into this channel so your agents can review and act on them.'),
    form,
  ]);
  repoInput.focus();
}

async function openPhoneCloneModal() {
  const cloneUrl = `https://helmian.cloud/app${ws.channelId ? `?channel=${encodeURIComponent(ws.channelId)}` : ''}#desktop`;
  const qrBox = h('div', { class: 'int-qr', style: 'margin:0 auto;' }, 'Generating QR…');
  try {
    const { default: qrcode } = await import('./vendor/qrcode.mjs');
    const qr = qrcode(0, 'M');
    qr.addData(cloneUrl);
    qr.make();
    qrBox.innerHTML = qr.createSvgTag({ scalable: true, margin: 2 });
  } catch {
    qrBox.textContent = cloneUrl;
  }
  const copyBtn = h('button', { type: 'button', class: 'ew-btn primary sm', onclick: async () => { try { await navigator.clipboard.writeText(cloneUrl); ws.ctx.toast('Phone clone link copied', 'ok'); } catch {} } }, 'Copy phone link');
  const heraldBtn = h('a', { href: '/herald', class: 'ew-btn ghost sm' }, 'Open Herald Cockpit (/herald) →');
  openModal('📱 Phone Remote — 1:1 Workspace Clone', [
    h('p', { class: 'muted sm' }, 'Scan with your phone camera to open a live 1:1 clone of this exact Envoy channel, your custom agents, and your terminal on your phone.'),
    qrBox,
    h('ol', { class: 'ew-steps sm' },
      h('li', {}, 'Point your phone camera at the QR code above and tap the link.'),
      h('li', {}, 'Sign in once (your phone stays signed in for 30 days).'),
      h('li', {}, 'Use the bottom navigation bar on your phone to flip between Chat, Channels, Agent CLI, Custom Agents, Guard, and Workbench.')
    ),
    h('div', { class: 'ew-row' }, copyBtn, h('span', { class: 'ew-spacer' }), heraldBtn),
  ]);
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
function buildYoutubeLauncherHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; padding: 24px; background: #0b1120; color: #e2e8f0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    h2 { margin: 0 0 6px; font-size: 18px; color: #f8fafc; }
    p { margin: 0 0 16px; color: #94a3b8; font-size: 13px; }
    .row { display: flex; gap: 8px; margin-bottom: 18px; }
    input { flex: 1; padding: 9px 12px; border-radius: 8px; border: 1px solid #1e293b; background: #0f172a; color: #f8fafc; font-size: 13px; }
    button { padding: 9px 14px; border-radius: 8px; border: 0; background: #0284c7; color: #fff; font-weight: 600; cursor: pointer; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px; }
    .card { padding: 12px; border-radius: 10px; background: #1e293b; border: 1px solid #334155; cursor: pointer; text-align: left; color: #e2e8f0; }
    .card:hover { border-color: #38bdf8; }
    .card strong { display: block; margin-bottom: 4px; font-size: 13px; color: #f8fafc; }
    .card span { font-size: 11px; color: #94a3b8; }
  </style></head><body>
    <h2>YouTube Player</h2>
    <p>YouTube's homepage requires a video URL to embed inside another app. Paste any YouTube video link or pick one below:</p>
    <form class="row" onsubmit="event.preventDefault(); var v=document.getElementById('yt-in').value.trim(); if(v) parent.postMessage({type:'helmian-browser-navigate',url:v},'*');">
      <input id="yt-in" placeholder="Paste https://www.youtube.com/watch?v=... or video ID" required>
      <button type="submit">Play Video</button>
    </form>
    <div class="grid">
      <button class="card" type="button" onclick="parent.postMessage({type:'helmian-browser-navigate',url:'https://www.youtube.com/watch?v=OC2Y82gv6co'},'*')"><strong>Helmian Demo 1</strong><span>youtube.com/watch?v=OC2Y82gv6co</span></button>
      <button class="card" type="button" onclick="parent.postMessage({type:'helmian-browser-navigate',url:'https://www.youtube.com/watch?v=_yUtw9YOzy8'},'*')"><strong>Helmian Demo 2</strong><span>youtube.com/watch?v=_yUtw9YOzy8</span></button>
      <button class="card" type="button" onclick="parent.postMessage({type:'helmian-browser-navigate',url:'https://www.youtube.com/watch?v=r3vWiOC3bKw'},'*')"><strong>Helmian Demo 3</strong><span>youtube.com/watch?v=r3vWiOC3bKw</span></button>
    </div>
  </body></html>`;
}
async function navigate(input, { push = true } = {}) {
  const status = $('ew-browser-status');
  const address = toAddress(input);
  if (!address) return;
  $('ew-browser-url').value = address;
  status.textContent = 'Checking address…';
  let navRes;
  try { navRes = await ws.ctx.post('/api/admin/browser/navigate', { url: address }); }
  catch (e) { status.textContent = e?.body?.message || 'That address was not accepted. Only public HTTPS sites open here.'; return; }
  const url = navRes.url;
  const yt = youtubeEmbed(url);
  if (new URL(url).origin === location.origin) { status.textContent = 'Helmian pages open in their own tab. Use ↗.'; window.open(url, '_blank', 'noopener'); return; }
  const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } })();
  const frame = $('ew-browser-frame');
  frame.hidden = false; $('ew-browser-start').hidden = true;
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(host) && !yt) {
    frame.removeAttribute('src');
    frame.srcdoc = buildYoutubeLauncherHtml();
    status.textContent = 'Pick or paste a YouTube video link below, or use ↗ to open youtube.com in a full tab.';
  } else if (navRes.embedHtml && !yt) {
    frame.removeAttribute('src');
    frame.srcdoc = navRes.embedHtml;
    status.textContent = `${host} · rendered in Helmian Reader (recorded in the audit trail). Use ↗ for full interactive tab.`;
  } else {
    frame.removeAttribute('srcdoc');
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
      if (made.channel?.id && made.inserted !== false) {
        saveAvatar(made.channel.id, ws.pendingAvatar);
        // The picked look is the channel's face for the whole
        // workspace (emoji bite 5): store it on the channel config
        // too. Best-effort — the device copy above already shows it
        // here, and a failed store must not fail the creation.
        await ws.ctx.post('/api/admin/envoy/channel-config', { action: 'set-channel-avatar', channelId: made.channel.id, avatar: ws.pendingAvatar }).catch(() => {});
      }
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
  $('ew-cli-new').addEventListener('click', () => pickCliProvider(ws.cli.provider));
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
  $('ew-link-slack').addEventListener('click', linkSlack);
  $('ew-link-github')?.addEventListener('click', linkGithub);
  $('ew-debate-toggle')?.addEventListener('click', openDebateModal);
  $('ew-debate-stop')?.addEventListener('click', stopDebateNow);
  $('ew-phone-qr')?.addEventListener('click', openPhoneCloneModal);
  $('ew-create-agent-btn')?.addEventListener('click', openCreateAgentModal);
  $('ew-foot-create-agent')?.addEventListener('click', openCreateAgentModal);
  $('ew-foot-phone-qr')?.addEventListener('click', openPhoneCloneModal);
  $('ew-mnav-chat')?.addEventListener('click', () => { closeSheets(); $('maestro-input')?.focus({ preventScroll: true }); });
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
  // The member's identity corner (emoji bite 5), built here so the
  // static shell needs no new element ids: name + face + face control
  // at the foot of the channels pane, above the source lines.
  const channelsFoot = document.querySelector('#ew-channels .ew-foot');
  if (channelsFoot && !document.getElementById('ew-me-face')) channelsFoot.prepend(h('div', { class: 'ew-me-face', id: 'ew-me-face' }));
  renderMeFace();
  // Guard
  $('guard-ackall').addEventListener('click', () => ws.ctx.ackAll?.());
  $('ew-guard-refresh').addEventListener('click', async () => { await ws.ctx.loadFeedData?.(); ws.ctx.renderFeed?.(); });
  ws.ctx.wireVoice?.();
  window.matchMedia('(max-width: 900px)').addEventListener?.('change', applyLayout);
}

async function loadPresence() {
  try { const body = await ws.ctx.api('/api/admin/envoy/runner/presence'); ws.online = new Set((body.presence ?? []).filter((p) => p.connected !== false).map((p) => { const n = String(p.provider ?? p.providerName ?? '').toLowerCase(); return n === 'xai' ? 'grok' : n === 'ollama' ? 'qwen' : n; })); ws.activity = Array.isArray(body.activity) ? body.activity : []; }
  catch { ws.online = new Set(); /* the last good activity feed stays — its events expire on their own stamps */ }
  syncActivityViews();
}

function renderAgentState() {
  const el = $('ew-agent-state'); if (!el) return;
  const line = agentStateBanner(ws.agentState);
  el.hidden = !line;
  el.textContent = line ?? '';
}

async function loadAgentState() {
  try { const body = await ws.ctx.api('/api/admin/envoy/agent-state'); ws.agentState = body.agentState ?? null; }
  catch { ws.agentState = null; }
  renderAgentState();
}

export async function mountWorkspace(ctx) {
  ws.ctx = ctx;
  if (!ws.wired) wire();
  applyLayout();
  selectTab(ls.get('tab', 'browser'));
  if (ctx.benchTab) { openBench(ctx.benchTab); ctx.benchTab = null; }
  ws.ctx.renderFeed?.();
  await loadChannels().catch(() => { $('ew-messages').replaceChildren(h('div', { class: 'ew-empty' }, 'Envoy is reconnecting…')); });
  await Promise.allSettled([loadPresence(), loadAgentState(), loadConfig(), loadMessages(), loadCliSessions(), loadFaces(), loadProfile()]);
  if (inMaestroMode()) loadDeskLists();
  await openCliRoom().catch(() => {});
  clearInterval(ws.timer); clearTimeout(ws.timer); clearInterval(ws.slowTimer);
  const visible = () => document.visibilityState === 'visible' && document.getElementById('shell')?.dataset.view === 'desktop';
  // Message poll: calm at rest, fast while the runner activity feed
  // shows a seat working in the open channel or the open room — and on
  // that fast cadence presence (which carries the feed) refreshes too,
  // so stage changes and the elapsed clock stay live. This is the
  // event-driven return of the adaptive poll the age-derived mirror
  // used to drive (killed 2026-11-04, Troy's order): the feed decides,
  // never message age. The generation counter retires a chain whose
  // mount has been superseded, so remounts never stack pollers.
  const gen = (ws.pollGen = (ws.pollGen ?? 0) + 1);
  const tick = async () => {
    if (gen !== ws.pollGen) return;
    if (visible()) { await loadMessages().catch(() => {}); await loadCliRoom().catch(() => {}); }
    if (gen !== ws.pollGen) return;
    let live = activityLive(ws.activity, ws.channelId, ws.config?.customAgents) || (ws.cli.roomId ? activityLive(ws.activity, ws.cli.roomId, ws.config?.customAgents) : false);
    if (visible() && live) { await loadPresence().catch(() => {}); live = activityLive(ws.activity, ws.channelId, ws.config?.customAgents) || (ws.cli.roomId ? activityLive(ws.activity, ws.cli.roomId, ws.config?.customAgents) : false); }
    if (gen !== ws.pollGen) return;
    syncActivityViews();
    ws.timer = setTimeout(tick, live ? ACTIVITY_POLL_MS : CALM_POLL_MS);
  };
  ws.timer = setTimeout(tick, CALM_POLL_MS);
  ws.slowTimer = setInterval(() => { if (visible()) { loadPresence(); loadAgentState(); loadConfig(); loadFaces(); if (inMaestroMode()) loadDeskLists(); } }, 15000);
}
