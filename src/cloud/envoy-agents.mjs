// Envoy agents: who is in a channel, who should answer a message, and how
// agent / Discord / system authors are named. Pure functions only, shared by
// the cloud routes (envoy-mesh.mjs), the PC bridge and the Discord bridge.
//
// Agents are channel members. Maestro is NOT one of them: Maestro is the
// human's manager seat, never an agent, so 'maestro' is not a routable
// answerer anywhere (Maestro Bite 2). A roster may still carry a historical
// 'maestro' entry; it is inert and filtered out of every routing result.
// A human message (typed in Helmian or in a linked Discord channel) is
// routed like this:
//   - @all                -> every agent in the channel
//   - @Claude, @Gemini... -> only the agents named
//   - no mention          -> NO agent turn (silence)
// An agent-authored message routes nobody: there is no dispatch hop,
// because dispatch is the human's act, and agents never loop on each other.
// A private agent room (kind 'agent') seats exactly one agent, so the mesh
// passes room:true for those channels and an unnamed prompt there goes to
// the room's agent — the room IS the address.
//
// The Maestro desk — the channel whose config carries desk:true, the human's
// manager seat (see envoy-maestro.mjs) — routes HUMAN sends as dispatches
// instead: @all broadcasts to every agent on the desk, @name picks the named
// agents, and an unnamed send reaches the whole desk (that
// unnamed-means-everyone rule is desk-only). 'maestro' is never a dispatch
// target: in the desk, Maestro is the human sending, so there is no agent
// behind the name to answer. Agent-authored and system messages route
// nobody in the desk too.

export const AGENT_PROVIDERS = Object.freeze(['maestro', 'claude', 'openai', 'grok', 'gemini']);
export const AGENT_NAMES = Object.freeze({ maestro: 'Maestro', claude: 'Claude', openai: 'ChatGPT', grok: 'Grok', gemini: 'Gemini' });
const ALIASES = Object.freeze({
  maestro: 'maestro', manager: 'maestro',
  claude: 'claude', anthropic: 'claude',
  chatgpt: 'openai', openai: 'openai', gpt: 'openai', codex: 'openai',
  grok: 'grok', xai: 'grok',
  gemini: 'gemini', google: 'gemini',
});

export const CONFIG_SUBJECT = 'system:envoy-config';
export const NOTICE_SUBJECT = 'system:envoy';
export const CONFIG_FORMAT = 'helmian.envoy.channel-config.v1';

// The desk channel is reserved by slug: the desk route (envoy-maestro.mjs)
// creates it lazily under this slug, and envoy-mesh.mjs refuses to seed
// desk config on any other channel.
export const MAESTRO_DESK_SLUG = 'maestro-desk';
// Roster the desk falls back to when it is the first thing a tenant
// configures (no other channel to take a roster from): every worker
// agent. 'maestro' is excluded by construction.
export const DESK_ROSTER_FALLBACK = Object.freeze(AGENT_PROVIDERS.filter((p) => p !== 'maestro'));

export function normalizeProvider(value) {
  const key = String(value ?? '').trim().toLowerCase().replace(/^@/, '');
  return ALIASES[key] ?? null;
}

export function agentSubject(provider) {
  const p = normalizeProvider(provider);
  if (!p) throw new Error('agent provider is unsupported');
  return `agent:${p}`;
}

export function emptyConfig() {
  return { format: CONFIG_FORMAT, agents: [], joined: {}, discord: null, pendingLink: null, desk: false };
}

// Parse a stored config row body. Bad rows read as "not configured".
export function parseConfig(body) {
  try {
    const raw = JSON.parse(String(body ?? ''));
    if (raw?.format !== CONFIG_FORMAT) return null;
    const agents = [...new Set((Array.isArray(raw.agents) ? raw.agents : []).map(normalizeProvider).filter(Boolean))];
    const discord = raw.discord && /^\d{5,25}$/.test(String(raw.discord.guildId)) && /^\d{5,25}$/.test(String(raw.discord.channelId))
      ? { guildId: String(raw.discord.guildId), channelId: String(raw.discord.channelId), channelName: String(raw.discord.channelName ?? '').slice(0, 100), guildName: String(raw.discord.guildName ?? '').slice(0, 100), linkedAt: raw.discord.linkedAt ?? null }
      : null;
    const pendingLink = raw.pendingLink && /^[a-f0-9]{64}$/.test(String(raw.pendingLink.codeHash)) && raw.pendingLink.expiresAt
      ? { codeHash: String(raw.pendingLink.codeHash), expiresAt: String(raw.pendingLink.expiresAt) }
      : null;
    const joined = {};
    for (const p of agents) { const t = raw.joined?.[p]; if (t && Number.isFinite(Date.parse(t))) joined[p] = String(t); }
    return { format: CONFIG_FORMAT, agents, joined, discord, pendingLink, desk: raw.desk === true };
  } catch { return null; }
}

export function serializeConfig(config) {
  const joined = {}; for (const p of config.agents ?? []) if (config.joined?.[p]) joined[p] = config.joined[p];
  const stored = { format: CONFIG_FORMAT, agents: config.agents ?? [], joined, discord: config.discord ?? null, pendingLink: config.pendingLink ?? null };
  // desk is written only when true, so every config stored before the
  // desk existed keeps its exact bytes.
  if (config.desk === true) stored.desk = true;
  const body = JSON.stringify(stored);
  if (body.length > 4000) throw new Error('channel config is too large');
  return body;
}

// What the browser may see: never the link code hash.
export function publicConfig(config, now = Date.now()) {
  const c = config ?? emptyConfig();
  return {
    agents: c.agents.map((p) => ({ provider: p, name: AGENT_NAMES[p], joinedAt: c.joined?.[p] ?? null })),
    desk: c.desk === true,
    discord: c.discord,
    pendingLink: c.pendingLink && Date.parse(c.pendingLink.expiresAt) > now ? { expiresAt: c.pendingLink.expiresAt } : null,
  };
}

export function mentionsIn(text) {
  const found = new Set();
  let all = false;
  for (const m of String(text ?? '').matchAll(/(^|[^\w@])@([a-z][a-z0-9_-]{1,20})\b/gi)) {
    const word = m[2].toLowerCase();
    if (word === 'all' || word === 'everyone' || word === 'here') { all = true; continue; }
    const p = normalizeProvider(word.replace(/\d+$/, ''));
    if (p) found.add(p);
  }
  return { all, providers: [...found] };
}

// The providers that can actually take an agent turn: every roster
// provider except 'maestro'. Maestro is the human's seat; it never
// answers, is never dispatched to, and never dispatches.
export const ANSWERING_PROVIDERS = Object.freeze(AGENT_PROVIDERS.filter((p) => p !== 'maestro'));

// Which agent members should answer `message`. `members` = provider ids.
// `desk: true` turns on the desk dispatch rules for human sends;
// `room: true` marks a private agent room, whose unnamed prompts go to
// the room's one agent (see the header note).
export function agentsToAnswer(message, members, { desk = false, room = false } = {}) {
  const roster = [...new Set((members ?? []).map(normalizeProvider).filter(Boolean))];
  const team = roster.filter((p) => p !== 'maestro');
  if (team.length === 0) return [];
  const text = String(message?.body ?? '');
  const kind = String(message?.authorKind ?? '');
  const { all, providers } = mentionsIn(text);
  if (desk && kind === 'human') {
    if (all) return team;
    if (providers.length) return team.filter((p) => providers.includes(p));
    return team;
  }
  // Agent-authored and system messages earn nobody a turn: dispatch is
  // the human's act, and no agent (Maestro included) relays for them.
  if (kind !== 'human') return [];
  if (all) return team;
  if (providers.length) return team.filter((p) => providers.includes(p));
  // Unnamed: silence in an ordinary channel; the room's agent in a
  // private room, where the room itself is the address.
  return room ? team : [];
}

// Display name + source for any stored author subject.
export function describeAuthor(subject, kind) {
  const s = String(subject ?? '');
  if (s.startsWith('agent:')) {
    const p = normalizeProvider(s.slice(6));
    return { name: AGENT_NAMES[p] ?? 'Agent', source: 'helmian', provider: p };
  }
  if (s.startsWith('discord:')) {
    const rest = s.slice(8);
    const i = rest.indexOf(':');
    const name = i >= 0 ? rest.slice(i + 1) : '';
    return { name: name || 'Discord member', source: 'discord', provider: null };
  }
  if (s.startsWith('system:') || kind === 'system') return { name: 'Helmian', source: 'helmian', provider: null };
  // Replies the PC bridge posts for its direct (non-Envoy) path are the
  // bridge speaking, not an agent named Maestro — Maestro is the human.
  if (s.endsWith(':bridge')) return { name: 'PC bridge', source: 'helmian', provider: null };
  return { name: null, source: 'helmian', provider: null };
}

export function discordSubject(userId, displayName) {
  if (!/^\d{5,25}$/.test(String(userId))) throw new Error('discord user id is invalid');
  const name = String(displayName ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64) || 'Discord member';
  return `discord:${userId}:${name}`;
}

// Text an agent gets for its turn: who it is, who else is here, the recent
// conversation, and the message it is answering.
export function agentPrompt({ provider, channelTitle, members, context = [], message, source = 'helmian' }) {
  const p = normalizeProvider(provider);
  // There is no Maestro prompt: no turn is ever composed for 'maestro',
  // because Maestro is the human's seat, not an agent (Bite 2).
  if (p === 'maestro') throw new Error('maestro is not an agent provider');
  const me = AGENT_NAMES[p] ?? 'Agent';
  const others = (members ?? []).map(normalizeProvider).filter((x) => x && x !== p && x !== 'maestro').map((x) => AGENT_NAMES[x]);
  const where = source === 'discord' ? `the #${channelTitle} channel (mirrored with Discord)` : `the #${channelTitle} channel in Helmian Envoy`;
  const role = `You are ${me}, an agent member of ${where}. Other agents here: ${others.join(', ') || 'none'}. If you were given a slice of work, start your reply with "Claim:" and the slice you are taking, so you do not overlap the others. Be concise.`;
  const history = context.slice(-12).map((m) => `${m.authorName || m.authorKind}: ${String(m.body ?? '').slice(0, 600)}`).join('\n');
  const from = message?.authorName || (message?.authorKind === 'agent' ? 'Agent' : 'Member');
  return `${role}\n\nRecent conversation:\n${history || '(none)'}\n\nReply to this message from ${from}:\n${String(message?.body ?? '')}`;
}

// ── Message attachments (composer "+" picker) ─────────────────────────────
// The picker attaches skills, connectors, plugins and FILES to a message,
// plus a web-search on/off flag. This is the ONE shape every layer agrees
// on: the web client builds it, envoy-chat stores it, envoy-mesh/Ably
// carry it, and the agent runtime (src/agent/attachments.mjs) consumes it.
// Pure and fail-closed: an unknown kind or an oversized field rejects the
// message rather than riding along unexamined.
//
// A file attachment carries its bytes INLINE, as base64 `data`, in the
// metadata itself: there is no upload endpoint and no byte store in the
// cloud, and the metadata jsonb (sql/060) is the one channel every layer
// already passes along. That choice caps the size honestly — the bounds
// below are the feature's real limits, stated plainly in the picker.
// Text-shaped files are inlined into the turn as text and images become
// real image content for the provider (src/agent/attachments.mjs); any
// other kind of file is refused here rather than stored unread.

export const ATTACHMENT_KINDS = Object.freeze(['skill', 'connector', 'plugin', 'file']);
export const MAX_MESSAGE_ATTACHMENTS = 8;
const ATTACHMENT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ATTACHMENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*(:[a-z0-9][a-z0-9_-]*)?$/;

export const FILE_ATTACHMENT_MAX_BYTES = 256 * 1024;
export const FILE_ATTACHMENTS_MAX_TOTAL_BYTES = 512 * 1024;
const FILE_DATA_MAX_CHARS = Math.ceil(FILE_ATTACHMENT_MAX_BYTES / 3) * 4;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
// The image types the turn path can hand a provider as image content
// (src/agent/bridge.mjs's req.images filter is the same set).
export const FILE_IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
const FILE_TEXT_MEDIA_TYPES = new Set([
  'application/json', 'application/xml', 'application/yaml', 'application/x-yaml',
  'application/toml', 'application/javascript', 'application/x-sh', 'image/svg+xml',
]);
// When the browser reports no useful media type, the extension decides —
// and only for kinds of file that are text by construction.
const FILE_TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'yaml', 'yml', 'toml',
  'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py',
  'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sh', 'sql', 'ini', 'env',
]);

/**
 * How a file attachment would be consumed by a turn: 'image' (real image
 * content), 'text' (decoded and inlined), or null (Helmian cannot read
 * this kind of file — refused at attach time, never stored unread).
 */
export function classifyFileAttachment({ name, mediaType } = {}) {
  const type = String(mediaType ?? '').trim().toLowerCase();
  if (FILE_IMAGE_MEDIA_TYPES.includes(type)) return 'image';
  if (type.startsWith('text/') || FILE_TEXT_MEDIA_TYPES.has(type)) return 'text';
  if (type === '' || type === 'application/octet-stream') {
    const ext = String(name ?? '').trim().toLowerCase().split('.').pop();
    if (ext && FILE_TEXT_EXTENSIONS.has(ext)) return 'text';
  }
  return null;
}

function fileAttachmentName(value) {
  // A file NAME, never a path: no separators, no control characters.
  const result = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  if (!result || result === '.' || result === '..' || result.includes('/') || result.includes('\\')) {
    throw new Error('attachment file name is invalid');
  }
  return result;
}

/** Decoded byte count of a well-formed base64 string; throws otherwise. */
export function base64DecodedBytes(data) {
  const text = String(data ?? '');
  if (!text || text.length % 4 !== 0 || !BASE64_PATTERN.test(text)) throw new Error('attachment file data is invalid');
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

function attachmentField(value, name, pattern) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!result || result.length > 64 || !pattern.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

/** One attachment → its canonical stored form, or a thrown Error. */
export function normalizeAttachment(input) {
  const kind = String(input?.kind ?? '').trim().toLowerCase();
  if (!ATTACHMENT_KINDS.includes(kind)) throw new Error('attachment kind is unsupported');
  if (kind === 'connector') {
    return Object.freeze({
      kind,
      key: attachmentField(input.key, 'attachment connector key', ATTACHMENT_KEY_PATTERN),
      ...(input.name ? { name: String(input.name).trim().slice(0, 120) } : {}),
    });
  }
  if (kind === 'file') {
    const name = fileAttachmentName(input.name);
    const mediaType = String(input.mediaType ?? '').trim().toLowerCase().slice(0, 100);
    if (mediaType && !MEDIA_TYPE_PATTERN.test(mediaType)) throw new Error('attachment file media type is invalid');
    const data = String(input.data ?? '');
    if (data.length > FILE_DATA_MAX_CHARS) throw new Error('attachment file is too large');
    const size = base64DecodedBytes(data);
    if (size < 1 || size > FILE_ATTACHMENT_MAX_BYTES) throw new Error('attachment file size is invalid');
    if (input.size !== undefined && Number(input.size) !== size) throw new Error('attachment file size is invalid');
    if (!classifyFileAttachment({ name, mediaType })) throw new Error('attachment file type is unsupported');
    return Object.freeze({ kind, name, mediaType, size, data });
  }
  return Object.freeze({
    kind,
    name: attachmentField(input.name, 'attachment name', ATTACHMENT_NAME_PATTERN),
  });
}

/**
 * The metadata object stored on a message. Accepts the two wire shapes the
 * client may send — `{ attachments: [...], webSearch?: boolean }` — and
 * returns the canonical frozen form, or null when nothing was attached.
 */
export function normalizeMessageMetadata(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('message metadata is invalid');
  const raw = input.attachments ?? [];
  if (!Array.isArray(raw)) throw new Error('message attachments are invalid');
  if (raw.length > MAX_MESSAGE_ATTACHMENTS) throw new Error('too many attachments');
  const seen = new Set();
  const attachments = raw.map((item) => {
    const clean = normalizeAttachment(item);
    // Files dedupe on name AND size: two different files that share a
    // name are both legitimate; the same file twice is not.
    const id = clean.kind === 'connector' ? `connector:${clean.key}` : clean.kind === 'file' ? `file:${clean.name}:${clean.size}` : `${clean.kind}:${clean.name}`;
    if (seen.has(id)) throw new Error('attachment is duplicated');
    seen.add(id);
    return clean;
  });
  const fileBytes = attachments.reduce((sum, a) => sum + (a.kind === 'file' ? a.size : 0), 0);
  if (fileBytes > FILE_ATTACHMENTS_MAX_TOTAL_BYTES) throw new Error('attached files are too large in total');
  const webSearch = input.webSearch === undefined ? undefined : input.webSearch === true;
  if (!attachments.length && webSearch === undefined) return null;
  return Object.freeze({
    ...(attachments.length ? { attachments: Object.freeze(attachments) } : {}),
    ...(webSearch !== undefined ? { webSearch } : {}),
  });
}
