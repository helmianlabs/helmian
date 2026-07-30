// THE BLOCK LEDGER — a durable record of every block event, from both layers.
//
// Troy's instruction, 2026-07-29: every time either layer blocks something —
// the browser Guardian or the execution guard — write it to a durable log, "not
// screenshots, not chat history." His schema, verbatim: timestamp, layer
// (browser/execution), matched pattern, full triggering text, source, outcome.
//
// He also named the second reason it exists: "it's also a legitimate product
// feature, a shippable audit log is something customers would want anyway." So
// this is written to be read by a buyer's compliance reviewer, not just by us.
//
// WHY JSONL AND NOT A DATABASE
//
// A block event happens at the exact moment a guard refuses an operation. That
// path must not depend on a network, a connection string, or a schema being
// migrated — Helmion already has a feature (the Postgres lease) that is
// unusable by anyone who has not configured Neon, and repeating that mistake in
// the audit trail would mean the evidence disappears precisely on the machines
// that are not set up. One append per event to a local file works offline, on a
// first run, and inside a sandbox. A durable exporter can read these files
// later; nothing is lost by writing here first.
//
// WHY APPEND-ONLY, ONE JSON OBJECT PER LINE
//
// A single `appendFileSync` of one line ending in \n is the cheapest durable
// write that survives a crash mid-session: a torn write loses at most the last
// line, and every earlier line stays parseable. A JSON array would be corrupt
// the moment the process died before closing the bracket.
//
// LOGGING MUST NEVER BLOCK A GUARD
//
// If this file cannot be written, the guard's verdict still stands. `record()`
// therefore never throws — it returns `{logged:false, reason}` so the caller can
// surface the failure without a refusal turning into a crash, or worse, into an
// allow. But it is never SILENT either: a caller that ignores the return value
// is the bug this codebase already made once, where a `skipped` flag was
// returned and dropped on the floor.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const AUDIT_DIR = path.join('.helmion', 'audit');
export const SCHEMA_VERSION = 1;

export const LAYER = Object.freeze({
  BROWSER: 'browser',
  EXECUTION: 'execution',
});

// Troy's schema, as the required key set. Anything missing is a programming
// error and is reported rather than written half-formed.
const REQUIRED = Object.freeze(['timestamp', 'layer', 'matchedPattern', 'text', 'source', 'outcome']);

// A block event's "full triggering text" is exactly the place a real credential
// is most likely to appear — the whole point is that it captures what somebody
// was about to run. Writing that verbatim into a file a customer ships to their
// auditor would be a leak, so known key shapes are masked and the masking is
// RECORDED, so nobody later mistakes a redacted log for a tampered one.
//
// This deliberately does not import src/agent/redact.mjs: that module is for
// model prompts and log lines, and coupling the audit trail to it would mean a
// change there silently changes the evidence format here.
const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[REDACTED]'],
  [/sk-proj-[A-Za-z0-9_-]{8,}/g, 'sk-proj-[REDACTED]'],
  [/sk-[A-Za-z0-9]{20,}/g, 'sk-[REDACTED]'],
  [/xai-[A-Za-z0-9]{8,}/g, 'xai-[REDACTED]'],
  [/gh[pousr]_[A-Za-z0-9]{8,}/g, 'gh_[REDACTED]'],
  [/github_pat_[A-Za-z0-9_]{8,}/g, 'github_pat_[REDACTED]'],
  [/AIza[A-Za-z0-9_-]{10,}/g, 'AIza[REDACTED]'],
  [/ya29\.[A-Za-z0-9._-]{10,}/g, 'ya29.[REDACTED]'],
  [/xox[baprs]-[A-Za-z0-9-]{8,}/g, 'xox-[REDACTED]'],
  [/AKIA[0-9A-Z]{12,}/g, 'AKIA[REDACTED]'],
  [/npg_[A-Za-z0-9]{8,}/g, 'npg_[REDACTED]'],
  // Connection strings: keep the shape, drop the credentials.
  [/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/]+:[^@\s]+@/gi, '$1://[REDACTED]@'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
];

/**
 * Mask credentials in the triggering text.
 * @returns {{text: string, redacted: boolean}}
 */
export function redactForAudit(input) {
  const original = String(input ?? '');
  let text = original;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return { text, redacted: text !== original };
}

export function auditDir(workspace) {
  if (!workspace || typeof workspace !== 'string') {
    throw new TypeError('the audit log needs a workspace path');
  }
  return path.join(workspace, AUDIT_DIR);
}

// One file per UTC day. Daily rotation keeps a long-running install from
// producing one unbounded file, and a UTC boundary means the filename does not
// change meaning when the machine's timezone or DST does.
export function auditFile(workspace, { now = new Date() } = {}) {
  const day = new Date(now).toISOString().slice(0, 10);
  return path.join(auditDir(workspace), `blocks-${day}.jsonl`);
}

/**
 * Write one block event.
 *
 * Never throws. Returns {logged, file, entry, reason} so a caller can report a
 * logging failure without turning a refusal into a crash — and so a caller that
 * checks the result can say "the block stood but was not recorded", which is a
 * materially different statement from "nothing was blocked".
 *
 * @param {string} workspace
 * @param {object} event
 * @param {'browser'|'execution'} event.layer
 * @param {string} event.matchedPattern  the rule or pattern name that fired
 * @param {string} event.text            the full text that triggered it
 * @param {string} event.source          which app, file, or session
 * @param {string} event.outcome         blocked | allowed-with-warning | ...
 */
export function recordBlockEvent(workspace, event = {}, { now = new Date() } = {}) {
  const layer = event.layer ?? null;
  if (layer !== LAYER.BROWSER && layer !== LAYER.EXECUTION) {
    return {
      logged: false,
      file: null,
      entry: null,
      reason: `layer must be "${LAYER.BROWSER}" or "${LAYER.EXECUTION}", got ${JSON.stringify(layer)}`,
    };
  }

  const { text, redacted } = redactForAudit(event.text);
  const entry = {
    schema: SCHEMA_VERSION,
    timestamp: new Date(now).toISOString(),
    layer,
    matchedPattern: String(event.matchedPattern ?? ''),
    text,
    source: String(event.source ?? ''),
    outcome: String(event.outcome ?? ''),
  };
  // Optional, additive fields. Recorded when supplied so the entry can carry
  // the line number a warning pointed at, or the extra hits a scan produced,
  // without changing the required schema Troy specified.
  if (redacted) entry.redacted = true;
  if (event.hits !== undefined) entry.hits = event.hits;
  if (event.lineNumber !== undefined) entry.lineNumber = event.lineNumber;
  if (event.detail !== undefined) entry.detail = String(event.detail);

  const missing = REQUIRED.filter((key) => entry[key] === undefined || entry[key] === null);
  if (missing.length) {
    return { logged: false, file: null, entry, reason: `missing required field(s): ${missing.join(', ')}` };
  }

  const file = auditFile(workspace, { now });
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    // One line, one append, newline-terminated. A crash mid-write costs the
    // last line and nothing before it.
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return { logged: true, file, entry, reason: '' };
  } catch (err) {
    return { logged: false, file, entry, reason: `could not append to ${file} (${err.message})` };
  }
}

/**
 * Read events back. For the side panel, for `helmion audit`, and for anyone who
 * has to answer "what did this thing block last Tuesday".
 *
 * A malformed line is REPORTED, not skipped silently — a log that quietly drops
 * what it cannot parse is not evidence.
 *
 * @returns {{entries: object[], malformed: {file: string, line: number, raw: string}[], files: string[]}}
 */
export function readBlockEvents(workspace, { limit = null, layer = null, since = null } = {}) {
  const dir = auditDir(workspace);
  let names;
  try {
    names = readdirSync(dir).filter((name) => /^blocks-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return { entries: [], malformed: [], files: [] };
    throw err;
  }

  const entries = [];
  const malformed = [];
  const sinceMs = since ? Date.parse(since) : null;

  for (const name of names) {
    const file = path.join(dir, name);
    const raw = readFileSync(file, 'utf8');
    const lines = raw.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformed.push({ file, line: index + 1, raw: line.slice(0, 200) });
        continue;
      }
      if (layer && parsed.layer !== layer) continue;
      if (sinceMs !== null && Date.parse(parsed.timestamp) < sinceMs) continue;
      entries.push(parsed);
    }
  }

  entries.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return {
    entries: limit ? entries.slice(0, limit) : entries,
    malformed,
    files: names.map((name) => path.join(dir, name)),
  };
}

/**
 * Counts for a status panel. Reports `malformed` explicitly rather than folding
 * unparseable lines into zero, for the same reason inspectLease reports
 * UNREADABLE instead of NONE: "I cannot tell" is not "nothing happened".
 */
export function summarizeBlockEvents(workspace, options = {}) {
  const { entries, malformed, files } = readBlockEvents(workspace, options);
  const byLayer = {};
  const byPattern = {};
  for (const entry of entries) {
    byLayer[entry.layer] = (byLayer[entry.layer] ?? 0) + 1;
    if (entry.matchedPattern) byPattern[entry.matchedPattern] = (byPattern[entry.matchedPattern] ?? 0) + 1;
  }
  return {
    total: entries.length,
    byLayer,
    byPattern,
    malformed: malformed.length,
    files: files.length,
    newest: entries[0]?.timestamp ?? null,
    oldest: entries[entries.length - 1]?.timestamp ?? null,
    bytes: files.reduce((sum, file) => {
      try { return sum + statSync(file).size; } catch { return sum; }
    }, 0),
  };
}
