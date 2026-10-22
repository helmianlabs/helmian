// Envoy agents: who is in a channel, who should answer a message, and how
// agent / Discord / system authors are named. Pure functions only, shared by
// the cloud routes (envoy-mesh.mjs), the PC bridge and the Discord bridge.
//
// Agents are channel members. A human message (typed in Helmian or in a linked
// Discord channel) is routed like this:
//   - @all                -> every agent in the channel
//   - @Claude, @Gemini... -> only the agents named
//   - no mention          -> Maestro if Maestro is in the channel, else every agent
// An agent message is answered only when Maestro (the manager) @mentions other
// agents, one hop deep, so agents never loop on each other.

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
  return { format: CONFIG_FORMAT, agents: [], joined: {}, discord: null, pendingLink: null };
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
    return { format: CONFIG_FORMAT, agents, joined, discord, pendingLink };
  } catch { return null; }
}

export function serializeConfig(config) {
  const joined = {}; for (const p of config.agents ?? []) if (config.joined?.[p]) joined[p] = config.joined[p];
  const body = JSON.stringify({ format: CONFIG_FORMAT, agents: config.agents ?? [], joined, discord: config.discord ?? null, pendingLink: config.pendingLink ?? null });
  if (body.length > 4000) throw new Error('channel config is too large');
  return body;
}

// What the browser may see: never the link code hash.
export function publicConfig(config, now = Date.now()) {
  const c = config ?? emptyConfig();
  return {
    agents: c.agents.map((p) => ({ provider: p, name: AGENT_NAMES[p], joinedAt: c.joined?.[p] ?? null })),
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

// Which agent members should answer `message`. `members` = provider ids.
export function agentsToAnswer(message, members) {
  const roster = [...new Set((members ?? []).map(normalizeProvider).filter(Boolean))];
  if (roster.length === 0) return [];
  const text = String(message?.body ?? '');
  const kind = String(message?.authorKind ?? '');
  const { all, providers } = mentionsIn(text);
  if (kind === 'agent') {
    // Only Maestro dispatches, and only to the workers it names.
    if (String(message?.authorSubject ?? '') !== 'agent:maestro') return [];
    const named = all ? roster : providers;
    return roster.filter((p) => p !== 'maestro' && named.includes(p));
  }
  if (kind !== 'human') return [];
  if (all) return roster;
  if (providers.length) return roster.filter((p) => providers.includes(p));
  if (roster.includes('maestro')) return ['maestro'];
  return roster;
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
  if (s.endsWith(':bridge')) return { name: 'Maestro', source: 'helmian', provider: 'maestro' };
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
  const me = AGENT_NAMES[p] ?? 'Agent';
  const others = (members ?? []).map(normalizeProvider).filter((x) => x && x !== p).map((x) => AGENT_NAMES[x]);
  const where = source === 'discord' ? `the #${channelTitle} channel (mirrored with Discord)` : `the #${channelTitle} channel in Helmian Envoy`;
  const role = p === 'maestro'
    ? `You are Maestro, the manager agent in ${where}. Other agents here: ${others.join(', ') || 'none'}. When the request needs work, split it into distinct slices and assign each with an @mention (for example "@Claude: ..."). Keep it short. If no other agents are here, answer yourself.`
    : `You are ${me}, an agent member of ${where}. Other agents here: ${others.join(', ') || 'none'}. If you were given a slice of work, start your reply with "Claim:" and the slice you are taking, so you do not overlap the others. Be concise.`;
  const history = context.slice(-12).map((m) => `${m.authorName || m.authorKind}: ${String(m.body ?? '').slice(0, 600)}`).join('\n');
  const from = message?.authorName || (message?.authorKind === 'agent' ? 'Agent' : 'Member');
  return `${role}\n\nRecent conversation:\n${history || '(none)'}\n\nReply to this message from ${from}:\n${String(message?.body ?? '')}`;
}
