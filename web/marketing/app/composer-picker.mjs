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
// - Upload: the app has no file-upload path (no endpoint, no form), so the
//   group is present but unavailable, with the reason stated.
//
// HOW AN ATTACHMENT TRAVELS: buildMessageRequest() returns the wire payload
// plus structured metadata. The payload stays inside the message route's
// exact field set ({ body, channelId, idempotencyKey } —
// src/cloud/live-admin.mjs rejects anything else today), so:
// - a skill rides IN the body as the leading /name (consumed for real by
//   the bridge today);
// - connectors ride as metadata only — the client builds it, nothing on the
//   server reads it yet. Agent-side consumption (accept + persist the
//   metadata field, hand it to the turn) is the next bite. Nothing here
//   pretends a connector changed the turn.
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

export function pickerModel({ connectors = {}, providers = {} } = {}) {
  const connectorItems = integrationsModel(connectors, providers).map((p) => ({
    kind: 'connector', key: p.key, name: p.name, kindLabel: p.kind, connected: p.connected === true,
  }));
  return Object.freeze({
    groups: Object.freeze([
      Object.freeze({
        id: 'skills', title: 'Skills', byName: true, items: Object.freeze([]),
        note: 'Skills live with your agents — command files and plugins on your PC bridge. Attach one by name and it runs as a /command at the start of your message.',
      }),
      Object.freeze({ id: 'connectors', title: 'Connectors', items: Object.freeze(connectorItems) }),
      Object.freeze({ id: 'upload', title: 'Upload a file', available: false, reason: UPLOAD_UNAVAILABLE_REASON, items: Object.freeze([]) }),
    ]),
  });
}

export function attachmentKey(att) {
  if (!att || typeof att !== 'object') return null;
  if (att.kind === 'skill') return att.name ? `skill:${att.name}` : null;
  if (att.kind === 'connector') return att.key ? `connector:${att.key}` : null;
  return null;
}

// catalog: the connectors group's items from pickerModel(). When given, a
// connector attachment must exist in the registry and be connected — the
// picker never attaches a connector the workspace does not actually have.
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
  } else {
    return fail('That kind of attachment is not supported yet.');
  }
  if (list.some((a) => attachmentKey(a) === attachmentKey(clean))) return { list, added: false, reason: 'Already attached.' };
  // parseSlashInput reads one leading command, so one skill can lead a
  // message; a second skill could not be carried honestly.
  if (clean.kind === 'skill' && list.some((a) => a.kind === 'skill')) return fail('Only one skill can lead a message. Remove the attached skill first.');
  if (list.length >= MAX_ATTACHMENTS) return fail(`Up to ${MAX_ATTACHMENTS} attachments per message.`);
  return { list: [...list, clean], added: true, reason: null };
}

export function removeAttachment(list = [], att) {
  const key = attachmentKey(att);
  if (!key) return list;
  return list.filter((a) => attachmentKey(a) !== key);
}

// The structured metadata shape the next bite teaches the server to accept
// and the turn to consume. Plain JSON, frozen.
export function attachmentMetadata(list = []) {
  if (!list.length) return null;
  return Object.freeze({
    attachments: Object.freeze(list.map((a) => (a.kind === 'skill'
      ? Object.freeze({ kind: 'skill', name: a.name })
      : Object.freeze({ kind: 'connector', key: a.key, name: a.name })))),
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
  return Object.freeze({
    // Exactly the fields POST /api/admin/envoy/messages accepts today.
    payload: Object.freeze({ channelId, body: applied.body, idempotencyKey }),
    // Structured metadata for the next bite (server accept + turn
    // consumption). Not sent on the wire today: the route rejects
    // unexpected fields.
    metadata: attachmentMetadata(attachments),
    skillCarried: applied.skillCarried,
    note: applied.note,
  });
}
