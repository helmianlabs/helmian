// Envoy workspace for the Desktop view: channels | chat | agents | workbench.
// app.js calls mountWorkspace(ctx) each time the Desktop view opens; wiring
// happens once, data refreshes every time.
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

export function agentStates(messages, roster, online, now = Date.now()) {
  const out = {};
  for (const p of roster) {
    const mine = messages.filter((m) => m.authorSubject === `agent:${p}`);
    const last = mine.at(-1) ?? null;
    const lastAsk = [...messages].reverse().find((m) => addressed(m, roster).includes(p));
    const answered = lastAsk && messages.some((m) => m.authorSubject === `agent:${p}` && m.idempotencyKey === `reply:${lastAsk.id}`);
    const fresh = lastAsk && now - new Date(lastAsk.createdAt).getTime() < 10 * 60_000;
    const isOnline = p === 'maestro' ? online.size > 0 : online.has(p);
    out[p] = { state: !isOnline ? 'offline' : (fresh && !answered ? 'working' : 'idle'), last: last?.body ?? '' };
  }
  return out;
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

const ws = { wired: false, ctx: null, channels: [], channelId: null, config: null, configured: false, discordBot: null, messages: [], sig: null, online: new Set(), timer: null, slowTimer: null, agentsPinned: ls.get('agentsPinned', {}), linkPoll: null };

function setPane(name, open, { user = false } = {}) {
  const pane = $(`ew-${name}`); if (!pane) return;
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
}
const paneOpen = (name) => { const p = $(`ew-${name}`); return narrow() ? p.classList.contains('sheet-open') : !p.classList.contains('collapsed'); };
function closeSheets() { for (const p of document.querySelectorAll('.ew-pane.sheet-open')) p.classList.remove('sheet-open'); $('ew-scrim').classList.remove('open'); for (const b of document.querySelectorAll('[data-toggle]')) b.setAttribute('aria-pressed', 'false'); }

function applyLayout() {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(ls.get('widths', {}))) if (v > 120 && v < 1400) root.style.setProperty(`--ew-${k}`, `${v}px`);
  if (narrow()) { for (const p of ['channels', 'agents', 'bench']) { $(`ew-${p}`).classList.remove('collapsed'); } closeSheets(); return; }
  setPane('channels', ls.get('open.channels', true));
  setPane('bench', ls.get('open.bench', window.innerWidth > 1100));
  syncAgentsPane();
}
function syncAgentsPane() {
  if (narrow()) return;
  const count = ws.config?.agents?.length ?? 0;
  const pinned = ws.agentsPinned[ws.channelId];
  // Agents pane opens in agent chats and folds away elsewhere, unless the user chose.
  setPane('agents', pinned === undefined ? count > 0 : pinned);
}

function wireSplitters() {
  for (const split of document.querySelectorAll('.ew-split')) {
    const name = split.dataset.split;
    const pane = $(`ew-${name}`);
    const sign = name === 'channels' ? 1 : -1;
    split.addEventListener('pointerdown', (e) => {
      if (narrow()) return;
      e.preventDefault(); split.setPointerCapture(e.pointerId); split.classList.add('dragging'); $('ew').classList.add('dragging');
      const start = e.clientX; const startW = pane.getBoundingClientRect().width;
      const move = (ev) => { const w = Math.max(180, Math.min(900, startW + sign * (ev.clientX - start))); document.documentElement.style.setProperty(`--ew-${name}`, `${w}px`); };
      const up = () => {
        split.classList.remove('dragging'); $('ew').classList.remove('dragging');
        split.removeEventListener('pointermove', move); split.removeEventListener('pointerup', up);
        const widths = ls.get('widths', {}); widths[name] = Math.round(pane.getBoundingClientRect().width); ls.set('widths', widths);
      };
      split.addEventListener('pointermove', move); split.addEventListener('pointerup', up);
    });
    split.addEventListener('dblclick', () => { document.documentElement.style.removeProperty(`--ew-${name}`); const w = ls.get('widths', {}); delete w[name]; ls.set('widths', w); });
    split.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const w = pane.getBoundingClientRect().width + sign * (e.key === 'ArrowRight' ? 24 : -24);
      document.documentElement.style.setProperty(`--ew-${name}`, `${Math.max(180, Math.min(900, w))}px`);
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
  const saved = ls.get('channel', null);
  if (!ws.channels.some((c) => c.id === ws.channelId)) ws.channelId = ws.channels.some((c) => c.id === saved) ? saved : ws.channels[0]?.id ?? null;
  renderChannels();
}
function renderChannels() {
  const list = $('ew-channel-list');
  list.replaceChildren(...ws.channels.map((c) => h('button', { type: 'button', class: `ew-channel${c.id === ws.channelId ? ' active' : ''}`, 'data-id': c.id, onclick: () => selectChannel(c.id) },
    h('span', { class: 'hash' }, '#'), h('span', { class: 'name' }, c.title || c.slug),
    h('span', { class: 'tags' }, c._discord ? h('span', { class: 'ew-mini discord', title: 'Linked to Discord' }) : null, c._agents ? h('span', { class: 'ew-mini agents', title: `${c._agents} agent(s)` }) : null))));
  if (!ws.channels.length) list.append(h('p', { class: 'ew-note' }, 'No channels yet.'));
}
async function selectChannel(id) {
  if (!id) return;
  ws.channelId = id; ls.set('channel', id); ws.sig = null; ws.messages = [];
  renderChannels();
  $('ew-messages').replaceChildren(h('div', { class: 'ew-empty' }, 'Loading…'));
  if (narrow()) closeSheets();
  await Promise.allSettled([loadConfig(), loadMessages()]);
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
  if (ch) { ch._agents = ws.config.agents.length; ch._discord = Boolean(ws.config.discord); }
  renderHeader(); renderAgents(); renderChannels(); syncAgentsPane();
}
function renderHeader() {
  const ch = ws.channels.find((c) => c.id === ws.channelId);
  const title = ch?.title || ch?.slug || 'channel';
  $('ew-channel-title').textContent = title;
  $('maestro-input').placeholder = ws.config?.agents?.length ? `Message #${title}. @ an agent, or let Maestro route it` : `Message #${title}`;
  const badge = $('ew-discord-badge');
  const d = ws.config?.discord;
  badge.hidden = !(d || ws.config?.pendingLink);
  badge.className = `ew-badge ${d ? 'discord' : 'pending'}`;
  badge.textContent = d ? `Discord #${d.channelName || d.channelId}` : 'Discord link pending';
  const admin = ['owner', 'admin'].includes(ws.ctx.state.actor?.role);
  const link = $('ew-link-discord');
  link.textContent = d ? 'Discord linked' : 'Link Discord';
  link.hidden = !admin && !d;
  $('ew-agent-count').textContent = String(ws.config?.agents?.length ?? 0);
  $('ew-discord-status-text').textContent = ws.discordBot?.configured ? (d ? `linked to #${d.channelName || d.channelId}` : 'ready to link') : 'bot not set up yet';
}
function renderAgents() {
  const roster = (ws.config?.agents ?? []).map((a) => a.provider);
  const states = agentStates(ws.messages, roster, ws.online);
  $('ew-agents-summary').textContent = roster.length ? `${roster.length} in this channel` : 'none in this channel';
  $('ew-agent-cards').replaceChildren(...roster.map((p) => {
    const s = states[p];
    const label = s.state === 'offline' ? 'OFFLINE' : s.state === 'working' ? 'WORKING' : 'IDLE';
    return h('div', { class: 'ew-agent', role: 'button', tabindex: 0, title: `Ask ${NAMES[p]}`, onclick: () => insertMention(NAMES[p]), onkeydown: (e) => { if (e.key === 'Enter') insertMention(NAMES[p]); } },
      avatarImg(p), h('strong', {}, NAMES[p]),
      h('button', { type: 'button', class: 'ew-icon remove', title: `Remove ${NAMES[p]} from this channel`, 'aria-label': `Remove ${NAMES[p]}`, onclick: (e) => { e.stopPropagation(); changeAgent('remove-agent', p); } }, '×'),
      h('span', { class: `ew-state ${s.state}` }, label),
      h('span', { class: 'last' }, s.state === 'offline' ? 'No runner online for this agent. Start the Helmian bridge on your PC.' : (s.last ? s.last.replace(/\s+/g, ' ').slice(0, 120) : 'Waiting for a message')));
  }));
  if (!roster.length) $('ew-agent-cards').append(h('p', { class: 'ew-note' }, 'No agents in this channel. Add one below to make it an agent chat.'));
  $('ew-agent-add').replaceChildren(...AGENTS.filter((p) => !roster.includes(p)).map((p) => h('button', { type: 'button', class: 'ew-pill', onclick: () => changeAgent('add-agent', p) }, avatarImg(p), `+ ${NAMES[p]}`)));
  $('ew-mention-pills').replaceChildren(...(roster.length > 1 ? [h('button', { type: 'button', class: 'ew-pill all', onclick: () => insertMention('all') }, '@all')] : []),
    ...roster.map((p) => h('button', { type: 'button', class: 'ew-pill', title: `Mention ${NAMES[p]}`, onclick: () => insertMention(NAMES[p]) }, avatarImg(p), NAMES[p])));
  $('ew-mention-pills').hidden = !roster.length;
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

// ---------- messages ----------
async function loadMessages() {
  const id = ws.channelId; if (!id) { $('ew-messages').replaceChildren(h('div', { class: 'ew-empty' }, 'No channel yet. Ask the workspace owner to create one.')); return; }
  const body = await ws.ctx.api(`/api/admin/envoy/messages?channel_id=${encodeURIComponent(id)}&limit=100`);
  if (id !== ws.channelId) return;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const sig = messages.map((m) => m.id).join(',');
  if (sig === ws.sig) { renderAgents(); return; }
  ws.sig = sig; ws.messages = messages;
  renderMessages(); renderAgents();
}
function whoOf(m) {
  const me = ws.ctx.state.actor?.subject;
  if (m.authorKind === 'human' && m.authorSubject === me) return { name: 'You', kind: 'me' };
  if (m.agentProvider || m.authorSubject?.startsWith('agent:')) return { name: m.authorName || 'Agent', kind: 'agent', provider: m.agentProvider || m.authorSubject.slice(6) };
  if (m.authorSubject?.endsWith(':bridge')) return { name: 'Maestro', kind: 'agent', provider: 'maestro' };
  if (m.source === 'discord') return { name: m.authorName || 'Discord member', kind: 'discord' };
  return { name: m.authorName || 'Member', kind: 'human' };
}
function renderMessages() {
  const box = $('ew-messages');
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
    out.push(h('div', { class: `ew-msg${cont ? ' cont' : ''}${m._pending ? ' pending' : ''}`, 'data-id': m.id }, avatar,
      h('div', {}, h('div', { class: 'ew-meta' }, h('strong', { class: who.kind === 'agent' ? 'agent' : '' }, who.name), src, h('time', { datetime: m.createdAt }, clock(m.createdAt))),
        h('div', { class: 'ew-body' }, renderBody(m.body, { onLink, onCanvas })))));
    prev = m;
  }
  if (!ws.messages.length) out.push(h('div', { class: 'ew-empty' }, ws.config?.agents?.length ? 'Say hello. Maestro answers messages nobody is named in.' : 'No messages yet. Say hello, or add an agent to make this an agent chat.'));
  box.replaceChildren(...out);
  if (atBottom || ws.messages.at(-1)?._pending || ws.messages.at(-1)?.authorSubject === ws.ctx.state.actor?.subject) box.scrollTop = box.scrollHeight;
}
const grow = () => { const t = $('maestro-input'); t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 200)}px`; };
async function send(e) {
  e?.preventDefault?.();
  const box = $('maestro-input'); const body = box.value.trim();
  if (!body || !ws.channelId) return;
  const key = crypto.randomUUID();
  const btn = $('maestro-send'); btn.disabled = true;
  ws.messages = [...ws.messages, { id: `pending-${key}`, authorKind: 'human', authorSubject: ws.ctx.state.actor?.subject, body, createdAt: new Date().toISOString(), _pending: true }];
  renderMessages();
  box.value = ''; grow();
  try { await ws.ctx.post('/api/admin/envoy/messages', { channelId: ws.channelId, body, idempotencyKey: key }); ws.sig = null; await loadMessages(); }
  catch { box.value = body; grow(); ws.messages = ws.messages.filter((m) => !m._pending); renderMessages(); ws.ctx.toast('Not sent. Your message is back in the box.'); }
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
function selectTab(name) {
  for (const t of document.querySelectorAll('#ew-bench .ew-tab')) { const on = t.dataset.tab === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on)); }
  for (const p of document.querySelectorAll('#ew-bench .ew-tabpane')) { const on = p.dataset.tabpane === name; p.hidden = !on; p.classList.toggle('active', on); }
  ls.set('tab', name);
  if (name === 'preview') ws.ctx.loadGuardPreview?.();
  if (name === 'create') ws.ctx.loadGuardCreateList?.();
  if (name === 'guard') { ws.ctx.renderFeed?.(); }
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
  $('ew-bench-max').addEventListener('click', () => { const on = $('ew').classList.toggle('bench-max'); $('ew-bench-max').textContent = on ? '⤡' : '⤢'; $('ew-bench-max').title = on ? 'Restore' : 'Expand'; });
  for (const t of document.querySelectorAll('#ew-bench .ew-tab')) t.addEventListener('click', () => selectTab(t.dataset.tab));
  $('ew-add-channel').addEventListener('click', () => { $('ew-new-channel').hidden = false; $('ew-add-channel').hidden = true; $('ew-new-channel-name').focus(); });
  $('ew-new-channel-cancel').addEventListener('click', () => { $('ew-new-channel').hidden = true; $('ew-add-channel').hidden = false; });
  $('ew-new-channel').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('ew-new-channel-name').value.trim(); if (!title) return;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'channel';
    try {
      const made = await ws.ctx.post('/api/admin/envoy/channels', { slug, title, kind: $('ew-new-channel-agents').checked ? 'agent' : 'team' });
      $('ew-new-channel').hidden = true; $('ew-add-channel').hidden = false; $('ew-new-channel-name').value = '';
      await loadChannels(); ws.channelId = made.channel?.id ?? ws.channelId;
      if ($('ew-new-channel-agents').checked && made.inserted !== false) await ws.ctx.post('/api/admin/envoy/channel-config', { action: 'add-agent', channelId: ws.channelId, provider: 'maestro' }).catch(() => {});
      await selectChannel(ws.channelId);
    } catch { ws.ctx.toast('Channel not created.'); }
  });
  $('maestro-form').addEventListener('submit', send);
  const box = $('maestro-input');
  box.addEventListener('input', grow);
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !narrow()) { e.preventDefault(); send(); } });
  $('maestro-plus').addEventListener('click', () => ws.ctx.openTools?.());
  $('ew-link-discord').addEventListener('click', linkDiscord);
  $('ew-modal-close').addEventListener('click', closeModal);
  $('ew-modal').addEventListener('click', (e) => { if (e.target === $('ew-modal')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if ($('ew-modal').classList.contains('open')) closeModal(); else closeSheets(); } });
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
  selectTab(ls.get('tab', 'guard'));
  await loadChannels().catch(() => { $('ew-messages').replaceChildren(h('div', { class: 'ew-empty' }, 'Envoy is reconnecting…')); });
  await Promise.allSettled([loadPresence(), loadConfig(), loadMessages()]);
  clearInterval(ws.timer); clearInterval(ws.slowTimer);
  const visible = () => document.visibilityState === 'visible' && document.getElementById('shell')?.dataset.view === 'desktop';
  ws.timer = setInterval(() => { if (visible()) loadMessages().catch(() => {}); }, 2500);
  ws.slowTimer = setInterval(() => { if (visible()) { loadPresence(); loadConfig(); } }, 15000);
}
