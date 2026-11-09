// Envoy agents: who is in a channel, who should answer a message, and how
// agent / Discord / Slack / system authors are named. Pure functions only,
// shared by the cloud routes (envoy-mesh.mjs), the PC bridge and the
// Discord / Slack bridge services.
//
// Agents are channel members. Maestro is NOT one of them: Maestro is the
// human's manager seat, never an agent, so 'maestro' is not a routable
// answerer anywhere (Maestro Bite 2). A roster may still carry a historical
// 'maestro' entry; it is inert and filtered out of every routing result.
// A human message (typed in Helmian or in a linked Discord or Slack
// channel) is routed like this:
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
//
// Maestro follow (maestroFollow:true on an ordinary channel's config)
// opts that channel into the same desk dispatch rules without being
// the desk: the mesh passes desk:true to agentsToAnswer when either
// flag is set (see envoy-mesh.mjs agentWork). The desk channel itself
// is unchanged, and Maestro still never answers.

export const AGENT_PROVIDERS = Object.freeze(['maestro', 'claude', 'openai', 'grok', 'gemini', 'mistral', 'qwen', 'groq', 'nvidia', 'cloudflare', 'openrouter', 'muse']);
export const AGENT_NAMES = Object.freeze({ maestro: 'Maestro', claude: 'Claude', openai: 'ChatGPT', grok: 'Grok', gemini: 'Gemini', mistral: 'Mistral', qwen: 'Qwen', runway: 'Runway', ollama: 'Ollama', custom: 'Custom AI', groq: 'Groq', nvidia: 'NVIDIA', cloudflare: 'Cloudflare', openrouter: 'OpenRouter', muse: 'Muse' });
export const CUSTOM_AGENT_ENGINES = Object.freeze(['claude', 'openai', 'grok', 'gemini', 'mistral', 'runway', 'ollama', 'groq', 'nvidia', 'cloudflare', 'openrouter', 'muse', 'custom']);
// One connect road (owner's law, 2026-11-01): a custom agent's account
// connects with an email and a password, and the seat works off that
// sign-in — the 'password_session' auth mode sql/063 defined. The old
// seat-mode menu no longer exists; sanitizeCustomAgent collapses every
// stored or incoming authMode value to this single mode.
export const CUSTOM_AGENT_AUTH_MODE = 'password_session';
export const MAX_CHANNEL_AGENTS = 50;
export const MAX_DEBATE_TURNS = 50;
export const DEFAULT_DEBATE_TURNS = 10;
const ALIASES = Object.freeze({
  maestro: 'maestro', manager: 'maestro',
  claude: 'claude', anthropic: 'claude',
  chatgpt: 'openai', openai: 'openai', gpt: 'openai', codex: 'openai',
  grok: 'grok', xai: 'grok', supergrok: 'grok',
  gemini: 'gemini', google: 'gemini',
  mistral: 'mistral', lechat: 'mistral',
  // Seat six (QWEN CHANNEL FIX, 2026-11-05): Qwen — the local model on
  // the user's own PC, engine Ollama — is a built-in provider in its
  // own right, addable to any channel like every other seat. 'ollama'
  // and 'local' name this same seat (its engine), never a second
  // agent. Before this she existed only as a per-channel custom agent
  // (handle 'qwen', engine 'ollama'), which is why she was missing
  // from every channel nobody had hand-built her into; that custom
  // shape keeps working (parseConfig + the worker's claim set are
  // unchanged), it is simply no longer the only road in.
  qwen: 'qwen', ollama: 'qwen', local: 'qwen',
  // The provider-catalog seats (provider-registry.mjs): their seat
  // names are their provider ids, so @groq / @nvidia / @cloudflare /
  // @openrouter / @muse address them in a channel like any built-in seat.
  groq: 'groq',
  nvidia: 'nvidia', nim: 'nvidia',
  cloudflare: 'cloudflare', workersai: 'cloudflare',
  openrouter: 'openrouter',
  muse: 'muse',
});
const ENGINE_ALIASES = Object.freeze({
  ...ALIASES,
  mistral: 'mistral', lechat: 'mistral',
  runway: 'runway', runwayml: 'runway',
  ollama: 'ollama', local: 'ollama',
  groq: 'groq',
  nvidia: 'nvidia', nim: 'nvidia',
  cloudflare: 'cloudflare', workersai: 'cloudflare',
  openrouter: 'openrouter',
  muse: 'muse',
  custom: 'custom',
});

export const CONFIG_SUBJECT = 'system:envoy-config';
export const NOTICE_SUBJECT = 'system:envoy';
export const CONFIG_FORMAT = 'helmian.envoy.channel-config.v1';

// A channel's own look (emoji bite 5): a character face or a plain
// letter icon, stored on the channel config so it renders for the
// whole workspace — the desk used to keep this choice in one
// browser's localStorage, so a channel wore a different face on
// every device. The shape is the desk's own avatar choice
// (web/marketing/app/avatars.mjs: {k:'char', id} | {k:'plain', c});
// the character ids and colour count are mirrored here because the
// cloud bundle ships only emoji-map.mjs from the web tree, and the
// bite-5 faces test pins this list against avatars.mjs CHARACTERS so
// the two can never drift.
export const CHANNEL_AVATAR_CHARACTERS = Object.freeze(['fox', 'panda', 'octo', 'unicorn', 'frog', 'robot', 'alien', 'cat', 'pup', 'owl', 'bee', 'penguin']);
export const CHANNEL_AVATAR_COLORS = 8;

export function sanitizeChannelAvatar(value) {
  if (value?.k === 'char' && CHANNEL_AVATAR_CHARACTERS.includes(value.id)) return { k: 'char', id: value.id };
  if (value?.k === 'plain' && Number.isInteger(value.c) && value.c >= 0 && value.c < CHANNEL_AVATAR_COLORS) return { k: 'plain', c: value.c };
  return null;
}

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

export function normalizeEngine(value) {
  const key = String(value ?? '').trim().toLowerCase().replace(/^@/, '');
  const engine = ENGINE_ALIASES[key] ?? null;
  return engine && engine !== 'maestro' ? engine : null;
}

const CUSTOM_HANDLE_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const RESERVED_HANDLES = new Set(['all', 'everyone', 'here', 'maestro', 'manager', 'system', 'helmian']);

export function normalizeCustomHandle(value) {
  const key = String(value ?? '').trim().toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  if (!CUSTOM_HANDLE_RE.test(key) || RESERVED_HANDLES.has(key)) return null;
  return key;
}

export function sanitizeCustomAgent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const handle = normalizeCustomHandle(raw.handle ?? raw.id ?? raw.name);
  if (!handle) return null;
  const provider = normalizeEngine(raw.provider) ?? 'claude';
  const name = String(raw.name ?? handle).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 48) || handle;
  const emoji = String(raw.emoji ?? '🤖').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 16) || '🤖';
  // Every legacy authMode collapses to the one road — stored records
  // keep loading (parseConfig runs them through here) and come out
  // carrying 'password_session', whatever they were saved with.
  const authMode = CUSTOM_AGENT_AUTH_MODE;
  const jobTitle = String(raw.jobTitle ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
  const jobPrompt = String(raw.jobPrompt ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 600);
  return { id: handle, handle, name, emoji, provider, authMode, jobTitle, jobPrompt };
}

export const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_EVENTS = new Set(['push', 'pull_request', 'issues']);

export function sanitizeGithubLink(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const repo = String(raw.repo ?? '').trim();
  if (!GITHUB_REPO_RE.test(repo)) return null;
  const eventsRaw = Array.isArray(raw.events) ? raw.events.map((e) => String(e).trim()).filter((e) => GITHUB_EVENTS.has(e)) : [];
  const events = eventsRaw.length ? [...new Set(eventsRaw)] : ['push', 'pull_request', 'issues'];
  return { repo, events, linkedAt: raw.linkedAt ? String(raw.linkedAt) : null };
}

export function agentSubject(provider, customAgents = []) {
  const p = normalizeProvider(provider);
  if (p) return `agent:${p}`;
  const h = normalizeCustomHandle(provider);
  if (h && Array.isArray(customAgents) && customAgents.some((a) => (a.handle || a.id) === h)) return `agent:${h}`;
  throw new Error('agent provider is unsupported');
}

export function emptyConfig() {
  return {
    format: CONFIG_FORMAT,
    agents: [],
    joined: {},
    discord: null,
    slack: null,
    github: null,
    pendingLink: null,
    desk: false,
    maestroFollow: false,
    customAgents: [],
    debateMode: 'off',
    maxRoundTurns: DEFAULT_DEBATE_TURNS,
    avatar: null,
  };
}

// Slack ids: team T…, channel C…, user U…/W… — uppercase letters and digits.
export const SLACK_ID = /^[A-Z0-9]{6,24}$/;
export function isSlackId(v) {
  return SLACK_ID.test(String(v ?? ''));
}

// Parse a stored config row body. Bad rows read as "not configured".
export function parseConfig(body) {
  try {
    const raw = JSON.parse(String(body ?? ''));
    if (raw?.format !== CONFIG_FORMAT) return null;
    const customAgents = [];
    const seenCustom = new Set();
    for (const item of Array.isArray(raw.customAgents) ? raw.customAgents : []) {
      const clean = sanitizeCustomAgent(item);
      if (clean && !seenCustom.has(clean.handle) && customAgents.length < MAX_CHANNEL_AGENTS) {
        seenCustom.add(clean.handle);
        customAgents.push(clean);
      }
    }
    const agents = [...new Set((Array.isArray(raw.agents) ? raw.agents : []).map((a) => {
      const std = normalizeProvider(a);
      if (std) return std;
      const h = normalizeCustomHandle(a);
      return h && seenCustom.has(h) ? h : null;
    }).filter(Boolean))].slice(0, MAX_CHANNEL_AGENTS);
    const discord = raw.discord && /^\d{5,25}$/.test(String(raw.discord.guildId)) && /^\d{5,25}$/.test(String(raw.discord.channelId))
      ? { guildId: String(raw.discord.guildId), channelId: String(raw.discord.channelId), channelName: String(raw.discord.channelName ?? '').slice(0, 100), guildName: String(raw.discord.guildName ?? '').slice(0, 100), linkedAt: raw.discord.linkedAt ?? null }
      : null;
    const slack = raw.slack && isSlackId(raw.slack.teamId) && isSlackId(raw.slack.channelId)
      ? { teamId: String(raw.slack.teamId), channelId: String(raw.slack.channelId), channelName: String(raw.slack.channelName ?? '').slice(0, 100), teamName: String(raw.slack.teamName ?? '').slice(0, 100), linkedAt: raw.slack.linkedAt ?? null }
      : null;
    const github = sanitizeGithubLink(raw.github);
    const pendingLink = raw.pendingLink && /^[a-f0-9]{64}$/.test(String(raw.pendingLink.codeHash)) && raw.pendingLink.expiresAt
      ? { codeHash: String(raw.pendingLink.codeHash), expiresAt: String(raw.pendingLink.expiresAt) }
      : null;
    const joined = {};
    for (const p of agents) { const t = raw.joined?.[p]; if (t && Number.isFinite(Date.parse(t))) joined[p] = String(t); }
    const debateMode = raw.debateMode === 'free-willy' ? 'free-willy' : 'off';
    const rawTurns = Number(raw.maxRoundTurns);
    const maxRoundTurns = Number.isFinite(rawTurns) ? Math.max(1, Math.min(MAX_DEBATE_TURNS, Math.trunc(rawTurns))) : DEFAULT_DEBATE_TURNS;
    const avatar = sanitizeChannelAvatar(raw.avatar);
    return { format: CONFIG_FORMAT, agents, joined, discord, slack, github, pendingLink, desk: raw.desk === true, maestroFollow: raw.maestroFollow === true, customAgents, debateMode, maxRoundTurns, avatar };
  } catch { return null; }
}

export function serializeConfig(config) {
  const joined = {}; for (const p of config.agents ?? []) if (config.joined?.[p]) joined[p] = config.joined[p];
  const stored = { format: CONFIG_FORMAT, agents: config.agents ?? [], joined, discord: config.discord ?? null, pendingLink: config.pendingLink ?? null };
  // slack is written only when set, so every config stored before the
  // Slack link existed keeps its exact bytes.
  if (config.slack) stored.slack = config.slack;
  if (config.github) stored.github = config.github;
  // desk is written only when true, so every config stored before the
  // desk existed keeps its exact bytes.
  if (config.desk === true) stored.desk = true;
  // maestroFollow is written only when true, so every config stored
  // before Maestro follow existed keeps its exact bytes.
  if (config.maestroFollow === true) stored.maestroFollow = true;
  if (Array.isArray(config.customAgents) && config.customAgents.length > 0) stored.customAgents = config.customAgents;
  if (config.debateMode === 'free-willy') stored.debateMode = 'free-willy';
  // The turn cap is the operator's setting, not part of the on/off state:
  // it persists across off-writes (stop-debate, set 'off') whenever it
  // differs from the default. Before this, serialize dropped the cap with
  // the mode, and the stored setting read back as the default (10).
  const turnsRaw = Number(config.maxRoundTurns);
  const turns = Number.isFinite(turnsRaw) ? Math.max(1, Math.min(MAX_DEBATE_TURNS, Math.trunc(turnsRaw))) : DEFAULT_DEBATE_TURNS;
  if (config.debateMode === 'free-willy' || turns !== DEFAULT_DEBATE_TURNS) stored.maxRoundTurns = turns;
  // avatar is written only when set, so every config stored before
  // channel faces existed keeps its exact bytes.
  const avatar = sanitizeChannelAvatar(config.avatar);
  if (avatar) stored.avatar = avatar;
  const body = JSON.stringify(stored);
  if (body.length > 4000) throw new Error('channel config is too large');
  return body;
}

// What the browser may see: never the link code hash.
export function publicConfig(config, now = Date.now()) {
  const c = config ?? emptyConfig();
  const customMap = new Map((c.customAgents ?? []).map((a) => [a.handle || a.id, a]));
  return {
    agents: c.agents.map((p) => {
      const custom = customMap.get(p);
      if (custom) {
        return {
          provider: p,
          engine: custom.provider,
          name: custom.name,
          emoji: custom.emoji,
          authMode: custom.authMode,
          jobTitle: custom.jobTitle,
          jobPrompt: custom.jobPrompt,
          custom: true,
          joinedAt: c.joined?.[p] ?? null,
        };
      }
      return { provider: p, name: AGENT_NAMES[p], joinedAt: c.joined?.[p] ?? null };
    }),
    customAgents: c.customAgents ?? [],
    avatar: sanitizeChannelAvatar(c.avatar),
    debateMode: c.debateMode === 'free-willy' ? 'free-willy' : 'off',
    maxRoundTurns: c.maxRoundTurns ?? DEFAULT_DEBATE_TURNS,
    desk: c.desk === true,
    maestroFollow: c.maestroFollow === true,
    discord: c.discord,
    slack: c.slack ?? null,
    github: c.github ?? null,
    pendingLink: c.pendingLink && Date.parse(c.pendingLink.expiresAt) > now ? { expiresAt: c.pendingLink.expiresAt } : null,
  };
}

export function mentionsIn(text, customHandles = []) {
  const found = new Set();
  const customSet = new Set((customHandles ?? []).map((h) => String(h).toLowerCase()));
  let all = false;
  for (const m of String(text ?? '').matchAll(/(^|[^\w@])@([a-z][a-z0-9_-]{1,31})\b/gi)) {
    const word = m[2].toLowerCase();
    if (word === 'all' || word === 'everyone' || word === 'here') { all = true; continue; }
    if (customSet.has(word)) { found.add(word); continue; }
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
// `debateMode: 'free-willy'` allows agents to debate each other up to `maxRoundTurns`.
export function agentsToAnswer(message, members, { desk = false, room = false, debateMode = 'off', roundTurns = 0, maxRoundTurns = DEFAULT_DEBATE_TURNS, customAgents = [] } = {}) {
  const customSet = new Set((customAgents ?? []).map((a) => String(a?.handle ?? a?.id ?? a ?? '').toLowerCase()).filter(Boolean));
  const roster = [...new Set((members ?? []).map((m) => {
    const std = normalizeProvider(m);
    if (std) return std;
    const h = normalizeCustomHandle(m);
    return h && customSet.has(h) ? h : null;
  }).filter(Boolean))];
  const team = roster.filter((p) => p !== 'maestro');
  if (team.length === 0) return [];
  const text = String(message?.body ?? '');
  const kind = String(message?.authorKind ?? '');
  const { all, providers } = mentionsIn(text, [...customSet]);
  if (desk && kind === 'human') {
    if (all) return team;
    if (providers.length) return team.filter((p) => providers.includes(p));
    return team;
  }
  if (debateMode === 'free-willy') {
    const cap = Math.max(1, Math.min(MAX_DEBATE_TURNS, Math.trunc(Number(maxRoundTurns) || DEFAULT_DEBATE_TURNS)));
    if (kind === 'human') {
      if (all) return team;
      if (providers.length) return team.filter((p) => providers.includes(p));
      return team;
    }
    if (kind === 'agent') {
      if (roundTurns >= cap) return [];
      const subj = String(message?.authorSubject ?? '');
      const rawAuthor = subj.startsWith('agent:') ? subj.slice(6).toLowerCase() : '';
      const authorId = normalizeProvider(rawAuthor) ?? (customSet.has(rawAuthor) ? rawAuthor : rawAuthor);
      if (!authorId || authorId === 'maestro') return [];
      const peers = team.filter((p) => p !== authorId);
      if (peers.length === 0) return [];
      if (all) return peers;
      const namedPeers = peers.filter((p) => providers.includes(p));
      return namedPeers.length ? namedPeers : peers;
    }
    return [];
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
export function describeAuthor(subject, kind, customAgents = []) {
  const s = String(subject ?? '');
  if (s.startsWith('agent:')) {
    const raw = s.slice(6);
    const p = normalizeProvider(raw);
    if (p) return { name: AGENT_NAMES[p] ?? 'Agent', source: 'helmian', provider: p };
    const custom = Array.isArray(customAgents) ? customAgents.find((a) => (a.handle || a.id) === raw.toLowerCase()) : null;
    if (custom) return { name: `${custom.emoji} ${custom.name}`, source: 'helmian', provider: custom.handle, engine: custom.provider };
    return { name: raw || 'Agent', source: 'helmian', provider: raw || null };
  }
  if (s.startsWith('discord:')) {
    const rest = s.slice(8);
    const i = rest.indexOf(':');
    const name = i >= 0 ? rest.slice(i + 1) : '';
    return { name: name || 'Discord member', source: 'discord', provider: null };
  }
  if (s.startsWith('slack:')) {
    const rest = s.slice(6);
    const i = rest.indexOf(':');
    const name = i >= 0 ? rest.slice(i + 1) : '';
    return { name: name || 'Slack member', source: 'slack', provider: null };
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

export function slackSubject(userId, displayName) {
  if (!isSlackId(userId)) throw new Error('slack user id is invalid');
  const name = String(displayName ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64) || 'Slack member';
  return `slack:${userId}:${name}`;
}

// Text an agent gets for its turn: who it is, who else is here, the recent
// conversation, and the message it is answering. `notebook`, when the mesh
// supplies one (envoy-notebook.mjs), is the tenant's shared-notebook block
// — already bounded and formatted — rendered between the role line and the
// recent conversation. Absent or empty, the prompt is exactly what it has
// always been, byte for byte.
export function agentPrompt({ provider, channelTitle, members, context = [], message, source = 'helmian', customAgents = [], debateMode = 'off', notebook = null }) {
  const customMap = new Map((customAgents ?? []).map((a) => [a.handle || a.id, a]));
  const p = normalizeProvider(provider) ?? (customMap.has(String(provider ?? '').toLowerCase()) ? String(provider).toLowerCase() : null);
  // There is no Maestro prompt: no turn is ever composed for 'maestro',
  // because Maestro is the human's seat, not an agent (Bite 2).
  if (p === 'maestro') throw new Error('maestro is not an agent provider');
  const custom = customMap.get(p);
  const me = custom ? `${custom.emoji} ${custom.name} (@${custom.handle})` : (AGENT_NAMES[p] ?? 'Agent');
  const others = (members ?? []).map((x) => {
    const std = normalizeProvider(x);
    if (std && std !== p && std !== 'maestro') return AGENT_NAMES[std];
    const c = customMap.get(String(x).toLowerCase());
    if (c && c.handle !== p) return `${c.emoji} ${c.name} (@${c.handle})`;
    return null;
  }).filter(Boolean);
  const where = source === 'discord' ? `the #${channelTitle} channel (mirrored with Discord)` : source === 'slack' ? `the #${channelTitle} channel (mirrored with Slack)` : `the #${channelTitle} channel in Helmian Envoy`;
  const jobLine = custom && (custom.jobTitle || custom.jobPrompt)
    ? ` Your assigned job: ${custom.jobTitle ? `${custom.jobTitle} — ` : ''}${custom.jobPrompt || 'Fulfill your role.'}`
    : '';
  const debateLine = debateMode === 'free-willy'
    ? ' Free-Willy Debate Mode is active: debate directly with the other agents, challenge weak points, @mention peers when responding to them, and converge on the strongest solution.'
    : '';
  const role = `You are ${me}, an agent member of ${where}.${jobLine} Other agents here: ${others.join(', ') || 'none'}. If you were given a slice of work, start your reply with "Claim:" and the slice you are taking, so you do not overlap the others.${debateLine} Be concise.`;
  const history = context.slice(-12).map((m) => `${m.authorName || m.authorKind}: ${String(m.body ?? '').slice(0, 600)}`).join('\n');
  const from = message?.authorName || (message?.authorKind === 'agent' ? 'Agent' : 'Member');
  const notebookBlock = String(notebook ?? '').trim();
  return `${role}${notebookBlock ? `\n\n${notebookBlock}` : ''}\n\nRecent conversation:\n${history || '(none)'}\n\nReply to this message from ${from}:\n${String(message?.body ?? '')}`;
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
// The connector-library toggles a message may carry (metadata.connectors,
// connector-library SPEC §1.6): one { seatId, entryId } per connector the
// person armed for this turn from the "+" library panel. Ids are the
// library's slugs (seat ids from the catalog, entry ids from the read).
export const MAX_MESSAGE_CONNECTORS = 16;
// The Helmian-store skills a message may carry (metadata.skills,
// slash-skills DESIGN §3.1): one { skillId, seatId } per skill the
// person attached for this turn from the "/" picker. Bodies inject
// whole into a turn (src/agent/attachments.mjs caps them), unlike
// connector toggles which inject a descriptor — hence the small cap.
export const MAX_MESSAGE_SKILLS = 3;
const CONNECTOR_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;
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
 * The external-source stamp a bridge stores on a mirrored message:
 * `{ source: { provider, teamId?, channelId, channelName? } }`. It is a
 * display hint only — the badge itself keys off the author subject, which
 * the server sets — so an invalid stamp is dropped, never thrown. Only the
 * fields the /app badge renders survive.
 */
export function normalizeSourceRef(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const provider = input.provider === 'slack' || input.provider === 'discord' ? input.provider : null;
  if (!provider) return undefined;
  const idOk = provider === 'slack' ? isSlackId : (v) => /^\d{5,25}$/.test(String(v ?? ''));
  if (!idOk(input.channelId)) return undefined;
  const clean = (v) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 100);
  return Object.freeze({
    provider,
    ...(input.teamId !== undefined && idOk(input.teamId) ? { teamId: String(input.teamId) } : {}),
    channelId: String(input.channelId),
    ...(clean(input.channelName) ? { channelName: clean(input.channelName) } : {}),
  });
}

/**
 * The connector-library toggles a message carries (SPEC §1.6): the set
 * of connectors the person armed for this turn from the "+" library
 * panel. Each entry names its seat — a seat's turn consumes only its
 * own entries (§3.4) — so the pair is the identity and duplicates are
 * refused, exactly like attachments. Absent (the untouched panel) is
 * the default every layer already treats as "nothing armed".
 */
export function normalizeConnectorToggles(input) {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) throw new Error('message connectors are invalid');
  if (input.length > MAX_MESSAGE_CONNECTORS) throw new Error('too many connectors');
  const seen = new Set();
  const out = input.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('message connectors are invalid');
    const seatId = String(item.seatId ?? '');
    const entryId = String(item.entryId ?? '');
    if (!CONNECTOR_ID_PATTERN.test(seatId) || !CONNECTOR_ID_PATTERN.test(entryId)) throw new Error('message connectors are invalid');
    const id = `${seatId}:${entryId}`;
    if (seen.has(id)) throw new Error('connector is duplicated');
    seen.add(id);
    return Object.freeze({ seatId, entryId });
  });
  return out.length ? Object.freeze(out) : undefined;
}

/**
 * The Helmian-store skills a message carries (slash-skills DESIGN
 * §3.1): the set of workspace skills the person attached for this turn
 * from the "/" picker. Each entry names its skill and its target — a
 * library seat id, a custom-agent handle, or the literal 'all' for
 * every agent — so the pair is the identity and duplicates are
 * refused, exactly like connector toggles. The message's target is
 * only ever a request: dispatch (envoy-mesh.mjs) clamps it to the
 * skill record's own scope, so a message cannot widen a seat-scoped
 * skill. Absent (nothing attached) is the default every layer already
 * treats as "no skills".
 *
 * This is a SEPARATE road from the by-name { kind: 'skill' }
 * attachment above: that one rides the message body as a leading
 * /name and expands a markdown command file on the seat's own
 * computer; this one names a Helmian-store skill and is resolved
 * cloud-side at dispatch. The one-skill-per-message rule in the
 * composer governs the by-name road only (one leading command is all
 * a body can carry) — this list has its own cap, MAX_MESSAGE_SKILLS.
 * Neither road dedupes against the other.
 */
export function normalizeSkillToggles(input) {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) throw new Error('message skills are invalid');
  if (input.length > MAX_MESSAGE_SKILLS) throw new Error('too many skills');
  const seen = new Set();
  const out = input.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('message skills are invalid');
    const skillId = String(item.skillId ?? '');
    const seatId = String(item.seatId ?? '');
    if (!CONNECTOR_ID_PATTERN.test(skillId) || !CONNECTOR_ID_PATTERN.test(seatId)) throw new Error('message skills are invalid');
    const id = `${skillId}:${seatId}`;
    if (seen.has(id)) throw new Error('skill is duplicated');
    seen.add(id);
    return Object.freeze({ skillId, seatId });
  });
  return out.length ? Object.freeze(out) : undefined;
}

/**
 * The metadata object stored on a message. Accepts the wire shapes the
 * client may send — `{ attachments: [...], webSearch?: boolean,
 * connectors?: [...], skills?: [...] }` — plus the bridge's source
 * stamp, and returns the canonical frozen form, or null when nothing
 * was attached.
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
  const connectors = normalizeConnectorToggles(input.connectors);
  const skills = normalizeSkillToggles(input.skills);
  const source = normalizeSourceRef(input.source);
  if (!attachments.length && webSearch === undefined && !connectors && !skills && !source) return null;
  return Object.freeze({
    ...(attachments.length ? { attachments: Object.freeze(attachments) } : {}),
    ...(webSearch !== undefined ? { webSearch } : {}),
    ...(connectors ? { connectors } : {}),
    ...(skills ? { skills } : {}),
    ...(source ? { source } : {}),
  });
}
