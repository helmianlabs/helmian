// Envoy workspace for the Desktop view: channels | chat | guard | workbench.
// app.js calls mountWorkspace(ctx) each time the Desktop view opens; wiring
// happens once, data refreshes every time.
import { CHARACTERS, COLORS, avatarFor, defaultChoice, sanitizeChoice } from './avatars.mjs?v=30a56f991a6244c2';
import { UPLOAD_NOTE, addAttachment, addSkillAttach, attachmentKey, buildMessageRequest, fileRefusalReason, removeAttachment, removeSkillAttach } from './composer-picker.mjs?v=30a56f991a6244c2';
import { armedConnectorPairs, armedStateFromConfig, connectorsForTurn, level1Model, level2Model, librarySeat, providerForSeat, seatForProvider, seatName, toggleConnector } from './connector-panel.mjs?v=30a56f991a6244c2';
import { collectCatalogEntryIds, dedupePanelConnectorRows, menuForSeat, walkMenuItems } from './connector-menu.mjs?v=30a56f991a6244c2';
import { loadToolAccess, pickToolAccessEntry, toolAccessEntries, writeToolAccessPosture, writeToolAccessTool } from './connector-tool-access.mjs?v=30a56f991a6244c2';
import { disconnectKeyEntry, isNeedsCredentialAnswer, keyEntryKey, keyFormModel, noteConnectAnswer, opensKeyFormFromSeed, seedKnownKeyEntries, submitKeyForm } from './connector-key-form.mjs?v=30a56f991a6244c2';
import { customFormModel, submitCustomForm } from './connector-custom-form.mjs?v=30a56f991a6244c2';
import { customRemoveModel, submitCustomRemove } from './connector-custom-remove.mjs?v=30a56f991a6244c2';
import { moveSlashHighlight, slashInsertValue, slashMenuModel, slashPickList, slashSkillScopeModel, slashTokenOf } from './slash-menu.mjs?v=30a56f991a6244c2';
import { applySkillPaste, emptySkillDraft, skillDraftFromRecord, skillDraftId, skillSavePayload, validateSkillDraft } from './skill-editor.mjs?v=30a56f991a6244c2';
import { createConnectFields } from './connect-fields.mjs?v=30a56f991a6244c2';
import { AGENT_FACE_DEFAULTS, EMOJI_MAP, emojiAssetSlug, emojiAssetUrl } from './emoji-map.mjs?v=30a56f991a6244c2';
import { LIBRARY_FACES, LIBRARY_REACTIONS, isLibraryFaceToken, parseLibraryFaceToken, libraryFaceToken, libraryFaceStillUrl, libraryFaceClipUrl, libraryReaction, libraryReactionSlug, libraryReactionName, libraryReactionStillUrl } from './face-library.mjs?v=30a56f991a6244c2';

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

// The first-run hand-off (polish P1): while the workspace has NO AI
// connected, the chat pane carries one card with one button —
// "Connect your first AI" — whose target is the Agents tab of
// Integrations, the one place a seat connects. It is the visible
// half of the setup hand-off that follows "Turn on Maestro": the
// activation notice promises Maestro answers here himself until an
// AI is connected (the server's empty-desk answer), and this card
// is how the person fixes it. The model is pure so the suite pins
// it: present exactly while connectedProviders is empty (a fresh
// workspace, before any seat connects), gone the moment the first
// seat connects — including the PC-asleep case, where providers
// exist and the asleep banner above is the honest surface instead.
export function firstRunHandoff(agentState) {
  if (!agentState || !Array.isArray(agentState.connectedProviders) || agentState.connectedProviders.length > 0) return null;
  return Object.freeze({
    label: 'Connect your first AI',
    heading: 'Start here',
    body: 'This workspace has no AI connected yet. Connect the AI you already have, and your messages get answered here.',
    view: 'integrations',
    tab: 'agents',
  });
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
// Working stages roll (the seat is visibly busy — the face
// tumbles in its tile, Troy's Grok-companion ask, 2026-11-10); 'published' —
// its reply landing — gets the talking bobble. The gate is the
// desk's own emojiStill(): plain emoji mode and prefers-reduced-
// motion systems get the still frame and no motion class at all,
// and envoy.css repeats the reduced-motion gate on the animation
// itself. The animated asset's own internal (SMIL) motion is a
// separate layer and untouched by this one.
export function activityMotionKind(stage) {
  if (stage === 'published') return 'talk';
  if (stage === 'started' || stage === 'working' || stage === 'file-placed') return 'roll';
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
// per visible cue, for the open channel. When it
// changes — a stage moved, a cue appeared or cleared, or a live clock
// ticked into a new second — the message view re-renders; when it
// doesn't, polls leave the DOM alone.
let activityViewSig = '';
function activityViewSignature(now = Date.now()) {
  const parts = [];
  for (const c of activityCues(ws.activity, ws.channelId, ws.config?.customAgents, now)) parts.push(`ch:${c.provider}:${c.event.stage}:${activityElapsed(c.event, now)}`);
  return parts.join(',');
}
function syncActivityViews() {
  const sig = activityViewSignature();
  if (sig === activityViewSig) return;
  activityViewSig = sig;
  renderMessages();
  syncCrewMotion();
}

// The CREW rail rows are rebuilt by renderAgents() on the message poll
// (loadMessages renders them on every poll, changed signature or not),
// so their status dots and activity lines ride that cadence. Their
// faces' motion (emoji bite 4) is synced in place from the same
// signature change that re-renders the message views: class toggles on
// the face shell only, no rebuild, and only while the signature
// actually moved. Faces bite 4b rides the same pass: a face carrying a
// state clip (see crewFaceClip below) is pointed at the clip its seat's
// current stage calls for, in place — same no-rebuild discipline.
function syncCrewMotion() {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
  for (const row of document.querySelectorAll('#ew-crew-list .ew-crew-row[data-provider]')) {
    const face = row.querySelector('.ew-crew-face');
    if (!face) continue;
    const stage = activityMotionStage(ws.activity, row.getAttribute('data-provider'), ws.channelId);
    const cls = activityMotionClass(stage);
    face.classList.toggle('ew-ava-roll', cls === 'ew-ava-roll');
    face.classList.toggle('ew-ava-talk', cls === 'ew-ava-talk');
    const video = face.querySelector('video.ew-crew-face-video');
    if (video) crewClipApply(video, stage);
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

// ---------- CREW rail faces (UI polish bite 1) ----------
// The rail's faces are the library pack's stills, served as app assets
// at /app/assets/crew/<seat>-<size>.png. (Faces bite 4b layers the
// pack's state clips over the same stills — see crewFaceClip below;
// the still builders here stay as the poster/fallback chain and as
// the message-row faces.) Seat slugs are the manifest's
// (library-pack/manifest.json seats[]); the one mismatch with the
// room's provider keys is ChatGPT — provider 'openai', asset slug
// 'chatgpt'. If an asset 404s (the pack is uploaded separately), the
// face falls back to the seat's existing avatar — the workspace emoji
// face when it has one, otherwise the stock picture — so a missing
// file never leaves an empty slot.
const CREW_FACE_SLUG = { openai: 'chatgpt' };
const crewFaceSlug = (provider) => CREW_FACE_SLUG[provider] ?? provider;
function crewFaceImg(slug, fallback) {
  const img = h('img', { class: 'ew-crew-face-img', src: `/app/assets/crew/${slug}-56.png`, srcset: `/app/assets/crew/${slug}-128.png 2x, /app/assets/crew/${slug}-256.png 3x`, alt: '', width: 36, height: 36, loading: 'lazy' });
  img.addEventListener('error', () => {
    if (img.dataset.fbk) return;
    img.dataset.fbk = '1';
    img.replaceWith(fallback());
  });
  return img;
}
const crewSeatFaceImg = (provider) => crewFaceImg(crewFaceSlug(provider), () => seatFaceImg(provider));
const crewOwnerFaceImg = () => crewFaceImg('owner', () => ownerFaceFallback());
// The rail's face slot: 36px rounded square (radius 8 — never a
// circle) on the soft backing, with the status dot pinned at its
// bottom-right over a surface ring, and the seat's live activity
// motion riding the shell exactly as it did on the agent cards.
function crewFaceNode(faceImg, statusKind, motionStage) {
  const motion = activityMotionClass(motionStage);
  return h('span', { class: `ew-crew-face${motion ? ` ${motion}` : ''}` },
    faceImg,
    h('span', { class: `ew-crew-dot ${statusKind}`, 'aria-hidden': 'true' }));
}

// ---------- CREW rail face clips (faces bite 4b) ----------
// The rail face can carry the library pack's per-seat state clips
// (bite 4a uploads them next to the stills as
// /app/assets/crew/<slug>-<kind>.webm): a muted, looping <video>
// inside the same 36px dark-tile shell, the 56px still as its poster.
// The clips are dark-stage renders with no alpha channel — the
// shell's dark tile is what contains them, and envoy.css fits the
// video to the tile edge to edge so no letterbox shows.
// The clip is a RENDERING of the same activity feed the motion
// classes read, never a state of its own. The mapping: no live
// stage → idle; a working stage (started / working / file-placed)
// → thinking; 'published' — the reply landing → speaking. Only a
// seat with a live stage ever loads a thinking or speaking clip;
// every other face holds its small idle loop. emojiStill() (plain
// emoji mode, reduced-motion systems) never builds a video at all —
// those faces keep the still (with the CSS idle life from bite 4c) —
// and a clip that fails to load hands the slot back to the still
// and its own fallback chain, so a missing upload never leaves an
// empty tile.
export function crewClipKind(stage) {
  if (stage === 'published') return 'speaking';
  if (stage === 'started' || stage === 'working' || stage === 'file-placed') return 'thinking';
  return 'idle';
}
const crewClipSrc = (slug, kind) => `/app/assets/crew/${slug}-${kind}.webm`;
// Point one face's video at the clip for a stage and keep playback
// honest: the src swaps only when the kind actually changed, the
// clip plays unless the tab is hidden, and pauses when it is.
function crewClipApply(video, stage) {
  if (!video || video.dataset.fbk) return;
  const kind = crewClipKind(stage);
  if (video.dataset.clip !== kind) {
    video.dataset.clip = kind;
    video.src = crewClipSrc(video.dataset.slug, kind);
    video.load();
  }
  if (typeof document !== 'undefined' && document.hidden) { video.pause(); return; }
  if (video.paused) { const p = video.play(); if (p && typeof p.catch === 'function') p.catch(() => {}); }
}
// The clip face for one pack slug, opening on the clip for the
// stage the seat is in at build time. In still mode this IS the
// still — no video element is built.
function crewFaceClip(slug, stage, stillFallback) {
  if (emojiStill()) return crewFaceImg(slug, stillFallback);
  const video = h('video', { class: 'ew-crew-face-video', muted: true, loop: true, playsinline: true, preload: 'metadata', poster: `/app/assets/crew/${slug}-56.png`, 'aria-hidden': 'true' });
  video.muted = true;
  video.dataset.slug = slug;
  video.dataset.clip = 'idle';
  video.src = crewClipSrc(slug, 'idle');
  video.addEventListener('error', () => {
    if (video.dataset.fbk) return;
    video.dataset.fbk = '1';
    video.replaceWith(crewFaceImg(slug, stillFallback));
  });
  crewClipApply(video, stage);
  return video;
}
const crewSeatFaceClip = (provider, stage) => crewFaceClip(crewFaceSlug(provider), stage, () => seatFaceImg(provider));
const crewOwnerFaceClip = (stage) => crewFaceClip('owner', stage, () => ownerFaceFallback());
// Tab hidden → every crew clip pauses; visible again → each one
// resumes at the clip its seat's current stage calls for.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (typeof document.querySelectorAll !== 'function') return;
    for (const row of document.querySelectorAll('#ew-crew-list .ew-crew-row[data-provider]')) {
      const video = row.querySelector('video.ew-crew-face-video');
      if (!video) continue;
      if (document.hidden) video.pause();
      else crewClipApply(video, activityMotionStage(ws.activity, row.getAttribute('data-provider'), ws.channelId));
    }
  });
}

// ---------- message-row faces (UI polish bite 2) ----------
// A message row's face is the library still in the row's rounded-
// square slot (28px, radius 8 — envoy.css .ew-msg .ew-avatar), with
// bite 1's fallback chain behind it: if the pack file is missing,
// the seat's existing avatar art (its workspace emoji face, else
// the stock picture) takes the slot, so a row never renders empty.
// The owner's own rows carry the owner face the same way. A seat
// with no provider (the PC bridge) keeps the old avatar path —
// there is no pack slug to ask for.
function msgSeatAvatar(provider, motionStage = null) {
  if (!provider) return seatAvatar(provider, motionStage);
  const motion = activityMotionClass(motionStage);
  return h('div', { class: `ew-avatar${motion ? ` ${motion}` : ''}` }, crewSeatFaceImg(provider));
}
function msgOwnerAvatar() {
  return h('div', { class: 'ew-avatar' }, crewOwnerFaceImg());
}

function renderFaceViews() { renderAgents(); renderMessages(); }

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
  grid._redraw = draw;
  return grid;
}

// ---------- Maestro Library faces (face-library bite) ----------
// A member's stored face is one string with two vocabularies: an emoji
// character (rendered through bite 1's map) or a Maestro Library token
// (face-library.mjs). The library still renders in the same slots the
// emoji face uses, with the crew pack's fallback discipline: a missing
// file hands the slot to the member's initial, never an empty box —
// and a client that predates the token simply never builds this node.
function libraryFaceImg(token, size = 128) {
  const slug = parseLibraryFaceToken(token);
  if (!slug) return null;
  const img = h('img', { class: 'ew-lib-face-img', src: libraryFaceStillUrl(slug, size), srcset: `${libraryFaceStillUrl(slug, 256)} 2x`, alt: '', loading: 'lazy' });
  img.addEventListener('error', () => {
    if (img.dataset.fbk) return;
    img.dataset.fbk = '1';
    img.replaceWith(h('span', { class: 'ew-crew-initial' }, (ws.profile?.nickname || 'You').slice(0, 1).toUpperCase()));
  });
  return img;
}
// The owner's face as a bare node (no .ew-avatar shell): the crew
// rail's fallback behind the crew pack's owner still.
function ownerFaceFallback() {
  const face = myFace();
  if (isLibraryFaceToken(face)) { const img = libraryFaceImg(face); if (img) return img; }
  return face ? emojiNode(face) : h('span', { class: 'ew-crew-initial' }, (ws.profile?.nickname || 'You').slice(0, 1).toUpperCase());
}
// The Change-face picker's library section: the glossy avatar pieces
// as stills with their names, one radio per piece. Picking stores the
// piece's TOKEN through the same save path an emoji pick uses.
function libraryFaceGrid(label, picked, onPick) {
  const grid = h('div', { class: 'ew-lib-grid', role: 'radiogroup', 'aria-label': label });
  const draw = () => {
    grid.replaceChildren(...LIBRARY_FACES.map((f) => {
      const token = libraryFaceToken(f.slug);
      return h('button', {
        type: 'button', class: `ew-lib-btn${picked() === token ? ' on' : ''}`, 'aria-checked': String(picked() === token),
        title: f.use, 'aria-label': `Face: ${f.label}`,
        onclick: () => { onPick(token); draw(); },
      }, h('img', { src: libraryFaceStillUrl(f.slug, 128), srcset: `${libraryFaceStillUrl(f.slug, 256)} 2x`, alt: '', loading: 'lazy', width: 40, height: 40 }),
        h('span', { class: 'ew-lib-btn-name' }, f.label));
    }));
  };
  draw();
  grid._redraw = draw;
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

// ---------- channels foot collapse ----------
// The foot of the channels pane folds to its identity row (Troy,
// 2026-11-08: "put a collapse on the very bottom where it's got
// change face and your Helmian and all that — they each need to be
// able to collapse also just like the other ones"). What folds: the
// source lines (Helmian Envoy / Discord / Slack / GitHub) and the
// action buttons (Custom Agent / Sync Profile / Phone QR). What
// stays, as the slim bar: the identity row itself — avatar, name,
// the Change face control — plus this toggle, so the collapsed foot
// is still the member's corner and reopens from the same spot. The
// state persists in the shelves' own store (the `ls` helper, key
// 'footCollapsed'); unset reads as expanded — today's look, byte for
// byte. The crew shelf's bottom separator is the foot's sibling, not
// its child, and shelfCeilingNow measures the foot's rendered height
// live, so a folded foot simply gives the crew shelf more ceiling.
export function footCollapsedFrom(stored) { return stored === true; }
function footCollapsed() { return footCollapsedFrom(ls.get('footCollapsed', false)); }
function applyFootCollapse() {
  const foot = document.querySelector('#ew-channels .ew-foot');
  if (!foot) return;
  const collapsed = footCollapsed();
  foot.classList.toggle('foot-collapsed', collapsed);
  for (const b of foot.querySelectorAll('.ew-foot-toggle')) {
    b.setAttribute('aria-expanded', String(!collapsed));
    b.setAttribute('aria-label', collapsed ? 'Expand footer' : 'Collapse footer');
    b.title = collapsed ? 'Expand footer' : 'Collapse footer';
    b.textContent = collapsed ? '▴' : '▾';
  }
}
function toggleFootCollapse() { ls.set('footCollapsed', !footCollapsed()); applyFootCollapse(); }

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
    isLibraryFaceToken(face) ? h('div', { class: 'ew-avatar lib-ava' }, libraryFaceImg(face))
      : face ? h('div', { class: 'ew-avatar emoji-ava' }, emojiNode(face)) : h('div', { class: 'ew-avatar' }, name.slice(0, 1).toUpperCase()),
    h('span', { class: 'name' }, name),
    h('button', { type: 'button', class: 'ew-btn ghost sm', onclick: openMyFaceModal }, face ? 'Change face' : 'Pick a face'),
    h('button', { type: 'button', class: 'ew-icon sm ew-foot-toggle', 'aria-expanded': 'true', 'aria-controls': 'ew-channels-foot', 'aria-label': 'Collapse footer', title: 'Collapse footer', onclick: toggleFootCollapse }, '▾'),
  );
  applyFootCollapse();
}

function openMyFaceModal() {
  let picked = myFace();
  // The pick preview: a library pick plays its idle clip (the current
  // picker shows motion — the emoji art is animated — so the library
  // section answers with the piece's own motion), still-mode systems
  // and a failed clip get the 256px still; an emoji pick previews
  // through the emoji map, as before.
  const preview = h('div', { class: 'ew-lib-preview' });
  const drawPreview = () => {
    const slug = parseLibraryFaceToken(picked);
    if (slug) {
      if (emojiStill()) { preview.replaceChildren(h('img', { src: libraryFaceStillUrl(slug, 256), alt: '', width: 56, height: 56 })); return; }
      const video = h('video', { class: 'ew-lib-preview-video', muted: true, loop: true, playsinline: true, preload: 'metadata', poster: libraryFaceStillUrl(slug, 256), 'aria-hidden': 'true' });
      video.muted = true;
      video.src = libraryFaceClipUrl(slug);
      video.addEventListener('error', () => { video.replaceWith(h('img', { src: libraryFaceStillUrl(slug, 256), alt: '', width: 56, height: 56 })); });
      const p = video.play(); if (p && typeof p.catch === 'function') p.catch(() => {});
      preview.replaceChildren(video);
    } else if (picked) {
      preview.replaceChildren(h('div', { class: 'ew-avatar emoji-ava ew-lib-preview-emoji' }, emojiNode(picked)));
    } else {
      preview.replaceChildren(h('span', { class: 'muted sm' }, 'No face picked — your initial shows.'));
    }
  };
  const libGrid = libraryFaceGrid('Pick a Maestro Library face', () => picked, (token) => { picked = token; emGrid._redraw?.(); drawPreview(); });
  const emGrid = faceGrid('Pick an emoji face', () => picked, (em) => { picked = em; libGrid._redraw?.(); drawPreview(); });
  openModal('Your face', [
    h('p', { class: 'muted sm' }, 'Your face shows next to your name here and on your messages, for everyone in this workspace.'),
    preview,
    h('p', { class: 'muted sm ew-lib-sec' }, 'Maestro Library'),
    h('div', { class: 'ew-row' }, libGrid),
    h('p', { class: 'muted sm ew-lib-sec' }, 'Emoji faces'),
    h('div', { class: 'ew-row' }, emGrid),
    h('div', { class: 'ew-row' },
      h('button', { type: 'button', class: 'ew-btn ghost sm', onclick: () => saveMyFace(null) }, 'No face — use my initial'),
      h('span', { class: 'ew-spacer' }),
      h('button', { type: 'button', class: 'ew-btn ghost sm', onclick: closeModal }, 'Cancel'),
      h('button', { type: 'button', class: 'ew-btn primary sm', onclick: () => saveMyFace(picked) }, 'Save')),
  ]);
  drawPreview();
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

const ws = { avatars: ls.get('avatars', {}), pendingAvatar: null, wired: false, ctx: null, channels: [], channelId: null, mode: ls.get('netMode', 'envoy') === 'discord' ? 'discord' : 'envoy', config: null, configured: false, discordBot: null, slackBot: null, messages: [], sig: null, online: new Set(), presenceRows: [], activity: [], agentState: null, faces: null, profile: null, timer: null, slowTimer: null, linkPoll: null, attach: { channel: [] }, webSearch: { channel: false }, pickerFor: null, libraryFacts: null, libraryLoading: null, librarySeatLoading: {}, libraryFetchedAt: {}, libraryFactsFetchedAt: 0, libraryWriteAt: 0, libraryPreloadStarted: false, libraryPanel: { level: 1, seatId: null, sub: null }, connectorToggles: {}, skillAttach: { channel: [] }, skills: { list: null, loaded: false, loading: null }, plugins: { list: null, unavailable: [], loaded: false, loading: null }, projects: { list: null, activeKey: null, loaded: false, loading: null }, armedSaved: null, toolAccess: { open: false, seatId: null, entryId: null, model: null, loading: false, saving: false, error: '' }, connectErrors: {}, keyForm: { openFor: null, model: null, saving: false, error: '', known: {} }, customForm: { open: false, seatId: null, model: null, saving: false, error: '', created: null }, customRemove: { confirmFor: null, model: null, removing: false, error: '' }, githubFile: { open: false, path: '', entries: null, note: '', loading: false }, fileInput: null, reactions: { channelId: null, byId: {}, mine: {} }, reactionsStamp: 0, reactionPopFor: null, slash: { commands: null, loaded: false, loading: null, openFor: null, index: 0, dismissedFor: null, scopeFor: null } };

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
    if (user) ls.set(`open.${name}`, open);
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

// ---------- channels rail rest (panel bite, 2026-11-08) ----------
// Troy's final word: the channels pane folds ITSELF to a slim rail and
// hovering the rail opens the whole pane over the chat — "you can
// scroll, you can do all that... that's how it should be" — everywhere,
// not just in a narrow window. The rest state replaces hide-to-zero
// for this pane only: open.channels now records "pinned open", and
// anything else rests as the rail. A click pins both ways: the rail
// tab (or the chat head's Channels button) pins it open in the layout,
// the pane head's ‹ folds it back to the rail. Narrow screens keep the
// sheet behaviour and never rest.
function setChannelsRest(rest, { user = false } = {}) {
  const pane = $('ew-channels'); if (!pane) return;
  if (narrow()) rest = false;
  pane.classList.toggle('rail-rest', rest);
  if (rest) {
    pane.classList.remove('collapsed');
    $('ew').classList.remove('no-channels');
  } else {
    pane.classList.remove('peeking');
  }
  $('ew').classList.toggle('channels-rest', rest);
  if (user) ls.set('open.channels', !rest);
}
function wireChannelsRail() {
  const pane = $('ew-channels'); if (!pane || pane.dataset.railWired) return;
  pane.dataset.railWired = '1';
  pane.addEventListener('mouseenter', () => { if (pane.classList.contains('rail-rest')) pane.classList.add('peeking'); });
  pane.addEventListener('mouseleave', () => pane.classList.remove('peeking'));
  pane.addEventListener('focusin', () => { if (pane.classList.contains('rail-rest')) pane.classList.add('peeking'); });
  pane.addEventListener('focusout', (e) => { if (!pane.contains(e.relatedTarget)) pane.classList.remove('peeking'); });
  const tab = $('ew-channels-rail-tab');
  if (tab) tab.addEventListener('click', () => { setChannelsRest(false); setPane('channels', true, { user: true }); });
}

function applyLayout() {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(ls.get('widths', {}))) if (v > 120 && v < 1400) root.style.setProperty(`--ew-${k}`, `${v}px`);
  applyHeights();
  if (narrow()) { for (const p of ['channels', 'guard', 'bench']) { $(`ew-${p}`).classList.remove('collapsed'); } closeSheets(); return; }
  // Channels rests as the rail unless the user pinned it open (panel bite).
  if (ls.get('open.channels', false)) setPane('channels', true);
  else setChannelsRest(true);
  setPane('guard', ls.get('open.guard', true));
  setPane('bench', ls.get('open.bench', window.innerWidth >= 1680));
}
// Splitter floors per pane. The CSS min-widths in envoy.css match these
// exactly — when the two disagreed (JS clamped at 180, CSS floored the
// workbench at 320) the drag had dead travel in both directions. Releasing
// a drag below SNAP collapses the pane instead of parking it at the floor;
// the pre-drag width stays in the var, so reopening restores it.
const PANE_MIN = { channels: 132, guard: 150, bench: 200 };
const PANE_MAX = 900;
const SNAP = 76;
// Sized panes in DOM order (the chat sits between channels and guard but is
// not sized — it is the flexible pane every drag trades space with).
const PANE_ORDER = ['channels', 'guard', 'bench'];

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

// ---------- shelves: resizable sections inside a pane ----------
// The width splitters above trade a whole pane against the chat; these
// trade the SECTIONS stacked inside one pane against each other (Troy,
// 2026-11-08: the channels column scrunches — as the crew grows it
// squeezes the channel list, and a pile of Guard approvals pushes the
// feed away). Two shelves exist: the CREW section in the channels pane
// (separator on both its edges — the channel list above it is the
// flexible sibling) and the APPROVALS section in the Guard pane
// (separator on its bottom edge — the findings feed below it is the
// flexible sibling). The footer's link block is fixed-height content;
// the crew shelf's bottom separator resizes the crew from that edge.
// A shelf's height is a user var (--ew-crew-h / --ew-appr-h) applied
// only while the pane carries its *-sized class; stored heights live in
// ls 'heights', the shelf sibling of the width splitters' 'widths'.
// The smallest honest shelf heights (floor-fix, 2026-11-08). Crew
// arithmetic, border-box (the app.css * rule): section padding 14 +
// border 1 + crew head ~23 + the ADD TO THIS CHANNEL subhead ~31 +
// the add block capped at 180 (six 24px pill rows, envoy.css) + one
// 46px crew row = 295 — the floor sits just above the sum. The
// original 112 predated the panes-removal port that moved the subhead
// and pill block inside this section: at 112 the fixed content alone
// overflowed the box (the live-gate breakage — rows squeezed to zero,
// pills spilling over the footer). Approvals: subhead ~31 + the
// Open-approvals link ~34 + section padding/border 9 ≈ 74, under its
// floor with the list clipping inside. Stored heights below a floor
// are ignored on restore (applyHeights), so a height persisted under
// the old crew floor returns the section to its natural height
// instead of rendering broken.
const SHELF_MIN = { crew: 296, approvals: 104 };
// The room the flexible sibling always keeps, whatever the drag asks.
const SHELF_FLEX_MIN = 120;
const SHELF_DEFS = {
  crew: { pane: () => $('ew-channels'), section: () => $('ew-crew'), flex: () => $('ew-channel-list'), cls: 'crew-sized', varName: '--ew-crew-h' },
  approvals: { pane: () => $('ew-guard'), section: () => document.querySelector('#ew-guard .ew-approvals'), flex: () => $('guard-findings'), cls: 'appr-sized', varName: '--ew-appr-h' },
};

// Pure shelf geometry, exported for tests. A shelf drag moves the
// section's boundary edge 1:1 with the pointer: at the 'top' edge the
// section shrinks as the pointer moves down, at the 'bottom' edge it
// grows. The result clamps to [min, max]; the floor wins when the pane
// is too short for both (max < min), so a shelf can never be dragged
// out of existence.
export function shelfDrag({ startH, dy, edge, min, max }) {
  const raw = edge === 'top' ? startH - dy : startH + dy;
  return Math.max(min, Math.min(max, raw));
}

// The tallest a shelf may grow inside its pane: the pane's height minus
// everything that is neither the shelf nor its flexible sibling
// (fixedH), minus the room the sibling keeps. Never below the floor.
export function shelfCeiling({ paneH, fixedH, flexMin, min }) {
  return Math.max(min, paneH - fixedH - flexMin);
}

// Live ceiling for one shelf: the fixed share is measured now (pane
// height minus the shelf's and the sibling's rendered heights), so it
// stays right as the content above and below changes height. A pane
// with no height (a hidden view) has no ceiling.
function shelfCeilingNow(key) {
  const def = SHELF_DEFS[key];
  const pane = def.pane(); const section = def.section(); const flex = def.flex();
  if (!pane || !section || !flex) return Infinity;
  const paneH = pane.clientHeight;
  if (!paneH) return Infinity;
  const fixedH = paneH - section.getBoundingClientRect().height - flex.getBoundingClientRect().height;
  return shelfCeiling({ paneH, fixedH, flexMin: SHELF_FLEX_MIN, min: SHELF_MIN[key] });
}

// Stored shelf heights back onto the panes (applyLayout's shelf half,
// the exact sibling of its widths loop). Narrow keeps the stacked
// layout untouched: the vars come off and the sections size naturally.
// On a window shorter than the one a height was stored on, the applied
// var clamps to the live ceiling so the flexible sibling is never
// stranded — storage keeps the user's number for a taller window.
function applyHeights() {
  const root = document.documentElement;
  const heights = ls.get('heights', {});
  for (const [key, def] of Object.entries(SHELF_DEFS)) {
    const pane = def.pane(); if (!pane) continue;
    const v = heights[key];
    if (narrow() || !(v >= SHELF_MIN[key] && v <= 2400)) { root.style.removeProperty(def.varName); pane.classList.remove(def.cls); continue; }
    const ceiling = shelfCeilingNow(key);
    root.style.setProperty(def.varName, `${Math.round(Math.min(v, ceiling))}px`);
    pane.classList.add(def.cls);
  }
}

function wireShelves() {
  const ew = $('ew'); if (!ew) return;
  wireShelfSplitter(ew, { key: 'crew', edge: 'top', label: 'Resize crew section', before: () => $('ew-crew') });
  wireShelfSplitter(ew, { key: 'crew', edge: 'bottom', label: 'Resize crew section', before: () => document.querySelector('#ew-channels .ew-foot') });
  wireShelfSplitter(ew, { key: 'approvals', edge: 'bottom', label: 'Resize approvals section', before: () => document.querySelector('#ew-guard > .ew-subhead') });
}

function wireShelfSplitter(ew, { key, edge, label, before }) {
  const def = SHELF_DEFS[key];
  const pane = def.pane(); const section = def.section(); const anchor = before();
  if (!pane || !section || !anchor) return;
  // The separators are built here rather than written into index.html:
  // the sections they divide are static shells whose contents other
  // code renders into, and a built separator can never drift out of
  // the markup the way a hand-placed one could.
  const split = h('div', { class: 'ew-hsplit', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': label, tabindex: '0', 'data-shelf': `${key}-${edge}` });
  anchor.before(split);
  const setH = (px) => {
    document.documentElement.style.setProperty(def.varName, `${Math.round(px)}px`);
    pane.classList.add(def.cls);
    for (const s of document.querySelectorAll(`[data-shelf^="${key}-"]`)) s.setAttribute('aria-valuenow', String(Math.round(px)));
  };
  const clearH = () => {
    document.documentElement.style.removeProperty(def.varName);
    pane.classList.remove(def.cls);
    const now = String(Math.round(section.getBoundingClientRect().height));
    for (const s of document.querySelectorAll(`[data-shelf^="${key}-"]`)) s.setAttribute('aria-valuenow', now);
  };
  const persist = (px) => { const heights = ls.get('heights', {}); heights[key] = Math.round(px); ls.set('heights', heights); };
  const reset = () => { const heights = ls.get('heights', {}); delete heights[key]; ls.set('heights', heights); clearH(); };
  const ceiling = () => { const max = shelfCeilingNow(key); split.setAttribute('aria-valuemax', String(Math.round(Math.min(max, 2400)))); return max; };
  split.setAttribute('aria-valuemin', String(SHELF_MIN[key]));
  split.setAttribute('aria-valuenow', String(Math.round(section.getBoundingClientRect().height)));
  split.addEventListener('pointerdown', (e) => {
    if (narrow()) return;
    e.preventDefault(); split.setPointerCapture(e.pointerId);
    const startY = e.clientY; const startH = section.getBoundingClientRect().height;
    const max = ceiling();
    const prior = ls.get('heights', {})[key];
    split.classList.add('dragging'); ew.classList.add('shelf-dragging');
    let current = startH; let done = false;
    const move = (ev) => { current = shelfDrag({ startH, dy: ev.clientY - startY, edge, min: SHELF_MIN[key], max }); setH(current); };
    const finish = (commit) => {
      if (done) return; done = true;
      split.classList.remove('dragging'); ew.classList.remove('shelf-dragging');
      split.removeEventListener('pointermove', move); split.removeEventListener('pointerup', up); split.removeEventListener('pointercancel', cancel);
      if (commit) persist(current);
      else if (prior === undefined) clearH();
      else setH(prior);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    split.addEventListener('pointermove', move); split.addEventListener('pointerup', up); split.addEventListener('pointercancel', cancel);
  });
  split.addEventListener('dblclick', reset);
  split.addEventListener('keydown', (e) => {
    // Keyboard parity with the pointer, mirroring the width splitters:
    // arrows move the boundary edge 24px the way the arrow points,
    // Enter/End reset to the natural height like the dblclick reset,
    // Home parks the shelf at its floor (a shelf has no collapse —
    // the floor is its smallest honest state).
    if (e.key === 'Enter' || e.key === 'End') { e.preventDefault(); reset(); return; }
    if (narrow()) return;
    if (e.key === 'Home') { e.preventDefault(); setH(SHELF_MIN[key]); persist(SHELF_MIN[key]); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const startH = section.getBoundingClientRect().height;
    const next = shelfDrag({ startH, dy: e.key === 'ArrowDown' ? 24 : -24, edge, min: SHELF_MIN[key], max: ceiling() });
    setH(next); persist(next);
  });
}

// ---------- channels ----------
// Per-channel link flags for the channel list: the channels API now
// carries each channel's Discord / Slack / GitHub link itself (server truth from
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
    c._github = 'github' in c ? Boolean(c.github?.repo) : Boolean(cached?.g);
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
const slackLinkedChannels = (channels = ws.channels) => channels.filter((c) => c._slack);
const githubLinkedChannels = (channels = ws.channels) => channels.filter((c) => c._github);
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
  if (mode === 'discord') {
    return channel ? `You're posting to Discord · #${channel.discord?.channelName || config?.discord?.channelName || title}` : "You're in Discord · no channel linked yet";
  }
  // Maestro always-on (2026-11-09): every Envoy channel dispatches as
  // Maestro — there is no plain posting mode left to name.
  if (isDeskChannel(channel)) {
    return "You're dispatching as Maestro · the desk — replies come back under each agent's own name";
  }
  return `You're dispatching as Maestro · Maestro follows you in #${title} — replies come back under each agent's own name`;
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
      ...(linked.length ? linked.map(row) : [h('p', { class: 'ew-note' }, bot?.configured ? 'No channels linked yet. Flip to Envoy, open a channel and use + Link Discord in the channel list to mirror it here.' : 'Bot not connected yet. Linked channels mirror here.')])
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
    h('div', { class: 'ew-src-head' },
      h('span', { class: 'ew-discord-mark', 'aria-hidden': 'true' }),
      'DISCORD',
      h('button', { type: 'button', class: 'ew-icon sm', title: 'Link a Discord channel to this channel', 'aria-label': 'Link Discord channel', style: 'margin-left:auto;', onclick: (e) => { e.stopPropagation(); if (narrow()) closeSheets(); linkDiscord(); } }, '+')
    ),
    ...(linked.length ? linked.map(row) : [h('p', { class: 'ew-note' }, bot?.configured ? 'No channels linked yet.' : 'Bot not connected yet. Linked channels mirror here.')]),
    ws.config?.discord
      ? h('button', { type: 'button', class: 'ew-channel', title: `This channel mirrors with Discord #${ws.config.discord.channelName || ws.config.discord.channelId} — click to manage`, onclick: () => { if (narrow()) closeSheets(); linkDiscord(); } },
          h('span', { class: 'ew-discord-mark', 'aria-hidden': 'true' }),
          h('span', { class: 'name' }, `#${ws.config.discord.channelName || ws.config.discord.channelId}`),
          h('span', { class: 'tags' }, h('span', { class: 'ew-ca-tag' }, 'Linked')))
      : h('button', { type: 'button', class: 'ew-channel', title: 'Mirror this channel with a Discord channel', onclick: () => { if (narrow()) closeSheets(); linkDiscord(); } },
          h('span', { class: 'ew-discord-mark', 'aria-hidden': 'true' }),
          h('span', { class: 'name' }, '+ Link Discord')),
    h('div', { class: 'ew-src-head' },
      h('span', { class: 'ew-slack-mark', 'aria-hidden': 'true' }),
      'SLACK',
      h('button', { type: 'button', class: 'ew-icon sm', title: 'Link a Slack channel to this channel', 'aria-label': 'Link Slack channel', style: 'margin-left:auto;', onclick: (e) => { e.stopPropagation(); if (narrow()) closeSheets(); linkSlack(); } }, '+')
    ),
    ws.config?.slack
      ? h('button', { type: 'button', class: 'ew-channel', title: `This channel mirrors with Slack #${ws.config.slack.channelName || ws.config.slack.channelId} — click to manage`, onclick: () => { if (narrow()) closeSheets(); linkSlack(); } },
          h('span', { class: 'ew-slack-mark', 'aria-hidden': 'true' }),
          h('span', { class: 'name' }, `#${ws.config.slack.channelName || ws.config.slack.channelId}`),
          h('span', { class: 'tags' }, h('span', { class: 'ew-ca-tag' }, 'Linked')))
      : h('button', { type: 'button', class: 'ew-channel', title: 'Mirror this channel with a Slack channel', onclick: () => { if (narrow()) closeSheets(); linkSlack(); } },
          h('span', { class: 'ew-slack-mark', 'aria-hidden': 'true' }),
          h('span', { class: 'name' }, '+ Link Slack')),
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
  // Leaving a channel marks it seen up to its newest message (the
  // unread divider's last-seen stamp, bite 2).
  if (ws.channelId && ws.channelId !== id) markChannelSeen(ws.channelId, ws.messages);
  ws.channelId = id; ls.set('channel', id); ls.set(`netChannel.${ws.mode}`, id); ws.sig = null; ws.messages = [];
  ws.reactions = { channelId: null, byId: {}, mine: {} }; ws.reactionsStamp = 0; closeReactionPicker();
  setComposer(true);
  renderChannels();
  $('ew-messages').replaceChildren(h('div', { class: 'ew-empty' }, 'Loading…'));
  if (narrow()) closeSheets();
  await Promise.allSettled([loadConfig(), loadMessages()]);
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
// The channels-column footer's Discord line is a WORKSPACE summary —
// it sits in the .ew-foot source list ("Helmian Envoy / Discord: … /
// Slack: … / GitHub: …") — so it derives from the per-channel link
// data the channels API carries (applyChannelLinks → _discord, the
// same read linkedChannels() and the Discord rail consume), never
// from the open channel's config alone: a workspace's Discord pair
// can live on any channel, and reading only the open channel's
// config printed "ready to link" in the footer while another room
// in the workspace was linked. The open channel's loaded config is
// passed only as a NAME hint for that channel's own link (the
// netStripText fallback pattern), never as the existence test.
// Pure; unit tested.
export function discordFooterStatus({ channels = [], bot = null, openChannelId = null, openLink = null } = {}) {
  if (!bot?.configured) return 'bot not set up yet';
  const linked = linkedChannels(channels);
  if (!linked.length) return 'ready to link';
  const first = linked[0];
  const link = first.discord ?? (openLink && first.id === openChannelId ? openLink : null);
  const name = link?.channelName || link?.channelId || first.title || first.slug || 'channel';
  return linked.length === 1 ? `linked to #${name}` : `linked to #${name} + ${linked.length - 1} more`;
}
// The footer's Slack line is the same workspace summary as the
// Discord line above (footer truth, part 2): Slack links are
// per-channel pairs too, so the line derives from the per-channel
// Slack data the channels API carries (applyChannelLinks → _slack,
// each channel's link object riding the same list) — never from the
// open channel's config alone, which printed "ready to link" for a
// linked workspace whenever the open room was not the one holding
// the pair. The open channel's loaded config is passed only as a
// NAME hint for that channel's own link (the discordFooterStatus
// pattern), never as the existence test. Wording mirrors
// mirrorLinkHeader's statusText exactly. Pure; unit tested.
export function slackFooterStatus({ channels = [], bot = null, openChannelId = null, openLink = null } = {}) {
  if (!bot?.configured) return 'bot not set up yet';
  const linked = slackLinkedChannels(channels);
  if (!linked.length) return 'ready to link';
  const first = linked[0];
  const link = first.slack ?? (openLink && first.id === openChannelId ? openLink : null);
  const name = link?.channelName || link?.channelId || first.title || first.slug || 'channel';
  return linked.length === 1 ? `linked to #${name}` : `linked to #${name} + ${linked.length - 1} more`;
}
// The footer's GitHub line, same workspace law again: GitHub links
// are per-channel pairs (each channel's config carries at most one
// repo — the rail's GITHUB section reads that config), and the
// channels API already returns every channel's GitHub link next to
// its Discord / Slack links (server-side attachChannelLinks builds
// all three from the same per-channel config rows the rail and the
// bridges read), so this derives from the list exactly like the two
// lines above — no second state source, no new endpoint. The open
// channel's loaded config is only a name hint for its own link.
// Wording mirrors githubLinkHeader's statusText; when a link is
// known only by its flag (the chanMeta cache standing in for an
// older server that did not send the field) the line stays truthful
// but coarse — "linked to GitHub" — the same coarseness the Discord
// line accepts with its title fallback. Pure; unit tested.
export function githubFooterStatus({ channels = [], openChannelId = null, openLink = null } = {}) {
  const linked = githubLinkedChannels(channels);
  if (!linked.length) return 'ready to link';
  const first = linked[0];
  const link = first.github ?? (openLink && first.id === openChannelId ? openLink : null);
  const repo = link?.repo || 'GitHub';
  return linked.length === 1 ? `linked to ${repo}` : `linked to ${repo} + ${linked.length - 1} more`;
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
// Maestro always-on (Troy's ruling, 2026-11-09, superseding the
// per-channel Maestro follow switch shipped the same morning): Maestro
// follows the human in EVERY channel, so an unnamed send reaches the
// crew everywhere. There is no toggle and nothing to switch — the
// header state is a permanent badge. The desk channel itself shows no
// badge (nothing to follow — Maestro is already home there).
export function maestroHeaderState({ desk = false } = {}) {
  return {
    active: true,
    badgeHidden: desk === true,
    badgeText: desk === true ? '' : 'Maestro following',
  };
}
// The composer placeholder for the open channel. Every Envoy channel
// carries the dispatch wording: an unnamed message reaches the crew.
export function composerPlaceholderText({ mode, title, hasAgents = false, narrowScreen = false } = {}) {
  if (mode === 'discord') return `Message #${title}`;
  return `Message #${title} · Maestro follows you here — @name for one agent, no name for everyone`;
}
// The empty-channel line. Every channel with a crew carries the
// dispatch wording, with the channel standing where the desk stands
// in its own line.
export function emptyChannelText({ desk = false, hasAgents = false } = {}) {
  if (desk) return 'This is your desk. Send a dispatch — @name for one agent, @all for everyone, or name nobody and it goes to everyone on the desk.';
  if (hasAgents) return 'Maestro follows you here. Send a message — @name for one agent, @all for everyone, or name nobody and it goes to everyone in this channel.';
  return 'No messages yet. Say hello, or add an agent to make this an agent chat.';
}
async function loadConfig() {
  if (!ws.channelId) return;
  const id = ws.channelId;
  try {
    const body = await ws.ctx.api(`/api/admin/envoy/channel-config?channel_id=${encodeURIComponent(id)}`);
    if (id !== ws.channelId) return;
    ws.config = body.config ?? { agents: [] }; ws.configured = Boolean(body.configured); ws.discordBot = body.discordBot ?? null; ws.slackBot = body.slackBot ?? null;
    // The channel's standing armed set (bite A2) hydrates from the
    // config that carries it: the toggle store is re-seeded from
    // the stored pairs on every load, so a reload, a second device,
    // or a config change elsewhere never leaves this composer
    // holding a set the channel no longer has. The hydrated state
    // is also the last-saved snapshot a failed persist reverts to.
    ws.connectorToggles = armedStateFromConfig(ws.config, `channel:${id}`);
    ws.armedSaved = ws.connectorToggles;
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
  if (ch) { ch._agents = ws.config.agents.length; ch._discord = Boolean(ws.config.discord); ch._slack = Boolean(ws.config.slack); ch._github = Boolean(ws.config.github?.repo); if ('avatar' in (ws.config ?? {})) ch.avatar = ws.config.avatar; const seen = ls.get('chanMeta', {}); seen[ch.id] = { a: ch._agents, d: ch._discord, s: ch._slack, g: ch._github }; ls.set('chanMeta', seen); }
  renderAttachChips('channel');
  renderHeader(); renderAgents(); renderChannels();
}

// The standing set's write road (bite A2): every flip — from the
// toggle list or a chip's × — posts the channel's WHOLE armed set
// through the channel-config road, the same road every other
// per-channel setting travels (the set-armed-connectors action in
// envoy-mesh.mjs). The write is optimistic in the composer and
// honest on failure: a failed post reverts the store to the last
// state the server confirmed (ws.armedSaved, seeded by every
// config load) and says so, so a switch never shows a state the
// channel does not hold. Concurrent flips are not queued: each post
// carries the full set as of its own flip, and the server's newest
// config row wins — the same last-write discipline the config
// store itself runs on.
async function persistArmedConnectors() {
  const channelId = ws.channelId;
  if (!channelId) return;
  const pairs = armedConnectorPairs(ws.connectorToggles, `channel:${channelId}`);
  try {
    const body = await ws.ctx.post('/api/admin/envoy/channel-config', { action: 'set-armed-connectors', channelId, armedConnectors: pairs });
    if (channelId !== ws.channelId) return;
    ws.armedSaved = ws.connectorToggles;
    if (body?.config) ws.config = body.config;
  } catch {
    if (channelId !== ws.channelId) return;
    ws.connectorToggles = ws.armedSaved ?? {};
    ws.ctx.toast('That connector change could not be saved.');
    renderAttachChips('channel');
    if (ws.pickerFor) renderPicker(ws.pickerFor);
  }
}
function renderHeader() {
  const ch = ws.channels.find((c) => c.id === ws.channelId);
  const title = ch?.title || ch?.slug || 'channel';
  $('ew-channel-title').textContent = title; renderHeadAvatar();
  // The placeholder names the destination channel in both modes; the
  // long @agent hint is an Envoy-side extra and stays there.
  $('maestro-input').placeholder = composerPlaceholderText({ mode: ws.mode, title, hasAgents: Boolean(ws.config?.agents?.length), narrowScreen: narrow() });
  const badge = $('ew-discord-badge');
  const d = ws.config?.discord;
  const admin = ['owner', 'admin'].includes(ws.ctx.state.actor?.role);
  const dh = mirrorLinkHeader({ link: d, pending: Boolean(ws.config?.pendingLink), bot: ws.discordBot, admin, label: 'Discord' });
  badge.hidden = dh.badgeHidden;
  badge.className = `ew-badge ${dh.badgeClass}`;
  badge.textContent = dh.badgeText;
  const sBadge = $('ew-slack-badge');
  const s = ws.config?.slack;
  const sh = mirrorLinkHeader({ link: s, bot: ws.slackBot, admin, label: 'Slack' });
  sBadge.hidden = sh.badgeHidden;
  sBadge.className = `ew-badge ${sh.badgeClass}`;
  sBadge.textContent = sh.badgeText;
  const ghBadge = $('ew-github-badge');
  const gh = githubLinkHeader({ github: ws.config?.github, admin });
  if (ghBadge) { ghBadge.hidden = gh.badgeHidden; ghBadge.textContent = gh.badgeText; }
  const ghStatus = $('ew-github-status-text');
  if (ghStatus) ghStatus.textContent = githubFooterStatus({ channels: ws.channels, openChannelId: ws.channelId, openLink: ws.config?.github });
  const deb = debateHeaderState({ debateMode: ws.config?.debateMode, maxRoundTurns: ws.config?.maxRoundTurns });
  const debBadge = $('ew-debate-badge');
  const debBtn = $('ew-debate-toggle');
  const debStop = $('ew-debate-stop');
  if (debBadge) { debBadge.hidden = deb.badgeHidden; debBadge.textContent = deb.badgeText; }
  if (debBtn) { const l = debBtn.querySelector('.lbl'); if (l) l.textContent = deb.buttonLabel; debBtn.setAttribute('aria-pressed', String(deb.active)); }
  if (debStop) debStop.hidden = deb.stopHidden;
  const mf = maestroHeaderState({ desk: inMaestroMode() });
  const mfBadge = $('ew-maestro-follow-badge');
  if (mfBadge) { mfBadge.hidden = mf.badgeHidden; mfBadge.textContent = mf.badgeText; }
  const agentCount = $('ew-agent-count'); if (agentCount) agentCount.textContent = String((ws.config?.agents?.length ?? 0));
  $('ew-discord-status-text').textContent = discordFooterStatus({ channels: ws.channels, bot: ws.discordBot, openChannelId: ws.channelId, openLink: d });
  $('ew-slack-status-text').textContent = slackFooterStatus({ channels: ws.channels, bot: ws.slackBot, openChannelId: ws.channelId, openLink: s });
  renderNetStrip();
  renderMaestroMode();
}
// The desk's on-screen state (fun pass F4): the desk channel wears
// no costume — no banner over the thread, no mode styling on the
// pane, no seat to leave. What this still owns is the one plain
// composer hint that says how a desk send is addressed. (The desk's
// handoff and checkpoint lists live in the shell's Evidence view —
// the Agents pane that used to carry a second copy is gone.)
// Everything else about the open desk is ordinary channel
// furniture, rendered by the ordinary paths.
function renderMaestroMode() {
  // Maestro always-on: the dispatch hint is every channel's standing
  // composer line — there is no non-dispatch mode to fall back to.
  const hint = $('ew-composer-hint');
  if (hint) hint.textContent = '@name for one agent, no name for everyone';
}
// ---------- CREW rail (UI polish bite 1) ----------
// The sidebar presence rail that replaces the composer's pill strip
// and the Agents pane's cards. Everything it shows comes from feeds
// the room already loads — nothing new is fetched:
//   · presence: GET /api/admin/envoy/runner/presence (loadPresence)
//     fills ws.online (connected seats) and ws.presenceRows (the raw
//     rows, kept for the limit read below);
//   · work: the runner activity feed on that same GET (ws.activity),
//     read through activityCue() — the exact helper the in-stream
//     activity rows are built from;
//   · roster: the channel config's agents + custom agents, the same
//     set renderAgents() has always derived.
// Status kinds: 'working' (a live, non-terminal activity cue),
// 'limit' (the seat's presence row carries a limit flag — see
// crewLimit), 'live' (connected, no live cue), 'offline' (not in the
// presence set). Rows sort working → limit → live → offline, roster
// order inside a group (spec §4: the list is the room's heartbeat).
const CREW_RANK = { working: 0, limit: 1, live: 2, offline: 3 };
// The seat's raw presence row, matched under any of its feed names
// (the qwen seat reports as 'ollama', grok may report as 'xai').
function crewPresenceRow(provider) {
  const names = activityProviderNames(provider);
  return (ws.presenceRows ?? []).find((row) => {
    const n = String(row?.provider ?? row?.providerName ?? '').toLowerCase();
    return activityDeskProvider(n) === provider || names.includes(n);
  }) ?? null;
}
// At-limit state, read off the presence row when the server marks it:
// a limited/atLimit flag, a limited/at-limit status word, or a future
// limit-reset stamp. The client payload the room consumes today
// carries only provider + connected on each row, so until the server
// adds one of these fields this read returns null and no seat renders
// at-limit — the rail never invents a limit it cannot see.
function crewLimit(provider) {
  const row = crewPresenceRow(provider);
  if (!row) return null;
  const until = row.limitUntil ?? row.limitedUntil ?? row.limitResetsAt ?? row.resetsAt ?? row.resetAt ?? null;
  const flagged = row.limited === true || row.atLimit === true || row.at_limit === true
    || row.status === 'limited' || row.status === 'at-limit' || row.state === 'limited' || row.state === 'at-limit'
    || (typeof until === 'string' && Boolean(until) && new Date(until).getTime() > Date.now());
  if (!flagged) return null;
  return { until: typeof until === 'string' && until ? until : null };
}
// One seat's rail status: { kind, line } — the line is always plain
// words, never blank. A working seat's line is its activity event's
// own detail when the event carries one, else the stage words the
// in-stream cue uses (ACTIVITY_STAGE_WORDS).
function crewStatus(key, online, now = Date.now()) {
  const cue = activityCue(ws.activity, key, ws.channelId, now);
  const limit = AGENTS.includes(key) ? crewLimit(key) : null;
  if (limit) { const untilText = limit.until ? clock(limit.until) : ''; return { kind: 'limit', line: untilText ? `At its limit until ${untilText}` : 'At its limit' }; }
  if (cue && !ACTIVITY_TERMINAL_STAGES.has(cue.stage)) {
    const detail = typeof cue.detail === 'string' ? cue.detail.trim() : '';
    const words = ACTIVITY_STAGE_WORDS[cue.stage] ?? 'working on it';
    return { kind: 'working', line: detail || `${words.charAt(0).toUpperCase()}${words.slice(1)}` };
  }
  if (!online) return { kind: 'offline', line: 'Offline' };
  if (cue) {
    const words = ACTIVITY_STAGE_WORDS[cue.stage] ?? 'working on it';
    return { kind: 'live', line: `${words.charAt(0).toUpperCase()}${words.slice(1)}` };
  }
  return { kind: 'live', line: 'Standing by' };
}
// --- composer targeting, driven from the rail ---
// There is no separate target state to keep: send() posts the
// composer's text, and routing (addressed / deskTargets — the client
// mirrors of the server's rules) parses the @mentions out of that
// text. The pill strip wrote the text with insertMention() — a
// leading `@Name ` prefix in #maestro-input — and the rail writes the
// exact same text the exact same way, so the send path is untouched.
// Picking a seat first strips any leading @tags the rail (or the old
// pills) put there, so a click always leaves exactly one target.
function crewTagName(key) {
  if (key === 'all') return 'all';
  if (NAMES[key]) return NAMES[key];
  return key; // a custom agent is targeted by its handle
}
function crewKnownTags() {
  const map = new Map([['all', 'all']]);
  for (const p of AGENTS) { map.set(p, p); map.set(NAMES[p].toLowerCase(), p); }
  for (const [word, p] of Object.entries(ALIAS)) map.set(word, p);
  for (const ca of ws.config?.customAgents ?? []) if (ca.handle) map.set(String(ca.handle).toLowerCase(), ca.handle);
  return map;
}
function crewLeadingTargets() {
  const box = $('maestro-input');
  if (!box) return [];
  const known = crewKnownTags();
  const out = [];
  let rest = box.value;
  let m;
  while ((m = rest.match(/^@([A-Za-z0-9_-]+)[ \t]+/))) {
    const key = known.get(m[1].toLowerCase());
    if (!key) break;
    out.push(key);
    rest = rest.slice(m[0].length);
  }
  return out;
}
function stripCrewLeadingTargets() {
  const box = $('maestro-input');
  if (!box) return;
  const known = crewKnownTags();
  let rest = box.value;
  let m;
  while ((m = rest.match(/^@([A-Za-z0-9_-]+)[ \t]+/)) && known.has(m[1].toLowerCase())) rest = rest.slice(m[0].length);
  box.value = rest;
}
function setCrewTarget(key) {
  if (!$('maestro-input')) return;
  stripCrewLeadingTargets();
  insertMention(crewTagName(key));
  syncCrewSelection();
}
// The whole-crew row reads selected when nothing leads the draft (the
// default) or when @all leads it; a seat row reads selected when its
// tag leads the draft. Derived from the draft text itself, so hand
// edits and pill-era drafts show the same truth the send will use.
function crewRowSelected(key, targets) {
  if (key === 'all') return targets.length === 0 || (targets.length === 1 && targets[0] === 'all');
  return targets.includes(key);
}
function syncCrewSelection() {
  const list = $('ew-crew-list');
  if (!list) return;
  const targets = crewLeadingTargets();
  for (const row of list.querySelectorAll('.ew-crew-row[data-provider]')) {
    const on = crewRowSelected(row.getAttribute('data-provider'), targets);
    row.classList.toggle('selected', on);
    row.setAttribute('aria-pressed', String(on));
  }
}
function crewRow({ key, name, faceImg, status, motionStage, title }) {
  const selected = crewRowSelected(key, crewLeadingTargets());
  return h('button', { type: 'button', class: `ew-crew-row${selected ? ' selected' : ''}`, 'data-provider': key, 'aria-pressed': String(selected), title, onclick: () => setCrewTarget(key) },
    crewFaceNode(faceImg, status.kind, motionStage),
    h('span', { class: 'ew-crew-text' },
      h('span', { class: 'ew-crew-name' }, name),
      h('span', { class: 'ew-crew-line' }, status.line)));
}
function renderCrew(roster, customList, states, desk) {
  const list = $('ew-crew-list');
  if (!list) return;
  const total = roster.length + customList.length;
  const titleEl = $('ew-crew-title');
  if (titleEl) titleEl.textContent = total ? `CREW — ${total} IN THIS CHANNEL` : 'CREW';
  const entries = [];
  roster.forEach((p, i) => {
    const status = crewStatus(p, states[p].state !== 'offline');
    entries.push({ rank: CREW_RANK[status.kind], order: i, make: () => { const stage = activityMotionStage(ws.activity, p, ws.channelId); return crewRow({ key: p, name: NAMES[p], faceImg: crewSeatFaceClip(p, stage), status, motionStage: stage, title: desk ? `Dispatch to ${NAMES[p]} — your message goes to this seat` : `Target ${NAMES[p]} — your message goes to this seat` }); } });
  });
  customList.forEach((ca, i) => {
    const status = crewStatus(ca.handle, ws.online.has(ca.provider) || ca.provider === 'ollama');
    entries.push({ rank: CREW_RANK[status.kind], order: roster.length + i, make: () => crewRow({ key: ca.handle, name: ca.name, faceImg: emojiNode(ca.emoji || '🤖'), status, motionStage: activityMotionStage(ws.activity, ca.handle, ws.channelId), title: `Target ${ca.name} (@${ca.handle})` }) });
  });
  entries.sort((a, b) => a.rank - b.rank || a.order - b.order);
  const ownerRow = crewRow({ key: 'all', name: 'Whole crew', faceImg: crewOwnerFaceClip(null), status: { kind: 'live', line: desk ? 'Everyone on the desk' : 'Everyone in this channel' }, motionStage: null, title: desk ? 'Dispatch to everyone on the desk' : 'Target the whole crew — clears a single-seat target' });
  const activeKey = document.activeElement?.classList?.contains('ew-crew-row') ? document.activeElement.getAttribute('data-provider') : null;
  list.replaceChildren(ownerRow, ...entries.map((e) => e.make()),
    ...(total ? [] : [h('p', { class: 'ew-note' }, desk ? 'No agents on the desk yet. Add one from the row below.' : 'No agents in this channel yet. Add one from the row below.')]));
  if (activeKey) for (const row of list.querySelectorAll('.ew-crew-row')) if (row.getAttribute('data-provider') === activeKey) { row.focus({ preventScroll: true }); break; }
}

// The add-render peek decision (channels-pane bite, 2026-11-11):
// the channels pane's peek survives an add-list rebuild only when
// the pane was resting as the rail AND peeking AND the rebuild is
// about to destroy a focused node inside it — the three facts
// renderAgents holds at the rebuild. Pure, so it is unit tested;
// renderAgents applies it.
export function addRenderKeepsPeek({ railRest = false, peeking = false, focusInside = false } = {}) {
  return Boolean(railRest && peeking && focusInside);
}

function renderAgents() {
  const desk = inMaestroMode();
  const raw = (ws.config?.agents ?? []).map((a) => a.provider);
  const customList = ws.config?.customAgents ?? [];
  const roster = deskRoster(raw);
  const states = agentStates(ws.messages, roster, ws.online, Date.now(), desk ? deskTargets : addressed);
  // The CREW rail (sidebar) is the seat surface now — the Agents
  // pane's cards and the composer's pill strip are gone (bite 1),
  // and the pane itself is gone (panes removal, 2026-11-08): the
  // member count rides the CREW title, and the add-pills live
  // under the crew list in the same rail (#ew-crew-add).
  renderCrew(roster, customList, states, desk);
  // Panel-stays-open fix (2026-11-10): the add list rebuilds on every
  // render, and the pill that was clicked is one of the nodes the
  // rebuild destroys — an added seat leaves the list. A destroyed
  // focused node drops focus to <body>, and the channels pane reads
  // focus leaving as a close: its focusout handler drops the rail
  // peek, so the panel shut on every add and the owner had to reopen
  // it per agent. Remember a focused pill and land focus on its
  // successor in the same pass — the same pill when it survives (a
  // render the click did not cause), else the create pill, which
  // always renders. renderCrew does the same for crew rows above;
  // this is the add list's half of that discipline.
  //
  // Peek trap (channels-pane bite, 2026-11-11): the restore below
  // is not enough on its own in the rail-rest state — the state
  // the pane rests in. Destroying the focused pill drops focus to
  // <body> inside replaceChildren, the pane's focusout handler
  // (wireChannelsRail) reads that as a close and drops the peek,
  // and a rail-rest pane without the peek hides every child but
  // the rail tab (envoy.css: .rail-rest:not(.peeking) > * is
  // display:none) — so the successor stands in a display:none
  // subtree when its focus() runs, the focus lands nowhere, no
  // focusin ever brings the peek back, and the pane stays shut.
  // The picker rows never hit this: renderPicker rebuilds inside
  // a panel that stays visible throughout. Here the peek is
  // remembered before the rebuild and put back before the
  // successor is focused, so the successor is rendered when its
  // focus() runs. The close was never load-bearing: the added
  // agent's armed state arrives from changeAgent's own config
  // and message re-reads, not from the pane closing.
  const addBox = $('ew-crew-add');
  const focusedPill = addBox && document.activeElement && addBox.contains(document.activeElement) ? document.activeElement : null;
  const focusedAdd = focusedPill ? focusedPill.getAttribute('data-provider') : null;
  const channelsPane = $('ew-channels');
  const wasPeeking = addRenderKeepsPeek({
    railRest: Boolean(channelsPane?.classList.contains('rail-rest')),
    peeking: Boolean(channelsPane?.classList.contains('peeking')),
    focusInside: Boolean(focusedPill),
  });
  addBox.replaceChildren(
    ...AGENTS.filter((p) => !roster.includes(p) && p !== 'maestro').map((p) => h('button', { type: 'button', class: 'ew-pill', 'data-provider': p, title: desk ? `Add ${NAMES[p]} to the desk — it receives your dispatches` : `Add ${NAMES[p]} to this channel — it answers here`, onclick: () => changeAgent('add-agent', p) }, seatFaceImg(p), `+ ${NAMES[p]}`)),
    h('button', { type: 'button', class: 'ew-pill create-custom', title: 'Create a custom agent with emoji, name, job & AI provider', onclick: openCreateAgentModal }, '✨ + Custom Agent')
  );
  if (focusedPill) {
    if (wasPeeking) channelsPane.classList.add('peeking');
    const next = (focusedAdd && addBox.querySelector(`[data-provider="${focusedAdd}"]`)) || addBox.querySelector('.create-custom');
    if (next) next.focus({ preventScroll: true });
  }
}
async function changeAgent(action, provider) {
  try {
    const body = await ws.ctx.post('/api/admin/envoy/channel-config', { action, channelId: ws.channelId, provider });
    ws.config = body.config; ws.configured = true;
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

// ---------- composer mention buttons (mention-buttons bite, 2026-11-08) ----------
// Two quiet buttons in the composer row for a voice-first owner who
// should never have to hunt a keyboard for "@": "@all" targets the
// whole crew through the exact crew-rail path (setCrewTarget('all') —
// strips any leading single-seat tag, then insertMention('all') writes
// the leading `@all ` the send path's mentions() parses), and "@"
// inserts a bare "@" at the caret for the name to follow. There is NO
// mention autocomplete in the room today (the only composer menu is
// the "/" slash menu), so the "@" button deliberately just inserts —
// no picker is invented here. mentionAtInsert is the pure caret math
// behind it, unit-tested.
export function mentionAtInsert(value, start, end, insert = '@') {
  const v = String(value ?? '');
  const s = Math.max(0, Math.min(typeof start === 'number' ? start : v.length, v.length));
  const e = Math.max(s, Math.min(typeof end === 'number' ? end : s, v.length));
  return { value: v.slice(0, s) + insert + v.slice(e), caret: s + insert.length };
}
function insertAtSignAtCaret() {
  const box = $('maestro-input');
  if (!box) return;
  const next = mentionAtInsert(box.value, box.selectionStart, box.selectionEnd, '@');
  box.value = next.value;
  box.setSelectionRange(next.caret, next.caret);
  // The box's own 'input' listener grows it and re-syncs crew targeting.
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.focus();
}

// The spoken-mention tag table derived from THIS module's seat
// registry (AGENTS + NAMES + ALIAS, plus custom-agent handles) — the
// same shape as SPOKEN_MENTION_TAGS in web/shared/voice-dictation.mjs,
// which carries the built-in table for the dictation insert path in
// app.js (app.js cannot import this module's registry: it lazy-loads
// envoy-workspace for mountWorkspace only, and inlines the voice
// module instead). Exported so tests can pin the two tables together
// on the core seats, and so a future caller with the live registry
// (custom handles included) can build the exact table.
export function spokenMentionTags(customAgents = []) {
  const tags = { all: 'all', everyone: 'all', here: 'all' };
  for (const p of AGENTS) if (NAMES[p]) { tags[p] = NAMES[p]; tags[NAMES[p].toLowerCase()] = NAMES[p]; }
  for (const [word, p] of Object.entries(ALIAS)) if (NAMES[p]) tags[word] = NAMES[p];
  for (const ca of customAgents ?? []) if (ca?.handle) tags[String(ca.handle).toLowerCase()] = String(ca.handle);
  return tags;
}

// ---------- composer "+" menu: pick a seat, then that seat's own menu (bite 3R-b) ----------
// The channel composer's one "+" menu. Troy's shape for it
// (2026-11-08): press +, pick your agent, then THAT agent's own menu
// opens — one small popup at the button, in the seat vendor's own
// words and order, as close to the vendor's own product as the room
// can honestly run. The menu DEFINITIONS are connector-menu.mjs
// (bite 3R-a, frozen): per seat, the items and their order. The row
// STATE comes from connector-panel.mjs — its Level 1 / Level 2
// models stay the single source of row state — and the toggle store
// is bite 3's shape, re-homed by bite A2 (Amendment 1 §2.3): the
// Connectors list is a STANDING toggle list. Toggles are held per
// (seat, channel) in ws.connectorToggles, persisted on the channel's
// own config through the channel-config road (action
// 'set-armed-connectors') and hydrated back from it on every config
// load, so the set survives reloads and follows the channel, never
// another seat's list or another channel's (SPEC §1.6/§3.4). Every
// message the composer sends carries the set's still-connected
// pairs as metadata.connectors; a send consumes nothing. What a
// flip does NOT do yet, stated plainly: nothing on the turn path
// reads the armed set — the connectorArming seam is unwired until
// Mirror M3's G4 — so an armed connector's tools do not join a turn
// on the strength of this list. The switch records the channel's
// choice, and the chips below show it; that is the whole effect
// today. Closing the menu (the button, Escape, an outside press,
// or the send) never touches the composer text; nothing in this
// section writes to the draft boxes.
//
// What the old full-width panel carried that this menu does not —
// named, not silently dropped (the frozen definitions have no row
// for either, and this bite does not fork them):
// - By-name skill attach and bridge-plugin attach (the old per-agent
//   groups). Skills ride the room's slash road now: type /name — the
//   slash menu below is that road, and the road Troy settled for
//   Helmian's own skills. Plugin attach has no seat-menu home yet;
//   it waits on a definition, not a workaround.
// - Registry connectors as note-only attachments (the old CONNECTORS
//   group). The library toggles are the connector road now: an armed
//   Helmian-brokered connector rides every message as
//   metadata.connectors, which the note-only attach never did — and
//   its tools join the turn when the arming seam is wired (M3 G4),
//   per the honesty note above.
// The session console's "+" keeps its own panel (app.js): a console
// message addresses ONE session agent and its send carries no
// connector toggles, so this menu's toggles would arm nothing there —
// the console keeps the bridge attach panel its send can honour.
// Same bare "+" face, different job.

const PICKER_IDS = {
  channel: { panel: 'ew-picker', chips: 'ew-attach-chips' },
};

// Which agent a composer is talking to, in workspace agent keys — or
// null for the shared picker. Pure, so it is unit tested: a 'cli'
// caller talks to its picked agent ('maestro' is the human's own seat, so
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
  // The channel's standing armed set shows as chips above the
  // message box (Amendment 1 §2.3): one chip per armed connector,
  // each with its remove control — the × flips the same toggle the
  // menu's switch flips, and persists it the same way. The chips do
  // NOT leave with a send; the set stands until flipped off. A pair
  // whose connector the seat's loaded library read no longer shows
  // as connected (disconnected, or the connection now needs
  // reconnect) wears no chip — the stored pair stays in the config
  // but rides nothing and promises nothing, exactly as the send
  // path treats it. The names come from the library reads — a
  // toggle can only exist for a row the panel showed.
  for (const { seatId, entryId } of connectorsForTurn(ws.connectorToggles, conversationIdFor(which))) {
    const library = ws.libraryFacts?.libraries?.[seatId];
    if (library && !library.error) {
      const row = library.rows.find((r) => r.entryId === entryId);
      if (!row || row.state !== 'connected' || row.brokerMode !== 'helmian') continue;
    }
    const name = ws.libraryFacts?.names?.[`${seatId}:${entryId}`] ?? entryId;
    chips.push(h('span', { class: 'ew-chip connector' },
      name,
      h('button', { type: 'button', class: 'ew-chip-x', title: `Turn ${name} off in this channel`, 'aria-label': `Turn ${name} off`, onclick: () => { ws.connectorToggles = toggleConnector(ws.connectorToggles, conversationIdFor(which), seatId, entryId); void persistArmedConnectors(); renderAttachChips(which); if (ws.pickerFor === which) renderPicker(which); } }, '×')));
  }
  // Helmian skills armed from the "/" menu's Skills group ride the
  // next message the same way (metadata.skills): one chip each —
  // "/name" for every agent, "/name → Seat" for one seat — gone with
  // the send (or the ×).
  for (const { skillId, seatId } of ws.skillAttach[which]) {
    const label = seatId === 'all' ? `/${skillId}` : `/${skillId} → ${skillSeatLabel(seatId)}`;
    chips.push(h('span', { class: 'ew-chip helmian-skill' },
      label,
      h('button', { type: 'button', class: 'ew-chip-x', title: `Remove the ${skillId} skill from this message`, 'aria-label': `Remove skill ${skillId}`, onclick: () => { ws.skillAttach[which] = removeSkillAttach(ws.skillAttach[which], { skillId, seatId }); renderAttachChips(which); } }, '×')));
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
  // The menu always opens on Level 1 (pick the seat).
  ws.libraryPanel = { level: 1, seatId: null, sub: null };
  await renderPicker(which);
}

// ---------- the menu's data: per-seat connector libraries (SPEC §1.1, bite 3) ----------
// The reads behind both levels. Level 1 picks the seat (face, name,
// connected count); Level 2 is that seat's library, read from
// GET /api/admin/connector-library (the Bite 2 read behind the Bite 3
// route). The scope a composer's toggles belong to: the open channel
// — the standing set is the channel's, so the scope key names it
// (menu, chips and send all read the same scope).
function conversationIdFor(which) {
  return `channel:${ws.channelId ?? 'none'}`;
}
async function loadLibraryFacts() {
  if (ws.libraryFacts && Date.now() - ws.libraryFactsFetchedAt < LIBRARY_STALE_MS) return ws.libraryFacts;
  if (ws.libraryLoading) return ws.libraryLoading;
  ws.libraryLoading = (async () => {
    // A refresh keeps the per-seat libraries and names the session
    // already holds — those carry their own staleness clocks (fix D);
    // only the seat list and its counts are re-read here.
    const prior = ws.libraryFacts;
    const facts = { seats: [], libraries: prior?.libraries ?? {}, names: prior?.names ?? {}, error: false };
    try {
      const body = await ws.ctx.api('/api/admin/connector-library/seats');
      facts.seats = Array.isArray(body?.seats) ? body.seats : [];
    } catch { facts.error = true; }
    // A failed refresh keeps the last good facts rather than blanking
    // the menu; the fetch clock still advances, so a down read is not
    // retried on every open inside the window.
    if (facts.error && prior) {
      ws.libraryFactsFetchedAt = Date.now();
      return prior;
    }
    ws.libraryFacts = facts;
    ws.libraryFactsFetchedAt = Date.now();
    return facts;
  })();
  try {
    return await ws.libraryLoading;
  } finally {
    ws.libraryLoading = null;
  }
}
// A cached seat library is served for a short window only (fix D).
// The store can change under an open page — a connector connected
// from another surface, an operator catalog refresh — and a cache
// with no invalidation hides the change until a full page reload:
// the Idiolect row, created mid-session on 2026-11-09, stayed
// invisible in a tab opened earlier for exactly this reason. Past
// the window the next load re-reads; inside it the cache stands.
// No polling, no timers — the check rides the surface opens that
// already call this loader.
//
// THE WORKSPACE SET RULE (sync S2b): connections are the person's
// workspace set, not one agent's — a connector write made through
// ANY agent's panel in this session (connect, disconnect, a
// posture or tool-enable write, a key store or replace, a custom
// entry created or removed) changes what EVERY agent's library
// read answers. So a write invalidates every seat's cached
// library at once (invalidateAllSeatLibraries below): each seat's
// fetch stamp is zeroed, the Level 1 facts stamp is zeroed (its
// counts ride the same set), and the write's own time is kept in
// ws.libraryWriteAt. seatLibraryStale then refuses any copy
// fetched before that write, however fresh its 60-second window
// still is — so a Connectors level opened after a write in this
// session always re-reads, and a stale set can never be served on
// open. The server read itself is always fresh; this rule governs
// only this session's cached copies.
export const LIBRARY_STALE_MS = 60_000;
function seatLibraryStale(seatId, now) {
  if (!ws.libraryFacts?.libraries?.[seatId]) return true;
  const fetchedAt = ws.libraryFetchedAt[seatId] ?? 0;
  if (fetchedAt < (ws.libraryWriteAt ?? 0)) return true;
  return now - fetchedAt >= LIBRARY_STALE_MS;
}
// Every connector write the panel makes lands here first (the
// write sites in this file call it on success, before any
// re-read): all seats' cached libraries are stale from this
// moment, the acted-on seat included — its own write site
// re-reads it straight away, so its fresh copy carries a fetch
// stamp at or after the write and stands.
export function invalidateAllSeatLibraries(now = Date.now()) {
  ws.libraryWriteAt = now;
  for (const seatId of Object.keys(ws.libraryFetchedAt)) ws.libraryFetchedAt[seatId] = 0;
  ws.libraryFactsFetchedAt = 0;
}
export async function loadSeatLibrary(seatId, now = Date.now()) {
  const facts = await loadLibraryFacts();
  if (facts.libraries[seatId] && !seatLibraryStale(seatId, now)) return facts.libraries[seatId];
  // One read per seat in flight (boot-load fix, 2026-11-11): the
  // mount preload and a panel open can ask for the same seat in the
  // same moment; both join the read already running instead of the
  // second firing a duplicate. The in-flight entry clears when the
  // read settles — the staleness window above governs every later
  // load exactly as before.
  if (ws.librarySeatLoading[seatId]) return ws.librarySeatLoading[seatId];
  const loading = (async () => {
    let library;
    try {
      const body = await ws.ctx.api(`/api/admin/connector-library?seat=${encodeURIComponent(seatId)}`);
      library = { seatId, connectedCount: body?.connectedCount ?? 0, rows: Array.isArray(body?.rows) ? body.rows : [] };
      for (const key of Object.keys(facts.names)) if (key.startsWith(`${seatId}:`)) delete facts.names[key];
      for (const row of library.rows) facts.names[`${seatId}:${row.entryId}`] = row.name;
    } catch {
      library = { seatId, connectedCount: 0, rows: [], error: true };
    }
    facts.libraries[seatId] = library;
    // The key-kind seed (panel key-seed bite): each read row carries
    // its entry's authMode from its definition, so the panel learns
    // which entries take a key from the read itself — a header entry
    // connected in an earlier session shows Replace in this fresh
    // session, with no connect attempt. Rows without the field seed
    // nothing and the panel learns from connect answers exactly as
    // before (connector-key-form.mjs's known set carries the rules).
    ws.keyForm.known = seedKnownKeyEntries(ws.keyForm.known, library.rows);
    ws.libraryFetchedAt[seatId] = now;
    return library;
  })();
  ws.librarySeatLoading[seatId] = loading;
  try {
    return await loading;
  } finally {
    if (ws.librarySeatLoading[seatId] === loading) delete ws.librarySeatLoading[seatId];
  }
}
// The mount preload (speed fix, 2026-11-09): the plus menu used to
// start its reads on first open and paint "Loading libraries…" while
// they ran. mountWorkspace fires this once per session instead — the
// same loaders, the same caches, started early: the seats facts, the
// plugins list and the skills list land while the workspace settles,
// then every seat's library prefetches in the background as ONE
// batch. Opening the menu afterwards paints from memory with the
// library's own joined states; the loaders' staleness windows still
// govern every later refresh, and a cold first open (the preload has
// not landed yet) keeps the loading line exactly as before. Nothing
// here is awaited by the mount.
//
// The batch shape (boot-load fix, 2026-11-11): the prefetch used to
// walk the seats strictly one at a time — each seat's read waited
// for the seat before it — so on a cold start the chain summed
// every seat's seconds: the production log for 2026-11-11
// 18:04:59–18:06:46 MST shows the fourteen seat reads landing one
// after another, 1.8 s growing to 27 s apiece, ~135 s for the chain.
// One batch fires them together; the wall clock is the slowest
// single read, not the sum, and loadSeatLibrary's in-flight share
// means a panel open during the batch joins the running read
// instead of doubling it. The per-open fan-out the read-perf fix
// removed stays removed: an open still reads only its own seat.
export function preloadLibrarySession() {
  if (!ws.ctx?.api || ws.libraryPreloadStarted) return;
  ws.libraryPreloadStarted = true;
  void loadBridgePlugins().catch(() => {});
  void loadSkills().catch(() => {});
  void (async () => {
    const facts = await loadLibraryFacts().catch(() => null);
    if (!facts || facts.error) return;
    await Promise.allSettled(facts.seats.map((seat) => loadSeatLibrary(seat.seatId)));
  })();
}
// The test seam for the session caches above: installs the read
// context and clears every cached copy, so tests drive the real
// loaders end to end against a fake read.
export function resetLibrarySession(ctx) {
  ws.ctx = ctx;
  ws.libraryFacts = null;
  ws.libraryLoading = null;
  ws.librarySeatLoading = {};
  ws.libraryFetchedAt = {};
  ws.libraryFactsFetchedAt = 0;
  ws.libraryWriteAt = 0;
  ws.libraryPreloadStarted = false;
  ws.toolAccess = { open: false, seatId: null, entryId: null, model: null, loading: false, saving: false, error: '' };
  ws.keyForm = { openFor: null, model: null, saving: false, error: '', known: {} };
  ws.customForm = { open: false, seatId: null, model: null, saving: false, error: '', created: null };
  ws.customRemove = { confirmFor: null, model: null, removing: false, error: '' };
  ws.skills = { list: null, loaded: false, loading: null };
  ws.plugins = { list: null, unavailable: [], loaded: false, loading: null };
}
// A seat's face on the crew tile: the library-pack still by seat slug
// (the pack's slugs ARE the library seat ids), falling back to the
// seat's workspace face, then its initial — the crewFaceImg chain, so
// a missing asset never leaves an empty slot.
function librarySeatFace(seatId) {
  const provider = providerForSeat(seatId);
  return h('span', { class: 'ew-lib-face' }, crewFaceImg(seatId, () => (provider ? seatFaceImg(provider) : h('span', { class: 'ew-crew-initial' }, seatName(seatId).slice(0, 1)))));
}
// A library row's icon tile (§1.2 field 1). iconRef names the
// service's own mark as a stored asset ('icon:<slug>'); the marks are
// not in the app yet, so the tile carries the service's initial on the
// same consistent tile every row wears — never a borrowed logo.
function libraryIconTile(row) {
  return h('span', { class: 'ew-lib-icon', 'aria-hidden': 'true' }, (row.name ?? '?').slice(0, 1).toUpperCase());
}
function libraryRowNode(which, row, { shape = null } = {}) {
  const vendorLine = row.mirror
    ? `${row.vendorLabel} · ${row.trustText} · Managed in ${row.mirror.managedIn}`
    : `${row.vendorLabel} · ${row.trustText}`;
  const text = h('span', { class: 'ew-lib-text' },
    h('span', { class: 'ew-lib-name' }, row.name),
    h('span', { class: 'ew-lib-line' }, row.oneLiner),
    h('span', { class: 'ew-lib-line' }, vendorLine));
  // The removal control (panel-native home bite 4): a custom
  // entry's row — and only a custom entry's row — carries the
  // removal control under it (customRemoveNode below). The model
  // rules on the row's own facts (row.kind, row.brokerMode,
  // row.mirror): catalog and Helmian entries carry none, because
  // the removal road refuses them, and a mirror row carries none,
  // because a mirror's state lives in the vendor's own product.
  const removeModel = customRemoveModel({
    seatId: row.seatId, entryId: row.entryId, name: row.name,
    kind: row.kind, brokerMode: row.brokerMode, mirror: row.mirror,
  });
  const withRemove = (node) => (removeModel
    ? h('div', { class: 'ew-picker-group' }, node, customRemoveNode(which, row, removeModel))
    : node);
  if (row.toggleable) {
    // The state line stands in the text block as its own line, and
    // the word beside the switch comes from the switch's own source
    // (row.on — armed in THIS channel) and nothing else (owner
    // report, 2026-11-10: the switch rendered OFF beside the words
    // "Connected as …" because the trailing word borrowed the
    // connection's state label while the switch drew the channel's
    // armed state — two sources in one slot, and the row read as a
    // lie).
    text.append(h('span', { class: 'ew-lib-line ew-lib-state' }, row.stateLabel));
    const toggleRow = h('button', { type: 'button', class: `ew-picker-row${row.on ? ' on' : ''}`, title: row.on ? `${row.name} is on in this channel — tap to turn it off` : `Turn ${row.name} on in this channel`, onclick: () => {
      ws.connectorToggles = toggleConnector(ws.connectorToggles, conversationIdFor(which), row.seatId, row.entryId);
      // The flip persists to the channel's config before anything
      // else renders from it (bite A2); a failed save reverts the
      // store and re-renders, inside persistArmedConnectors.
      void persistArmedConnectors();
      renderAttachChips(which); renderPicker(which);
    } }, libraryIconTile(row), text,
      h('span', { class: 'ew-lib-switch', 'aria-hidden': 'true' }),
      h('span', { class: `ew-picker-state ${row.on ? 'on' : 'off'}` }, row.on ? 'On' : 'Off'));
    // A connected entry the panel knows takes a key — seeded
    // from the library read's authMode when the seat's library
    // loaded, or taught by a connect start's needs-credential
    // answer this session — carries the key form's Replace row
    // under its switch — see keyFormNode. An entry known from
    // neither source carries nothing extra: the panel invents no
    // key-kind it was not told.
    const key = keyEntryKey(row.seatId, row.entryId);
    if (!key || !ws.keyForm.known[key]) return withRemove(toggleRow);
    const formOpen = ws.keyForm.openFor === key;
    const replaceRow = h('div', { class: 'ew-picker-row ew-lib-row' },
      h('span', { class: 'ew-lib-text' },
        h('span', { class: 'ew-lib-name' }, 'Key or token'),
        h('span', { class: 'ew-lib-line' }, row.stateLabel)),
      h('button', { type: 'button', class: 'ew-lib-connect', title: `Replace the key for ${row.name}`, onclick: () => { openKeyForm(which, row, { connected: true }); renderPicker(which); } }, 'Replace key'));
    return withRemove(formOpen
      ? h('div', { class: 'ew-picker-group' }, toggleRow, replaceRow, keyFormNode(which, row))
      : h('div', { class: 'ew-picker-group' }, toggleRow, replaceRow));
  }
  if (row.connectable) {
    // The Connect button the owner ordered on this panel
    // (2026-11-10): it starts the connector library's
    // connect-start — see startPanelConnect.
    const connectRow = h('div', { class: 'ew-picker-row ew-lib-row' }, libraryIconTile(row), text,
      h('span', { class: 'ew-picker-state off' }, row.stateLabel),
      h('button', { type: 'button', class: 'ew-lib-connect', title: `Connect ${row.name} for your workspace — every agent shares it`, onclick: () => { void startPanelConnect(which, row); } }, row.reconnect ? 'Reconnect' : 'Connect'));
    // The key form, when this entry's connect start opened it,
    // expands under its own row in the panel (keyFormNode below).
    if (ws.keyForm.openFor === keyEntryKey(row.seatId, row.entryId) && ws.keyForm.model) {
      return withRemove(h('div', { class: 'ew-picker-group' }, connectRow, keyFormNode(which, row)));
    }
    // A refused connect start's words paint under its own row in
    // the panel's note style (startPanelConnect records them on
    // ws.connectErrors), the same expand-in-place shape as the
    // key form above.
    const connectError = ws.connectErrors[keyEntryKey(row.seatId, row.entryId)];
    if (connectError) {
      return withRemove(h('div', { class: 'ew-picker-group' }, connectRow, h('p', { class: 'ew-note' }, connectError)));
    }
    return withRemove(connectRow);
  }
  if (row.mirror) {
    // A mirror row is never a button Helmian can't honour (§1.5):
    // the connection lives in the seat's own product, so the button
    // this row CAN honour opens the seat's account page in Helmian —
    // the Agents tab, where the seat's own sign-in is managed — and
    // never a link out to the vendor (Troy's ruling, 2026-11-08).
    // The same-name Helmian-brokered entry, when the library holds
    // one, stands in this panel with the real Connect. The row
    // states that plainly in its title and its trailing word; the
    // state it shows is the state the vendor side last reported.
    return h('button', { type: 'button', class: `ew-picker-row ew-lib-row mirror${shape === 'state' ? ' state' : ''}`, title: `${row.name} is managed in ${row.mirror.managedIn}, not in Helmian — open Helmian's Agents page for ${seatName(row.seatId)}'s account`, onclick: () => openManageForSeat(which) }, libraryIconTile(row), text,
      h('span', { class: `ew-picker-state ${row.state === 'connected' ? 'on' : 'off'}` }, row.stateLabel),
      h('span', { class: 'ew-picker-state off' }, 'Open'));
  }
  return withRemove(h('div', { class: 'ew-picker-row ew-lib-row' }, libraryIconTile(row), text,
    h('span', { class: 'ew-picker-state off' }, row.stateLabel)));
}

// The words a refused connect start paints: the server's own
// plain-language error when the answer carried one (the write
// route sends { error } and the shell's api() throws with that
// parsed body on the error's .body), else the panel's generic
// refusal. Pure, so the wording contract is unit-tested.
export function connectFailureMessage(error, name) {
  return error?.body?.error || `Could not start ${name}. Try again.`;
}

// The panel's Connect button (owner order, 2026-11-10): the same
// library connect-start the connector library routes serve. The
// answers are handled in the panel: a no-sign-in connector lands
// connected on the spot (the panel re-reads the seat's library and
// repaints); an OAuth connector answers with the service's own
// sign-in door and the person is handed that door; a sign-in
// Helmian cannot broker yet says so in the route's own words; a
// key connector needs its key — that answer opens the key form
// under the entry's own row in this panel (openKeyForm below;
// panel-native home bite 2). Every other answer's handling is
// exactly what it was before the form landed. A key entry the
// library read already seeded (its row carries authMode 'header')
// never makes this trip at all: its Connect opens the form from
// the seed, and the connect answers that do happen fold into the
// known set as the live truth (noteConnectAnswer).
async function startPanelConnect(which, row) {
  // A read-seeded key entry opens its key form on Connect
  // directly — the library read already named its auth mode, so
  // the connect start's round trip would only repeat it. The
  // seed is the read's word, not the road's: the first connect
  // answer this entry actually gets still re-rules the known set
  // (noteConnectAnswer below).
  // The one row the seed shortcut must NOT serve (sync S2c): a
  // gate missing on this seat — a custom entry projected from the
  // agent it was created on, holding no gate row here. Its
  // Connect promises, in the row's own words, that connecting
  // runs its safety check for this agent, and the connect start
  // below is the road that registers and probes this seat's gate
  // (S2a); opening the key form from the seed would skip that
  // start entirely. When the check passes, the start's own
  // needs-credential answer opens the key form through the normal
  // answer path below.
  const gateMissingHere = row.gate?.state === 'missing' && row.gate?.passed !== true;
  if (!gateMissingHere && opensKeyFormFromSeed(ws.keyForm.known, row.seatId, row.entryId)) {
    openKeyForm(which, row, { connected: row.state === 'connected' });
    renderPicker(which);
    return;
  }
  const connectKey = keyEntryKey(row.seatId, row.entryId);
  let out;
  try {
    out = await ws.ctx.post('/api/admin/connector-library/connect', { seatId: row.seatId, entryId: row.entryId });
  } catch (e) {
    // A refused start answers with the server's own plain words
    // (connectFailureMessage). The toast alone cannot carry them
    // here: its node lives in the console view's section, which
    // is hidden whenever this panel is on screen, so from the
    // panel a refused Connect read as silence (the Gamma walk,
    // 2026-11-11: a 502 with plain words in the body, and the
    // panel showed nothing). The refusal also paints under the
    // entry's own row, in the panel's note style, and stays
    // until the entry's next answer (cleared below on any
    // answer that comes back).
    const message = connectFailureMessage(e, row.name);
    if (connectKey) ws.connectErrors[connectKey] = message;
    ws.ctx.toast(message);
    renderPicker(which);
    return;
  }
  if (connectKey) delete ws.connectErrors[connectKey];
  // The live answer outranks the read seed, either way it lands:
  // needs-credential confirms the entry as key-kind from the
  // road's own mouth; any other answer clears a seeded entry the
  // road just declined to treat as one.
  ws.keyForm.known = noteConnectAnswer(ws.keyForm.known, row, out);
  if (out?.status === 'connected') {
    ws.ctx.toast(`${row.name} is connected.`, 'ok');
    invalidateAllSeatLibraries();
    await loadSeatLibrary(row.seatId).catch(() => {});
    renderPicker(which);
    return;
  }
  if (out?.status === 'authorize' && out.authorizeUrl) {
    ws.ctx.toast(out.briefing?.summary || `${row.name} opens its sign-in page — approve it there and the connection lands back here.`);
    window.location.assign(out.authorizeUrl);
    return;
  }
  if (out?.status === 'consent-boundary') {
    ws.ctx.toast(out.note || 'This sign-in cannot be completed inside Helmian yet.');
    return;
  }
  if (isNeedsCredentialAnswer(out)) {
    openKeyForm(which, row, { connected: row.state === 'connected' });
    renderPicker(which);
    return;
  }
  ws.ctx.toast(`${row.name}: ${out?.status ?? 'connect started'}.`);
}

// The key form (panel-native home bite 2): a key-kind entry's
// Connect — the connect start's needs-credential answer — opens
// this form under the entry's own row in the panel, the same
// expand-in-place pattern as the Tool access face
// (connector-key-form.mjs renders the model; this section renders
// its DOM). The key field is write-only: it starts empty every
// time the form is drawn, a stored key is never read back into
// it, and the state the form shows after a write is the write
// road's own returned connection — the panel re-reads the seat's
// library too, so the row's state comes from the same stored
// record. A refused write stays in the form as the server's own
// plain words, and nothing reads connected. A connected key entry
// the panel knows — seeded from the library read's authMode, or
// taught by a connect answer this session — offers Replace (this
// same form, a fresh key through the same road) and the existing
// disconnect, which revokes the stored key before the record
// clears.
function openKeyForm(which, row, { connected = false } = {}) {
  const kf = ws.keyForm;
  const key = keyEntryKey(row.seatId, row.entryId);
  if (!key) return;
  // Opening the form records the entry as known — and keeps the
  // source it was known by: a read seed stays a seed (its Connect
  // keeps opening from the read until a live answer re-rules it),
  // an answer-taught entry stays answer-sourced, and a form opened
  // any other way (the Replace row) counts as learned here.
  kf.known[key] = { seatId: row.seatId, entryId: row.entryId, source: kf.known[key]?.source ?? 'answer' };
  kf.openFor = key;
  kf.model = keyFormModel({
    seatId: row.seatId, entryId: row.entryId, name: row.name, kind: row.kind,
    connected, accountIdentity: row.accountIdentity ?? null,
  });
  kf.error = '';
}
async function saveKeyForm(which, inputs) {
  const kf = ws.keyForm;
  if (!kf.model || kf.saving) return;
  kf.saving = true;
  const result = await submitKeyForm({
    post: (path, body) => ws.ctx.post(path, body),
    model: kf.model,
    values: { apiKey: inputs.apiKey?.value ?? '', accountLabel: inputs.accountLabel?.value ?? '' },
  });
  kf.saving = false;
  if (result.ok) {
    kf.model = result.model;
    kf.error = '';
    ws.ctx.toast(`${result.model.name} is connected.`, 'ok');
    invalidateAllSeatLibraries();
    await loadSeatLibrary(result.model.seatId).catch(() => {});
  } else {
    kf.error = result.error;
  }
  if (ws.pickerFor === which) renderPicker(which);
}
async function disconnectKeyForm(which) {
  const kf = ws.keyForm;
  if (!kf.model || kf.saving) return;
  kf.saving = true;
  const result = await disconnectKeyEntry({
    post: (path, body) => ws.ctx.post(path, body),
    model: kf.model,
  });
  kf.saving = false;
  if (result.ok) {
    kf.model = result.model;
    kf.error = '';
    ws.ctx.toast(result.out?.custodyRevoked
      ? `${result.model.name} is disconnected and its stored sign-in was revoked.`
      : `${result.model.name} is disconnected.`);
    invalidateAllSeatLibraries();
    await loadSeatLibrary(result.model.seatId).catch(() => {});
  } else {
    kf.error = result.error;
  }
  if (ws.pickerFor === which) renderPicker(which);
}
function keyFormNode(which, row) {
  const kf = ws.keyForm;
  const model = kf.model;
  if (!model) return h('p', { class: 'ew-note' }, '');
  const children = [h('p', { class: 'ew-note' }, model.intro)];
  if (model.connected) children.push(h('p', { class: 'ew-note' }, model.stateLine));
  const inputs = {};
  for (const field of model.fields) {
    const input = h('input', {
      type: field.type, class: 'ew-gh-path', placeholder: field.placeholder,
      autocomplete: field.autocomplete, 'aria-label': field.label,
      ...(field.maxLength ? { maxLength: field.maxLength } : {}),
    });
    inputs[field.name] = input;
    children.push(input);
  }
  if (kf.error) children.push(h('p', { class: 'ew-note' }, kf.error));
  const buttons = [h('button', {
    type: 'button', class: 'ew-lib-connect', disabled: kf.saving,
    title: `Store the key and connect ${model.name} for your workspace — every agent shares it`,
    onclick: () => { void saveKeyForm(which, inputs); },
  }, kf.saving ? model.button.pendingLabel : model.button.label)];
  if (model.connected) {
    buttons.push(h('button', {
      type: 'button', class: 'ew-btn sm', disabled: kf.saving,
      title: `Disconnect ${model.name} and revoke its stored key`,
      onclick: () => { void disconnectKeyForm(which); },
    }, 'Disconnect'));
  }
  children.push(h('div', { class: 'ew-gh-bar' }, ...buttons));
  return h('div', { class: 'ew-picker-group ew-key-form' }, ...children);
}

// The Level 2 model: one seat's menu definition composed with that
// seat's library read and the toggle store. Pure, so it is unit
// tested like the models it composes: connector-menu.mjs decides
// shape, order and words; connector-panel.mjs's Level 2 model
// decides row state; this decides only how the two meet on the face.
// Rows are descriptors the renderer maps to nodes:
//   { kind: 'attach', label }
//   { kind: 'capability', label, capability, on }  (web search only)
//   { kind: 'screenshot', label }                  (browser capture)
//   { kind: 'action', label, action }              (github-file)
//   { kind: 'action', label, action:'tool-access', seatId, entries, selectedEntryId, open, libraryState }
//   { kind: 'label', label }                       (a group heading)
//   { kind: 'note', text }
//   { kind: 'toggle' | 'mirror' | 'row' | 'connect', row, rowShape }
//   { kind: 'custom-add', seatId }                (the Connectors list's last row)
//   { kind: 'skill', skillId, name, description, on, disabled }
//   { kind: 'plugin', name, brings, toolCount, on }
//   { kind: 'project', key, name, active }
//   { kind: 'submenu', label, rows, badge? }       (badge = needs-reconnect count)
//   { kind: 'manage', label, target }
// A connector group binds its rows from the read by entry id, in the
// definition's own order. A live-toggle group — the Connectors list —
// carries the seat's WHOLE Helmian-brokered library (owner order,
// 2026-11-10, superseding bite A2's connected-only list): Connected
// rows render as switches in the channel's standing set (Amendment 1
// §2.3), not-connected rows carry a working Connect action, rows that
// can be neither today (owner-disabled, a safety check that ran
// on this seat and did not pass, a local-only entry) stand as
// honest state rows, and library rows no
// menu binds — a person's own entries — join this list so nothing
// the library holds is missing from the panel. Vendor mirrors are
// never offered here; an unbound mirror joins the seat's mirror
// group instead. A live group with nothing to show says so in one
// note. Connector rows seed no drafts: the catalog starter actions
// and the arm-time MCP prompt rows the M2 face rendered under a
// connector are gone with the per-message arming they served. A
// group that resolves to no rows renders one honest note row, never
// a dead control.
// The plugins read's failure line (fix B): the read answers an
// `unavailable` list beside the plugins — every plugin that failed
// to load. When it is non-empty the menu says so in words; an empty
// plugin list with failures behind it never reads as "none
// installed". One wording, shared with the Manage Plugins tab.
export function pluginsUnavailableNote(count) {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return n ? `${n} plugin${n === 1 ? '' : 's'} could not be loaded.` : null;
}

export function plusMenuLevel2Model({ seatId, library = null, toggles = {}, conversationId = '', webSearchOn = false, skills = null, plugins = null, pluginsUnavailable = [], skillAttach = [], attachments = [], projects = null, activeProjectKey = null, toolAccess = null } = {}) {
  const definition = menuForSeat(seatId);
  if (!definition) return null;
  const byId = new Map();
  let level2 = null;
  if (library && !library.error) {
    level2 = level2Model(library, toggles, conversationId);
    for (const row of [...level2.connected, ...level2.catalog]) byId.set(row.entryId, row);
  }
  // The Connectors badge (mirror-design §3.1, bite M2): Troy's
  // Claude.ai shot carries ⚠ 1 on the Connectors row — Canva needs
  // reconnect. Ours is a roll-up over the seat's whole library read:
  // the count of rows whose state is needs-reconnect, whoever holds
  // them. Zero renders no badge — a healthy library wears nothing.
  const reconnectCount = [...byId.values()].filter((row) => row.state === 'needs-reconnect').length;
  const boundRows = (item) => {
    if (!Array.isArray(item.entryIds)) return null;
    const rows = item.entryIds.map((id) => byId.get(id)).filter(Boolean);
    return rows.length ? rows : null;
  };
  // The full-library sweeps (owner order, 2026-11-10): the panel
  // carries every row the seat's library read holds, not only the
  // rows a menu binds. Helmian-brokered rows no menu binds (a
  // person's own entries, a local-only entry) join the seat's
  // Connectors list; vendor rows no menu binds join its mirror
  // group. Each sweep is spent by the first group of its kind, in
  // walk order, so a row still renders exactly once.
  const boundIds = new Set(collectCatalogEntryIds(definition));
  let helmianSweep = [...byId.values()].filter((r) => r.brokerMode === 'helmian' && !boundIds.has(r.entryId));
  let vendorSweep = [...byId.values()].filter((r) => r.brokerMode === 'vendor' && !boundIds.has(r.entryId));
  const feedRows = (item) => {
    const out = [];
    if (item.label) out.push({ kind: 'label', label: item.label });
    if (item.feed === 'helmian-skills') {
      if (!Array.isArray(skills)) { out.push({ kind: 'note', text: 'Loading skills...' }); return out; }
      const mine = skills.filter((s) => s && (s.scope !== 'seats' || (Array.isArray(s.seatIds) && s.seatIds.map(String).includes(seatId))));
      if (!mine.length) { out.push({ kind: 'note', text: `No skills on ${seatName(seatId)}'s shelf yet.` }); return out; }
      for (const s of mine) {
        const skillId = String(s.id ?? '');
        if (!skillId) continue;
        out.push({
          kind: 'skill', skillId, name: String(s.name ?? skillId),
          description: typeof s.description === 'string' ? s.description : '',
          on: (skillAttach ?? []).some((a) => a.skillId === skillId && a.seatId === seatId),
          disabled: s.state === 'disabled-by-owner',
        });
      }
      return out;
    }
    if (item.feed === 'bridge-plugins') {
      if (!Array.isArray(plugins)) { out.push({ kind: 'note', text: 'Loading plugins...' }); return out; }
      const unavailableNote = pluginsUnavailableNote(Array.isArray(pluginsUnavailable) ? pluginsUnavailable.length : 0);
      // The empty note stands only when the read is truly empty —
      // no plugins AND none that failed to load (fix B).
      if (!plugins.length && !unavailableNote) { out.push({ kind: 'note', text: 'No plugins are installed.' }); return out; }
      for (const p of plugins) {
        const name = String(p?.name ?? '').trim().toLowerCase();
        if (!name) continue;
        // The tool count rides only when the plugins read provides
        // one; today's read (installed-plugins.mjs) reports a
        // `tools` boolean and a `brings` line, no count — so the
        // count is null and the row draws none, never an invented
        // number.
        out.push({ kind: 'plugin', name, brings: String(p?.brings ?? ''), toolCount: Number.isSafeInteger(p?.toolCount) ? p.toolCount : null, on: (attachments ?? []).some((a) => a.kind === 'plugin' && a.name === name) });
      }
      if (unavailableNote) out.push({ kind: 'note', text: unavailableNote });
      return out;
    }
    out.push({ kind: 'note', text: 'Nothing here yet.' });
    return out;
  };
  const groupRows = (item, rowShape) => {
    const out = [];
    if (item.label) out.push({ kind: 'label', label: item.label });
    if (item.note) out.push({ kind: 'note', text: item.note });
    if (!Array.isArray(item.entryIds) && item.feed) return [...out, ...feedRows(item).filter((r) => r.kind !== 'label')];
    if (!library) { out.push({ kind: 'note', text: `Loading ${seatName(seatId)}'s library...` }); return out; }
    if (library.error) { out.push({ kind: 'note', text: 'This library could not be loaded.' }); return out; }
    if (item.type === 'live-toggle-group') {
      // The Connectors list (owner order, 2026-11-10): the seat's
      // whole Helmian-brokered library — bound rows in the menu's
      // order, then the unbound sweep. Connected rows are switches
      // (row.toggleable is exactly that test); not-connected rows
      // carry the Connect action (row.connectable); the rest stand
      // as state rows with their true labels. A vendor mirror bound
      // here is not offered: mirrors are the mirror groups' rows.
      let rows = boundRows(item) ?? [];
      if (helmianSweep.length) { rows = [...rows, ...helmianSweep]; helmianSweep = []; }
      const mine = rows.filter((r) => r.brokerMode === 'helmian');
      const toggles = mine.filter((r) => r.toggleable);
      const connects = mine.filter((r) => !r.toggleable && r.connectable);
      const resting = mine.filter((r) => !r.toggleable && !r.connectable);
      if (!toggles.length && !connects.length && !resting.length) {
        out.push({ kind: 'note', text: 'No connectors are connected yet.' });
        out.push({ kind: 'custom-add', seatId });
        return out;
      }
      for (const row of toggles) out.push({ kind: 'toggle', row, rowShape });
      for (const row of connects) out.push({ kind: 'connect', row, rowShape });
      for (const row of resting) out.push({ kind: 'row', row, rowShape });
      // The add-a-custom row (panel-native home bite 3): the
      // Connectors list's last row — where a person adding
      // something new looks is the end of the list it will join.
      // The creation road is owner/admin on the server; a caller
      // the road refuses reads its words in the form, never a
      // hidden row this client cannot ground.
      out.push({ kind: 'custom-add', seatId });
      return out;
    }
    let rows = boundRows(item);
    if (item.type === 'mirror-group' && vendorSweep.length) {
      rows = [...(rows ?? []), ...vendorSweep];
      vendorSweep = [];
    }
    if (!rows || !rows.length) { out.push({ kind: 'note', text: 'Nothing here yet.' }); return out; }
    for (const row of rows) {
      out.push({ kind: row.toggleable ? 'toggle' : row.mirror ? 'mirror' : 'row', row, rowShape });
    }
    if (rowShape === 'state') out.push({ kind: 'note', text: 'On for the whole account — name it in a message to use it.' });
    return out;
  };
  const projectRows = () => {
    if (!Array.isArray(projects)) return [{ kind: 'note', text: 'Loading projects...' }];
    if (!projects.length) return [{ kind: 'note', text: 'No projects in this workspace yet.' }];
    return projects.map((p) => ({ kind: 'project', key: p.key, name: p.name, active: p.key === activeProjectKey }));
  };
  const itemRows = (item) => {
    switch (item?.type) {
      case 'attach': return [{ kind: 'attach', label: item.label }];
      case 'capability':
        // Only web search has a real road in this composer — the
        // per-message webSearch flag every consumer already reads.
        // Any other capability key renders nothing rather than a row
        // the room cannot run for this seat (REPORT §6).
        if (item.capability === 'web-search') return [{ kind: 'capability', label: item.label, capability: item.capability, on: webSearchOn === true }];
        if (item.capability === 'screenshot') return [{ kind: 'screenshot', label: item.label }];
        return [];
      case 'action': {
        if (item.action === 'tool-access') {
          // Tool access (panel-native home bite 1): the row opens
          // THIS seat's tool access face in the panel — the entries
          // it can speak for come from the seat's own library read
          // (connector-tool-access.mjs's entry list over the Level 2
          // model), and the face's open/selected state rides in from
          // the workspace so the model stays pure.
          const entries = level2 ? toolAccessEntries(level2) : [];
          const selected = pickToolAccessEntry(entries, toolAccess?.entryId ?? null);
          return [{
            kind: 'action', label: item.label, action: item.action, seatId,
            entries, selectedEntryId: selected?.entryId ?? null,
            open: toolAccess?.open === true && toolAccess?.seatId === seatId,
            libraryState: !library ? 'loading' : library.error ? 'error' : 'ready',
          }];
        }
        return [{ kind: 'action', label: item.label, action: item.action }];
      }
      case 'projects': return [{ kind: 'submenu', label: item.label, rows: projectRows() }];
      case 'live-toggle-group': return groupRows(item, 'mirror');
      case 'mirror-group': return groupRows(item, item.rowShape ?? 'mirror');
      case 'submenu': {
        // One connector name, one row (menu dedupe, 2026-11-09):
        // a submenu is where a seat's brokered toggles and its
        // vendor mirrors stand in ONE list — the composed rows go
        // through the panel dedupe before they render.
        const rows = dedupePanelConnectorRows((item.items ?? []).flatMap(itemRows));
        const hasConnectorRows = rows.some((r) => r.kind === 'toggle' || r.kind === 'mirror' || r.kind === 'row' || r.kind === 'connect');
        return [{ kind: 'submenu', label: item.label, rows, ...(hasConnectorRows && reconnectCount > 0 ? { badge: reconnectCount } : {}) }];
      }
      case 'manage-link': return [{ kind: 'manage', label: item.label, target: item.target }];
      default: return [];
    }
  };
  return Object.freeze({
    seatId,
    seatName: seatName(seatId),
    // The same one-name-one-row law on the panel's top level,
    // where the plain Helmian lists carry their toggle group.
    rows: Object.freeze(dedupePanelConnectorRows(definition.flatMap(itemRows))),
  });
}

function renderPlusMenuLevel1(which) {
  const facts = ws.libraryFacts;
  if (!facts) {
    void loadLibraryFacts().then(() => { if (ws.pickerFor === which) renderPicker(which); });
    return [h('p', { class: 'ew-note' }, 'Loading libraries...')];
  }
  // Past the staleness window the cached list paints while a refresh
  // runs behind it — the paint-then-refresh shape Level 2 already
  // uses for a seat's own library (fix D's window, now both levels).
  if (Date.now() - ws.libraryFactsFetchedAt >= LIBRARY_STALE_MS) {
    void loadLibraryFacts().then(() => { if (ws.pickerFor === which) renderPicker(which); });
  }
  const model = level1Model(facts.seats);
  const rows = model.rows.map((seat) => h('button', { type: 'button', class: 'ew-picker-row ew-lib-seat', title: `See ${seat.name}'s menu`, onclick: () => {
    ws.libraryPanel = { level: 2, seatId: seat.seatId, sub: null };
    void loadSeatLibrary(seat.seatId).then(() => { if (ws.pickerFor === which) renderPicker(which); });
    renderPicker(which);
  } },
    librarySeatFace(seat.seatId),
    h('span', { class: 'ew-lib-text' }, h('span', { class: 'ew-lib-name' }, seat.name)),
    h('span', { class: 'ew-picker-state' }, seat.connectedCount ? `${seat.connectedCount} connected` : 'None connected')));
  return rows.length ? rows : [h('p', { class: 'ew-note' }, facts.error ? 'The libraries could not be loaded.' : 'No libraries in this workspace yet.')];
}

function renderPlusMenuLevel2(which) {
  const seatId = ws.libraryPanel.seatId;
  const library = ws.libraryFacts?.libraries?.[seatId] ?? null;
  if (!library || seatLibraryStale(seatId, Date.now())) {
    void loadSeatLibrary(seatId).then(() => { if (ws.pickerFor === which) renderPicker(which); });
  }
  // The feed-bound groups and the project row lazy-load their own
  // sources on first open (the same promise-cache shape the Skills
  // library read uses): the model renders their loading notes until
  // the read lands, then this render runs again.
  const feeds = new Set();
  for (const { item } of walkMenuItems(menuForSeat(seatId) ?? [])) if (item.feed) feeds.add(item.feed);
  if (feeds.has('helmian-skills') && !ws.skills.loaded && !ws.skills.loading) loadSkills().then(() => { if (ws.pickerFor === which) renderPicker(which); }).catch(() => {});
  if (feeds.has('bridge-plugins') && !ws.plugins.loaded && !ws.plugins.loading) loadBridgePlugins().then(() => { if (ws.pickerFor === which) renderPicker(which); }).catch(() => {});
  if (!ws.projects.loaded && !ws.projects.loading) loadWorkspaceProjects().then(() => { if (ws.pickerFor === which) renderPicker(which); }).catch(() => {});
  const model = plusMenuLevel2Model({
    seatId,
    library,
    toggles: ws.connectorToggles,
    conversationId: conversationIdFor(which),
    webSearchOn: ws.webSearch[which] === true,
    skills: ws.skills.loaded ? ws.skills.list : null,
    plugins: ws.plugins.loaded ? ws.plugins.list : null,
    pluginsUnavailable: ws.plugins.loaded ? ws.plugins.unavailable : [],
    skillAttach: ws.skillAttach[which] ?? [],
    attachments: ws.attach[which] ?? [],
    projects: ws.projects.loaded ? ws.projects.list : null,
    activeProjectKey: ws.projects.activeKey ?? ws.ctx?.state?.activeProjectKey ?? null,
    toolAccess: ws.toolAccess,
  });
  const back = h('button', { type: 'button', class: 'ew-btn sm ghost ew-lib-back', onclick: () => { ws.libraryPanel = { level: 1, seatId: null, sub: null }; renderPicker(which); } }, '‹ All agents');
  const head = h('div', { class: 'ew-plus-head' }, back, h('strong', {}, seatName(seatId)));
  if (!model) return [head, h('p', { class: 'ew-note' }, 'This menu could not be loaded.')];
  return [head, ...model.rows.map((row, i) => plusMenuRowNode(which, row, i))];
}

// The attach row: the room's upload, on the menu's first row. The
// file input itself stays hidden in the row's group; picking a file
// runs the same refusal-then-read path the old panel ran, and the
// file joins the same attach list the chips render.
// One ingest for every file that joins a message — the picker row,
// Ctrl+U, a screenshot, a GitHub file: refuse on name/type/size
// before reading a single byte, then the same add-attachment road
// the chips render. A refusal lands in the caller's note element
// when it has one, else in a toast.
async function ingestPickedFile(which, file, note = null) {
  const show = (text) => { if (note) { note.textContent = text; note.hidden = false; } else ws.ctx?.toast?.(text); };
  const refusal = fileRefusalReason({ name: file.name, mediaType: file.type || '', size: file.size });
  if (refusal) { show(refusal); return false; }
  try {
    const data = await readFileAsBase64(file);
    const r = addAttachment(ws.attach[which], { kind: 'file', name: file.name, mediaType: file.type || '', size: file.size, data });
    if (!r.added) { show(r.reason); return false; }
    ws.attach[which] = r.list;
    renderAttachChips(which); renderPicker(which);
    return true;
  } catch { show('That file could not be read.'); return false; }
}
function attachRowNode(which, row) {
  const note = h('p', { class: 'ew-note' });
  note.hidden = true;
  const fileInput = h('input', { type: 'file', class: 'ew-file-input ew-plus-file', 'aria-label': 'Choose a file to attach to this message' });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    await ingestPickedFile(which, file, note);
  });
  const btn = h('button', { type: 'button', class: 'ew-picker-row', title: UPLOAD_NOTE, onclick: () => fileInput.click() },
    h('span', {}, row.label));
  return h('div', { class: 'ew-picker-group' }, btn, fileInput, note);
}
// Ctrl+U on the composer (mirror-design §3.1): Claude's own attach
// shortcut opens the same file picker without the "+" menu. The
// input is created once and reused; its change runs the same
// ingest as the menu row.
function pickFileForComposer(which) {
  if (!ws.fileInput) {
    const input = h('input', { type: 'file', class: 'ew-file-input', 'aria-label': 'Choose a file to attach to this message' });
    input.hidden = true;
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.value = '';
      if (file) await ingestPickedFile(which, file, null);
    });
    ws.fileInput = input;
    ($('maestro-input')?.parentElement ?? document.body).append(input);
  }
  ws.fileInput.click();
}
// Take a screenshot (mirror-design §3.1): the browser's own screen
// capture. One frame is taken at capture time, scaled to the image
// road's lane, and ingested as a JPEG through the same file road —
// nothing is captured until the person picks a surface in the
// browser's own chooser, and a cancel is a quiet note, not an error.
async function captureScreenshot(which, note) {
  if (!navigator.mediaDevices?.getDisplayMedia) { note.textContent = 'Screen capture is not available in this browser.'; note.hidden = false; return; }
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    const scale = Math.min(1, 1600 / Math.max(video.videoWidth || 1, video.videoHeight || 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((video.videoWidth || 1) * scale));
    canvas.height = Math.max(1, Math.round((video.videoHeight || 1) * scale));
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) { note.textContent = 'The screenshot could not be taken.'; note.hidden = false; return; }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    await ingestPickedFile(which, new File([blob], `screenshot-${stamp}.jpg`, { type: 'image/jpeg' }), note);
  } catch { note.textContent = 'The screenshot was cancelled.'; note.hidden = false; }
  finally { if (stream) for (const track of stream.getTracks()) track.stop(); }
}
function screenshotRowNode(which, row) {
  const note = h('p', { class: 'ew-note' });
  note.hidden = true;
  const btn = h('button', { type: 'button', class: 'ew-picker-row', title: 'Capture a screen, window or tab and attach it to this message', onclick: () => { void captureScreenshot(which, note); } },
    h('span', {}, row.label));
  return h('div', { class: 'ew-picker-group' }, btn, note);
}

// Land on the Integrations view's Agents tab (owner order,
// 2026-11-10): the per-seat Manage surface that used to live on the
// Integrations Connectors tab is removed — connectors live in this
// panel now — so this road lands on the seat's account page instead.
// The tab marker names 'agents'; app.js's loadIntegrations consumes
// it and selects that tab, so the landing is never left hidden
// behind the remembered tab. No seat marker is written any more:
// nothing consumes one. Shared by the manage footer row and the
// mirror rows. (The Tool access action row no longer rides this
// funnel — it expands its own face in the panel, toolAccessNode
// below; the panel Connect's key-needed answer no longer rides it
// either — it opens the key form in the panel, keyFormNode above.)
function openManageForSeat(which) {
  try {
    sessionStorage.removeItem('helmian.manageSeat');
    sessionStorage.setItem('helmian.manageTab', 'agents');
  } catch {}
  closePicker();
  document.querySelector('.nav-item[data-view="integrations"]')?.click();
}
// The GitHub file source (mirror-design §4): browse the channel's
// linked repo through the cloud read and pick a file into the
// message. The repo is never typed here — it is the channel's link,
// the one source the server will serve. A refusal renders the
// route's own plain words — the error body's error text — in
// preference to the bare code the shared api() helper throws with,
// so the person reads the reason, not the code.
function githubFileNode(which, row) {
  const gf = ws.githubFile;
  const repo = typeof ws.config?.github?.repo === 'string' ? ws.config.github.repo : '';
  const note = h('p', { class: 'ew-note' });
  note.hidden = !gf.note;
  if (gf.note) note.textContent = gf.note;
  const head = h('button', { type: 'button', class: 'ew-picker-row', 'aria-expanded': String(gf.open), onclick: () => {
    gf.open = !gf.open;
    if (gf.open && repo && gf.entries === null && !gf.loading) void loadGithubEntries(which, '');
    renderPicker(which);
  } }, h('span', {}, row.label), h('span', { class: 'ew-picker-state off' }, gf.open ? '▾' : '›'));
  if (!gf.open) return head;
  const children = [head];
  if (!repo) {
    children.push(h('p', { class: 'ew-note' }, 'Link a GitHub repo to this channel first — then its files can be added here.'));
    return h('div', { class: 'ew-picker-group' }, ...children);
  }
  children.push(h('p', { class: 'ew-note' }, `Repo: ${repo}${gf.path ? ` — ${gf.path}` : ''}`));
  const pathInput = h('input', { type: 'text', class: 'ew-gh-path', placeholder: 'Folder or file path (blank = repo root)', value: gf.path, 'aria-label': 'Path in the linked GitHub repo' });
  const listBtn = h('button', { type: 'button', class: 'ew-btn sm', onclick: () => { void loadGithubEntries(which, pathInput.value.trim()); } }, 'List');
  children.push(h('div', { class: 'ew-gh-bar' }, pathInput, listBtn));
  if (gf.loading) children.push(h('p', { class: 'ew-note' }, 'Reading the repo...'));
  if (Array.isArray(gf.entries)) {
    for (const entry of gf.entries) {
      if (entry.kind === 'dir') {
        children.push(h('button', { type: 'button', class: 'ew-picker-row ew-gh-entry', onclick: () => { void loadGithubEntries(which, entry.path); } },
          h('span', {}, `${entry.name}/`), h('span', { class: 'ew-picker-kind' }, 'folder')));
      } else {
        children.push(h('button', { type: 'button', class: 'ew-picker-row ew-gh-entry', onclick: () => { void pickGithubFile(which, entry, note); } },
          h('span', {}, entry.name), h('span', { class: 'ew-picker-kind' }, 'file')));
      }
    }
    if (!gf.entries.length) children.push(h('p', { class: 'ew-note' }, 'Nothing at that path.'));
  }
  children.push(note);
  return h('div', { class: 'ew-picker-group' }, ...children);
}
async function loadGithubEntries(which, path) {
  const gf = ws.githubFile;
  const repo = typeof ws.config?.github?.repo === 'string' ? ws.config.github.repo : '';
  if (!repo) return;
  gf.loading = true; gf.note = ''; gf.entries = null; gf.path = path || '';
  if (ws.pickerFor === which) renderPicker(which);
  try {
    const body = await ws.ctx.api(`/api/admin/connector-library/github-file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path || '')}`);
    if (body?.kind === 'dir') { gf.entries = body.entries ?? []; gf.path = body.path ?? path ?? ''; }
    else if (body?.kind === 'file') { await ingestGithubBody(which, body, null); gf.entries = null; }
    else gf.note = 'That path could not be read.';
  } catch (error) { gf.note = error?.body?.error || error?.message || 'That path could not be read.'; }
  gf.loading = false;
  if (ws.pickerFor === which) renderPicker(which);
}
async function pickGithubFile(which, entry, note) {
  const repo = typeof ws.config?.github?.repo === 'string' ? ws.config.github.repo : '';
  if (!repo) return;
  try {
    const body = await ws.ctx.api(`/api/admin/connector-library/github-file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(entry.path)}`);
    if (body?.kind !== 'file') { ws.githubFile.note = 'That file could not be read.'; renderPicker(which); return; }
    await ingestGithubBody(which, body, note);
  } catch (error) { ws.githubFile.note = error?.body?.error || error?.message || 'That file could not be read.'; renderPicker(which); }
}
// A GitHub file body joins the message through the same ingest as a
// picked local file: base64 → Blob → File, with the media type
// guessed from the extension where the read carries none (an image
// road needs its type to classify at all).
async function ingestGithubBody(which, body, note) {
  const binary = atob(String(body.data ?? ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const name = String(body.name ?? 'github-file');
  const lower = name.toLowerCase();
  const mediaType = body.mediaType || (lower.endsWith('.png') ? 'image/png' : lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : lower.endsWith('.webp') ? 'image/webp' : '');
  const file = new File([bytes], name, { type: mediaType });
  await ingestPickedFile(which, file, note);
}

// The Tool access face (panel-native home bite 1): the Tool access
// row in a seat's Connectors submenu expands in place — the same
// expand pattern as the GitHub file source above — into the seat's
// per-connection posture picker and per-tool switches
// (connector-tool-access.mjs). The face reads its state from the
// tool-access read when it opens (loadToolAccess below, on the
// workspace's own api road); a posture pick or a tool flip writes
// through the library's write roads, and what renders next is the
// state the write itself returned — never an optimistic flip.
// Entries with no connection carry no controls: posture belongs to
// a connection, so their row states the truth ("Connect first" /
// "Reconnect first") and is not a button. The key/token form is a
// sibling bite — it expands under the connector's own row in the
// Connectors list (keyFormNode above), following this face's
// expand-in-place pattern. The add-a-custom form (panel-native
// home bite 3) stands as the Connectors list's last row —
// customFormNode above.
async function openToolAccess(which, row) {
  const ta = ws.toolAccess;
  ta.open = true;
  ta.seatId = row.seatId;
  ta.entryId = row.selectedEntryId ?? null;
  ta.model = null;
  ta.error = '';
  if (ta.entryId) await refreshToolAccess(which);
}
async function refreshToolAccess(which) {
  const ta = ws.toolAccess;
  if (!ta.seatId || !ta.entryId || ta.loading) return;
  ta.loading = true;
  try {
    ta.model = await loadToolAccess({ api: (url) => ws.ctx.api(url), seatId: ta.seatId, entryId: ta.entryId });
    ta.error = '';
  } catch {
    ta.model = null;
    ta.error = 'Tool access could not be loaded. Try again.';
  }
  ta.loading = false;
  if (ws.pickerFor === which) renderPicker(which);
}
async function saveToolAccessPosture(which, posture) {
  const ta = ws.toolAccess;
  if (!ta.model || ta.saving) return;
  ta.saving = true;
  try {
    const next = await writeToolAccessPosture({ post: (path, body) => ws.ctx.post(path, body), model: ta.model, posture });
    if (next) {
      ta.model = next;
      // A posture write is a write to the workspace set's
      // connection: every seat's cached library is stale from
      // here (sync S2b) — the next open of any agent's
      // Connectors level re-reads. This face keeps the write's
      // own returned record; it does not re-read a library the
      // posture does not change the rows of.
      invalidateAllSeatLibraries();
    }
    ta.error = '';
  } catch { ta.error = 'That change could not be saved. Try again.'; }
  ta.saving = false;
  if (ws.pickerFor === which) renderPicker(which);
}
async function saveToolAccessTool(which, tool) {
  const ta = ws.toolAccess;
  if (!ta.model || ta.saving) return;
  ta.saving = true;
  try {
    const next = await writeToolAccessTool({ post: (path, body) => ws.ctx.post(path, body), model: ta.model, toolName: tool.name, enabled: !tool.enabled });
    if (next) {
      ta.model = next;
      // Same set rule as the posture write above: a tool-enable
      // write invalidates every seat's cached library.
      invalidateAllSeatLibraries();
    }
    ta.error = '';
  } catch { ta.error = 'That change could not be saved. Try again.'; }
  ta.saving = false;
  if (ws.pickerFor === which) renderPicker(which);
}
function toolAccessNode(which, row) {
  const ta = ws.toolAccess;
  const open = row.open === true;
  const head = h('button', { type: 'button', class: 'ew-picker-row', 'aria-expanded': String(open), title: 'Set when this connection\u2019s tools ask before they run, and turn single tools on or off', onclick: () => {
    if (open) { ta.open = false; renderPicker(which); return; }
    void openToolAccess(which, row).then(() => { if (ws.pickerFor === which) renderPicker(which); });
    renderPicker(which);
  } }, h('span', {}, row.label), h('span', { class: 'ew-picker-state off' }, open ? '▾' : '›'));
  if (!open) return head;
  const children = [head];
  if (row.libraryState === 'loading') {
    children.push(h('p', { class: 'ew-note' }, 'Loading connectors...'));
    return h('div', { class: 'ew-picker-group' }, ...children);
  }
  if (row.libraryState === 'error') {
    children.push(h('p', { class: 'ew-note' }, 'This library could not be loaded.'));
    return h('div', { class: 'ew-picker-group' }, ...children);
  }
  if (!row.entries.length) {
    children.push(h('p', { class: 'ew-note' }, 'No connectors can be set here yet.'));
    return h('div', { class: 'ew-picker-group' }, ...children);
  }
  for (const entry of row.entries) {
    if (!entry.connected) {
      // No connection, no controls — the row states the truth and
      // is a plain row, never a button that goes nowhere.
      children.push(h('div', { class: 'ew-picker-row ew-lib-row ew-tool-access-entry' },
        h('span', { class: 'ew-lib-text' }, h('span', { class: 'ew-lib-name' }, entry.name)),
        h('span', { class: 'ew-picker-state off' }, entry.blockedNote)));
      continue;
    }
    const picked = entry.entryId === row.selectedEntryId;
    children.push(h('button', { type: 'button', class: `ew-picker-row ew-tool-access-entry${picked ? ' on' : ''}`, 'aria-expanded': String(picked), onclick: () => {
      if (picked) return;
      ta.entryId = entry.entryId;
      ta.model = null;
      ta.error = '';
      void refreshToolAccess(which);
      renderPicker(which);
    } }, h('span', { class: 'ew-lib-text' }, h('span', { class: 'ew-lib-name' }, entry.name)),
      h('span', { class: 'ew-picker-state off' }, picked ? '▾' : '›')));
    if (!picked) continue;
    if (ta.loading || !ta.model) {
      children.push(h('p', { class: 'ew-note' }, ta.error || 'Loading tool access...'));
      continue;
    }
    const model = ta.model;
    if (model.connectFirst) {
      children.push(h('p', { class: 'ew-note' }, 'Connect first — tool access belongs to a connection, and this one is not connected.'));
      continue;
    }
    if (ta.error) children.push(h('p', { class: 'ew-note' }, ta.error));
    children.push(h('div', { class: 'ew-subhead' }, 'When tools ask before running'));
    for (const option of model.options) {
      children.push(h('button', { type: 'button', class: `ew-picker-row${option.selected ? ' on' : ''}`, disabled: ta.saving || option.selected, title: option.detail, onclick: () => { void saveToolAccessPosture(which, option.value); } },
        h('span', { class: 'ew-lib-text' },
          h('span', { class: 'ew-lib-name' }, option.label),
          h('span', { class: 'ew-lib-line' }, option.detail)),
        h('span', { class: `ew-picker-state ${option.selected ? 'on' : 'off'}` }, option.selected ? 'In use' : 'Use')));
    }
    children.push(h('div', { class: 'ew-subhead' }, 'Tools'));
    if (!model.tools.length) {
      children.push(h('p', { class: 'ew-note' }, model.hasSnapshot ? 'This connection has no tools.' : 'No tool list has been saved for this connection yet.'));
    }
    for (const tool of model.tools) {
      const text = h('span', { class: 'ew-lib-text' },
        h('span', { class: 'ew-lib-name' }, tool.name),
        ...(tool.description ? [h('span', { class: 'ew-lib-line' }, tool.description)] : []),
        h('span', { class: 'ew-lib-line' }, tool.kindLabel));
      children.push(h('button', { type: 'button', class: `ew-picker-row${tool.enabled ? ' on' : ''}`, disabled: ta.saving, title: tool.enabled ? `${tool.name} is on — tap to turn it off` : `Turn ${tool.name} on`, onclick: () => { void saveToolAccessTool(which, tool); } },
        text,
        h('span', { class: 'ew-lib-switch', 'aria-hidden': 'true' }),
        h('span', { class: `ew-picker-state ${tool.enabled ? 'on' : 'off'}` }, tool.enabled ? 'On' : 'Off')));
    }
  }
  return h('div', { class: 'ew-picker-group' }, ...children);
}

function plusMenuRowNode(which, row, index) {
  switch (row.kind) {
    case 'attach': return attachRowNode(which, row);
    case 'screenshot': return screenshotRowNode(which, row);
    case 'action': {
      if (row.action === 'github-file') return githubFileNode(which, row);
      if (row.action === 'tool-access') return toolAccessNode(which, row);
      return h('p', { class: 'ew-note' }, '');
    }
    case 'skill': {
      if (row.disabled) {
        return h('div', { class: 'ew-picker-row ew-plus-skill off' }, h('span', {}, row.name), h('span', { class: 'ew-picker-kind' }, 'turned off'));
      }
      const on = row.on;
      return h('button', { type: 'button', class: `ew-picker-row ew-plus-skill${on ? ' on' : ''}`, title: row.description || row.name, onclick: () => {
        const seatId = ws.libraryPanel.seatId;
        if (on) ws.skillAttach[which] = removeSkillAttach(ws.skillAttach[which], { skillId: row.skillId, seatId });
        else {
          const res = addSkillAttach(ws.skillAttach[which], { skillId: row.skillId, seatId });
          if (!res.added) { ws.ctx?.toast?.(res.reason); return; }
          ws.skillAttach[which] = res.list;
        }
        renderAttachChips(which); renderPicker(which);
      } }, h('span', {}, row.name), h('span', { class: `ew-picker-state ${on ? 'on' : 'off'}` }, on ? 'On' : 'Off'));
    }
    case 'plugin': {
      const on = row.on;
      return h('button', { type: 'button', class: `ew-picker-row${on ? ' on' : ''}`, title: row.brings || row.name, onclick: () => {
        if (on) ws.attach[which] = removeAttachment(ws.attach[which], { kind: 'plugin', name: row.name });
        else {
          const catalog = (ws.plugins.list ?? []).map((p) => ({ kind: 'plugin', name: String(p?.name ?? '').trim().toLowerCase() })).filter((p) => p.name);
          const res = addAttachment(ws.attach[which], { kind: 'plugin', name: row.name }, { catalog });
          if (!res.added) { ws.ctx?.toast?.(res.reason); return; }
          ws.attach[which] = res.list;
        }
        renderAttachChips(which); renderPicker(which);
      } }, h('span', {}, row.name),
      // The tool count shows only when the plugins read provided
      // one (the model's toolCount) — today's read provides none,
      // so no count renders; an invented count never does.
      ...(row.toolCount != null ? [h('span', { class: 'ew-picker-kind' }, `${row.toolCount} tool${row.toolCount === 1 ? '' : 's'}`)] : [h('span', { class: 'ew-picker-kind' }, 'plugin')]),
      h('span', { class: `ew-picker-state ${on ? 'on' : 'off'}` }, on ? 'On' : 'Off'));
    }
    case 'project': {
      return h('button', { type: 'button', class: `ew-picker-row${row.active ? ' on' : ''}`, title: row.active ? 'The active project — this conversation\u2019s messages carry it' : 'Make this the active project for your messages', onclick: async () => {
        if (!row.active) await setActiveProjectFromMenu(row.key);
        renderPicker(which);
      } }, h('span', {}, row.name), h('span', { class: `ew-picker-state ${row.active ? 'on' : 'off'}` }, row.active ? 'Active' : 'Set active'));
    }
    case 'capability': {
      const on = row.on;
      return h('button', { type: 'button', class: `ew-picker-row${on ? ' on' : ''}`, title: on ? 'Web search is on for this message — tap to turn it off' : 'Turn web search on for this message', onclick: () => {
        ws.webSearch[which] = !on;
        renderAttachChips(which); renderPicker(which);
      } }, h('span', {}, row.label), h('span', { class: 'ew-picker-kind' }, 'per message'), h('span', { class: `ew-picker-state ${on ? 'on' : 'off'}` }, on ? 'On' : 'Off'));
    }
    case 'label': return h('div', { class: 'ew-subhead' }, row.label);
    case 'note': return h('p', { class: 'ew-note' }, row.text);
    case 'toggle': case 'mirror': case 'row': case 'connect': return libraryRowNode(which, row.row, { shape: row.rowShape });
    case 'custom-add': return customFormNode(which, row);
    case 'submenu': {
      const open = ws.libraryPanel.sub === index;
      const head = h('button', { type: 'button', class: 'ew-picker-row', 'aria-expanded': String(open), onclick: () => {
        ws.libraryPanel = { ...ws.libraryPanel, sub: open ? null : index };
        renderPicker(which);
      } }, h('span', {}, row.label),
      ...(row.badge ? [h('span', { class: 'ew-picker-badge', title: `${row.badge} connection${row.badge === 1 ? '' : 's'} need${row.badge === 1 ? 's' : ''} reconnecting` }, `⚠ ${row.badge}`)] : []),
      h('span', { class: 'ew-picker-state off' }, open ? '▾' : '›'));
      if (!open) return head;
      return h('div', { class: 'ew-picker-group' }, head,
        h('div', { class: 'ew-plus-sub' }, ...row.rows.map((r, i) => plusMenuRowNode(which, r, i))));
    }
    case 'manage': {
      // The footer's one road: Helmian's own Integrations view, for
      // every seat (Troy's ruling, 2026-11-08 — a seat's connections
      // are managed inside Helmian, never in a vendor window, so no
      // vendor manage row and no dead placeholder row exists).
      if (row.target === 'integrations') {
        return h('button', { type: 'button', class: 'ew-picker-row ew-plus-manage', onclick: () => openManageForSeat(which) }, h('span', {}, row.label), h('span', { class: 'ew-picker-state off' }, 'Open'));
      }
      return h('p', { class: 'ew-note' }, '');
    }
    default: return h('p', { class: 'ew-note' }, '');
  }
}

function renderPicker(which) {
  const panel = $(PICKER_IDS[which].panel); if (!panel) return;
  if (ws.pickerFor !== which) { panel.hidden = true; return; }
  panel.hidden = false;
  if (ws.libraryPanel.level === 2 && ws.libraryPanel.seatId) {
    panel.replaceChildren(...renderPlusMenuLevel2(which));
  } else {
    panel.replaceChildren(...renderPlusMenuLevel1(which));
  }
}

// The add-a-custom form (panel-native home bite 3): the last row
// of a seat's Connectors list opens this form in the panel — the
// same expand-in-place pattern as the key form above
// (connector-custom-form.mjs renders the model; this section
// renders its DOM). Submitting posts the creation road's exact
// payload; on success the panel re-reads the seat's library, so
// the new entry appears in the list from the stored record, in
// its true state — created, not connected — and the form states
// the creation answer's safety-check state in plain words (a
// check that has not passed is stated, never dressed as passed;
// the entry's key, when it takes one, is entered afterwards
// through the key form under its own row). On refusal the
// server's plain words stay in the form and no entry appears —
// the creation road is owner/admin, and a member who is neither
// reads exactly that refusal here.
function openCustomForm(which, seatId) {
  const cf = ws.customForm;
  cf.open = true;
  cf.seatId = seatId;
  cf.model = customFormModel({ seatId });
  cf.error = '';
  cf.created = null;
}
async function saveCustomForm(which, inputs) {
  const cf = ws.customForm;
  if (!cf.model || cf.saving) return;
  cf.saving = true;
  const result = await submitCustomForm({
    post: (path, body) => ws.ctx.post(path, body),
    model: cf.model,
    values: {
      name: inputs.name?.value ?? '',
      mcpEndpointUrl: inputs.mcpEndpointUrl?.value ?? '',
      oneLiner: inputs.oneLiner?.value ?? '',
      authMode: inputs.authMode?.value ?? '',
    },
  });
  cf.saving = false;
  if (result.ok) {
    cf.created = result.created;
    cf.error = '';
    ws.ctx.toast(`${result.created.name} was added to ${seatName(result.created.seatId ?? cf.seatId)}'s library.`, 'ok');
    invalidateAllSeatLibraries();
    await loadSeatLibrary(cf.seatId).catch(() => {});
  } else {
    cf.error = result.error;
    cf.created = null;
  }
  if (ws.pickerFor === which) renderPicker(which);
}
function customFormNode(which, row) {
  const cf = ws.customForm;
  const open = cf.open === true && cf.seatId === row.seatId;
  const head = h('button', { type: 'button', class: 'ew-picker-row', 'aria-expanded': String(open), title: `Add a custom connector to ${seatName(row.seatId)}'s library`, onclick: () => {
    if (open) { cf.open = false; renderPicker(which); return; }
    openCustomForm(which, row.seatId);
    renderPicker(which);
  } }, h('span', {}, 'Add a custom connector'), h('span', { class: 'ew-picker-state off' }, open ? '▾' : '›'));
  if (!open) return head;
  const model = cf.model;
  if (!model) return h('div', { class: 'ew-picker-group' }, head, h('p', { class: 'ew-note' }, 'This connector cannot be added here.'));
  const children = [head, h('p', { class: 'ew-note' }, model.intro)];
  if (cf.created) {
    children.push(h('p', { class: 'ew-note' }, `${cf.created.name} was added to this seat's library. It is not connected yet.`));
    children.push(h('p', { class: 'ew-note' }, cf.created.gate.line));
  }
  const inputs = {};
  for (const field of model.fields) {
    if (field.kind === 'select') {
      const select = h('select', { class: 'ew-gh-path', 'aria-label': field.label });
      for (const option of field.options) {
        const opt = h('option', { value: option.value }, option.label);
        if (option.value === model.defaultAuthMode) opt.selected = true;
        select.append(opt);
      }
      inputs[field.name] = select;
      children.push(select);
      continue;
    }
    const input = h('input', {
      type: field.type, class: 'ew-gh-path', placeholder: field.placeholder,
      autocomplete: field.autocomplete, 'aria-label': field.label,
      ...(field.maxLength ? { maxLength: field.maxLength } : {}),
    });
    inputs[field.name] = input;
    children.push(input);
  }
  if (cf.error) children.push(h('p', { class: 'ew-note' }, cf.error));
  children.push(h('div', { class: 'ew-gh-bar' }, h('button', {
    type: 'button', class: 'ew-lib-connect', disabled: cf.saving,
    title: `Add a custom connector to ${seatName(model.seatId)}'s library`,
    onclick: () => { void saveCustomForm(which, inputs); },
  }, cf.saving ? model.button.pendingLabel : model.button.label)));
  return h('div', { class: 'ew-picker-group ew-custom-form' }, ...children);
}

// The custom entry removal control (panel-native home bite 4): a
// custom entry's row in the Connectors list carries a Remove
// control under it (connector-custom-remove.mjs renders the
// model; this section renders its DOM) — the panel surface for
// the removal road bite 3's report named as a dead end.
// Placement and confirmation follow the panel's own patterns:
// the control stands under the entry's row the way the key
// form's Replace row stands under a connected row, and the
// confirmation follows the skill editor's delete pattern — a
// plain line stating what goes, then Keep it / Remove for good.
// The confirmation is not the key form's Disconnect:
// disconnect leaves the entry standing and revokes its stored
// key; this removes the entry itself, and the model's line says
// so, including that a connection under the entry goes with it.
// Submitting posts the road's exact payload; on success the
// panel re-reads the seat's library, so the entry is gone
// because the read no longer returns it — nothing is removed
// from the cached list here. On refusal the server's plain
// words stay on the row and the entry stays. The road is
// owner/admin and custom entries only: the control is offered
// only on a custom entry's row (libraryRowNode above), and a
// member the road refuses reads its words here.
async function removeCustomEntry(which) {
  const cr = ws.customRemove;
  if (!cr.model || cr.removing) return;
  cr.removing = true;
  const result = await submitCustomRemove({
    post: (path, body) => ws.ctx.post(path, body),
    model: cr.model,
  });
  cr.removing = false;
  if (result.ok) {
    const seatId = cr.model.seatId;
    cr.confirmFor = null;
    cr.model = null;
    cr.error = '';
    ws.ctx.toast(`${result.removed.name} was removed from ${seatName(seatId)}'s library.`, 'ok');
    invalidateAllSeatLibraries();
    await loadSeatLibrary(seatId).catch(() => {});
  } else {
    cr.error = result.error;
  }
  if (ws.pickerFor === which) renderPicker(which);
}
function customRemoveNode(which, row, model) {
  const cr = ws.customRemove;
  const confirming = cr.confirmFor === keyEntryKey(model.seatId, model.entryId) && Boolean(cr.model);
  if (!confirming) {
    return h('div', { class: 'ew-picker-row ew-lib-row' },
      h('span', { class: 'ew-lib-text' },
        h('span', { class: 'ew-lib-name' }, 'Custom connector'),
        h('span', { class: 'ew-lib-line' }, 'Added to this seat — it can be removed from here')),
      h('button', {
        type: 'button', class: 'ew-lib-connect',
        title: `Remove ${model.name} from ${seatName(model.seatId)}'s library`,
        onclick: () => { openCustomRemove(which, model); },
      }, model.button.label));
  }
  const children = [h('p', { class: 'ew-note' }, model.confirmLine)];
  if (cr.error) children.push(h('p', { class: 'ew-note' }, cr.error));
  children.push(h('div', { class: 'ew-gh-bar' },
    h('button', {
      type: 'button', class: 'ew-btn sm', disabled: cr.removing,
      title: `Keep ${model.name} in ${seatName(model.seatId)}'s library`,
      onclick: () => { cancelCustomRemove(which); },
    }, model.keepLabel),
    h('button', {
      type: 'button', class: 'ew-lib-connect', disabled: cr.removing,
      title: `Remove ${model.name} from ${seatName(model.seatId)}'s library for good`,
      onclick: () => { void removeCustomEntry(which); },
    }, cr.removing ? model.button.pendingLabel : model.confirmLabel)));
  return h('div', { class: 'ew-picker-group ew-custom-remove' }, ...children);
}
function openCustomRemove(which, model) {
  const cr = ws.customRemove;
  cr.confirmFor = keyEntryKey(model.seatId, model.entryId);
  cr.model = model;
  cr.error = '';
  renderPicker(which);
}
function cancelCustomRemove(which) {
  const cr = ws.customRemove;
  cr.confirmFor = null;
  cr.model = null;
  cr.error = '';
  renderPicker(which);
}

// ---------- composer "/" menu: the workspace's slash commands ----------
// The channel composer's slash menu; the pure model in
// slash-menu.mjs decides when it opens and what it lists. The list is the
// served workspace's real command registry (GET /api/admin/commands) —
// the same set the bridge will expand — fetched lazily on the first "/"
// and cached for the mount. Picking a row only inserts "/name " into
// the input; sending is always the human's own Enter.
//
// The menu's second group is the workspace's HELMIAN skills
// (slash-skills DESIGN §4, bite S3): the cloud store's list
// (GET /api/admin/skills — names, descriptions, scopes; no bodies),
// fetched lazily beside the commands and cached the same way. A skill
// pick never inserts text: it opens the scope step (Every agent, or
// one seat of this channel), and picking a scope ARMS the skill for
// the next message (metadata.skills, composer-picker.mjs) and clears
// the token the person typed to get here — the token was navigation,
// and leaving it in the body would hand the bridge a command file
// that does not exist. The group's last row authors a new skill
// (openSkillEditor below).
const SLASH_IDS = {
  channel: { input: 'maestro-input', menu: 'ew-slash-menu' },
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
async function loadSkills() {
  if (ws.skills.loaded) return ws.skills.list;
  if (!ws.skills.loading) {
    ws.skills.loading = ws.ctx.api('/api/admin/skills')
      .then((body) => { ws.skills.list = Array.isArray(body?.skills) ? body.skills : []; ws.skills.loaded = true; })
      .catch(() => { ws.skills.list = null; })
      .finally(() => { ws.skills.loading = null; });
  }
  await ws.skills.loading;
  return ws.skills.list;
}
// An authoring write (create/edit/delete) makes the cached list
// stale; it is dropped, never patched, so the menu refetches the
// store's own truth on its next open.
function invalidateSkills() {
  ws.skills.list = null; ws.skills.loaded = false; ws.skills.loading = null;
}
// The plugin list (bite M2): the Plugins submenu binds to
// GET /api/admin/plugins — the plugins whose tools join a seat's
// turns. The read answers from the serving process's own workspace
// and carries { plugins, unavailable }: `unavailable` names every
// plugin that failed to load, and it is kept on the state so the
// menu can surface it (fix B) — an empty list with failures behind
// it is not "no plugins installed". A failed read leaves the list
// null and the next open tries again, the same shape as the Skills
// loader above.
async function loadBridgePlugins() {
  if (ws.plugins.loaded) return ws.plugins.list;
  if (!ws.plugins.loading) {
    ws.plugins.loading = ws.ctx.api('/api/admin/plugins')
      .then((body) => { ws.plugins.list = Array.isArray(body?.plugins) ? body.plugins : []; ws.plugins.unavailable = Array.isArray(body?.unavailable) ? body.unavailable : []; ws.plugins.loaded = true; })
      .catch(() => { ws.plugins.list = null; })
      .finally(() => { ws.plugins.loading = null; });
  }
  await ws.plugins.loading;
  return ws.plugins.list;
}
// The workspace project registry for the "Add to project" row:
// the project list + the durable per-person active project. The
// app shell keeps its own copy in ctx.state; both write through the
// same route, and this cache re-reads on first open.
async function loadWorkspaceProjects() {
  if (ws.projects.loaded) return ws.projects.list;
  if (!ws.projects.loading) {
    ws.projects.loading = Promise.all([
      ws.ctx.api('/api/admin/workspace/projects').catch(() => null),
      ws.ctx.api('/api/admin/workspace/active-project').catch(() => null),
    ]).then(([listBody, activeBody]) => {
      ws.projects.list = (Array.isArray(listBody?.projects) ? listBody.projects : [])
        .map((p) => ({ key: String(p?.projectKey ?? ''), name: String(p?.displayName ?? p?.projectKey ?? '') }))
        .filter((p) => p.key);
      const active = typeof activeBody?.projectKey === 'string' ? activeBody.projectKey : null;
      ws.projects.activeKey = active;
      if (ws.ctx?.state) ws.ctx.state.activeProjectKey = active;
      ws.projects.loaded = true;
    }).catch(() => { ws.projects.list = null; })
      .finally(() => { ws.projects.loading = null; });
  }
  await ws.projects.loading;
  return ws.projects.list;
}
// Setting the active project from the menu writes the same durable
// per-person selection the Agents page writes; the send then rides
// it in the message metadata. There is no per-conversation stash.
async function setActiveProjectFromMenu(projectKey) {
  try {
    await ws.ctx.post('/api/admin/workspace/active-project', { projectKey });
    ws.projects.activeKey = projectKey;
    if (ws.ctx?.state) ws.ctx.state.activeProjectKey = projectKey;
    ws.ctx.toast?.('Active project set', 'ok');
  } catch { ws.ctx.toast?.('Could not set the active project'); }
}
// The name a seat id wears in chips, badges and scope rows: a
// library seat's room name, a custom agent's own name, or the id
// itself when neither knows it.
function skillSeatLabel(seatId) {
  if (librarySeat(seatId)) return seatName(seatId);
  const custom = (ws.config?.customAgents ?? []).find((a) => (a.handle || a.id) === seatId);
  return custom?.name ?? String(seatId ?? '');
}
// This channel's seats, for the scope step: the standard agents by
// their LIBRARY seat id (the id metadata.skills and the skill store
// speak — the room's provider key maps through seatForProvider, so
// ChatGPT the room agent is 'chatgpt' the seat), plus the channel's
// custom agents by handle. Maestro is never a row: the manager is
// the human, never a turn recipient (DESIGN §5.5).
function channelSkillSeats() {
  const out = [];
  const seen = new Set();
  for (const a of ws.config?.agents ?? []) {
    const provider = typeof a === 'string' ? a : a?.provider;
    if (!provider || provider === 'maestro') continue;
    const seatId = seatForProvider(provider) ?? provider;
    if (seen.has(seatId)) continue;
    seen.add(seatId);
    out.push({ seatId, name: NAMES[provider] ?? skillSeatLabel(seatId) });
  }
  for (const a of ws.config?.customAgents ?? []) {
    const handle = a?.handle || a?.id;
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    out.push({ seatId: handle, name: a?.name ?? handle });
  }
  return out;
}
function currentSlashModel(which) {
  const box = $(SLASH_IDS[which].input); if (!box) return null;
  if (ws.slash.dismissedFor === box.value) return null;
  return slashMenuModel({ commands: ws.slash.commands ?? [], loaded: ws.slash.loaded, value: box.value, skills: ws.skills.list ?? [], skillsLoaded: ws.skills.loaded, seatLabel: skillSeatLabel });
}
// The menu's current view: level 1 (commands + skills) or, while
// ws.slash.scopeFor names a listed skill, the scope step for it.
// Render and keyboard both read this, so they can never disagree
// about what a highlight index points at.
function slashView(which) {
  const model = currentSlashModel(which);
  if (!model) return null;
  if (ws.slash.scopeFor) {
    const skill = model.skillRows.find((s) => s.id === ws.slash.scopeFor);
    if (skill) {
      const scope = slashSkillScopeModel(skill, channelSkillSeats());
      const entries = [Object.freeze({ type: 'back' }), ...scope.rows.map((r) => Object.freeze({ type: 'scope', seatId: r.seatId })), Object.freeze({ type: 'edit', id: skill.id })];
      return { model, level: 2, skill, scope, entries: Object.freeze(entries) };
    }
    ws.slash.scopeFor = null;
  }
  return { model, level: 1, entries: slashPickList(model) };
}
function closeSlashMenu() {
  ws.slash.openFor = null; ws.slash.index = 0; ws.slash.scopeFor = null;
  for (const { menu } of Object.values(SLASH_IDS)) { const m = $(menu); if (m) m.hidden = true; }
}
async function refreshSlashMenu(which) {
  const box = $(SLASH_IDS[which].input); if (!box) return;
  if (!ws.slash.loaded || !ws.skills.loaded) {
    if (!slashMenuModel({ commands: [], loaded: true, value: box.value })) { closeSlashMenu(); return; }
    await Promise.all([loadSlashCommands(), loadSkills()]);
  }
  if (ws.slash.dismissedFor !== null && ws.slash.dismissedFor !== box.value) ws.slash.dismissedFor = null;
  renderSlashMenu(which);
}
function slashRowButton(which, entry, index, kids) {
  return h('button', {
    type: 'button', role: 'option', 'aria-selected': String(index === ws.slash.index),
    class: `ew-picker-row ew-slash-row${index === ws.slash.index ? ' on' : ''}`,
    onmousedown: (e) => { e.preventDefault(); pickSlashEntry(which, entry); },
  }, ...kids);
}
function renderSlashMenu(which) {
  const menu = $(SLASH_IDS[which].menu); if (!menu) return;
  const view = slashView(which);
  if (!view) { if (ws.slash.openFor === which) closeSlashMenu(); else menu.hidden = true; return; }
  const opening = ws.slash.openFor !== which;
  ws.slash.openFor = which;
  if (opening || ws.slash.index >= view.entries.length) ws.slash.index = 0;
  if (view.level === 2) { renderSlashScopeStep(which, menu, view); return; }
  const { model } = view;
  const nodes = [];
  let pickIndex = -1;
  for (const c of model.rows) {
    pickIndex += 1;
    const i = pickIndex;
    nodes.push(slashRowButton(which, { type: 'command', name: c.name }, i, [
      h('span', { class: 'ew-slash-name' }, `/${c.name}`), h('span', { class: 'ew-picker-kind' }, c.description ?? ''), h('span', { class: 'ew-picker-state off' }, SLASH_ORIGIN_LABEL[c.origin] ?? c.origin ?? ''),
    ]));
  }
  if (!model.rows.length && !model.skillRows.length) {
    nodes.push(h('p', { class: 'ew-note' }, model.empty === 'no-commands' && model.skillsEmpty === 'no-skills'
      ? 'No commands or skills in this workspace yet. Add a skill below — or add markdown files to .helmion/commands/ and they will show up here.'
      : 'No matching command or skill.'));
  }
  if (model.showNewSkill) {
    nodes.push(h('div', { class: 'ew-subhead' }, 'Skills'));
    for (const s of model.skillRows) {
      pickIndex += 1;
      const i = pickIndex;
      nodes.push(slashRowButton(which, { type: 'skill', id: s.id }, i, [
        h('span', { class: 'ew-slash-name' }, `/${s.id}`), h('span', { class: 'ew-picker-kind' }, s.description || (s.name !== s.id ? s.name : '')), h('span', { class: 'ew-picker-state off' }, s.badge),
      ]));
    }
    pickIndex += 1;
    const i = pickIndex;
    nodes.push(slashRowButton(which, { type: 'new-skill' }, i, [
      h('span', { class: 'ew-slash-name' }, '＋ New skill…'), h('span', { class: 'ew-picker-kind' }, 'Write or paste one for this workspace'),
    ]));
  }
  menu.replaceChildren(...nodes);
  menu.hidden = false;
}
// The scope step (DESIGN §4.2): a second level in the same menu
// element — back row, the skill's name, then Every agent and this
// channel's seats (or only the record's seats: the record's scope
// is the ceiling), and the Edit row that keeps the authoring editor
// reachable from the pick that uses the skill. An owner-disabled
// skill shows its turned-off note where the attach rows would be.
function renderSlashScopeStep(which, menu, view) {
  const { scope } = view;
  const nodes = [];
  let pickIndex = -1;
  const row = (entry, kids) => { pickIndex += 1; nodes.push(slashRowButton(which, entry, pickIndex, kids)); };
  row({ type: 'back' }, [h('span', { class: 'ew-slash-name' }, '‹ Skills'), h('span', { class: 'ew-picker-kind' }, 'back to the list')]);
  nodes.push(h('div', { class: 'ew-subhead' }, `/${scope.skillId} — attach for`));
  if (scope.disabled) {
    nodes.push(h('p', { class: 'ew-note' }, 'Turned off by your workspace owner — it will not ride on a message until it is turned back on.'));
  }
  for (const r of scope.rows) {
    row({ type: 'scope', seatId: r.seatId }, [
      h('span', { class: 'ew-slash-name' }, r.name), h('span', { class: 'ew-picker-kind' }, r.seatId === 'all' ? 'every agent in this channel' : ''), h('span', { class: 'ew-picker-state off' }, r.seatId === 'all' ? 'all' : ''),
    ]);
  }
  row({ type: 'edit', id: scope.skillId }, [
    h('span', { class: 'ew-slash-name' }, '✎ Edit skill…'), h('span', { class: 'ew-picker-kind' }, 'name, description, instructions, scope'),
  ]);
  menu.replaceChildren(...nodes);
  menu.hidden = false;
}
function pickSlashEntry(which, entry) {
  const view = slashView(which);
  if (!entry) return;
  if (entry.type === 'command') { pickSlashCommand(which, entry.name); return; }
  if (entry.type === 'skill') { ws.slash.scopeFor = entry.id; ws.slash.index = 0; renderSlashMenu(which); return; }
  if (entry.type === 'back') { ws.slash.scopeFor = null; ws.slash.index = 0; renderSlashMenu(which); return; }
  if (entry.type === 'scope' && view?.skill) { armSlashSkill(which, view.skill, entry.seatId); return; }
  if (entry.type === 'new-skill') { openSkillEditor(null); return; }
  if (entry.type === 'edit') { openSkillEditor(entry.id); return; }
}
// Arming a skill (DESIGN §4.2): the chip appears, the menu closes,
// and the typed token leaves the box — it was how the person got
// here, not part of the message. Sending stays the human's Enter,
// on the message they now write.
function armSlashSkill(which, skill, seatId) {
  const res = addSkillAttach(ws.skillAttach[which], { skillId: skill.id, seatId });
  ws.skillAttach[which] = res.list;
  if (!res.added && res.reason) ws.ctx.toast(res.reason);
  const box = $(SLASH_IDS[which].input);
  ws.slash.dismissedFor = null;
  closeSlashMenu();
  if (box) { box.value = ''; box.focus(); grow(); }
  renderAttachChips(which);
}
function pickSlashCommand(which, name) {
  const box = $(SLASH_IDS[which].input); if (!box) return;
  box.value = slashInsertValue(name);
  ws.slash.dismissedFor = null;
  closeSlashMenu();
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
  grow();
}
// True when the key belonged to the open menu (and has been handled, so
// the composer's own Enter-to-send must not also fire). Registered
// before the send keydown handlers for that reason.
function slashKeydown(which, e) {
  if (ws.slash.openFor !== which) return false;
  const view = slashView(which);
  if (!view) { closeSlashMenu(); return false; }
  if (e.key === 'Escape' || (view.level === 2 && e.key === 'ArrowLeft')) {
    e.preventDefault(); e.stopImmediatePropagation();
    // Escape steps OUT one level at a time (DESIGN §4.2): from the
    // scope step back to the list; from the list, the menu closes.
    if (view.level === 2) { ws.slash.scopeFor = null; ws.slash.index = 0; renderSlashMenu(which); }
    else {
      ws.slash.dismissedFor = $(SLASH_IDS[which].input)?.value ?? null;
      closeSlashMenu();
    }
    return true;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); e.stopImmediatePropagation();
    ws.slash.index = moveSlashHighlight(ws.slash.index, e.key === 'ArrowDown' ? 1 : -1, view.entries.length);
    renderSlashMenu(which);
    return true;
  }
  if ((e.key === 'Enter' || e.key === 'Tab') && view.entries.length) {
    e.preventDefault(); e.stopImmediatePropagation();
    pickSlashEntry(which, view.entries[ws.slash.index] ?? view.entries[0]);
    return true;
  }
  return false;
}

// ---------- the skill authoring editor (DESIGN §2.3/§4.3) ----------
// One editor serves typing AND paste, reached from the "/" menu: the
// Skills group's New row (create) and a skill's scope-step Edit row
// (edit in place). The pure half — slug derivation, draft validation,
// the paste prefill, the save payload — is skill-editor.mjs; this is
// the DOM and the S2 routes (POST/PUT/DELETE /api/admin/skills).
// Paste never rewrites the body here: the raw text rides in the
// payload and the route's own lift strips its frontmatter
// server-side; the editor only prefills the fields the paste's
// frontmatter names (applySkillPaste), so what the form shows is
// what will be saved. Saving a NEW skill also attaches it to the
// pending message in the same motion (attach-on-save) — the person
// just wrote it for this message. An edit only saves.
function skillSaveErrorText(err) {
  switch (err?.body?.code) {
    case 'SKILL_CONFLICT': return 'A skill with that id already exists — rename it, or remove the other one first.';
    case 'SKILL_SEAT_UNKNOWN': return 'One of the picked agents is not a seat this workspace has.';
    case 'SKILL_ROLE_FORBIDDEN': return 'Your role can read skills but not author them.';
    case 'SKILLS_UNAVAILABLE': return 'Skills are not available on this workspace yet.';
    case 'SKILL_INVALID': return 'That skill was refused — check the name and the lengths.';
    default: return 'Could not save the skill.';
  }
}
async function openSkillEditor(skillId) {
  // The menu closes and stays closed for this token — the modal is
  // the surface now; cancelling out of it must not pop the menu back.
  const composerBox = $('maestro-input');
  if (composerBox) ws.slash.dismissedFor = composerBox.value;
  closeSlashMenu();
  const editing = Boolean(skillId);
  let draft = emptySkillDraft();
  if (editing) {
    try {
      const body = await ws.ctx.api(`/api/admin/skills/${encodeURIComponent(skillId)}`);
      if (!body?.skill) throw new Error('missing');
      draft = skillDraftFromRecord(body.skill);
    } catch { ws.ctx.toast('Could not load that skill.'); return; }
  }
  // The id a create will save under: the record's (never edited), a
  // paste's frontmatter slug, or — while both are empty — derived
  // live from the name field.
  let pasteId = editing ? draft.id : '';
  const nameInput = h('input', { value: draft.name, maxlength: 120, placeholder: 'e.g. Deep research', 'aria-label': 'Skill name' });
  const descInput = h('input', { value: draft.description, maxlength: 200, placeholder: 'One line — what the picker shows', 'aria-label': 'Skill description' });
  const bodyInput = h('textarea', { rows: 10, 'aria-label': 'Skill instructions', placeholder: 'Write the instructions — or paste a skill file (SKILL.md) here and its name and description fill in above.' }, draft.body);
  const idNote = h('p', { class: 'ew-note' });
  const drawId = () => {
    idNote.textContent = editing
      ? `This skill is /${draft.id} — its id never changes under an edit.`
      : `Saves as /${skillDraftId({ id: pasteId, name: nameInput.value }) ?? '…'} — the name the menu lists and the message carries.`;
  };
  nameInput.addEventListener('input', drawId);
  bodyInput.addEventListener('paste', () => {
    // The paste has not landed in the value yet at event time; read
    // it on the next tick, whole — the prefill fills only the fields
    // still empty, and the body itself is never rewritten.
    setTimeout(() => {
      const next = applySkillPaste({ id: pasteId, name: nameInput.value, description: descInput.value, body: bodyInput.value, scope: 'blanket', seatIds: [] }, bodyInput.value);
      if (!nameInput.value && next.name) nameInput.value = next.name;
      if (!descInput.value && next.description) descInput.value = next.description;
      if (!pasteId && next.id) pasteId = next.id;
      drawId();
    }, 0);
  });
  drawId();
  const blanketRadio = h('input', { type: 'radio', name: 'ew-skill-scope', value: 'blanket', ...(draft.scope === 'blanket' ? { checked: true } : {}) });
  const seatsRadio = h('input', { type: 'radio', name: 'ew-skill-scope', value: 'seats', ...(draft.scope === 'seats' ? { checked: true } : {}) });
  const seatChecks = channelSkillSeats().map((s) => ({ seatId: s.seatId, input: h('input', { type: 'checkbox', ...(draft.seatIds.includes(s.seatId) ? { checked: true } : {}) }), name: s.name }));
  const seatsBox = h('div', { class: 'ew-picker-group' },
    ...(seatChecks.length
      ? seatChecks.map((c) => h('label', {}, c.input, ` ${c.name}`))
      : [h('p', { class: 'ew-note' }, 'No agents are in this channel to pick — a skill for picked agents needs a channel with agents.')]));
  const syncScope = () => { seatsBox.hidden = !seatsRadio.checked; };
  blanketRadio.addEventListener('change', syncScope);
  seatsRadio.addEventListener('change', syncScope);
  syncScope();
  const statusNote = h('p', { class: 'muted sm' }, editing
    ? 'Edits change future turns only — messages already sent keep the skill they named, read as it stands when their turn comes.'
    : 'Saving attaches the new skill to the message you are writing.');
  const draftFromFields = () => ({
    id: editing ? draft.id : pasteId,
    name: nameInput.value,
    description: descInput.value,
    body: bodyInput.value,
    scope: seatsRadio.checked ? 'seats' : 'blanket',
    seatIds: seatChecks.filter((c) => c.input.checked).map((c) => c.seatId),
  });
  const form = h('form', { class: 'ew-modal-form', onsubmit: async (e) => {
    e.preventDefault();
    const now = draftFromFields();
    const verdict = validateSkillDraft(now);
    if (!verdict.ok) { statusNote.textContent = Object.values(verdict.errors)[0]; return; }
    const payload = skillSavePayload(now, { editing });
    try {
      const res = editing
        ? await ws.ctx.api(`/api/admin/skills/${encodeURIComponent(draft.id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
        : await ws.ctx.post('/api/admin/skills', payload);
      const saved = res.skill;
      invalidateSkills();
      closeModal();
      if (editing) { ws.ctx.toast(`Skill /${saved.id} saved`, 'ok'); return; }
      // Attach-on-save (DESIGN §4.3): the record's own scope names
      // the targets — every agent, or each picked seat.
      const targets = saved.scope === 'seats' ? saved.seatIds : ['all'];
      let list = ws.skillAttach.channel;
      let refused = null;
      for (const seatId of targets) {
        const r = addSkillAttach(list, { skillId: saved.id, seatId });
        list = r.list;
        if (!r.added && r.reason && r.reason !== 'Already attached.') refused = r.reason;
      }
      ws.skillAttach.channel = list;
      renderAttachChips('channel');
      if (composerBox && slashTokenOf(composerBox.value)) { composerBox.value = ''; grow(); }
      ws.slash.dismissedFor = null;
      if (refused) ws.ctx.toast(`Skill /${saved.id} saved. ${refused}`);
      else ws.ctx.toast(`Skill /${saved.id} saved and attached to your next message`, 'ok');
    } catch (err) { statusNote.textContent = skillSaveErrorText(err); }
  } },
    h('label', { class: 'ew-field' }, h('span', { class: 'ew-field-label' }, 'Name'), nameInput),
    idNote,
    h('label', { class: 'ew-field' }, h('span', { class: 'ew-field-label' }, 'Description'), descInput),
    h('label', { class: 'ew-field' }, h('span', { class: 'ew-field-label' }, 'Instructions'), bodyInput),
    h('div', { class: 'ew-field' }, h('span', { class: 'ew-field-label' }, 'Who is it for'),
      h('div', { class: 'ew-row' },
        h('label', {}, blanketRadio, ' Every agent'),
        h('label', {}, seatsRadio, ' Pick agents…')),
      seatsBox),
    statusNote);
  if (editing) {
    // Delete sits in the editor (DESIGN §4.3), behind a confirm line
    // that states the §2.4 consequence before anything is removed.
    const confirmRow = h('div', { class: 'ew-modal-actions', hidden: true },
      h('span', {}, `Delete /${draft.id} for good? Messages that already named it will say it is no longer in this workspace's skills.`));
    const keepBtn = h('button', { type: 'button', class: 'ew-btn ghost' }, 'Keep it');
    const killBtn = h('button', { type: 'button', class: 'ew-btn danger' }, 'Delete for good');
    confirmRow.append(h('span', { class: 'ew-spacer' }), keepBtn, killBtn);
    const actionsRow = h('div', { class: 'ew-modal-actions' },
      h('button', { type: 'button', class: 'ew-btn danger', onclick: () => { actionsRow.hidden = true; confirmRow.hidden = false; } }, 'Delete skill'),
      h('span', { class: 'ew-spacer' }),
      h('button', { type: 'button', class: 'ew-btn ghost', onclick: closeModal }, 'Cancel'),
      h('button', { type: 'submit', class: 'ew-btn primary' }, 'Save skill'));
    keepBtn.addEventListener('click', () => { confirmRow.hidden = true; actionsRow.hidden = false; });
    killBtn.addEventListener('click', async () => {
      try {
        await ws.ctx.api(`/api/admin/skills/${encodeURIComponent(draft.id)}`, { method: 'DELETE' });
        invalidateSkills();
        closeModal();
        ws.ctx.toast(`Skill /${draft.id} deleted`, 'ok');
      } catch { statusNote.textContent = 'Could not delete the skill.'; confirmRow.hidden = true; actionsRow.hidden = false; }
    });
    form.append(actionsRow, confirmRow);
  } else {
    form.append(h('div', { class: 'ew-modal-actions' }, h('span', { class: 'ew-spacer' }), h('button', { type: 'button', class: 'ew-btn ghost', onclick: closeModal }, 'Cancel'), h('button', { type: 'submit', class: 'ew-btn primary' }, 'Save skill')));
  }
  openModal(editing ? `Edit skill /${draft.id}` : 'New skill', [
    h('p', {}, editing
      ? 'Change what this skill says or who it is for. It stays the same skill — messages name it by its id.'
      : 'Write a skill, or paste one in — a pasted SKILL.md fills its own name and description in. Helmian keeps it for this workspace.'),
    form,
  ]);
  nameInput.focus();
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
  const id = ws.channelId; if (!id) { $('ew-messages').replaceChildren(h('div', { class: 'ew-empty' }, ws.mode === 'discord' ? discordEmptyText() : 'No channel yet. Ask the workspace owner to create one.')); setComposer(false); return; }
  const body = await ws.ctx.api(`/api/admin/envoy/messages?channel_id=${encodeURIComponent(id)}&limit=100`);
  if (id !== ws.channelId) return;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const sig = messages.map((m) => m.id).join(',');
  if (sig === ws.sig) {
    renderAgents();
    loadReactions(); // throttled — a reaction lands without any message change
    return;
  }
  ws.sig = sig; ws.messages = messages;
  speakNewMessages(id, messages);
  renderMessages(); renderAgents();
  loadReactions(); // throttled — the 5s cadence governs during activity too (latency fix L1)
}
// ---------- spoken replies (voice bite 2d) ----------
// While voice chat is on, messages from anyone else are read aloud
// through the shared voice controller (ctx.voiceSpeak, wired in
// app.js; it speaks only in voice chat, and its view gate keeps the
// session console as the only speaker while that view is up). One
// seen-set covers both streams this module renders — the open
// channel and the agent-CLI room — so a message is spoken by
// whichever surface sees it first, never twice. A stream's first
// load only primes the set: history is never read aloud by the
// scanner, only messages that arrive while the member is in the
// room. Pending rows are local echoes of the member's own send and
// never speak.
//
// The seen-set records every message the scanner has looked at —
// including replies that arrived while voice chat was off, whose
// speak call the controller declined. voicedIds is the narrower
// truth: the messages that were actually SPOKEN — a message lands
// there only when the controller reports its first chunk playing
// (noteSpeaking, in the speaking-proof section below), never when
// a speak is merely taken. A taken speak whose audio never plays —
// the served fetch failed and the in-tab road could not speak it
// either, or the speech was cancelled before it started — leaves
// the message unvoiced, so the voice-on catch-up below can still
// offer it (voice-hardening bite: marking rides playback, not the
// offer). It exists for the catch-up, which owes the member the
// newest seat reply that landed before voice chat was switched on.
const spokenIds = new Set();
const voicedIds = new Set();
const spokenPrimed = new Set();
function speakNewMessages(streamId, messages) {
  if (!streamId || typeof ws.ctx?.voiceSpeak !== 'function') return;
  if (!spokenPrimed.has(streamId)) {
    spokenPrimed.add(streamId);
    for (const m of messages ?? []) if (m?.id) spokenIds.add(m.id);
    return;
  }
  for (const m of messages ?? []) {
    if (!m?.id || m._pending || spokenIds.has(m.id)) continue;
    spokenIds.add(m.id);
    const who = whoOf(m);
    if (m.authorKind === 'system' || who.kind === 'me') continue;
    // The seat key rides along so the controller can speak in that
    // seat's own Kokoro voice (per-seat voice map in the controller).
    // The message id rides too, so the speaking proof can light the
    // speaker icon on THIS message while it is being spoken. Taking
    // the speak does NOT mark the message voiced: the mark lands in
    // noteSpeaking, when the first chunk actually plays — a speak
    // that never reaches playback stays eligible for the catch-up.
    ws.ctx.voiceSpeak(m.body, who.provider ?? null, m.id);
  }
}
// ---------- voice-on catch-up (catch-up bite) ----------
// The scanner above only speaks messages that arrive while voice
// chat is on: a reply that landed earlier was seen, declined, and
// never revisited — so the owner's real move (ask everybody, then
// switch voice chat on) was met with silence. The catch-up closes
// that gap: at the moment voice chat is switched on in this room
// (app.js calls speakCatchUp from the room's voice toggle), the
// newest completed seat reply in the open channel that has not
// been voiced is spoken through the same speak path — its seat
// voice, its speaker icon — exactly one message per switch-on,
// never a backlog replay.
//
// catchUpPick is the pure decision, exported for tests: the newest
// message in stream order that is a seat/agent message (the same
// agent test whoOf makes: an agent provider, an agent: subject, or
// a PC-bridge row), complete (not a pending local echo, with a
// speakable body), not a system row, and not the member's own.
// runCatchUp applies the already-voiced rule on top: if that
// newest reply was voiced, no catch-up fires at all — the room
// never reaches back to an older reply in its place. A speak the
// controller declines (voice chat already off again, the console
// view gate) does not mark the message voiced, so a later
// switch-on can still offer it. A speak the controller TAKES does
// not mark it voiced either: the mark lands in noteSpeaking, when
// the first chunk actually plays, so a catch-up whose audio never
// plays is offered again at the next switch-on. It still cannot
// be offered twice in between: the catch-up fires only at
// switch-on, and reaching switch-on again means a switch-off
// happened first, which cancels a queued catch-up through the
// controller's own cancel path.
export function catchUpPick(messages, me) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!m?.id || m._pending) continue;
    if (typeof m.body !== 'string' || !m.body.trim()) continue;
    if (m.authorKind === 'system') continue;
    if (m.authorKind === 'human' && me && m.authorSubject === me) continue;
    const isSeat = Boolean(m.agentProvider)
      || (typeof m.authorSubject === 'string' && (m.authorSubject.startsWith('agent:') || m.authorSubject.endsWith(':bridge')));
    if (!isSeat) continue;
    const provider = m.agentProvider || (typeof m.authorSubject === 'string' && m.authorSubject.startsWith('agent:') ? m.authorSubject.slice(6) : null);
    return { id: m.id, body: m.body, provider };
  }
  return null;
}
export function runCatchUp({ messages, voiced, me, speak }) {
  if (typeof speak !== 'function' || !voiced) return null;
  const pick = catchUpPick(messages, me);
  if (!pick || voiced.has(pick.id)) return null;
  if (speak(pick.body, pick.provider, pick.id) === false) return null;
  return pick; // no mark here: voiced is written at playback (noteSpeaking), so an unplayed offer stays eligible
}
export function speakCatchUp() {
  if (!ws.channelId || typeof ws.ctx?.voiceSpeak !== 'function') return;
  if (!spokenPrimed.has(ws.channelId)) return;
  runCatchUp({
    messages: ws.messages,
    voiced: voicedIds,
    me: ws.ctx.state.actor?.subject,
    speak: (body, provider, id) => ws.ctx.voiceSpeak(body, provider, id),
  });
}
// ---------- speaking proof (speaker-proof bite) ----------
// Troy's ask (2026-11-08): a little speaker icon on a seat's message
// that lights while that seat's voice is actually playing, so he —
// and an automated checker — can see which seat's voice fired. The
// voice controller owns the truth (it reports playback start/end per
// engine through the listener app.js forwards to noteSpeaking here);
// this module owns the drawing. The marker is machine-readable: a
// checker counts `.ew-speaking[data-speaking="true"]` inside
// `#ew-messages` and reads the seat from its data-seat (the engine
// from data-engine). State lives in this module, not on DOM nodes:
// renders draw the icon from speakingNow (the speaking state rides
// the row's render signature), and noteSpeaking patches the live
// DOM immediately between renders — an incremental render keeps the
// very node the patch landed on, so the icon is never wiped.
let speakingNow = null;
export function noteSpeaking(info) {
  // Voiced marking (voice-hardening bite): this report — a chunk of
  // the message actually playing, on whichever road spoke it — is
  // the one place a message becomes voiced. On the served road it
  // fires only after the first chunk's fetch succeeded and its
  // buffer started; on the in-tab roads it fires at generation or
  // utterance start. A speak that was taken but never played never
  // reaches here, so its message stays eligible for the catch-up.
  if (info?.ref) voicedIds.add(info.ref);
  speakingNow = info ?? null;
  patchSpeakingIcon();
}
export function speakingIconNode(info) {
  return h('span', { class: 'ew-speaking', 'data-speaking': 'true', 'data-seat': info?.seat ?? '', 'data-engine': info?.engine ?? '', role: 'img', 'aria-label': 'Speaking now' }, '🔊');
}
function patchSpeakingIcon() {
  if (typeof document === 'undefined') return;
  const box = $('ew-messages');
  if (!box) return;
  for (const n of box.querySelectorAll('.ew-speaking')) n.remove();
  if (!speakingNow?.ref) return;
  for (const row of box.querySelectorAll('.ew-msg')) {
    if (row.dataset.id !== speakingNow.ref) continue;
    const meta = row.querySelector('.ew-meta');
    if (!meta) return;
    // A grouped follow-up's meta line is CSS-hidden; its icon stands
    // right after the meta instead, beside the spoken text.
    if (row.classList.contains('cont')) meta.after(speakingIconNode(speakingNow));
    else meta.append(speakingIconNode(speakingNow));
    return;
  }
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
// ---------- unread "New" divider (UI polish bite 2) ----------
// Client-side only: a per-channel last-seen stamp in localStorage
// (the ls store, key lastSeen.<channelId>, ms since epoch). Entering
// a channel snapshots the stored stamp; renders draw the red
// divider before the first message from someone else that is newer
// than the snapshot. The stamp advances when the member leaves the
// channel (selectChannel) or settles at its bottom (the scroll
// listener in wire()); the snapshot itself never moves mid-visit,
// so the divider holds its place across poll re-renders. A channel
// with no stored stamp (first ever visit) shows no divider.
const unread = { channelId: null, at: 0, armedAt: 0 };
function unreadSnapshot() {
  if (unread.channelId === ws.channelId) return;
  unread.channelId = ws.channelId;
  unread.at = ws.channelId ? Number(ls.get(`lastSeen.${ws.channelId}`, 0)) || 0 : 0;
  // The entry render auto-scrolls to the bottom; that programmatic
  // scroll is not the member viewing the bottom, so the scroll
  // listener stays disarmed briefly after each channel switch.
  unread.armedAt = Date.now() + 600;
}
function markChannelSeen(channelId, messages) {
  if (!channelId || !messages?.length) return;
  let newest = 0;
  for (const m of messages) { const t = new Date(m.createdAt).getTime(); if (t > newest) newest = t; }
  if (!(newest > 0)) return;
  if (newest > (Number(ls.get(`lastSeen.${channelId}`, 0)) || 0)) ls.set(`lastSeen.${channelId}`, newest);
  if (unread.channelId === channelId && newest > unread.at) unread.at = newest;
}
// ---------- incremental message rendering (page-lockup fix, 2026-11-11) ----------
// renderMessages used to rebuild every row on every call: it looped
// the whole loaded history, re-ran renderBody on every body and
// re-created every avatar, then swapped the container. During a fast
// round (a post landing every second or two, plus the activity tick
// re-rendering once a second while any seat works) the tab's main
// thread saturated and Chrome raised "Page Unresponsive" (Troy,
// 2026-11-10). The render is now keyed: a per-channel cache maps a
// row's key to its live DOM node plus a signature of everything that
// can change that row's drawing. A call builds rows only for new or
// changed messages, drops rows whose messages vanished, and — when
// the desired child sequence already matches the DOM exactly —
// performs no DOM writes at all (the bare poll case). Day dividers,
// the New divider and the activity rows are keyed in the same cache;
// their rebuilds are cheap and never touch a kept message row.
// The speaking icon keeps its standing discipline: the signature
// covers the speaking state, and noteSpeaking()/patchSpeakingIcon()
// still patch the live DOM between renders — a kept row is the very
// node they patch, so an incremental render never wipes a live icon
// from an unchanged row.
const msgRenderCache = { channelId: undefined, entries: new Map() };

function renderMessages() {
  const box = $('ew-messages');
  const deskChannel = inMaestroMode();
  // Maestro always-on: a human send in every channel is a dispatch,
  // so human messages carry their dispatch line everywhere.
  const desk = true;
  unreadSnapshot();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
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
  // The keyed-row cache is per channel: entering another channel
  // starts from an empty cache (the box is reconciled against the
  // real DOM either way, so a foreign writer — the Loading… card, the
  // Discord empty state — is evicted by the same pass).
  if (msgRenderCache.channelId !== ws.channelId) { msgRenderCache.channelId = ws.channelId; msgRenderCache.entries = new Map(); }
  const prevEntries = msgRenderCache.entries;
  const nextEntries = new Map();
  const desired = [];
  const keyUse = new Map();
  const keep = (key, sig, build) => {
    const seen = (keyUse.get(key) ?? 0) + 1; keyUse.set(key, seen);
    const k = seen > 1 ? `${key}#${seen}` : key;
    const hit = prevEntries.get(k);
    const node = hit && hit.sig === sig ? hit.node : build();
    nextEntries.set(k, { node, sig });
    desired.push(node);
    return node;
  };
  // The salt: every workspace-level input a row's drawing reads —
  // whose face is whose (the faces map, the profile nickname), the
  // still/motion gate, the custom-agent records behind whoOf, and
  // the desk roster behind the dispatch line. When any of it moves
  // (loadFaces landing is the live case), every signature moves and
  // the rows rebuild once, exactly as the old full render did.
  const salt = JSON.stringify([
    ws.ctx.state.actor?.subject ?? '',
    ws.faces ?? null,
    ws.profile?.nickname ?? '',
    emojiStill(),
    ws.config?.customAgents ?? null,
    (ws.config?.agents ?? []).map((a) => a.provider),
  ]);
  let prev = null; let prevDay = ''; let newShown = false;
  for (const m of ws.messages) {
    const day = dayLabel(m.createdAt);
    if (day !== prevDay) { keep(`day:${day}`, day, () => h('div', { class: 'ew-day' }, day)); prevDay = day; prev = null; }
    if (m.authorKind === 'system') {
      keep(`msg:${m.id}`, JSON.stringify([salt, m.authorKind, m.body]), () => h('div', { class: 'ew-notice' }, h('span', {}, m.body)));
      prev = null; continue;
    }
    const who = whoOf(m);
    // The red "New" divider (bite 2): the first message from someone
    // else newer than the entry snapshot carries it, and the divider
    // breaks the group — this message prints its full header.
    const showNew = !newShown && unread.at > 0 && who.kind !== 'me' && !m._pending && new Date(m.createdAt).getTime() > unread.at;
    if (showNew) newShown = true;
    const cont = !showNew && prev && prev.authorSubject === m.authorSubject && new Date(m.createdAt) - new Date(prev.createdAt) < 5 * 60_000;
    const motionCls = who.kind === 'agent' ? activityMotionClass(liveMotion.get(who.custom ? who.custom.handle : who.provider)) : '';
    if (showNew) keep('new-divider', `new:${m.id}`, () => h('div', { class: 'ew-new-divider' }, h('span', {}, 'New')));
    // The row signature: everything this row's drawing reads — the
    // message's own fields (body, stamp, pending flag, author fields,
    // metadata), its grouping against the previous message, the New
    // divider break, its seat's live motion class, the speaking
    // state, and its reaction chips as the store currently stands.
    const speakingSig = speakingNow && speakingNow.ref === m.id ? `${speakingNow.seat ?? ''}|${speakingNow.engine ?? ''}` : '';
    const reactionsSig = ws.reactions.channelId === ws.channelId ? JSON.stringify([ws.reactions.byId[m.id] ?? null, ws.reactions.mine[m.id] ?? null]) : '';
    const sig = JSON.stringify([salt, m.body, m.createdAt, m._pending ? 1 : 0, m.authorKind, m.authorSubject ?? '', m.agentProvider ?? '', m.authorName ?? '', m.authorEmoji ?? '', m.source ?? '', JSON.stringify(m.metadata ?? null), cont ? 1 : 0, showNew ? 1 : 0, motionCls, speakingSig, reactionsSig]);
    keep(`msg:${m.id}`, sig, () => {
      const avatar = who.kind === 'agent'
        ? (who.custom ? h('div', { class: `ew-avatar emoji-ava${motionCls ? ` ${motionCls}` : ''}` }, emojiNode(who.custom.emoji || '🤖')) : msgSeatAvatar(who.provider, liveMotion.get(who.provider) ?? null))
        : who.kind === 'me'
          ? msgOwnerAvatar()
          : (who.authorEmoji ? (isLibraryFaceToken(who.authorEmoji) ? h('div', { class: 'ew-avatar lib-ava' }, libraryFaceImg(who.authorEmoji)) : h('div', { class: 'ew-avatar emoji-ava' }, emojiNode(who.authorEmoji))) : h('div', { class: `ew-avatar${who.kind === 'discord' ? ' discord' : who.kind === 'slack' ? ' slack' : ''}` }, who.name.slice(0, 1).toUpperCase()));
      const slackChannel = who.kind === 'slack' && m.metadata?.source?.channelName ? ` · #${m.metadata.source.channelName}` : '';
      const src = who.kind === 'agent'
        ? h('span', { class: 'ew-src agent' }, who.custom?.jobTitle ? `AGENT · ${who.custom.jobTitle}` : 'AGENT')
        : who.kind === 'discord' ? h('span', { class: 'ew-src discord' }, 'DISCORD') : who.kind === 'slack' ? h('span', { class: 'ew-src slack' }, `SLACK${slackChannel}`) : null;
      // In the desk, a manager send carries its dispatch line; agent
      // replies render as themselves, under their own names, as anywhere.
      const dispatch = desk && m.authorKind === 'human' ? deskDispatchLine(m) : null;
      // A Helmian skill that rode this message shows as a chip row
      // under its body (DESIGN §4.4): without it a metadata skill
      // would be invisible on its own message — the by-name road's
      // skill is visible only because its /name leads the body text.
      const skillRefs = Array.isArray(m.metadata?.skills) ? m.metadata.skills : [];
      const skillRefRow = skillRefs.length ? h('div', { class: 'ew-msg-skills' }, ...skillRefs.map((s) => h('span', { class: 'ew-chip skill-ref' }, s.seatId === 'all' ? `/${s.skillId}` : `/${s.skillId} → ${skillSeatLabel(s.seatId)}`))) : null;
      // Grouped follow-ups print no avatar and no header; in their
      // place the gutter carries the follow-up's time, shown on hover
      // (bite 2). Every per-message action lives in the one hover
      // toolbar — the reaction button moved inside it, beside Copy.
      const firstCell = cont ? h('time', { class: 'ew-gutter-time', datetime: m.createdAt }, clock(m.createdAt)) : avatar;
      // Speaking proof: the message being spoken right now carries the
      // speaker icon — in its meta line, or (grouped follow-up, whose
      // meta is hidden) standing right after the meta, beside the text.
      const speakIcon = speakingNow && speakingNow.ref === m.id ? speakingIconNode(speakingNow) : null;
      return h('div', { class: `ew-msg${cont ? ' cont' : ''}${m._pending ? ' pending' : ''}`, 'data-id': m.id }, firstCell,
        h('div', {}, h('div', { class: 'ew-meta' }, h('strong', { class: who.kind === 'agent' ? 'agent' : '' }, who.name), src, h('time', { datetime: m.createdAt }, clock(m.createdAt)), cont ? null : speakIcon),
          cont ? speakIcon : null,
          h('div', { class: 'ew-body' }, renderBody(m.body, who.kind === 'agent' ? { onLink: onAgentLink, linkTitle: 'Open in a new tab', onCanvas } : { onLink, onCanvas })),
          skillRefRow,
          h('div', { class: 'ew-reactions' }, ...reactionChipKids(m.id)), dispatch),
        m._pending ? null : h('div', { class: 'ew-msg-tools', role: 'toolbar', 'aria-label': 'Message actions' }, reactionAddButton(m), copyMessageButton(m)));
    });
    prev = m;
  }
  // Real runner activity rows (activity desk bite): one per seat whose
  // newest unexpired event for this channel is live, sitting where its
  // reply will land. Events or nothing — the age-derived "X is
  // answering…" cue that stood here was removed 2026-11-04 on Troy's
  // order; it lit seats from message age alone, job or no job.
  for (const cue of cues) keep(`act:${cue.provider}`, JSON.stringify([salt, cue.provider, cue.event.stage, activityElapsed(cue.event), activityCueText(activityName(cue.provider, ws.config?.customAgents), cue.event)]), () => activityRow(cue.provider, cue.event, ws.config?.customAgents));
  if (!ws.messages.length) keep('ew-empty', emptyChannelText({ desk: deskChannel, hasAgents: Boolean(ws.config?.agents?.length) }), () => h('div', { class: 'ew-empty' }, emptyChannelText({ desk: deskChannel, hasAgents: Boolean(ws.config?.agents?.length) })));
  msgRenderCache.entries = nextEntries;
  // Reconcile the box against the desired sequence by node identity.
  // An identical sequence (the bare poll) writes nothing at all.
  // Otherwise only the delta moves: foreign or vanished children are
  // removed, new or out-of-order nodes are inserted — kept rows are
  // never re-created, so their patched speaking icons, reaction chips
  // and scroll state survive untouched.
  const cur = [...box.childNodes];
  let identical = cur.length === desired.length;
  if (identical) for (let i = 0; i < cur.length; i++) { if (cur[i] !== desired[i]) { identical = false; break; } }
  if (!identical) {
    const keepSet = new Set(desired);
    for (const n of cur) if (!keepSet.has(n)) n.remove();
    let next = null;
    for (let i = desired.length - 1; i >= 0; i--) {
      const node = desired[i];
      if (node.parentNode !== box || node.nextSibling !== next) box.insertBefore(node, next);
      next = node;
    }
    if (atBottom || ws.messages.at(-1)?._pending || ws.messages.at(-1)?.authorSubject === ws.ctx.state.actor?.subject) box.scrollTop = box.scrollHeight;
  }
}

// ---------- message reactions (emoji bites 2 + 3) ----------
// Bite 2's store owns the data (route /api/admin/envoy/message-reactions:
// a bulk GET summary per message, a POST toggle that answers with the
// message's full new summary). Unicode stays the data there too — the
// store keeps bite 1's SLUG, the desk renders the slug's own art, and a
// slug this build ships no art for never renders as a broken image.
//
// Face-library extension: Maestro Library pieces ride the same store
// under 'lib-<name>' slugs with pack 'maestro-library' (the pack seam
// sql/068 built). The desk renders a library slug's still from
// face-library.mjs; the chip model carries library entries beside
// emoji entries, and an entry neither vocabulary knows is dropped, so
// a slug with no art never renders. NOTE: the store still validates
// against the emoji map — library toggles answer
// ENVOY_REACTION_EMOJI_UNSUPPORTED until the named server gap
// (FACE-LIBRARY-REPORT.md) lands; the desk's failure toast covers it.
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
// the signed-in member has on flagged as mine. Library entries carry
// library:true, the piece name and its spoken label, and char:null —
// the two vocabularies share one chip row without pretending a library
// piece is an emoji.
export function reactionChipModel(summary = [], mine = []) {
  const mineSet = new Set(mine ?? []);
  const out = [];
  for (const e of summary ?? []) {
    if (!(e?.count > 0)) continue;
    const libName = libraryReactionName(e?.emoji);
    if (libName) {
      const piece = libraryReaction(libName);
      out.push({ slug: e.emoji, char: null, library: true, name: libName, label: piece.label, count: e.count, mine: mineSet.has(e.emoji), actors: reactionActorLabel(e.actors) });
      continue;
    }
    const char = reactionChar(e?.emoji);
    if (!char) continue;
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
const reactionFace = (slug) => libraryReactionName(slug)
  ? h('img', { class: 'hx-emoji ew-rchip-face ew-rchip-lib', src: libraryReactionStillUrl(slug), alt: '', 'aria-hidden': 'true', loading: 'lazy' })
  : h('img', { class: 'hx-emoji ew-rchip-face', src: emojiAssetUrl(slug, { still: emojiStill() }), alt: '', 'aria-hidden': 'true', loading: 'lazy' });
function reactionChipKids(messageId) {
  if (ws.reactions.channelId !== ws.channelId) return [];
  return reactionChipModel(ws.reactions.byId[messageId], ws.reactions.mine[messageId]).map((c) => h('button', {
    type: 'button', class: `ew-rchip${c.mine ? ' mine' : ''}`,
    title: c.actors || 'Reaction', 'aria-pressed': String(c.mine),
    'aria-label': `${c.library ? c.label : c.char} reaction, ${c.count} ${c.count === 1 ? 'person' : 'people'}${c.mine ? ', including you' : ''} — activate to ${c.mine ? 'remove yours' : 'add yours'}`,
    onclick: () => toggleReaction(messageId, c.slug),
  }, reactionFace(c.slug), h('span', { class: 'ew-rchip-count' }, String(c.count))));
}
function reactionAddButton(m) {
  return h('button', { type: 'button', class: 'ew-react-add', title: 'Add a reaction', 'aria-label': 'Add a reaction', 'aria-haspopup': 'dialog',
    onclick: (e) => openReactionPicker(m.id, e.currentTarget) },
    emojiNode('🙂'), h('span', { class: 'ew-react-plus', 'aria-hidden': 'true' }, '+'));
}
// Copy a message's raw text (bite 2 hover toolbar). Clipboard API
// first; the off-screen textarea path covers the contexts where it
// is unavailable. The result is toasted either way — a silent copy
// button reads as a broken one.
function copyMessageButton(m) {
  return h('button', { type: 'button', class: 'ew-tool-btn', title: 'Copy message text', 'aria-label': 'Copy message text',
    onclick: () => { void copyMessageText(m); } }, 'Copy');
}
async function copyMessageText(m) {
  const text = typeof m.body === 'string' ? m.body : '';
  let done = false;
  try { await navigator.clipboard.writeText(text); done = true; } catch { /* fall through to the textarea path */ }
  if (!done) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    try { done = document.execCommand('copy'); } catch { done = false; }
    ta.remove();
  }
  ws.ctx.toast(done ? 'Message copied.' : 'Copy did not work here.');
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
  // The Maestro Library section: the glossy reaction pieces as stills
  // with their names — the library's own grid, under its own heading,
  // riding the same toggle road as the emoji grid above it.
  const libGrid = h('div', { class: 'ew-lib-react-grid', role: 'group', 'aria-label': 'Maestro Library reactions' },
    ...LIBRARY_REACTIONS.map((piece) => {
      const slug = libraryReactionSlug(piece.name);
      return h('button', { type: 'button', class: `ew-lib-react-btn${mine.has(slug) ? ' on' : ''}`, title: piece.use, 'aria-label': `React with ${piece.label}`, 'aria-pressed': String(mine.has(slug)), onclick: () => { closeReactionPicker(); toggleReaction(messageId, slug); } },
        h('img', { src: libraryReactionStillUrl(piece.name), alt: '', loading: 'lazy', width: 28, height: 28 }),
        h('span', { class: 'ew-lib-react-name' }, piece.label));
    }));
  reactionPop.replaceChildren(
    h('div', { class: 'ew-react-pop-head' }, h('span', {}, 'React'), h('button', { type: 'button', class: 'ew-chip-x', 'aria-label': 'Close reaction picker', onclick: closeReactionPicker }, '×')),
    grid,
    h('div', { class: 'ew-react-pop-head ew-react-sec' }, h('span', {}, 'Maestro Library')),
    libGrid);
  reactionPop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = Math.min(384, window.innerWidth - 16);
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
  const convId = conversationIdFor('channel');
  // The channel's standing armed set rides every message (bite A2) —
  // but only its still-connected pairs. A connector that has since
  // disconnected (or whose connection now needs reconnect) is
  // filtered out here against the seat's library read, loading the
  // read first when this session has not opened the menu yet, so a
  // set hydrated from the channel config is judged by the same
  // truth the toggle list showed. A seat whose read fails keeps its
  // pairs off the wire — unproven is unarmed. The set itself is
  // NOT cleared by the send: it stands until a flip changes it.
  const armedPairs = connectorsForTurn(ws.connectorToggles, convId);
  for (const seatId of [...new Set(armedPairs.map((p) => p.seatId))]) {
    try { await loadSeatLibrary(seatId); } catch {}
  }
  const sendableConnectors = armedPairs.filter((pair) => {
    const library = ws.libraryFacts?.libraries?.[pair.seatId];
    const row = library && !library.error ? library.rows.find((r) => r.entryId === pair.entryId) : null;
    return Boolean(row && row.state === 'connected' && row.brokerMode === 'helmian');
  });
  const req = buildMessageRequest({ channelId: ws.channelId, body, idempotencyKey: key, attachments: ws.attach.channel, webSearch: ws.webSearch.channel, connectors: sendableConnectors, skills: ws.skillAttach.channel, projectKey: ws.projects.activeKey ?? ws.ctx?.state?.activeProjectKey ?? null });
  const btn = $('maestro-send'); btn.disabled = true;
  ws.messages = [...ws.messages, { id: `pending-${key}`, authorKind: 'human', authorSubject: ws.ctx.state.actor?.subject, body: req.payload.body, createdAt: new Date().toISOString(), _pending: true }];
  renderMessages();
  box.value = ''; grow(); closeSlashMenu();
  try { await ws.ctx.post('/api/admin/envoy/messages', req.payload); ws.attach.channel = []; ws.webSearch.channel = false; ws.skillAttach.channel = []; renderAttachChips('channel'); closePicker(); ws.sig = null; await loadMessages(); loadPresence().catch(() => {}); }
  catch { box.value = body; grow(); ws.messages = ws.messages.filter((m) => !m._pending); renderMessages(); ws.ctx.toast('Not sent. Your message is back in the box.'); }
  finally { btn.disabled = false; }
}

// ---------- agent chat pane: sessions + prompt composer ----------
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
    const { default: qrcode } = await import('./vendor/qrcode.mjs?v=30a56f991a6244c2');
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
  wireShelves();
  for (const b of document.querySelectorAll('#ew [data-collapse]')) b.addEventListener('click', () => { const n = b.dataset.collapse; if (narrow()) { closeSheets(); return; } if (n === 'channels') { setChannelsRest(true, { user: true }); return; } setPane(n, false, { user: true }); });
  for (const b of document.querySelectorAll('#ew [data-open]')) b.addEventListener('click', () => { if (b.dataset.open === 'channels') setChannelsRest(false); setPane(b.dataset.open, true); });
  wireChannelsRail();
  for (const b of document.querySelectorAll('#ew [data-toggle]')) b.addEventListener('click', () => {
    const n = b.dataset.toggle; const open = !paneOpen(n);
    if (narrow()) closeSheets();
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
  // Unread divider (bite 2): settling at the bottom of the channel
  // marks it seen and clears the divider in place. Disarmed briefly
  // after each channel switch — the entry render's own auto-scroll
  // is not the member viewing the bottom (see unreadSnapshot).
  $('ew-messages').addEventListener('scroll', () => {
    if (Date.now() < unread.armedAt) return;
    const mb = $('ew-messages');
    if (mb.scrollHeight - mb.scrollTop - mb.clientHeight < 80) {
      markChannelSeen(ws.channelId, ws.messages);
      mb.querySelector('.ew-new-divider')?.remove();
    }
  }, { passive: true });
  const box = $('maestro-input');
  box.addEventListener('input', () => { grow(); refreshSlashMenu('channel'); syncCrewSelection(); });
  box.addEventListener('keydown', (e) => { slashKeydown('channel', e); });
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !narrow()) { e.preventDefault(); send(); } });
  // Ctrl+U attaches a file (mirror-design §3.1 — Claude's own
  // composer shortcut): opens the same hidden file input the "+"
  // menu's attach row uses, so the picked file runs the same ingest.
  box.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'u') { e.preventDefault(); pickFileForComposer('channel'); } });
  $('maestro-plus').addEventListener('click', () => togglePicker('channel'));
  // The "+" menu wears its popup shape from here (bite 3R-b): the
  // panel element keeps .ew-picker's chrome; this class narrows it
  // and anchors it above the button (envoy.css).
  $('ew-picker')?.classList.add('ew-plus-menu');
  // An outside press closes the menu, like the reaction picker below:
  // the button itself is excluded — its own click toggles.
  document.addEventListener('pointerdown', (e) => {
    if (!ws.pickerFor) return;
    const panel = $(PICKER_IDS[ws.pickerFor].panel);
    if (panel && !panel.hidden && !panel.contains(e.target) && !$('maestro-plus')?.contains(e.target)) closePicker();
  });
  $('maestro-mention-all')?.addEventListener('click', () => setCrewTarget('all'));
  $('maestro-mention')?.addEventListener('click', insertAtSignAtCaret);
  $('ew-debate-toggle')?.addEventListener('click', openDebateModal);
  $('ew-debate-stop')?.addEventListener('click', stopDebateNow);
  $('ew-phone-qr')?.addEventListener('click', openPhoneCloneModal);
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
  $('ew-guard-refresh').addEventListener('click', async () => { await ws.ctx.loadFeedData?.({ force: true }); ws.ctx.renderFeed?.(); });
  ws.ctx.wireVoice?.();
  window.matchMedia('(max-width: 900px)').addEventListener?.('change', applyLayout);
}

async function loadPresence() {
  try { const body = await ws.ctx.api('/api/admin/envoy/runner/presence'); ws.presenceRows = Array.isArray(body.presence) ? body.presence : []; ws.online = new Set((body.presence ?? []).filter((p) => p.connected !== false).map((p) => { const n = String(p.provider ?? p.providerName ?? '').toLowerCase(); return n === 'xai' ? 'grok' : n === 'ollama' ? 'qwen' : n; })); ws.activity = Array.isArray(body.activity) ? body.activity : []; }
  catch { ws.online = new Set(); /* the last good presence rows and activity feed stay — activity events expire on their own stamps */ }
  syncActivityViews();
}

function renderAgentState() {
  const el = $('ew-agent-state'); if (!el) return;
  const line = agentStateBanner(ws.agentState);
  el.hidden = !line;
  el.textContent = line ?? '';
}

// The first-run card's render (polish P1): rebuilt only when its
// visibility flips, so the 15-second state refresh never rebuilds
// the button under a click. The button rides the app shell's
// Agents-tab road (ctx.openAgentsTab) and falls back to the
// Integrations view itself on an older shell.
let firstRunCardShown = false;
function renderFirstRunCard() {
  const el = $('ew-first-run'); if (!el) return;
  const card = firstRunHandoff(ws.agentState);
  if (!card) {
    if (!el.hidden) { el.hidden = true; el.replaceChildren(); }
    firstRunCardShown = false;
    return;
  }
  if (firstRunCardShown) return;
  firstRunCardShown = true;
  el.replaceChildren(
    h('div', { class: 'ew-first-run-body' },
      h('strong', {}, card.heading),
      h('p', {}, card.body)),
    h('button', { type: 'button', class: 'ew-btn primary', onclick: () => { if (ws.ctx.openAgentsTab) ws.ctx.openAgentsTab(); else ws.ctx.openTools?.(); } }, card.label),
  );
  el.hidden = false;
}

async function loadAgentState() {
  try { const body = await ws.ctx.api('/api/admin/envoy/agent-state'); ws.agentState = body.agentState ?? null; }
  catch { ws.agentState = null; }
  renderAgentState();
  renderFirstRunCard();
}

export async function mountWorkspace(ctx) {
  ws.ctx = ctx;
  if (!ws.wired) wire();
  applyLayout();
  selectTab(ls.get('tab', 'browser'));
  if (ctx.benchTab) { openBench(ctx.benchTab); ctx.benchTab = null; }
  ws.ctx.renderFeed?.();
  await loadChannels().catch(() => { $('ew-messages').replaceChildren(h('div', { class: 'ew-empty' }, 'Envoy is reconnecting…')); });
  await Promise.allSettled([loadPresence(), loadAgentState(), loadConfig(), loadMessages(), loadFaces(), loadProfile()]);
  // Warm the plus menu's library caches while the workspace settles,
  // so a first open paints from memory instead of "Loading
  // libraries…" (the mount preload — see preloadLibrarySession).
  void preloadLibrarySession();
  clearInterval(ws.timer); clearTimeout(ws.timer); clearInterval(ws.slowTimer);
  const visible = () => document.visibilityState === 'visible' && document.getElementById('shell')?.dataset.view === 'desktop';
  // Message poll: calm at rest, fast while the runner activity feed
  // shows a seat working in the open channel — and on
  // that fast cadence presence (which carries the feed) refreshes too,
  // so stage changes and the elapsed clock stay live. This is the
  // event-driven return of the adaptive poll the age-derived mirror
  // used to drive (killed 2026-11-04, Troy's order): the feed decides,
  // never message age. The generation counter retires a chain whose
  // mount has been superseded, so remounts never stack pollers.
  const gen = (ws.pollGen = (ws.pollGen ?? 0) + 1);
  const tick = async () => {
    if (gen !== ws.pollGen) return;
    if (visible()) { await loadMessages().catch(() => {}); }
    if (gen !== ws.pollGen) return;
    let live = activityLive(ws.activity, ws.channelId, ws.config?.customAgents);
    if (visible() && live) { await loadPresence().catch(() => {}); live = activityLive(ws.activity, ws.channelId, ws.config?.customAgents); }
    if (gen !== ws.pollGen) return;
    syncActivityViews();
    ws.timer = setTimeout(tick, live ? ACTIVITY_POLL_MS : CALM_POLL_MS);
  };
  ws.timer = setTimeout(tick, CALM_POLL_MS);
  ws.slowTimer = setInterval(() => { if (visible()) { loadPresence(); loadAgentState(); loadConfig(); loadFaces(); } }, 15000);
}
