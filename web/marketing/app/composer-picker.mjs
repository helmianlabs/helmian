// Composer "+" picker: attach a skill, a connector, or (once it exists) a
// file to the message you are about to send. Pure model — no DOM — so it is
// unit tested like app-model.mjs; envoy-workspace.js renders it.
//
// WHERE THE GROUPS COME FROM (real registries only; nothing invented):
// - Connectors: PROVIDER_REGISTRY in app-model.mjs, with live connected
//   state from GET /api/admin/cora/connectors + GET
//   /api/admin/provider-connections merged by integrationsModel() — the
//   exact lists the Integrations page renders. A connector can be attached
//   only when that registry says it is connected.
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
// - Upload: the app has no file-upload path (no endpoint, no form), so the
//   group is present but unavailable, with the reason stated.
//
// HOW AN ATTACHMENT TRAVELS: buildMessageRequest() returns the wire payload
// plus structured metadata. The message route allowlists `metadata`
// alongside { body, channelId, idempotencyKey }, envoy-chat stores it on
// the message (sql/060), and the bridges hand it to the turn:
// - a skill rides IN the body as the leading /name (expanded by the
//   bridge) AND in the metadata;
// - connectors and plugins ride as metadata, consumed agent-side by
//   src/agent/attachments.mjs (plugins contribute real MCP tools;
//   connectors are context-only today and the turn is told so).
import { integrationsModel } from './app-model.mjs';

export const MAX_ATTACHMENTS = 8;
export const SKILL_NAME_MAX = 64;
// Command names are file names in the commands registry; plugin skills are
// namespaced "plugin:skill" (src/agent/plugins.mjs). One segment, or one
// namespace segment + one name segment.
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*(:[a-z0-9][a-z0-9_-]*)?$/;
export const UPLOAD_UNAVAILABLE_REASON = 'File upload is not wired into chat yet.';

export function normalizeSkillName(value) {
  const name = String(value ?? '').trim().replace(/^\//, '').toLowerCase();
  if (!name) return { ok: false, name: null, reason: 'Type a skill name first.' };
  if (name.length > SKILL_NAME_MAX) return { ok: false, name: null, reason: 'That skill name is too long.' };
  if (!SKILL_NAME_PATTERN.test(name)) return { ok: false, name: null, reason: 'Skill names use letters, numbers and dashes — plugin skills look like plugin:skill.' };
  return { ok: true, name, reason: null };
}

export function pickerModel({ connectors = {}, providers = {}, plugins = {} } = {}) {
  const connectorItems = integrationsModel(connectors, providers).map((p) => ({
    kind: 'connector', key: p.key, name: p.name, kindLabel: p.kind, connected: p.connected === true,
  }));
  const pluginItems = (Array.isArray(plugins?.plugins) ? plugins.plugins : []).map((p) => ({
    kind: 'plugin',
    name: String(p?.name ?? '').trim().toLowerCase(),
    brings: String(p?.brings ?? ''),
  })).filter((p) => p.name);
  return Object.freeze({
    groups: Object.freeze([
      Object.freeze({
        id: 'skills', title: 'Skills', byName: true, items: Object.freeze([]),
        note: 'Skills live with your agents — command files and plugins on your PC bridge. Attach one by name and it runs as a /command at the start of your message.',
      }),
      Object.freeze({ id: 'connectors', title: 'Connectors', items: Object.freeze(connectorItems) }),
      Object.freeze({
        id: 'plugins', title: 'Plugins', items: Object.freeze(pluginItems),
        note: 'Plugins live on your PC bridge. Attaching one gives the agent its approved tools for this turn.',
      }),
      Object.freeze({ id: 'upload', title: 'Upload a file', available: false, reason: UPLOAD_UNAVAILABLE_REASON, items: Object.freeze([]) }),
    ]),
  });
}

export function attachmentKey(att) {
  if (!att || typeof att !== 'object') return null;
  if (att.kind === 'skill') return att.name ? `skill:${att.name}` : null;
  if (att.kind === 'connector') return att.key ? `connector:${att.key}` : null;
  if (att.kind === 'plugin') return att.name ? `plugin:${att.name}` : null;
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
      const item = catalog.find((i) => i.key === key);
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
      const item = catalog.find((i) => i.name === name);
      if (!item) return fail('That plugin is not installed on your PC bridge.');
      clean = { kind: 'plugin', name: item.name };
    } else {
      clean = { kind: 'plugin', name };
    }
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
// canonical validator). Plain JSON, frozen.
export function attachmentMetadata(list = []) {
  if (!list.length) return null;
  return Object.freeze({
    attachments: Object.freeze(list.map((a) => (a.kind === 'connector'
      ? Object.freeze({ kind: 'connector', key: a.key, name: a.name })
      : Object.freeze({ kind: a.kind, name: a.name })))),
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

export function buildMessageRequest({ channelId, body, idempotencyKey, attachments = [] } = {}) {
  const applied = applySkillToBody(body, attachments);
  const metadata = attachmentMetadata(attachments);
  return Object.freeze({
    // The fields POST /api/admin/envoy/messages accepts: the original
    // three, plus `metadata` when something is attached. The route
    // allowlists it, envoy-chat stores it, and the bridges hand it to
    // the turn, which consumes it (src/agent/attachments.mjs).
    payload: Object.freeze({ channelId, body: applied.body, idempotencyKey, ...(metadata ? { metadata } : {}) }),
    metadata,
    skillCarried: applied.skillCarried,
    note: applied.note,
  });
}
