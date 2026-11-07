// Envoy seat-ask classification: what a channel message IS, as an action,
// before any executor sees it (Guard spine, bite 1 — GUARD-TRACE-2026-11-06).
//
// The desktop Guard worked because every action passed one evaluation gate
// before it ran. The cloud stored channel text and routed it by mention:
// nothing classified an ask as an action, so nothing was ever evaluated
// (finding G1). This module is the missing first step only — it turns a
// seat-directed message into a typed action that rides along on the work
// item the mesh hands an executor (envoy-mesh.mjs agentWork). It evaluates
// nothing, blocks nothing, and records nothing; evaluation and findings
// are the next bites. Dispatch behavior is unchanged by its presence.
//
// The vocabulary mirrors the governance kernel's action classes
// (src/core/governance.mjs destructive patterns, the gate's mutating tool
// names in src/core/governance-gate.mjs) and the cloud's own gated surface
// (the credential vault's Guard-gated resolve):
//   credential.resolve  an ask naming a stored credential and wanting it
//   file.delete         a destructive ask (kernel-shaped or plain verb)
//   file.write          an ask to create or change a file or page
//   send                an ask to send a message or email onward
//   shell               an ask to run a command
//   chat                the null action: ordinary conversation
//
// Conservative by construction: an ask is typed only when it names a gated
// class; everything else stays chat. Over-typing is the safe direction
// here because a later bite evaluates the typed payload — under-typing is
// the hole this spine exists to close.

export const SEAT_ACTION_TYPES = Object.freeze([
  'credential.resolve',
  'file.delete',
  'file.write',
  'send',
  'shell',
  'chat',
]);

// The null action, shared and frozen: ordinary chat.
export const CHAT_ACTION = Object.freeze({ type: 'chat', match: null });

const typed = (type, match) => Object.freeze({ type, match });

// A credential ask names the credential AND wants something done with it —
// shown, sent, looked up. A password merely mentioned in passing ("I
// changed my password yesterday") names no gated class and stays chat.
const CREDENTIAL_NOUN = /\b(passwords?|passphrases?|passcodes?|api[ -]?keys?|access[ -]tokens?|refresh[ -]tokens?|secret[ -]keys?|secrets?|credentials?|private[ -]keys?|recovery[ -]codes?)\b/i;
const CREDENTIAL_INTENT = /\b(show|reveal|tell|give|share|send|read|get|fetch|retrieve|print|stored|saved|look\s?up|what(?:'s| is| are))\b/i;

// Destruction in literal command shape. A deliberate subset of the
// kernel's DESTRUCTIVE_PATTERNS (src/core/governance.mjs), labels carried
// over unchanged so a later evaluation can name the same pattern the
// desktop gate names. The git spans keep the kernel's 200-char bounds.
const DESTRUCTIVE_LITERAL = [
  ['recursive/forced rm', /(?:^|[;&|`(\s])rm\s+[^;&|]*(?:-[A-Za-z]*[rRf][A-Za-z]*|--(?:recursive|force|dir))\b/i],
  ['rm of a glob', /(?:^|[;&|`(\s])rm\s+[^;&|]*\*/i],
  ['Remove-Item -Recurse/-Force', /\bRemove-Item\b[^;&|]*\s-(?:Rec|Forc)[a-z]*\b/i],
  ['rmdir /S', /\b(?:rmdir|rd)\b[^;&|]*\s\/s\b/i],
  ['cmd del /F, /Q, or /S', /(?:^|[;&|`(\s])del\s+[^;&|]*\/[fqs]\b/i],
  ['git reset discard', /\bgit\b[^;&|]{0,200}\breset\b[^;&|]{0,200}--(?:hard|merge|keep)\b/i],
  ['git clean', /\bgit\b[^;&|]{0,200}\bclean\b[^;&|]{0,200}\s-[A-Za-z]*[fdx]/i],
  ['git force push', /\bgit\b[^;&|]{0,200}\bpush\b[^;&|]{0,200}(?:--force(?:-with-lease)?|\s-f\b)/i],
  ['git branch force delete', /\bgit\b[^;&|]{0,200}\bbranch\b[^;&|]{0,200}\s-D\b/i],
  ['git checkout/restore discard', /\bgit\b[^;&|]{0,200}\b(?:checkout|restore)\b[^;&|]{0,200}\s--\s/i],
  ['git worktree remove', /\bgit\b[^;&|]{0,200}\bworktree\b[^;&|]{0,200}\bremove\b/i],
  ['Clear-Content', /\bClear-Content\b/i],
  ['direct SQL DDL', /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i],
  ['dd device write', /\bdd\b[^;&|]*\bof=/i],
  ['filesystem format', /\bmkfs(?:\.|\s)/i],
  ['Python recursive tree delete', /\bshutil\s*\.\s*rmtree\s*\(/i],
  ['Python file or directory delete', /\bos\s*\.\s*(?:remove|unlink|rmdir|removedirs)\s*\(/i],
  ['.NET directory delete', /\bDirectory\s*\.\s*Delete\s*\(/i],
  ['File.delete call', /\bFile\s*\.\s*delete\s*\(/i],
  ['Ruby forced recursive rm', /\bFileUtils\s*\.\s*rm_(?:rf|r|f)\b/i],
  ['Node filesystem delete', /\bfs(?:\s*\.\s*promises)?\s*\.\s*(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(/i],
];

// Destruction in plain words. 'drop' is held to a stricter shape than the
// others: it types only with a destructible object named, so "drop me a
// line" stays chat while "drop the old table" does not.
const DELETE_VERB = /\b(delete|remove|erase|wipe|destroy|shred)\b/i;
const DROP_WITH_OBJECT = /\bdrop\b[^.;]{0,60}?\b(files?|folders?|director(?:y|ies)|projects?|tables?|databases?|schemas?|repos?|repository|branch(?:es)?|collections?)\b/i;

// A command ask: a run/execute verb aimed at a command-shaped object, a
// shell invoked with a payload flag, a terminal named as the place, or a
// message that simply IS a bare command line.
const SHELL_RUN = /\b(run|execute|exec)\b[^.;]{0,80}?\b(commands?|scripts?|shell|terminal|powershell|bash|npm|node|git|tests?|build)\b/i;
const SHELL_INVOKE = /\b(?:powershell|pwsh|bash|zsh|sh|cmd)\s+(?:-c|\/c)\b/i;
const SHELL_PLACE = /\bin (?:the|a) (?:terminal|shell|command (?:line|prompt))\b/i;
const SHELL_BARE = /^\s*(?:npm|pnpm|yarn|node|git)\s+\S+/m;

// A write ask needs both halves: a making verb and a made thing — a file,
// a page, a document, or a named file with its extension. "Make the
// change" names neither half well enough and stays chat.
const WRITE_VERB = /\b(create|write|edit|update|modify|save|generate|build|make|add|rebuild|redesign)\b/i;
const WRITE_ARTIFACT = /\b(files?|landing pages?|web ?pages?|pages?|documents?|docs?|scripts?|code|components?|stylesheets?|readme)\b/i;
const WRITE_FILENAME = /\b[\w][\w.-]*\.(?:html?|mjs|cjs|js|ts|tsx|jsx|css|md|json|py|txt|sql)\b/i;

// A send ask: an outward verb with a message-shaped payload or a named
// destination. Credential asks outrank it (checked first): "send me the
// password" is a credential resolve, not a send.
const SEND_VERB = /\b(send|post|publish|email|dm|text)\b/i;
const SEND_TARGET = /\b(messages?|emails?|notes?|posts?|updates?|replies)\b|\bto\s+(?:the\s+|a\s+)?(#[\w-]+|channels?|groups?|teams?|slack|discord|him|her|them|us|me)\b|\bon\s+(?:slack|discord)\b/i;

/**
 * Classify one seat-directed ask. Returns a frozen `{ type, match }`:
 * `type` is one of SEAT_ACTION_TYPES and `match` names what fired (the
 * kernel pattern label, the credential noun, or the verb) so a later
 * evaluation and the panel can say why an ask was typed. Ordinary chat
 * returns CHAT_ACTION — the null action.
 *
 * Precedence is safety order, mirroring the kernel, which inspects shell
 * payloads for destruction before anything else runs: credential first,
 * then destructive (literal shapes before plain verbs), then shell, then
 * write, then send. An ask naming two classes is typed as the one a Guard
 * would need to see first.
 */
export function classifySeatAsk(text) {
  const body = String(text ?? '');
  if (!body.trim()) return CHAT_ACTION;

  const credential = body.match(CREDENTIAL_NOUN);
  if (credential && CREDENTIAL_INTENT.test(body)) {
    return typed('credential.resolve', credential[0].toLowerCase());
  }

  for (const [label, pattern] of DESTRUCTIVE_LITERAL) {
    if (pattern.test(body)) return typed('file.delete', label);
  }
  const deletion = body.match(DELETE_VERB);
  if (deletion) return typed('file.delete', deletion[0].toLowerCase());
  if (DROP_WITH_OBJECT.test(body)) return typed('file.delete', 'drop');

  if (SHELL_INVOKE.test(body)) return typed('shell', 'shell invoke');
  if (SHELL_RUN.test(body)) return typed('shell', 'run');
  if (SHELL_PLACE.test(body)) return typed('shell', 'terminal');
  if (SHELL_BARE.test(body)) return typed('shell', 'bare command');

  const write = body.match(WRITE_VERB);
  if (write && (WRITE_ARTIFACT.test(body) || WRITE_FILENAME.test(body))) {
    return typed('file.write', write[0].toLowerCase());
  }

  const send = body.match(SEND_VERB);
  if (send && SEND_TARGET.test(body)) return typed('send', send[0].toLowerCase());

  return CHAT_ACTION;
}
