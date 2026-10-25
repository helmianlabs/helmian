// Composer "+" picker: attach a skill, a connector, or a file to the
// message you are about to send, or flip its web-search toggle. Pure
// model — no DOM — so it is unit tested like app-model.mjs;
// envoy-workspace.js renders it.
//
// PER-AGENT (plus-parity bite 1): pass `agent` to pickerModel() and the
// model leads with that agent's own ecosystem group — its seat (the
// provider connection the agent itself runs on), its by-name skills, and
// the bridge plugins it can be handed — with the shared groups after.
// Without an agent (the Maestro desk, an unaddressed channel, no active
// session) the model is the shared one, exactly as before.
// EVERY entry carries a truthful `state`, computed from the same registry
// facts the Integrations page renders:
// - 'connected' (label "Works"): turning the message over really uses it
//   — an installed plugin's MCP tools join the turn; a seat is the
//   connection the agent itself answers through.
// - 'note-only' (label "Note only"): a registered connector. Attaching
//   it hands the agent a NOTE that the service is connected — the turn
//   is told the service was not opened for it (src/agent/attachments.mjs
//   is explicit about this). A connector can therefore NEVER carry
//   'connected' here: registry-connected is not turn-connected.
// - 'not-connected': the registry holds no connection for it.
//
// WHERE THE GROUPS COME FROM (real registries only; nothing invented):
// - Connectors: PROVIDER_REGISTRY in app-model.mjs, with connection truth
//   from integrationsModel() over GET /api/admin/cora/connectors, GET
//   /api/admin/provider-connections, GET /api/admin/tool-connections and
//   the runner presence feed — the exact rows the Integrations page
//   renders, each with its truthful statusText ("Connected" only from a
//   verified probe receipt or a live runner link; mirrors read "Linked").
//   A connector can be attached only when that truth says it is connected.
// - Skills: there is deliberately NO skill list here. Skills are markdown
//   command files that live with the agent runtime — .helmion/commands/
//   plus plugin commands/ (src/agent/commands.mjs, src/agent/plugins.mjs) —
//   discovered on the PC bridge at turn time. No cloud API lists them, so
//   the picker attaches a skill BY NAME and the message carries it the one
//   way the turn path already understands: as the leading /name the
//   bridge's turn handler expands (src/agent/bridge.mjs).
// - Plugins: installed on the PC bridge — the workspace registry plus the
//   install ledger's verdicts (src/agent/plugins.mjs) — and listed by GET
//   /api/admin/plugins (src/cloud/installed-plugins.mjs): the same enabled
//   set the turn consumes. A plugin can be attached only when that list
//   names it; a name the bridge does not have would ride to the turn and
//   match nothing, so the picker refuses it here instead.
// - Upload: a real file input. The picked file's bytes travel INLINE in
//   the message metadata as base64 — there is no upload endpoint and no
//   byte store in the cloud, and the metadata is the one channel every
//   layer already passes along. That shape sets the honest bounds the
//   group states plainly: up to 256 KB per file (512 KB per message),
//   text-shaped files and PNG/JPEG/WebP images only — the kinds a turn
//   can actually receive today (text is inlined; images become real
//   image content). Other kinds are refused with the reason, here and
//   again server-side.
//
// HOW AN ATTACHMENT TRAVELS: buildMessageRequest() returns the wire payload
// plus structured metadata. The message route allowlists `metadata`
// alongside { body, channelId, idempotencyKey }, envoy-chat stores it on
// the message (sql/060), and the bridges hand it to the turn:
// - a skill rides IN the body as the leading /name (expanded by the
//   bridge) AND in the metadata;
// - connectors and plugins ride as metadata, consumed agent-side by
//   src/agent/attachments.mjs (plugins contribute real MCP tools;
//   connectors are context-only today and the turn is told so);
// - a file rides as metadata too, consumed by the same module: images
//   join the turn's images, text is decoded and inlined.
// - the web-search toggle rides as metadata.webSearch — not an
//   attachment — and every consumer already reads it: the bridge resolver
//   (src/agent/attachments.mjs: native on the Claude seat, an honest line
//   on the others) and the cloud worker's context builder. It is carried
//   only when ON; off is the absence every layer already treats as the
//   default, so an untouched toggle changes nothing on the wire.
import { integrationsModel } from './app-model.mjs';

// Truthful attachment states (see the header): what attaching an entry
// actually does on the turn, never just what the registry holds.
export const ATTACH_STATE = Object.freeze({ CONNECTED: 'connected', NOTE_ONLY: 'note-only', NOT_CONNECTED: 'not-connected' });
export const ATTACH_STATE_LABEL = Object.freeze({ connected: 'Works', 'note-only': 'Note only', 'not-connected': 'Not connected' });

// The agents a composer can be talking to, and the PROVIDER_REGISTRY key
// of each one's own provider connection — its seat. Keys are the
// workspace's agent keys (envoy-workspace.js AGENTS, minus 'maestro':
// Maestro is the human's seat, never an agent with an ecosystem).
export const AGENT_ECOSYSTEMS = Object.freeze({
  claude: Object.freeze({ agent: 'claude', name: 'Claude', registryKey: 'anthropic' }),
  openai: Object.freeze({ agent: 'openai', name: 'ChatGPT', registryKey: 'openai' }),
  grok: Object.freeze({ agent: 'grok', name: 'Grok', registryKey: 'xai' }),
  gemini: Object.freeze({ agent: 'gemini', name: 'Gemini', registryKey: 'google' }),
});
const AGENT_ALIASES = Object.freeze({ chatgpt: 'openai', anthropic: 'claude', google: 'gemini', xai: 'grok' });

// An agent named any way the surfaces name it — workspace key ('gemini',
// 'openai'), display name ('Gemini', 'ChatGPT'), or registry key
// ('google', 'anthropic') — resolves to its workspace key, or null when
// it names no agent (including 'maestro', the human's seat).
export function normalizeAgentKey(value) {
  const k = String(value ?? '').trim().toLowerCase();
  if (!k || k === 'maestro') return null;
  if (Object.hasOwn(AGENT_ECOSYSTEMS, k)) return k;
  return AGENT_ALIASES[k] ?? null;
}

export function agentEcosystem(value) {
  const key = normalizeAgentKey(value);
  return key ? AGENT_ECOSYSTEMS[key] : null;
}

export const MAX_ATTACHMENTS = 8;
export const SKILL_NAME_MAX = 64;
// Command names are file names in the commands registry; plugin skills are
// namespaced "plugin:skill" (src/agent/plugins.mjs). One segment, or one
// namespace segment + one name segment.
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*(:[a-z0-9][a-z0-9_-]*)?$/;

// File bounds — mirrors of the canonical validator's
// (FILE_ATTACHMENT_MAX_BYTES / FILE_ATTACHMENTS_MAX_TOTAL_BYTES in
// src/cloud/envoy-agents.mjs). The server re-checks everything; these
// exist so the picker can refuse early, in plain words, before a big
// file is even read.
export const FILE_MAX_BYTES = 256 * 1024;
export const FILE_TOTAL_MAX_BYTES = 512 * 1024;
export const UPLOAD_NOTE = 'Up to 256 KB per file, 512 KB per message. Text files are read into the conversation; PNG, JPEG and WebP images are shown to the agent. Other kinds of file can\'t be read yet.';
export const WEB_SEARCH_NOTE = 'For this message only. Whether the agent can actually search depends on the seat: the Claude seat searches for real; other seats will say plainly that they can\'t, rather than pretend.';
const FILE_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const FILE_TEXT_MEDIA_TYPES = new Set([
  'application/json', 'application/xml', 'application/yaml', 'application/x-yaml',
  'application/toml', 'application/javascript', 'application/x-sh', 'image/svg+xml',
]);
const FILE_TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'yaml', 'yml', 'toml',
  'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py',
  'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sh', 'sql', 'ini', 'env',
]);

// Mirror of classifyFileAttachment in src/cloud/envoy-agents.mjs.
export function classifyFile({ name, mediaType } = {}) {
  const type = String(mediaType ?? '').trim().toLowerCase();
  if (FILE_IMAGE_MEDIA_TYPES.includes(type)) return 'image';
  if (type.startsWith('text/') || FILE_TEXT_MEDIA_TYPES.has(type)) return 'text';
  if (type === '' || type === 'application/octet-stream') {
    const ext = String(name ?? '').trim().toLowerCase().split('.').pop();
    if (ext && FILE_TEXT_EXTENSIONS.has(ext)) return 'text';
  }
  return null;
}

function cleanFileName(value) {
  const result = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  if (!result || result === '.' || result === '..' || result.includes('/') || result.includes('\\')) return null;
  return result;
}

/**
 * Type + size refusal for a picked file, BEFORE its bytes are read (the
 * workspace calls this on the File's name/type/size first). Returns a
 * plain-words reason, or null when the file may be attached.
 */
export function fileRefusalReason({ name, mediaType, size } = {}) {
  if (!cleanFileName(name)) return 'That file has no usable name.';
  if (!classifyFile({ name, mediaType })) return 'Helmian can\'t read that kind of file yet — text files and PNG, JPEG or WebP images work today.';
  if (!Number.isSafeInteger(size) || size < 1) return 'That file is empty.';
  if (size > FILE_MAX_BYTES) return `That file is too big — the limit is 256 KB per file.`;
  return null;
}

/**
 * A picked file (name, mediaType, size, base64 data) → the attachment the
 * list carries, or a plain-words refusal. The base64 must decode to
 * exactly `size` bytes: a truncated read is refused, never shipped.
 */
export function normalizeFileAttachment({ name, mediaType, size, data } = {}) {
  const refusal = fileRefusalReason({ name, mediaType, size });
  if (refusal) return { ok: false, attachment: null, reason: refusal };
  const text = String(data ?? '');
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const decoded = text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text) ? (text.length / 4) * 3 - padding : -1;
  if (decoded !== size) return { ok: false, attachment: null, reason: 'That file could not be read completely.' };
  return {
    ok: true,
    attachment: Object.freeze({ kind: 'file', name: cleanFileName(name), mediaType: String(mediaType ?? '').trim().toLowerCase().slice(0, 100), size, data: text }),
    reason: null,
  };
}

export function normalizeSkillName(value) {
  const name = String(value ?? '').trim().replace(/^\//, '').toLowerCase();
  if (!name) return { ok: false, name: null, reason: 'Type a skill name first.' };
  if (name.length > SKILL_NAME_MAX) return { ok: false, name: null, reason: 'That skill name is too long.' };
  if (!SKILL_NAME_PATTERN.test(name)) return { ok: false, name: null, reason: 'Skill names use letters, numbers and dashes — plugin skills look like plugin:skill.' };
  return { ok: true, name, reason: null };
}

const CONNECTORS_NOTE = 'Attaching a connector hands the agent a note that the service is connected — it does not open the service for the agent. Plugins are the exception: their tools really connect for the turn.';
const SKILLS_NOTE = 'Skills live with your agents — command files and plugins on your PC bridge. Attach one by name and it runs as a /command at the start of your message.';

export function pickerModel({ connectors = {}, providers = {}, plugins = {}, toolConnections = null, presence = null, now = Date.now(), agent = null } = {}) {
  // A connector the truth model calls connected is attachable (the
  // `connected` gate addAttachment enforces) but note-only on the turn;
  // anything else is simply not connected. Neither is ever 'connected'
  // as an attachment state — see the header. The row ALSO carries the
  // truth model's own status fields (status / statusText / source) the
  // Integrations surfaces render, so every surface tells the same story.
  const connectorItems = integrationsModel(connectors, providers, { toolConnections, presence, now }).map((p) => {
    const registered = p.connected === true;
    const state = registered ? ATTACH_STATE.NOTE_ONLY : ATTACH_STATE.NOT_CONNECTED;
    return {
      kind: 'connector', key: p.key, name: p.name, kindLabel: p.kind, connected: registered,
      status: p.status, statusText: p.statusText, source: p.source,
      state, stateLabel: ATTACH_STATE_LABEL[state],
    };
  });
  const pluginItems = (Array.isArray(plugins?.plugins) ? plugins.plugins : []).map((p) => ({
    kind: 'plugin',
    name: String(p?.name ?? '').trim().toLowerCase(),
    brings: String(p?.brings ?? ''),
    state: ATTACH_STATE.CONNECTED, stateLabel: ATTACH_STATE_LABEL[ATTACH_STATE.CONNECTED],
  })).filter((p) => p.name);
  const pluginsGroup = Object.freeze({
    id: 'plugins', title: 'Plugins', items: Object.freeze(pluginItems),
    note: 'Plugins live on your PC bridge. Attaching one gives the agent its approved tools for this turn.',
  });
  const uploadGroup = Object.freeze({ id: 'upload', title: 'Upload a file', fileInput: true, note: UPLOAD_NOTE, items: Object.freeze([]) });
  const webSearchGroup = Object.freeze({ id: 'web-search', title: 'Web search', toggle: true, note: WEB_SEARCH_NOTE, items: Object.freeze([]) });
  const eco = agentEcosystem(agent);
  if (!eco) {
    return Object.freeze({
      agent: null,
      groups: Object.freeze([
        Object.freeze({ id: 'skills', title: 'Skills', byName: true, items: Object.freeze([]), note: SKILLS_NOTE }),
        Object.freeze({ id: 'connectors', title: 'Connectors', note: CONNECTORS_NOTE, items: Object.freeze(connectorItems) }),
        pluginsGroup,
        uploadGroup,
        webSearchGroup,
      ]),
    });
  }
  // Per-agent: the agent's ecosystem leads. Its seat row is a STATUS row
  // (kind 'provider' — never an attachment; addAttachment accepts only
  // skill/connector/plugin/file), stating the one fact the integrations
  // registry holds about the seat itself. The seat's registry entry
  // leaves the shared connectors group — it is presented here, as the
  // seat, instead of masquerading there as one more note-only connector.
  const seatRow = connectorItems.find((i) => i.key === eco.registryKey);
  const seatState = seatRow?.connected ? ATTACH_STATE.CONNECTED : ATTACH_STATE.NOT_CONNECTED;
  const seatItem = Object.freeze({
    kind: 'provider', key: eco.registryKey, name: eco.name, kindLabel: 'This agent\'s seat', seat: true,
    connected: seatRow?.connected === true, state: seatState, stateLabel: ATTACH_STATE_LABEL[seatState],
  });
  const agentGroup = Object.freeze({
    id: 'agent', agent: eco.agent, title: `${eco.name}'s ecosystem`, byName: true,
    note: `${eco.name}'s skills live with the agent — command files and plugins on your PC bridge. Attach one by name and it runs as a /command at the start of your message.`,
    items: Object.freeze([seatItem, ...pluginItems]),
  });
  return Object.freeze({
    agent: eco.agent,
    groups: Object.freeze([
      agentGroup,
      Object.freeze({
        id: 'connectors', title: 'Connectors', note: CONNECTORS_NOTE,
        items: Object.freeze(connectorItems.filter((i) => i.key !== eco.registryKey)),
      }),
      pluginsGroup,
      uploadGroup,
      webSearchGroup,
    ]),
  });
}

export function attachmentKey(att) {
  if (!att || typeof att !== 'object') return null;
  if (att.kind === 'skill') return att.name ? `skill:${att.name}` : null;
  if (att.kind === 'connector') return att.key ? `connector:${att.key}` : null;
  if (att.kind === 'plugin') return att.name ? `plugin:${att.name}` : null;
  if (att.kind === 'file') return att.name ? `file:${att.name}:${att.size}` : null;
  return null;
}

// catalog: the connectors group's items from pickerModel() for a
// connector attachment, the plugins group's items for a plugin
// attachment. When given, the attachment must exist in that list — a
// connector must be registered and connected, a plugin must actually be
// installed on the PC bridge — the picker never attaches something the
// workspace does not actually have.
export function addAttachment(list = [], att, { catalog = null } = {}) {
  const fail = (reason) => ({ list, added: false, reason });
  if (!att || typeof att !== 'object') return fail('Nothing to attach.');
  let clean;
  if (att.kind === 'skill') {
    const n = normalizeSkillName(att.name);
    if (!n.ok) return fail(n.reason);
    clean = { kind: 'skill', name: n.name };
  } else if (att.kind === 'connector') {
    const key = String(att.key ?? '').trim().toLowerCase();
    if (!key) return fail('Pick a connector first.');
    if (catalog) {
      // Same-kind match only: a mixed catalog (the per-agent group holds
      // the seat row beside plugin rows) must never let one kind's entry
      // answer another kind's lookup.
      const item = catalog.find((i) => i.kind === 'connector' && i.key === key);
      if (!item) return fail('That connector is not in the registry.');
      if (!item.connected) return fail(`${item.name} is not connected yet — connect it in Integrations first.`);
      clean = { kind: 'connector', key: item.key, name: item.name };
    } else {
      clean = { kind: 'connector', key, name: String(att.name ?? key) };
    }
  } else if (att.kind === 'plugin') {
    // Plugin names are validated with the skill-name rules on purpose: the
    // server accepts exactly the same shape for a plugin attachment name
    // (ATTACHMENT_NAME_PATTERN in src/cloud/envoy-agents.mjs).
    const name = String(att.name ?? '').trim().toLowerCase();
    if (!name) return fail('Pick a plugin first.');
    if (name.length > SKILL_NAME_MAX || !SKILL_NAME_PATTERN.test(name)) return fail('That plugin name is not one a message can carry.');
    if (catalog) {
      const item = catalog.find((i) => i.kind === 'plugin' && i.name === name);
      if (!item) return fail('That plugin is not installed on your PC bridge.');
      clean = { kind: 'plugin', name: item.name };
    } else {
      clean = { kind: 'plugin', name };
    }
  } else if (att.kind === 'file') {
    const n = normalizeFileAttachment(att);
    if (!n.ok) return fail(n.reason);
    clean = n.attachment;
    const total = list.reduce((sum, a) => sum + (a.kind === 'file' ? a.size : 0), 0) + clean.size;
    if (total > FILE_TOTAL_MAX_BYTES) return fail('Those files together are too big — the limit is 512 KB of files per message.');
  } else {
    return fail('That kind of attachment is not supported yet.');
  }
  if (list.some((a) => attachmentKey(a) === attachmentKey(clean))) return { list, added: false, reason: 'Already attached.' };
  // parseSlashInput reads one leading command, so one skill can lead a
  // message; a second skill could not be carried honestly.
  if (clean.kind === 'skill' && list.some((a) => a.kind === 'skill')) return fail('Only one skill can lead a message. Remove the attached skill first.');
  // One plugin rides on a message: the turn resolves a single attached
  // plugin's tools, and a second would double the tool surface silently.
  if (clean.kind === 'plugin' && list.some((a) => a.kind === 'plugin')) return fail('Only one plugin can ride on a message. Remove the attached plugin first.');
  if (list.length >= MAX_ATTACHMENTS) return fail(`Up to ${MAX_ATTACHMENTS} attachments per message.`);
  return { list: [...list, clean], added: true, reason: null };
}

export function removeAttachment(list = [], att) {
  const key = attachmentKey(att);
  if (!key) return list;
  return list.filter((a) => attachmentKey(a) !== key);
}

// The structured metadata shape the server accepts, stores and hands to
// the turn (normalizeMessageMetadata in src/cloud/envoy-agents.mjs is the
// canonical validator). Plain JSON, frozen. The web-search toggle joins
// the same object as `webSearch` — carried only when ON (see the header).
export function attachmentMetadata(list = [], { webSearch = false } = {}) {
  if (!list.length && webSearch !== true) return null;
  return Object.freeze({
    ...(list.length ? {
      attachments: Object.freeze(list.map((a) => (a.kind === 'connector'
        ? Object.freeze({ kind: 'connector', key: a.key, name: a.name })
        : a.kind === 'file'
          ? Object.freeze({ kind: 'file', name: a.name, mediaType: a.mediaType, size: a.size, data: a.data })
          : Object.freeze({ kind: a.kind, name: a.name })))),
    } : {}),
    ...(webSearch === true ? { webSearch: true } : {}),
  });
}

// Mirrors parseSlashInput (src/agent/commands.mjs): the first token after a
// leading slash is the command name.
function leadingSlashName(body) {
  const text = String(body ?? '').trimStart();
  if (!text.startsWith('/')) return null;
  const m = /^\/([^\s]+)/.exec(text);
  return m ? m[1].toLowerCase() : null;
}

export function applySkillToBody(body, list = []) {
  const text = String(body ?? '');
  const skill = list.find((a) => a.kind === 'skill');
  if (!skill) return { body: text, skillCarried: false, note: null };
  const lead = leadingSlashName(text);
  if (lead === skill.name) return { body: text, skillCarried: true, note: null };
  if (lead) return { body: text, skillCarried: false, note: `Your message already starts with /${lead}, so the ${skill.name} skill rides as metadata only.` };
  return { body: `/${skill.name} ${text}`, skillCarried: true, note: null };
}

export function buildMessageRequest({ channelId, body, idempotencyKey, attachments = [], webSearch = false } = {}) {
  const applied = applySkillToBody(body, attachments);
  const metadata = attachmentMetadata(attachments, { webSearch });
  return Object.freeze({
    // The fields POST /api/admin/envoy/messages accepts: the original
    // three, plus `metadata` when something is attached or web search is
    // on. The route allowlists it, envoy-chat stores it, and the bridges
    // hand it to the turn, which consumes it (src/agent/attachments.mjs).
    payload: Object.freeze({ channelId, body: applied.body, idempotencyKey, ...(metadata ? { metadata } : {}) }),
    metadata,
    skillCarried: applied.skillCarried,
    note: applied.note,
  });
}
