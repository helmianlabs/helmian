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
// Maestro always-on (Troy's ruling, 2026-11-09, superseding the
// per-channel Maestro follow switch shipped the same morning): desk
// dispatch rules are how EVERY channel routes — the mesh passes
// desk:true to agentsToAnswer unconditionally (see envoy-mesh.mjs
// agentWork). The stored maestroFollow field survives in parse /
// serialize / public config purely for backward compatibility with
// configs written while the switch existed; routing never consults
// it, and a stored false does not restore the old silence. Maestro
// still never answers.
//
// Helm (Helm identity, bite H1): a second reserved presence in the
// same family as Maestro, and likewise never an agent. 'helm'
// resolves in the alias table so @helm parses to a role addressee
// and describeAuthor can name the 'agent:helm' subject Helm posts
// under, but Helm is NOT in AGENT_PROVIDERS: no runner serves it,
// no prompt is composed for it (agentPrompt refuses it beside
// 'maestro'), no channel config may seat it (parseConfig drops
// it), no custom agent may take its handle (RESERVED_HANDLES), and
// it is filtered out of every team and due set beside 'maestro'.
// What Helm does with the address (the presence law, the guide's
// voice) is later bites' work; this registry change is identity
// and presence only.
//
// The Librarian (bite L1): the third reserved presence, in the
// same family. 'librarian' resolves in the alias table so
// @librarian parses to a role addressee and describeAuthor can
// name the 'agent:librarian' subject the Librarian's filing
// confirmations and recall answers post under, with the same
// guards as Helm everywhere the alias could leak: not in
// AGENT_PROVIDERS, no engine, no prompt, no config seat, no
// custom handle, never in a team or a due set. The Librarian is
// the workspace's one pen: it acts only through deterministic
// cloud code (envoy-librarian.mjs's store, envoy-chat.mjs's
// filing hook), never through a runner.

export const AGENT_PROVIDERS = Object.freeze(['maestro', 'claude', 'openai', 'grok', 'gemini', 'mistral', 'qwen', 'groq', 'nvidia', 'cloudflare', 'openrouter', 'muse']);
export const AGENT_NAMES = Object.freeze({ maestro: 'Maestro', helm: 'Helm', librarian: 'Librarian', claude: 'Claude', openai: 'ChatGPT', grok: 'Grok', gemini: 'Gemini', mistral: 'Mistral', qwen: 'Qwen', runway: 'Runway', ollama: 'Ollama', custom: 'Custom AI', groq: 'Groq', nvidia: 'NVIDIA', cloudflare: 'Cloudflare', openrouter: 'OpenRouter', muse: 'Muse' });
export const CUSTOM_AGENT_ENGINES = Object.freeze(['claude', 'openai', 'grok', 'gemini', 'mistral', 'runway', 'ollama', 'groq', 'nvidia', 'cloudflare', 'openrouter', 'muse', 'custom']);
// One connect road: a custom agent's seat works off the tenant's
// provider connection of record. Under the owner's 2026-11-01 law
// that was the email + password sign-in ('password_session'); Troy's
// order of 2026-11-17 (Scribe letter 935) retired the password road,
// and the connection of record is now the API key ('api_key') — or
// an OAuth connection where one exists, which outranks the key in
// the connect route. The old seat-mode menu no longer exists;
// sanitizeCustomAgent collapses every stored or incoming authMode
// value to this single mode.
export const CUSTOM_AGENT_AUTH_MODE = 'api_key';
export const MAX_CHANNEL_AGENTS = 50;
export const MAX_DEBATE_TURNS = 50;
export const DEFAULT_DEBATE_TURNS = 10;
const ALIASES = Object.freeze({
  maestro: 'maestro', manager: 'maestro',
  // Helm (bite H1): a reserved role handle in Maestro's family.
  // The alias makes @helm resolve and 'agent:helm' describable;
  // every routing surface filters it back out (see the header).
  helm: 'helm',
  // The Librarian (bite L1): the same reserved role handle shape.
  // The alias makes @librarian resolve and 'agent:librarian'
  // describable; every routing surface filters it back out.
  librarian: 'librarian',
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
  // 'maestro', 'helm' and 'librarian' resolve as role handles
  // above, but none of them is an engine a custom agent may run on.
  return engine && engine !== 'maestro' && engine !== 'helm' && engine !== 'librarian' ? engine : null;
}

const CUSTOM_HANDLE_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const RESERVED_HANDLES = new Set(['all', 'everyone', 'here', 'maestro', 'manager', 'helm', 'librarian', 'system', 'helmian']);

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
  // carrying 'api_key', whatever they were saved with.
  const authMode = CUSTOM_AGENT_AUTH_MODE;
  const jobTitle = String(raw.jobTitle ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
  const jobPrompt = String(raw.jobPrompt ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 600);
  return { id: handle, handle, name, emoji, provider, authMode, jobTitle, jobPrompt };
}

export const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_EVENTS = new Set(['push', 'pull_request', 'issues']);

// The channel's standing armed connector set (Amendment 1 §2.3,
// bite A2): the { seatId, entryId } pairs the plus menu's Connectors
// toggle list has switched on for this channel, persisted on the
// channel config the way every other per-channel setting persists.
// Ids are the connector library's slugs — the same pattern the
// message toggles validate against (normalizeConnectorToggles
// below) — and the set is capped at the message cap: a channel can
// never arm more in standing state than one message may carry. The
// sanitizer is fail-closed per entry: a malformed pair is dropped,
// never carried, and duplicates collapse. What the set may contain
// is a preference; what a pair DOES is decided at compose time
// against the live library read (a pair whose connector is no
// longer connected rides nothing), and whether an armed turn runs
// the connector's tools at all is the arming road's own question
// (Mirror M3) — this field is the choice, not the effect.
const ARMED_CONNECTOR_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;
export function sanitizeArmedConnectors(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const seatId = String(item.seatId ?? '');
    const entryId = String(item.entryId ?? '');
    if (!ARMED_CONNECTOR_ID_PATTERN.test(seatId) || !ARMED_CONNECTOR_ID_PATTERN.test(entryId)) continue;
    const id = `${seatId}:${entryId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(Object.freeze({ seatId, entryId }));
    if (out.length >= MAX_MESSAGE_CONNECTORS) break;
  }
  return out;
}

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
    armedConnectors: [],
    toolAccess: 'when-used',
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
      // 'helm' and 'librarian' resolve as role handles but are
      // never channel members: a config naming either drops it
      // (bites H1 and L1). Maestro's historical entries, by
      // contrast, are kept and read as inert (see the header).
      if (std) return std === 'helm' || std === 'librarian' ? null : std;
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
    // The channel tool-loading setting (Mirror M3, bite G6): one
    // key, two values — anything but the exact 'keep-loaded'
    // string reads as the default, the debateMode discipline.
    const toolAccess = raw.toolAccess === 'keep-loaded' ? 'keep-loaded' : 'when-used';
    const rawTurns = Number(raw.maxRoundTurns);
    const maxRoundTurns = Number.isFinite(rawTurns) ? Math.max(1, Math.min(MAX_DEBATE_TURNS, Math.trunc(rawTurns))) : DEFAULT_DEBATE_TURNS;
    const avatar = sanitizeChannelAvatar(raw.avatar);
    const armedConnectors = sanitizeArmedConnectors(raw.armedConnectors);
    return { format: CONFIG_FORMAT, agents, joined, discord, slack, github, pendingLink, desk: raw.desk === true, maestroFollow: raw.maestroFollow === true, customAgents, debateMode, maxRoundTurns, avatar, armedConnectors, toolAccess };
  } catch { return null; }
}

// The stored-config size bound (hardening step 1, sql/098): channel
// config no longer lives only in an envoy_messages body, whose
// sql/009 CHECK caps it at 4,000 chars — the cap that made
// MAX_CHANNEL_AGENTS unreachable in one channel. The dedicated
// helmion.envoy_channel_configs table (envoy-config-store.mjs)
// carries bodies up to this bound; serializeConfig enforces the
// same bound so a config too large for the table fails here, at
// the one serialization point, instead of at the database.
export const MAX_CONFIG_BODY_CHARS = 65_536;

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
  // armedConnectors is written only when non-empty, so every config
  // stored before the standing toggle list existed keeps its exact
  // bytes (the avatar/desk discipline above).
  const armedConnectors = sanitizeArmedConnectors(config.armedConnectors);
  if (armedConnectors.length) stored.armedConnectors = armedConnectors;
  // toolAccess is written only when 'keep-loaded', so every config
  // stored before the tool-loading setting existed — and every
  // channel left at the default — keeps its exact bytes (the
  // armedConnectors discipline above).
  if (config.toolAccess === 'keep-loaded') stored.toolAccess = 'keep-loaded';
  const body = JSON.stringify(stored);
  if (body.length > MAX_CONFIG_BODY_CHARS) throw new Error('channel config is too large');
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
    armedConnectors: sanitizeArmedConnectors(c.armedConnectors),
    toolAccess: c.toolAccess === 'keep-loaded' ? 'keep-loaded' : 'when-used',
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

// ---------- role addressees (hook precedence, DESIGN section 1.5) ----------

// The three roles a human send can be addressed to by name.
// Roles are not providers: 'helm' and 'librarian' are not in
// AGENT_PROVIDERS at all, and 'maestro' is filtered out of every
// team, so mentionsIn can see at most one of the three and must
// not be bent to see the others. A role-addressed message is
// owned by that role's hook: under the precedence rule (coordinator,
// Helm, Librarian, guide, empty-desk) the setup guide matcher
// never fires on it. That is the rule that keeps a dispatch order
// to Maestro that happens to name a connector from being answered
// with a guide entry instead of reaching the crew.
export const ROLE_ADDRESSEES = Object.freeze(['maestro', 'helm', 'librarian']);

const ROLE_VOCATIVE_RE = /^\s*(?:(?:hey|hi|hello)\s+)?@?(?:the\s+)?(maestro|helm|librarian)\b/i;
const ROLE_MENTION_RE = /@(?:the\s+)?(maestro|helm|librarian)\b/i;

/**
 * The role a message is addressed to ('maestro', 'helm', or
 * 'librarian'), or null. Addressed means one of two shapes: a
 * vocative at the start of the message ("Maestro: ...",
 * "Helm, ...", "Librarian: ...", optionally after a greeting),
 * or an @mention of the role anywhere in the message. A role
 * named mid-message with no @mention is not an address, so an
 * ordinary setup question that merely talks about a role ("how
 * do I talk to Maestro?") stays the guide's, exactly as before.
 * Pure.
 */
export function roleAddresseeIn(text) {
  const body = String(text ?? '');
  const vocative = ROLE_VOCATIVE_RE.exec(body);
  if (vocative) return vocative[1].toLowerCase();
  const mention = ROLE_MENTION_RE.exec(body);
  return mention ? mention[1].toLowerCase() : null;
}

// ---------- Helm presence (fix programme bite H3, DESIGN 1.2 / 3.3) ----------

// The three shapes of Helm being due, named for the answer's
// metadata: 'alone' (@Helm named — Helm answers alone and no
// vendor seat is handed the message), 'team' (@all — Helm
// answers as one of the team, alongside the due seats), and
// 'last-resort' (no vendor seat due — Helm catches the message
// so it is not met with silence).
export const HELM_DUE_CASES = Object.freeze(['alone', 'team', 'last-resort']);

/**
 * Whether Helm answers `message`, and how: one of HELM_DUE_CASES,
 * or null when Helm stays silent. Pure — the caller supplies the
 * two facts it alone knows: `vendorDue`, the vendor due set AFTER
 * every filter and the claim gate have run (the mesh's due set at
 * the decision point), and `answered`, whether the channel record
 * already carries a response to this message of any answering
 * kind (a seat's reply, a Helm answer, a guide answer, the
 * empty-desk line). Helm is the answerer of last resort: a
 * message somebody already answered is never answered again,
 * whatever its due set computes to on a later poll.
 *
 * The law, in the order it is decided (DESIGN 1.2, 3.3):
 *   - Only a human send can be Helm's. Agent rows are never
 *     fresh asks for Helm, in debate mode or out of it.
 *   - A message a role hook already owns is never Helm's: a
 *     Maestro assignment (its parts and their settling are
 *     Maestro's road, bites M3/M4), a guide answer, a filed fact.
 *   - @Helm named — vocative or @mention, the roleAddresseeIn
 *     shapes — Helm answers ALONE, whatever the vendor due set
 *     holds: the address is the routing (precedence, 1.5).
 *   - @all: Helm answers as one of the team, alongside whatever
 *     seats are due — and still answers when none are, as the
 *     one team member who is always present.
 *   - An empty vendor due set: Helm answers as last resort.
 *     This is where the cases the brief names land — no
 *     connected or joined seat for the message, every due seat
 *     withheld by the claim gate, a message naming only a role
 *     (a lone @Maestro, an unparseable Maestro address, a
 *     Librarian address that is not a file request: the role
 *     hooks left them to dispatch, and dispatch found nobody).
 *   - Vendor seats due: Helm stays silent unless named, which
 *     the cases above have already decided.
 */
export function helmDue(message, { vendorDue = [], answered = false } = {}) {
  if (String(message?.authorKind ?? '') !== 'human') return null;
  const metadata = message?.metadata ?? null;
  if (metadata?.maestroAssignment || metadata?.helmKb || metadata?.librarianFact) return null;
  if (answered) return null;
  if (roleAddresseeIn(message?.body) === 'helm') return 'alone';
  if (mentionsIn(message?.body).all) return 'team';
  if (!Array.isArray(vendorDue) || vendorDue.length === 0) return 'last-resort';
  return null;
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
  // 'maestro' is the human's seat, 'helm' is a reserved presence
  // and 'librarian' is the workspace's pen: none of the three is
  // ever on a team or in a due set.
  const team = roster.filter((p) => p !== 'maestro' && p !== 'helm' && p !== 'librarian');
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
      if (!authorId || authorId === 'maestro' || authorId === 'helm' || authorId === 'librarian') return [];
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
    // The channel's configured identity wins: a custom agent record for
    // this handle IS the agent's workspace identity (its name and face),
    // even when the handle collides with a built-in provider id. The
    // provider table is the fallback for seats with no custom record,
    // never an override of a configured one — agentPrompt and
    // publicConfig already resolve in this order; this derivation was
    // the one that did not, so a custom agent whose handle matched a
    // provider id was shown (and reacted) under the provider's name.
    const custom = Array.isArray(customAgents) ? customAgents.find((a) => (a.handle || a.id) === raw.toLowerCase()) : null;
    if (custom) return { name: `${custom.emoji} ${custom.name}`, source: 'helmian', provider: custom.handle, engine: custom.provider };
    const p = normalizeProvider(raw);
    if (p) return { name: AGENT_NAMES[p] ?? 'Agent', source: 'helmian', provider: p };
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
// always been, byte for byte. `knowledgeBase`, when the mesh supplies one
// (envoy-librarian.mjs readKnowledgeBaseBlock), is the tenant's solved-
// incident block — mistakes already made in this workspace and their
// fixes — rendered after the notebook block under the same discipline.
// `slice`, when the mesh supplies one (fix programme bite M3, DESIGN
// 2.3), is this turn's part of a Maestro assignment: { n, total, text,
// job } — the part's number, the part count, the part text, and the
// full job the part belongs to. The role line gains the slice
// sentence, the full job renders as a context block beside the
// notebook block, and the message being answered becomes the part
// text. A slice carrying no real part (no text, no sane numbering)
// is no slice at all, under the same discipline as an absent
// notebook: the prompt is then exactly what it has always been.
export function agentPrompt({ provider, channelTitle, members, context = [], message, source = 'helmian', customAgents = [], debateMode = 'off', notebook = null, knowledgeBase = null, slice = null }) {
  const customMap = new Map((customAgents ?? []).map((a) => [a.handle || a.id, a]));
  const p = normalizeProvider(provider) ?? (customMap.has(String(provider ?? '').toLowerCase()) ? String(provider).toLowerCase() : null);
  // There is no Maestro prompt: no turn is ever composed for 'maestro',
  // because Maestro is the human's seat, not an agent (Bite 2).
  if (p === 'maestro') throw new Error('maestro is not an agent provider');
  // There is no Helm prompt either: Helm is a reserved presence
  // that answers through deterministic cloud code, never a
  // runner turn (bite H1).
  if (p === 'helm') throw new Error('helm is not an agent provider');
  // And no Librarian prompt: the Librarian files and confirms
  // through deterministic cloud code, never a runner turn
  // (bite L1).
  if (p === 'librarian') throw new Error('librarian is not an agent provider');
  const custom = customMap.get(p);
  const me = custom ? `${custom.emoji} ${custom.name} (@${custom.handle})` : (AGENT_NAMES[p] ?? 'Agent');
  const others = (members ?? []).map((x) => {
    // Same precedence as the self line above and describeAuthor: a
    // custom agent is introduced to its peers by its configured
    // identity (face, name, handle), never by the provider its handle
    // happens to collide with.
    const c = customMap.get(String(x).toLowerCase());
    if (c && c.handle !== p) return `${c.emoji} ${c.name} (@${c.handle})`;
    const std = normalizeProvider(x);
    if (std && std !== p && std !== 'maestro') return AGENT_NAMES[std];
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
  const knowledgeBaseBlock = String(knowledgeBase ?? '').trim();
  // The slice rendering (bite M3): the role line gains the slice
  // sentence so the turn is confined to its part; the full job
  // renders as a context block after the knowledge-base block when
  // it adds anything beyond the part itself; and the message being
  // answered is the part text, never the whole job. Without a real
  // slice every term below is empty and the return is byte for byte
  // the prompt this function has always composed.
  const sliceText = typeof slice?.text === 'string' ? slice.text.trim() : '';
  const sliceN = Number(slice?.n);
  const sliceTotal = Number(slice?.total);
  const sliceOk = Boolean(sliceText) && Number.isInteger(sliceN) && sliceN >= 1 && Number.isInteger(sliceTotal) && sliceTotal >= sliceN;
  const sliceJob = sliceOk && typeof slice?.job === 'string' ? slice.job.trim() : '';
  const roleLine = sliceOk ? `${role} Your slice is part ${sliceN} of ${sliceTotal}; answer only it.` : role;
  const jobBlock = sliceJob && sliceJob !== sliceText ? sliceJob : '';
  return `${roleLine}${notebookBlock ? `\n\n${notebookBlock}` : ''}${knowledgeBaseBlock ? `\n\n${knowledgeBaseBlock}` : ''}${jobBlock ? `\n\nThe full job this slice belongs to, for context only:\n${jobBlock}` : ''}\n\nRecent conversation:\n${history || '(none)'}\n\nReply to this message from ${from}:\n${sliceOk ? sliceText : String(message?.body ?? '')}`;
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
  // The composer's active project rides the message the way the
  // attachments do (mirror-design §3.1 "Add to project", bite M2):
  // the key is validated with the workspace project registry's own
  // shape (workspace-project-repository.mjs assertCloudProjectKey) —
  // a malformed key is refused, never carried.
  let projectKey;
  if (input.projectKey !== undefined && input.projectKey !== null) {
    const key = String(input.projectKey).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._:-]{0,95}$/.test(key) || key.includes('..') || /^[a-z]:/.test(key)) {
      throw new Error('message project is invalid');
    }
    projectKey = key;
  }
  if (!attachments.length && webSearch === undefined && !connectors && !skills && !source && !projectKey) return null;
  return Object.freeze({
    ...(attachments.length ? { attachments: Object.freeze(attachments) } : {}),
    ...(webSearch !== undefined ? { webSearch } : {}),
    ...(connectors ? { connectors } : {}),
    ...(skills ? { skills } : {}),
    ...(source ? { source } : {}),
    ...(projectKey ? { projectKey } : {}),
  });
}
