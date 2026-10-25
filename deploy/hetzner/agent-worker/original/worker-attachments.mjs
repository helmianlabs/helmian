// worker-attachments.mjs — composer "+" attachment brain for the cloud
// agent worker (companion module to agent-worker.mjs).
//
// The PC bridge resolves message attachments per turn in
// src/agent/attachments.mjs (resolveTurnAttachments): plugin MCP tools are
// REAL there because the bridge runs a tool-calling loop. This worker's
// runners are CLI/subprocess turns (Gemini CLI in a visible terminal or
// headless, Grok via run-grok.mjs) — there is no tool runtime here, so this
// module ports the CONTEXT half faithfully and says so:
//
// - connector → the bridge's exact context line (context only, "do not
//               claim you used it"). Wording replicated verbatim.
// - webSearch → the bridge's exact lines (ON = requested-but-unavailable
//               honesty, OFF = answer without web sources).
// - plugin    → named as attached, with what it WOULD bring in a bridge
//               turn (its approved MCP tools) and the plain fact that this
//               runner cannot connect them. Never the bridge's "connected
//               for this turn" line — that would be false here.
// - skill     → if the body leads with /name and the real command registry
//               (src/agent/commands.mjs, the same module the bridge uses)
//               resolves it against the job workspace, the body lead is
//               EXPANDED exactly like the bridge (parseSlashInput →
//               resolveCommand → expandCommand) and the bridge's skill
//               line is used. If it does not resolve, the line says the
//               command was NOT expanded — no fake expansion.
//
// Metadata arrives on the job itself: the cloud's agent-work payload
// (src/cloud/envoy-mesh.mjs agentWork → messageOut) already carries
// message.metadata since PR #97 (MSG_COLS selects the sql/060 column).

// ---- metadata normalization: replicated from src/cloud/envoy-agents.mjs ----
const ATTACHMENT_KINDS = Object.freeze(['skill', 'connector', 'plugin']);
const MAX_MESSAGE_ATTACHMENTS = 8;
const ATTACHMENT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ATTACHMENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*(:[a-z0-9][a-z0-9_-]*)?$/;

function attachmentField(value, name, pattern) {
  const field = String(value ?? '').trim().toLowerCase();
  if (!pattern.test(field)) throw new Error(`${name} is invalid`);
  return field;
}

function normalizeAttachment(input) {
  const kind = String(input?.kind ?? '').trim().toLowerCase();
  if (!ATTACHMENT_KINDS.includes(kind)) throw new Error('attachment kind is unsupported');
  if (kind === 'connector') {
    return Object.freeze({
      kind,
      key: attachmentField(input.key, 'attachment connector key', ATTACHMENT_KEY_PATTERN),
      ...(input.name ? { name: String(input.name).trim().slice(0, 120) } : {}),
    });
  }
  return Object.freeze({
    kind,
    name: attachmentField(input.name, 'attachment name', ATTACHMENT_NAME_PATTERN),
  });
}

function normalizeMessageMetadata(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('message metadata is invalid');
  const raw = input.attachments ?? [];
  if (!Array.isArray(raw)) throw new Error('message attachments are invalid');
  if (raw.length > MAX_MESSAGE_ATTACHMENTS) throw new Error('too many attachments');
  const seen = new Set();
  const attachments = raw.map((item) => {
    const clean = normalizeAttachment(item);
    const id = clean.kind === 'connector' ? `connector:${clean.key}` : `${clean.kind}:${clean.name}`;
    if (seen.has(id)) throw new Error('attachment is duplicated');
    seen.add(id);
    return clean;
  });
  const webSearch = input.webSearch === undefined ? undefined : input.webSearch === true;
  if (!attachments.length && webSearch === undefined) return null;
  return Object.freeze({
    ...(attachments.length ? { attachments: Object.freeze(attachments) } : {}),
    ...(webSearch !== undefined ? { webSearch } : {}),
  });
}
// ---- end replication ----

// Tolerant wrapper: metadata that fails normalization is dropped (and the
// drop is reported) — a malformed attachment must never kill a channel job.
export function safeNormalizeMetadata(input) {
  if (input === undefined || input === null) return { metadata: null, dropped: false };
  try {
    return { metadata: normalizeMessageMetadata(input), dropped: false };
  } catch {
    return { metadata: null, dropped: true };
  }
}

// The bridge loads its command registry from the repo tree; on this box the
// union snapshot carries the same module. Overridable by env for tests.
const DEFAULT_COMMANDS_MODULE = '/opt/helmian-cloud-agents/src/app/src/agent/commands.mjs';
let commandsModulePromise = null;
function loadCommandsModule() {
  if (!commandsModulePromise) {
    const path = process.env.HELMION_COMMANDS_MODULE || DEFAULT_COMMANDS_MODULE;
    commandsModulePromise = import(path).catch(() => null);
  }
  return commandsModulePromise;
}

/**
 * Expand a leading "/name args" body lead exactly like the bridge does
 * (parseSlashInput → resolveCommand → expandCommand against a registry
 * discovered from the job workspace). Returns { name, text } or null when
 * the body is not a slash lead, the module is unreachable, or no command
 * resolves — null means "pass the body through untouched", never a guess.
 */
export async function expandLeadingSlash(body, { workspace, commandsModule } = {}) {
  const mod = commandsModule ?? (await loadCommandsModule());
  if (!mod) return null;
  const parsed = mod.parseSlashInput(String(body ?? ''));
  if (!parsed) return null;
  let registry;
  try {
    registry = await mod.discoverCommands({ workspace, builtins: [], plugins: [] });
  } catch {
    return null;
  }
  const cmd = mod.resolveCommand(registry, parsed.name);
  if (!cmd) return null;
  return {
    name: cmd.name,
    text: mod.expandCommand(cmd.body, parsed.rawArgs, { argumentNames: cmd.argumentNames }),
  };
}

/**
 * Build the attachment context block for a turn. Same wrapper and, where
 * the bridge's claim is true here too, the same lines as
 * src/agent/attachments.mjs; plugin/skill lines are the honest runner
 * variants described in the header. Returns null when there is nothing
 * to say.
 */
export function attachmentContextText(metadata, { expandedSkill = null } = {}) {
  if (!metadata) return null;
  const lines = [];
  for (const attachment of metadata.attachments ?? []) {
    if (attachment.kind === 'skill') {
      if (expandedSkill && String(expandedSkill).toLowerCase() === attachment.name) {
        lines.push(`Skill attached: /${attachment.name}. If the message begins with that command it has already been expanded into the command's instructions for this turn.`);
      } else {
        lines.push(`Skill attached: /${attachment.name}. This channel runner could not expand the command for this turn (no matching command file in the agent workspace), so no skill instructions were loaded. Treat the skill name as context only and do not claim you ran it.`);
      }
      continue;
    }
    if (attachment.kind === 'connector') {
      const label = attachment.name ?? attachment.key;
      lines.push(`Connector attached: ${label} (${attachment.key}). It is connected in this workspace, but Helmian has NO agent-side callable tool for this connector today: you cannot call it in this turn. Treat it as context only and do not claim you used it.`);
      continue;
    }
    if (attachment.kind === 'plugin') {
      lines.push(`Plugin attached: ${attachment.name}. In a Helmian bridge turn, this plugin's approved MCP servers would be connected and their tools callable for the turn. This channel runner is a CLI/subprocess turn and cannot connect plugin tools, so NONE of its tools are available in this turn. Treat it as context only and do not claim you used it.`);
      continue;
    }
  }
  if (metadata.webSearch !== undefined) {
    lines.push(metadata.webSearch
      ? 'Web search: the user turned it ON for this message, but Helmian has no web-search tool today — you cannot search the web in this turn. Say so plainly if the answer needs current web information.'
      : 'Web search: OFF for this turn — answer without web sources.');
  }
  return lines.length ? `[Attached to this message — Helmian composer "+"]\n${lines.join('\n')}\n[/Attached]` : null;
}

/**
 * Prepare a claimed job's message for prompt assembly: expand a leading
 * slash command in the body (bridge semantics), then prepend the
 * attachment context block to the body — the same position the bridge
 * puts it (context first, then the turn text).
 */
export async function prepareJobMessage(message, { workspace, commandsModule } = {}) {
  const rawBody = String(message?.body ?? '');
  const { metadata, dropped } = safeNormalizeMetadata(message?.metadata);
  let body = rawBody;
  let expandedName = null;
  const expansion = await expandLeadingSlash(rawBody, { workspace, commandsModule });
  if (expansion) {
    body = expansion.text;
    expandedName = expansion.name;
  }
  const contextText = metadata ? attachmentContextText(metadata, { expandedSkill: expandedName }) : null;
  return {
    body: contextText ? `${contextText}\n\n${body}` : body,
    contextText,
    expandedName,
    attachmentKinds: (metadata?.attachments ?? []).map((a) => a.kind),
    webSearch: metadata?.webSearch,
    metadataDropped: dropped,
  };
}
