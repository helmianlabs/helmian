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
//   charge              an ask to charge, refund, or take a payment
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
  'charge',
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
const CREDENTIAL_INTENT = /\b(show|reveal|tell|give|share|send|read|get|fetch|retrieve|print|stored|saved|resolve|post|look\s?up|what(?:'s| is| are))\b/i;

// A stored-secret ask that names no listed noun (AT-4 T11, items K3/K4):
// the ask points at what the vault holds by describing where it lives —
// what we saved for an account, the entry we keep, the vault card —
// rather than by naming a credential. The "what did we save for …"
// question carries its own retrieval intent (asking what is stored IS
// asking for it); the reference phrases pair with the intent list above.
const CREDENTIAL_STORED_ASK = [
  ['what we saved', /\bwhat (?:did|do) we (?:save|saved|store|stored|keep|kept)\b[^.;]{0,80}?\bfor\b/i],
  ['what is saved', /\bwhat(?:'s| is) (?:saved|stored|kept)\b[^.;]{0,80}?\bfor\b/i],
];
const CREDENTIAL_REFERENCE = /\b(vault cards?|the entry we (?:keep|kept|have))\b/i;

// A charge ask names the money act AND its object — a card, a payment,
// an invoice, a dollar amount. Either half alone stays chat: "the
// billing page is down" names no object, "the card on the table" names
// no act. The phrase verbs cover the indirect shapes ("take the payment
// from their saved card", "take it from the card they have on file")
// where the act is spread across the sentence (AT-4 T11, items C1–C4).
const CHARGE_VERB = /\b(charge|charges|charged|charging|refund|refunds|refunded|refunding|bill|bills|billed|billing|debit|debits|debited|debiting)\b/i;
const CHARGE_PHRASE = /\b(?:take|process|collect)\b[^.;]{0,60}?\b(?:payments?|cards?)\b/i;
const CHARGE_OBJECT = /\b(cards?|payments?|invoices?)\b|\$\s?\d/i;

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

// Destruction in indirect plain words (AT-4 T11, items D3/D4/D5/X1/X2):
// no delete verb at all, so the closed verb list walked around them.
// Each shape names the act the way a person phrases it — getting rid of,
// making gone, a thing that should not exist — and the two verb-shaped
// ones are held to a named object the way 'drop' is, so "empty the
// dishwasher" and "format the document" stay chat. These live here, in
// the classifier that owns plain words, not in the Site Guard kernel.
const DELETE_PHRASE = [
  ['get rid of', /\bget rid of\b/i],
  ['make gone', /\bmake\b[^.;]{0,80}?\bgone\b/i],
  ['should not exist', /\bshould(?:n['\u2019]t| not) exist\b/i],
  ['format', /\bformat\b[^.;]{0,60}?\b(drives?|disks?|volumes?|partitions?)\b/i],
  ['empty', /\bempty\b[^.;]{0,60}?\b(buckets?|folders?|director(?:y|ies)|drives?|disks?|volumes?|partitions?|databases?|tables?|caches?|trash|bins?|queues?)\b/i],
];

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
// password" is a credential resolve, not a send. The target set also
// names the shapes AT-4's corpus walked around (items S2/S5, AT-3b D3):
// a mass destination ("to everyone", the group chat), a mailbox named
// by its service (gmail), and an external email address — an address is
// a destination in its own right, and a send that names one is matched
// 'external' so the evaluation can see where it is going. A bare
// "send it" types too: the pronoun's payload is the thing just drafted,
// and the ask is a send even with no destination in the sentence. The
// hand-off phrasing ("get it over to their gmail") carries no listed
// verb, so it is matched as its own phrase against the same targets.
const SEND_VERB = /\b(send|post|publish|email|dm|text)\b/i;
const SEND_TARGET = /\b(messages?|emails?|notes?|posts?|updates?|replies)\b|\bto\s+(?:the\s+|a\s+)?(#[\w-]+|channels?|groups?|teams?|slack|discord|him|her|them|us|me)\b|\bon\s+(?:slack|discord)\b|\bto\s+everyone\b|\bgroup chat\b|\bgmail\b/i;
const SEND_EXTERNAL = /\b[\w.+-]+@[\w-]+\.[\w.]+\b/;
const SEND_PHRASE = /\b(?:get|pass|ship|forward)\b[^.;]{0,80}?\bover to\b/i;

/**
 * Classify one seat-directed ask. Returns a frozen `{ type, match }`:
 * `type` is one of SEAT_ACTION_TYPES and `match` names what fired (the
 * kernel pattern label, the credential noun, or the verb) so a later
 * evaluation and the panel can say why an ask was typed. Ordinary chat
 * returns CHAT_ACTION — the null action.
 *
 * Precedence is safety order, mirroring the kernel, which inspects shell
 * payloads for destruction before anything else runs: credential first,
 * then destructive (literal shapes before plain verbs), then charge,
 * then shell, then write, then send. An ask naming two classes is typed
 * as the one a Guard would need to see first.
 */
export function classifySeatAsk(text) {
  const body = String(text ?? '');
  if (!body.trim()) return CHAT_ACTION;

  const credential = body.match(CREDENTIAL_NOUN);
  if (credential && CREDENTIAL_INTENT.test(body)) {
    return typed('credential.resolve', credential[0].toLowerCase());
  }
  for (const [label, pattern] of CREDENTIAL_STORED_ASK) {
    if (pattern.test(body)) return typed('credential.resolve', label);
  }
  const reference = body.match(CREDENTIAL_REFERENCE);
  if (reference && CREDENTIAL_INTENT.test(body)) {
    return typed('credential.resolve', reference[0].toLowerCase());
  }

  for (const [label, pattern] of DESTRUCTIVE_LITERAL) {
    if (pattern.test(body)) return typed('file.delete', label);
  }
  const deletion = body.match(DELETE_VERB);
  if (deletion) return typed('file.delete', deletion[0].toLowerCase());
  for (const [label, pattern] of DELETE_PHRASE) {
    if (pattern.test(body)) return typed('file.delete', label);
  }
  if (DROP_WITH_OBJECT.test(body)) return typed('file.delete', 'drop');

  const charge = body.match(CHARGE_VERB) ?? body.match(CHARGE_PHRASE);
  if (charge && CHARGE_OBJECT.test(body)) {
    return typed('charge', charge[0].toLowerCase());
  }

  if (SHELL_INVOKE.test(body)) return typed('shell', 'shell invoke');
  if (SHELL_RUN.test(body)) return typed('shell', 'run');
  if (SHELL_PLACE.test(body)) return typed('shell', 'terminal');
  if (SHELL_BARE.test(body)) return typed('shell', 'bare command');

  const write = body.match(WRITE_VERB);
  if (write && (WRITE_ARTIFACT.test(body) || WRITE_FILENAME.test(body))) {
    return typed('file.write', write[0].toLowerCase());
  }

  const send = body.match(SEND_VERB);
  if (send && SEND_EXTERNAL.test(body)) return typed('send', 'external');
  if (send && SEND_TARGET.test(body)) return typed('send', send[0].toLowerCase());
  if (/\bsend (?:it|that|this)\b/i.test(body)) return typed('send', 'send it');
  const handOff = body.match(SEND_PHRASE);
  if (handOff && (SEND_TARGET.test(body) || SEND_EXTERNAL.test(body))) {
    return typed('send', handOff[0].toLowerCase());
  }

  return CHAT_ACTION;
}

// --- Split asks: the thread tail (FIX-A8, AT-4 T11 finding 3) --------
//
// The classifier's classes are two-half shapes — an act and its object
// — and the road classifies one message at a time, so an ask split
// across two or three short messages from the same person reached a
// seat as ordinary chat even when its combined meaning was plainly a
// gated ask: the setup names the target ("The spare drive is just
// sitting in the rack."), the follow-up carries only the act
// ("Format it and reimage it."), or the reverse. Neither fragment
// types alone — each carries one half of a two-half class — and
// together they are the ask.
//
// The halves below are the classifier's own patterns, named
// separately so a fragment can be recognised as a fragment. An act
// half is a gated act with no object in the message; a target half is
// an object or destination with no act. The delete verbs are absent
// from the act halves — a bare delete verb types on its own — except
// the three object-held ones ('drop', 'format', 'empty'), whose verb
// alone is exactly a fragment. The delete target list is the union of
// the objects those three verbs and 'drop' are held to above.
const ACT_HALVES = [
  ['credential intent', CREDENTIAL_INTENT],
  ['charge act', CHARGE_VERB],
  ['write act', WRITE_VERB],
  ['send act', SEND_VERB],
  ['send act', SEND_PHRASE],
  ['delete act', /\b(?:drop|format|empty)\b/i],
];
const DELETE_OBJECT = /\b(?:files?|folders?|director(?:y|ies)|projects?|tables?|databases?|schemas?|repos?|repository|branch(?:es)?|collections?|drives?|disks?|volumes?|partitions?|buckets?|caches?|trash|bins?|queues?)\b/i;
const TARGET_HALVES = [
  ['credential target', CREDENTIAL_NOUN],
  ['credential target', CREDENTIAL_REFERENCE],
  ['charge target', CHARGE_OBJECT],
  ['write target', WRITE_ARTIFACT],
  ['write target', WRITE_FILENAME],
  ['send target', SEND_TARGET],
  ['send target', SEND_EXTERNAL],
  ['delete target', DELETE_OBJECT],
];

/**
 * The fragment halves one message carries: `{ act, target }`, each
 * the label of the first matching half or null, or null when the
 * message carries neither. A message that types on its own can carry
 * halves too — the halves matter only for a message that stays chat,
 * where they say the message may be one half of a split ask.
 */
export function seatAskFragment(text) {
  const body = String(text ?? '');
  if (!body.trim()) return null;
  let act = null;
  for (const [label, pattern] of ACT_HALVES) {
    if (pattern.test(body)) { act = label; break; }
  }
  let target = null;
  for (const [label, pattern] of TARGET_HALVES) {
    if (pattern.test(body)) { target = label; break; }
  }
  if (!act && !target) return null;
  return Object.freeze({ act, target });
}

// How many of the author's own immediately preceding messages the
// combined classification may reach back over. Every split in the
// audit corpus is two or three messages; two back covers a
// three-message ask, and each further message of reach multiplies
// the chance that two unrelated halves meet. The mesh supplies the
// tail from the window its poll already read (the channel's recent
// messages), so the reach is bounded in time by that window as well.
export const SEAT_ASK_TAIL_LIMIT = 2;

/**
 * Classify one seat-directed ask with its thread tail: the author's
 * own immediately preceding messages in the same channel, oldest
 * first, as bodies. Returns `{ action, body, threaded }` — the
 * action to stamp, the body the evaluation should judge, and whether
 * the combined reading fired.
 *
 * A message that types on its own is classified exactly as
 * classifySeatAsk classifies it (threaded: false, its own body) —
 * the tail is never consulted, so every previously typed ask keeps
 * its typing and posture untouched. The tail is consulted only when
 * the message stays chat AND carries an act-shaped or target-shaped
 * fragment. The combined reading then joins the tail window to the
 * message and classifies the whole, under three bounds:
 *
 *   - the window is the author's last SEAT_ASK_TAIL_LIMIT messages,
 *     walking back from the newest, and it stops before any message
 *     that types on its own — a complete ask closes the window, so
 *     halves older than a finished ask belong to that ask;
 *   - the current message must be necessary: if the tail window
 *     alone already types the combined class, that ask was complete
 *     before this message arrived (and was evaluated at its own
 *     dispatch), so this message stays chat;
 *   - the evaluation body is the joined text, so the gate judges
 *     the whole ask — a target named in the tail (an outside
 *     address, a mass audience) postures exactly as it would had
 *     the ask arrived in one message.
 */
export function classifySeatAskThread(text, tailTexts = []) {
  const body = String(text ?? '');
  const own = classifySeatAsk(body);
  if (own.type !== 'chat') return Object.freeze({ action: own, body, threaded: false });
  if (!seatAskFragment(body)) return Object.freeze({ action: own, body, threaded: false });
  const tail = [];
  for (let i = tailTexts.length - 1; i >= 0 && tail.length < SEAT_ASK_TAIL_LIMIT; i -= 1) {
    const prior = String(tailTexts[i] ?? '');
    if (!prior.trim()) continue;
    if (classifySeatAsk(prior).type !== 'chat') break;
    tail.unshift(prior);
  }
  if (!tail.length) return Object.freeze({ action: own, body, threaded: false });
  const joined = [...tail, body].join('\n');
  const combined = classifySeatAsk(joined);
  if (combined.type === 'chat') return Object.freeze({ action: own, body, threaded: false });
  if (classifySeatAsk(tail.join('\n')).type === combined.type) {
    return Object.freeze({ action: own, body, threaded: false });
  }
  return Object.freeze({ action: combined, body: joined, threaded: true });
}
