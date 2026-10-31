// Shared between the hands MCP server (Hetzner) and the PC spoke (Troy's PC).
// No dependencies, no I/O. Both sides import THIS file so the tool catalog,
// argument validation, the Guard action shape and decision verification can
// never drift between the hub and the PC that actually executes.
//
// Executive Guard contract: executive-guard/ (PR #53). Canonical JSON and the
// decision envelope ({ payload, signature, keyId }, Ed25519 over the payload
// string, aud 'helmian-executive-guard-decision-v1') mirror that server byte
// for byte.

import { createHash, createPublicKey, verify } from 'node:crypto';

export const DECISION_AUDIENCE = 'helmian-executive-guard-decision-v1';
export const ROOT_GRANT_AUDIENCE = 'helmian-executive-guard-root-grant-v1';
export const GUARD_ACTION_SITE = 'hands.helmian';
export const MAX_OUTPUT_BYTES = 64 * 1024;

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite numbers are not allowed');
    if (value === undefined) return 'null';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export const sha256Hex = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');

// ─── Tool catalog ────────────────────────────────────────────────────────────
// mutating: true  => needs scope hands.act AND a human-approved, signed Guard
//                    decision bound to these exact arguments. No Guard, no run.
// needs           => compute-routing capabilities (src/core/compute-routing.mjs)

export const POWERSHELL_COMMANDS = Object.freeze({
  'git-status': { readOnly: true, args: { repo: 'path' }, summary: 'git status of a repo' },
  'git-log': { readOnly: true, args: { repo: 'path', count: 'int' }, summary: 'recent git commits of a repo' },
  'disk-free': { readOnly: true, args: {}, summary: 'free disk space per drive' },
  'list-processes': { readOnly: true, args: {}, summary: 'top 20 processes by CPU' },
  'ollama-list': { readOnly: true, args: {}, summary: 'installed Ollama models' },
  'restart-bridge': { args: {}, summary: 'restart the Helmian Bridge service (its in-process spoke re-reads its config)' },
  'toolchain-versions': { readOnly: true, args: {}, summary: 'node, npm, npx and eas versions on the PC' },
  'eas-build': { args: { repo: 'path' }, summary: 'start an EAS Android preview build in a repo (detached; output logged in the repo)' },
  'eas-build-status': { readOnly: true, args: { repo: 'path' }, summary: 'tail of the latest spoke-started EAS build log in a repo, with its exit marker' },
  // Free text (Troy's full-access order, 2026-10-31): the command text is an
  // argument, not a table entry. Deliberately NOT readOnly — every run is a
  // change-class action behind a human Guard approval whose card quotes the
  // exact text (see describeHandsAction), and the spoke re-verifies that
  // approval against its pinned Guard key before anything runs.
  'run-command': { args: { command: 'text' }, summary: 'run one PowerShell command given as free text (Guard-approved; the card quotes the text)' },
});

// Read-only allow-list (Troy, 2026-10-30: "if it's read-only, the user doesn't
// need to click"). A run_powershell call whose commandId is flagged readOnly
// above only LOOKS at the PC (status, logs, versions, free space), so it skips
// the Executive Guard approval. Everything else (restart-bridge, eas-build,
// every write/move/copy/delete/open_url/phone change) still needs a human
// Guard approval. Both the hub and the PC spoke use this one check.
export const POWERSHELL_READ_COMMANDS = Object.freeze(Object.keys(POWERSHELL_COMMANDS).filter((id) => POWERSHELL_COMMANDS[id].readOnly === true));
// Capability a spoke reports when it runs read-only allow-listed commands
// without a Guard decision. Older spokes don't report it, so the hub keeps
// asking Guard for them (they would refuse an unsigned run_powershell job).
export const POWERSHELL_READ_CAPABILITY = 'powershell-read';

/** True only for a validated run_powershell call to a readOnly allow-listed command. */
export function isReadOnlyCall(tool, args) {
  return tool === 'run_powershell' && typeof args?.commandId === 'string' && POWERSHELL_READ_COMMANDS.includes(args.commandId);
}

// The phone family (Broad Spectrum Spoke, phone commands added 2026-10-26):
// fixed, narrow commands for a screen-by-screen pass over the Android phone
// paired with the PC (the spoke reaches it through the Android bridge, adb).
// The read commands ride the phone_look tool (no Guard ask, like the file
// reads); the changing commands ride run_phone and are Guard-gated exactly
// like run_powershell. One registry, split by each entry's `mutating` flag;
// validateArgs refuses a command on the wrong tool, fail closed.
// Arg kinds: 'coord' = a screen coordinate (integer 0..12000, no default);
// 'text' = words to type (plain string, capped in validateArgs);
// 'lines' = a log line count (integer 100..20000, defaults to 2000).
export const PHONE_COMMANDS = Object.freeze({
  'phone-status': { mutating: false, args: {}, summary: 'is the phone there: connected or not, which phone, battery, screen on or off' },
  'phone-screen': { mutating: false, args: {}, summary: 'a picture of the phone screen right now (small JPEG, base64, with its size)' },
  'phone-layout': { mutating: false, args: {}, summary: 'what is on the phone screen in words: the text, buttons and fields, and where each one sits' },
  'phone-logcat': { mutating: false, args: { lines: 'lines' }, summary: 'the phone system log (logcat): what the phone and its apps have been doing and saying, newest last' },
  'phone-tap': { mutating: true, args: { x: 'coord', y: 'coord' }, summary: 'tap the phone screen at one spot' },
  'phone-swipe': { mutating: true, args: { fromX: 'coord', fromY: 'coord', toX: 'coord', toY: 'coord' }, summary: 'swipe the phone screen from one spot to another' },
  'phone-type': { mutating: true, args: { text: 'text' }, summary: 'type words into the phone where the cursor already sits' },
  'phone-logcat-clear': { mutating: true, args: {}, summary: 'clear the phone system log so the next look starts clean' },
});

export const PHONE_READ_COMMANDS = Object.freeze(Object.keys(PHONE_COMMANDS).filter((id) => !PHONE_COMMANDS[id].mutating));
export const PHONE_ACT_COMMANDS = Object.freeze(Object.keys(PHONE_COMMANDS).filter((id) => PHONE_COMMANDS[id].mutating));

export const TOOLS = Object.freeze({
  list_files: { mutating: false, needs: ['local-files'], description: 'List files under a folder inside the PC workspace roots.' },
  read_file: { mutating: false, needs: ['local-files'], description: 'Read a text file inside the PC workspace roots (secrets paths refused, 64 KB cap).' },
  search_files: { mutating: false, needs: ['local-files'], description: 'Search inside the PC workspace roots: match file names by glob and/or file text by a plain-text query (secrets paths refused, results capped).' },
  ollama_generate: { mutating: false, needs: ['ollama'], description: 'Ask a local Ollama model on the PC. Free local compute; nothing leaves the PC except the answer.' },
  run_powershell: { mutating: true, needs: ['powershell'], description: 'Run ONE command by id: an allow-listed command, or free PowerShell text via the run-command id. Needs a human Guard approval (read-only allow-listed commands excepted).' },
  open_url: { mutating: true, needs: ['pc-browser'], description: 'Open an https URL in the PC browser. Needs a human Guard approval.' },
  write_file: { mutating: true, needs: ['local-files'], description: 'Save a plain-text file (a draft page, notes, a report) into a folder the owner already allowed on their own device. Replaces that file if it exists. The owner approves each save in Executive Guard.' },
  move_file: { mutating: true, needs: ['local-files'], description: 'Move or rename a file or folder inside the PC workspace roots. Refuses if the destination already exists. Needs a human Guard approval.' },
  copy_file: { mutating: true, needs: ['local-files'], description: 'Copy a file or folder inside the PC workspace roots. Refuses if the destination already exists. Needs a human Guard approval.' },
  delete_file: { mutating: true, needs: ['local-files'], description: 'Delete a file inside the PC workspace roots; a folder needs recursive: true. Needs a human Guard approval.' },
  make_dir: { mutating: true, needs: ['local-files'], description: 'Create one folder inside the PC workspace roots (its parent folder must already exist). Needs a human Guard approval.' },
  edit_file: { mutating: true, needs: ['local-files'], description: 'Replace exact text in a text file inside the PC workspace roots. Needs a human Guard approval.' },
  phone_look: { mutating: false, needs: ['phone'], description: 'Look at the Android phone paired with the PC: is it there, a picture of its screen, or its layout in words. Read-only.' },
  run_phone: { mutating: true, needs: ['phone'], description: 'Change something on the Android phone paired with the PC: tap, swipe, or type. Run ONE allow-listed command by id (never free text). Needs a human Guard approval.' },
});

export class ArgError extends Error {}

function str(v, name, max) {
  if (typeof v !== 'string' || !v.trim()) throw new ArgError(`${name} is required`);
  if (v.length > max) throw new ArgError(`${name} is longer than ${max} characters`);
  if (/[\u0000]/.test(v)) throw new ArgError(`${name} contains a NUL byte`);
  return v;
}

/** Validate one phone command call. `wantMutating` binds the tool to its half
 * of PHONE_COMMANDS: phone_look takes only the read commands, run_phone only
 * the changing ones; a command on the wrong tool is refused, fail closed. */
function validatePhoneArgs(a, wantMutating) {
  const id = str(a.commandId, 'commandId', 64);
  const spec = PHONE_COMMANDS[id];
  const own = wantMutating ? PHONE_ACT_COMMANDS : PHONE_READ_COMMANDS;
  if (!spec || spec.mutating !== wantMutating) {
    throw new ArgError(`commandId must be one of: ${own.join(', ')}`);
  }
  const inArgs = a.args && typeof a.args === 'object' ? a.args : {};
  const out = {};
  for (const [k, kind] of Object.entries(spec.args)) {
    if (kind === 'coord') {
      const n = Number(inArgs[k]);
      if (!Number.isInteger(n) || n < 0 || n > 12000) throw new ArgError(`args.${k} must be a screen coordinate (integer 0..12000)`);
      out[k] = n;
    }
    if (kind === 'lines') {
      const n = inArgs[k] == null ? 2000 : Number(inArgs[k]);
      if (!Number.isInteger(n) || n < 100 || n > 20000) throw new ArgError(`args.${k} must be a line count (integer 100..20000)`);
      out[k] = n;
    }
    if (kind === 'text') out[k] = str(inArgs[k], `args.${k}`, 1000);
  }
  for (const k of Object.keys(inArgs)) if (!(k in spec.args)) throw new ArgError(`unexpected argument args.${k}`);
  return { commandId: id, args: out };
}

/** Normalize and validate arguments. Returns a plain object with only known keys. */
export function validateArgs(tool, args = {}) {
  const a = args && typeof args === 'object' ? args : {};
  switch (tool) {
    case 'list_files':
      return { path: str(a.path, 'path', 1024), ...(a.glob ? { glob: str(a.glob, 'glob', 200) } : {}) };
    case 'read_file': {
      const maxBytes = a.maxBytes == null ? MAX_OUTPUT_BYTES : Number(a.maxBytes);
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_OUTPUT_BYTES) throw new ArgError(`maxBytes must be 1..${MAX_OUTPUT_BYTES}`);
      return { path: str(a.path, 'path', 1024), maxBytes };
    }
    case 'ollama_generate': {
      const model = str(a.model, 'model', 100);
      if (!/^[A-Za-z0-9._:/-]+$/.test(model)) throw new ArgError('model name has unexpected characters');
      return { model, prompt: str(a.prompt, 'prompt', 20000) };
    }
    case 'run_powershell': {
      const id = str(a.commandId, 'commandId', 64);
      const spec = POWERSHELL_COMMANDS[id];
      if (!spec) throw new ArgError(`commandId must be one of: ${Object.keys(POWERSHELL_COMMANDS).join(', ')}`);
      const inArgs = a.args && typeof a.args === 'object' ? a.args : {};
      const out = {};
      for (const [k, kind] of Object.entries(spec.args)) {
        if (kind === 'path') out[k] = str(inArgs[k], `args.${k}`, 1024);
        if (kind === 'text') out[k] = str(inArgs[k], `args.${k}`, 2000);
        if (kind === 'int') {
          const n = inArgs[k] == null ? 10 : Number(inArgs[k]);
          if (!Number.isInteger(n) || n < 1 || n > 50) throw new ArgError(`args.${k} must be 1..50`);
          out[k] = n;
        }
      }
      for (const k of Object.keys(inArgs)) if (!(k in spec.args)) throw new ArgError(`unexpected argument args.${k}`);
      return { commandId: id, args: out };
    }
    case 'phone_look':
      return validatePhoneArgs(a, false);
    case 'run_phone':
      return validatePhoneArgs(a, true);
    case 'open_url': {
      const raw = str(a.url, 'url', 2048);
      let u;
      try { u = new URL(raw); } catch { throw new ArgError('url is not a valid URL'); }
      if (u.protocol !== 'https:') throw new ArgError('only https URLs can be opened');
      return { url: u.toString() };
    }
    case 'write_file': {
      if (typeof a.content !== 'string') throw new ArgError('content is required');
      if (Buffer.byteLength(a.content, 'utf8') > MAX_OUTPUT_BYTES) throw new ArgError('content is larger than 64 KB');
      return { path: str(a.path, 'path', 1024), content: a.content };
    }
    case 'search_files': {
      const out = { path: str(a.path, 'path', 1024) };
      if (a.query) out.query = str(a.query, 'query', 1000);
      if (a.glob) out.glob = str(a.glob, 'glob', 200);
      if (!out.query && !out.glob) throw new ArgError('query or glob is required');
      const maxResults = a.maxResults == null ? 50 : Number(a.maxResults);
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 200) throw new ArgError('maxResults must be 1..200');
      return { ...out, maxResults };
    }
    case 'move_file':
    case 'copy_file':
      return { path: str(a.path, 'path', 1024), destination: str(a.destination, 'destination', 1024) };
    case 'delete_file': {
      if (a.recursive != null && typeof a.recursive !== 'boolean') throw new ArgError('recursive must be a boolean');
      return { path: str(a.path, 'path', 1024), ...(a.recursive ? { recursive: true } : {}) };
    }
    case 'make_dir':
      return { path: str(a.path, 'path', 1024) };
    case 'edit_file': {
      const find = str(a.find, 'find', 20000);
      if (typeof a.replace !== 'string') throw new ArgError('replace is required');
      if (a.replace.length > 20000) throw new ArgError('replace is longer than 20000 characters');
      if (/[\u0000]/.test(a.replace)) throw new ArgError('replace contains a NUL byte');
      if (a.all != null && typeof a.all !== 'boolean') throw new ArgError('all must be a boolean');
      return { path: str(a.path, 'path', 1024), find, replace: a.replace, ...(a.all ? { all: true } : {}) };
    }
    default:
      throw new ArgError(`unknown tool ${tool}`);
  }
}

// ─── Executive Guard action + decision ───────────────────────────────────────

// ── Human-readable action summary (display only — NEVER hashed) ────────────
//
// The summary is the one part of the Guard action a human actually reads on
// an approval surface, so it names the real target: tool, target path, and
// for content writes a short descriptor (byte count + first line). It is
// composed here, at the single point where the action is built, from the
// SAME validated args whose canonical form is hashed into contentHash — the
// display text has no second channel it could drift through, and the args
// the spoke executes are the args this summary was derived from.
//
// Verification never reads the summary: guardActionHash picks
// {kind, site, contentHash, riskSignals, target} only — here, in Guard
// (executive-guard/src/action.mjs mirrors it), and on the spoke. Enriching
// the summary therefore cannot change any actionHash, signature check or
// executed argument, and a hub/spoke pair running different summary builders
// still verifies identically. (Proven by the golden-hash regression test.)
//
// Guard validates summaries (executive-guard/src/action.mjs): >500 chars is
// refused, and a summary carrying an unredacted secret of most kinds is
// refused outright ('unredacted-content') — the decision request fails
// closed. So this builder never produces one: control characters stripped,
// snippets truncated, a first line matching Guard's refused secret shapes
// is withheld (byte count still shown), and if the composed summary STILL
// trips the scan it degrades stepwise — snippets off, then the bare legacy
// summary — never worse than the pre-enrichment behaviour.

const SUMMARY_MAX_CHARS = 460; // Guard's hard limit is 500; keep margin.
const SNIPPET_MAX_CHARS = 80;
// A free-text run-command is approved BY its text, so the card quotes far
// more of it than a content snippet: enough to read the whole command in
// the normal case, inside the summary cap with the prefix and cut marker.
const COMMAND_QUOTE_MAX_CHARS = 300;

// Detection-only port of the secret shapes Executive Guard refuses in a
// summary (action.mjs via extension/background/redact.js: every redaction
// type except email/phone/ipv4 rejects the request). Keep in step with
// that file; a miss here still fails closed because Guard refuses too.
const GUARD_REFUSED_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/u,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprse]-[A-Za-z0-9-]{12,}|AIza[0-9A-Za-z_-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|(?:sk|rk|pk)_live_[0-9A-Za-z]{16,}|(?:sk|rk)_test_[0-9A-Za-z]{16,}|whsec_[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}|glpat-[0-9A-Za-z_-]{20}|xai-[A-Za-z0-9]{20,})\b/u,
  /\baws_secret_access_key["']?\s*[:=]/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}/u,
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:@/]+:[^\s@/]+@/iu,
  /\b(?:SSN|social security(?: number| no\.?)?)\s*[:#]?\s*\d{3}\s?\d{2}\s?\d{4}\b/iu,
  /\b\d{3}-\d{2}-\d{4}\b/u,
  /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/u,
  /(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|pwd|passcode|passphrase|secret|token)\s*[:=]\s*[^\s,;]+/iu,
  /\b(?:pass(?:word|wd|phrase|code)?|pwd|api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret)\s+(?:is|was)\s*:?\s+["'`]?[^\s,;"'`)]{5,}/iu,
]);

function tripsGuardRefusal(text) {
  return GUARD_REFUSED_PATTERNS.some((pattern) => pattern.test(text));
}

function sanitizeSnippet(raw, max = SNIPPET_MAX_CHARS) {
  const clean = String(raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function displayPath(path, max = 180) {
  const text = String(path ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, 110)}…${text.slice(-60)}`;
}

/** "19 bytes: \"first line\"" — or bare bytes when there is nothing safe to quote. */
function contentDescriptor(text, { snippets = true, snippetMax = SNIPPET_MAX_CHARS } = {}) {
  const bytes = Buffer.byteLength(String(text ?? ''), 'utf8');
  if (!snippets) return `${bytes} bytes`;
  const firstLine = String(text ?? '').split(/\r\n|\r|\n/, 1)[0];
  const snippet = sanitizeSnippet(firstLine, snippetMax);
  if (!snippet) return `${bytes} bytes`;
  if (tripsGuardRefusal(snippet)) return `${bytes} bytes; first line withheld (looked sensitive)`;
  return `${bytes} bytes: "${snippet}"`;
}

/**
 * The summary a human approves by: tool + real target, from the exact args.
 * Falls back stepwise (no snippets, then the bare legacy form) if the rich
 * form would be too long or would trip Guard's summary refusal — the action
 * itself, and its hash, are identical either way.
 */
export function describeHandsAction(tool, args, { snippets = true } = {}) {
  const legacy = (tool === 'run_powershell' || tool === 'run_phone') ? `hands ${tool} ${args.commandId}`
    : tool === 'open_url' ? `hands ${tool} ${new URL(args.url).host}`
    : `hands ${tool}`;
  let rich;
  switch (tool) {
    case 'write_file':
      rich = `hands write_file → ${displayPath(args.path)} (${contentDescriptor(args.content, { snippets })})`;
      break;
    case 'edit_file':
      rich = `hands edit_file → ${displayPath(args.path)} (replace ${contentDescriptor(args.replace, { snippets, snippetMax: 40 })}; find ${contentDescriptor(args.find, { snippets, snippetMax: 40 })})`;
      break;
    case 'move_file':
      rich = `hands move_file → ${displayPath(args.path)} → ${displayPath(args.destination)}`;
      break;
    case 'copy_file':
      rich = `hands copy_file → ${displayPath(args.path)} → ${displayPath(args.destination)}`;
      break;
    case 'delete_file':
      rich = `hands delete_file → ${displayPath(args.path)}${args.recursive ? ' (recursive)' : ''}`;
      break;
    case 'make_dir':
      rich = `hands make_dir → ${displayPath(args.path)}`;
      break;
    case 'run_powershell': {
      if (args.commandId === 'run-command') {
        // The command text IS what the human approves: quote it on the card,
        // never a bare 'run-command' label. A command longer than the quote
        // is cut at the quote limit and marked with an explicit '…cut' (and
        // a command whose text trips Guard's secret shapes degrades through
        // the normal path below: snippets off, then the byte count only).
        const command = String(args.args?.command ?? '');
        if (!snippets) {
          rich = `hands run_powershell run-command (${Buffer.byteLength(command, 'utf8')} bytes; command text not shown)`;
          break;
        }
        const cleaned = command.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
        const quoted = sanitizeSnippet(command, COMMAND_QUOTE_MAX_CHARS);
        rich = quoted
          ? `hands run_powershell run-command: "${quoted}"${cleaned.length > COMMAND_QUOTE_MAX_CHARS ? ' …cut' : ''}`
          : `hands run_powershell run-command (${Buffer.byteLength(command, 'utf8')} bytes; command text not shown)`;
        break;
      }
      const bits = Object.entries(args.args || {}).map(([k, v]) => `${k}: ${v}`);
      rich = bits.length ? `hands run_powershell ${args.commandId} (${bits.join(', ')})` : legacy;
      break;
    }
    case 'run_phone': {
      // The words phone-type would type are never quoted on the card (they
      // could be a password being typed into the phone); the count is shown.
      const bits = Object.entries(args.args || {}).map(([k, v]) => (k === 'text' ? `text: ${String(v).length} characters` : `${k}: ${v}`));
      rich = bits.length ? `hands run_phone ${args.commandId} (${bits.join(', ')})` : legacy;
      break;
    }
    case 'open_url': {
      // Host + path, never the query string: secrets ride in query strings.
      const u = new URL(args.url);
      rich = `hands open_url → ${u.host}${u.pathname === '/' ? '' : displayPath(u.pathname, 100)}`;
      break;
    }
    default:
      rich = legacy;
  }
  if (rich.length <= SUMMARY_MAX_CHARS && !tripsGuardRefusal(rich)) return rich;
  if (snippets) return describeHandsAction(tool, args, { snippets: false });
  return legacy;
}

/** The action sent to Guard for a mutating tool. contentHash binds the exact arguments. */
export function buildGuardAction(tool, args) {
  return {
    kind: 'agent.tool',
    site: GUARD_ACTION_SITE,
    contentHash: sha256Hex(canonicalJson({ tool, args })),
    // 'destructive-intent' routes every mutating hands call to Guard's
    // human-approval rule; without it Guard's default is deny.
    riskSignals: ['destructive-intent', 'hands.act', `tool:${tool}`].sort(),
    summary: describeHandsAction(tool, args),
  };
}

export function guardActionHash(action) {
  const { kind, site, contentHash, riskSignals, target } = action;
  return sha256Hex(canonicalJson({ kind, site, contentHash, riskSignals, target }));
}

export function publicKeyFromX(x) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
}

/**
 * Verify that `envelope` is a Guard decision that APPROVES running `tool(args)`:
 * good Ed25519 signature from the pinned key, right audience, not expired,
 * verdict allow, a human approval (approvalId + decidedBy), bound to the same
 * action hash, nonce and device. Anything else is a refusal.
 */
export function verifyApproval({ publicKeyX, envelope, tool, args, nonce, deviceId, now = Date.now() }) {
  try {
    if (!publicKeyX) return { ok: false, error: 'no pinned Guard key' };
    if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') return { ok: false, error: 'malformed decision' };
    const good = verify(null, Buffer.from(envelope.payload, 'utf8'), publicKeyFromX(publicKeyX), Buffer.from(envelope.signature, 'base64url'));
    if (!good) return { ok: false, error: 'bad signature' };
    const claims = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'));
    if (claims.aud !== DECISION_AUDIENCE) return { ok: false, error: 'wrong audience' };
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < now) return { ok: false, error: 'expired' };
    if (claims.verdict !== 'allow') return { ok: false, error: `verdict ${claims.verdict}` };
    if (!claims.approvalId || !claims.decidedBy) return { ok: false, error: 'not a human approval' };
    if (claims.actionHash !== guardActionHash(buildGuardAction(tool, args))) return { ok: false, error: 'approval is for different arguments' };
    if (nonce && claims.nonce !== nonce) return { ok: false, error: 'nonce mismatch' };
    if (deviceId && claims.deviceId !== deviceId) return { ok: false, error: 'device mismatch' };
    return { ok: true, claims };
  } catch (error) {
    return { ok: false, error: `unverifiable: ${error.message}` };
  }
}

// ─── PC workspace root grants ────────────────────────────────────────────────
//
// A root grant is NOT a Guard action decision. Existing decisions are bound to
// one tool call, carry a nonce, are single-use, and are intentionally short
// lived; none of those properties can describe standing folder access. A root
// grant therefore uses the same transport-level trust shape as a decision —
// a canonical-JSON payload in an Ed25519 envelope ({ payload, signature,
// keyId }) verified against the Guard key pinned on the PC — but with its own
// audience and claims. It is read-only, bound to one spoke device, and lasts
// until its optional `exp` or until the entry is removed from the local grants
// file (revocation). This distinction matters: today's Executive Guard decision
// endpoint cannot issue one of these long-lived grant envelopes.

export function isAbsoluteRootPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 1024
    && !/[\u0000]/.test(value)
    && (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value));
}

/** The Guard action a future hub root-request flow should ask a human to approve. */
export function buildRootGrantAction({ rootPath, scope = 'read-only', spokeDeviceId, expiresAt = null } = {}) {
  if (!isAbsoluteRootPath(rootPath)) throw new TypeError('rootPath must be an absolute path');
  if (scope !== 'read-only') throw new TypeError('root grants are read-only');
  if (!spokeDeviceId || typeof spokeDeviceId !== 'string') throw new TypeError('spokeDeviceId is required');
  return {
    kind: 'agent.tool',
    site: GUARD_ACTION_SITE,
    contentHash: sha256Hex(canonicalJson({ grant: { rootPath, scope, spokeDeviceId, expiresAt } })),
    riskSignals: ['destructive-intent', 'hands.act', 'root-grant'].sort(),
    summary: `hands grant read-only root ${rootPath}`,
  };
}

export function rootGrantActionHash(request) {
  return guardActionHash(buildRootGrantAction(request));
}

/**
 * Verify a signed root-grant envelope against the PC's pinned Guard key.
 * Required claims: aud, grantType='root', grantId, verdict='allow', a human
 * approvalId + decidedBy, rootPath, scope='read-only', spokeDeviceId.
 * Optional claims: requestId, actionHash, iat, exp (epoch seconds). No exp
 * means "until revoked" — the local grants file is the revocation list.
 */
export function verifyRootGrant({ publicKeyX, envelope, spokeDeviceId, now = Date.now() } = {}) {
  try {
    if (!publicKeyX) return { ok: false, error: 'no pinned Guard key' };
    if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') return { ok: false, error: 'malformed root grant' };
    const good = verify(null, Buffer.from(envelope.payload, 'utf8'), publicKeyFromX(publicKeyX), Buffer.from(envelope.signature, 'base64url'));
    if (!good) return { ok: false, error: 'bad signature' };
    const claims = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'));
    if (claims.aud !== ROOT_GRANT_AUDIENCE) return { ok: false, error: 'wrong audience' };
    if (claims.grantType !== 'root') return { ok: false, error: 'not a root grant' };
    if (!claims.grantId || typeof claims.grantId !== 'string') return { ok: false, error: 'missing grantId' };
    if (claims.verdict !== 'allow') return { ok: false, error: `verdict ${claims.verdict}` };
    if (!claims.approvalId || !claims.decidedBy) return { ok: false, error: 'not a human approval' };
    if (!isAbsoluteRootPath(claims.rootPath)) return { ok: false, error: 'rootPath is not absolute' };
    if (claims.scope !== 'read-only') return { ok: false, error: 'root grants are read-only' };
    if (!claims.spokeDeviceId || typeof claims.spokeDeviceId !== 'string') return { ok: false, error: 'missing spokeDeviceId' };
    if (spokeDeviceId && claims.spokeDeviceId !== spokeDeviceId) return { ok: false, error: 'device mismatch' };
    if (claims.exp != null) {
      if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return { ok: false, error: 'invalid expiry' };
      if (claims.exp * 1000 <= now) return { ok: false, error: 'expired' };
    }
    if (claims.iat != null && (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat))) return { ok: false, error: 'invalid issued-at' };
    return { ok: true, claims };
  } catch (error) {
    return { ok: false, error: `unverifiable: ${error.message}` };
  }
}

// ─── Spoke scope summary (scope-permission spec, bite 1: reporting) ──────────
//
// The spoke reports its file scope to the hub with its poll presence: which
// tier it is in, its built-in default roots, and the folders opened by signed
// root grants. The hub audits the report and flags changes (visibility only —
// a report never grants anything; enforcement stays on the PC, per operation).
// The tier words are the spec's three choices, machine-spelled:
//   full-pc         "Full PC" — agents can look anywhere on this computer
//   pick-folders    "Pick folders" — only the folders listed
//   no-file-access  "No file access" — every file tool refuses
export const SCOPE_TIERS = Object.freeze(['full-pc', 'pick-folders', 'no-file-access']);
export const MAX_SCOPE_PATHS = 32; // per list (roots / grants)
export const MAX_SCOPE_PATH_CHARS = 320;

/**
 * Canonicalize a scope summary arriving over the wire, or return null when it
 * is absent or malformed in any part (a malformed report is treated as no
 * report — never partially trusted). Canonical form: tier validated, roots
 * and grants deduplicated and sorted, so two summaries compare by value.
 */
export function cleanScopeSummary(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!SCOPE_TIERS.includes(raw.tier)) return null;
  const cleanList = (v) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > MAX_SCOPE_PATHS) return null;
    const out = new Set();
    for (const entry of v) {
      if (typeof entry !== 'string' || !entry.length || entry.length > MAX_SCOPE_PATH_CHARS) return null;
      out.add(entry);
    }
    return [...out].sort();
  };
  const roots = cleanList(raw.roots);
  const grants = cleanList(raw.grants);
  if (roots === null || grants === null) return null;
  return { tier: raw.tier, roots, grants };
}

/** Both inputs must already be canonical (cleanScopeSummary output). */
export function scopeSummariesEqual(a, b) {
  if (!a || !b) return a === b;
  return a.tier === b.tier
    && a.roots.length === b.roots.length && a.roots.every((r, i) => r === b.roots[i])
    && a.grants.length === b.grants.length && a.grants.every((r, i) => r === b.grants[i]);
}
