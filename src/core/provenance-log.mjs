// THE PROVENANCE LEDGER — which model actually answered, every single time.
//
// WHY THIS EXISTS. On 2026-07-30 Troy spoke to Helmion, saw "Qwen 3.5" flash on
// screen, said "hello Grok" and got a reply that called itself Helmion. He asked
// who he had been talking to and NO LOG ANYWHERE COULD ANSWER IT. The answer had
// to be reconstructed by inspecting live processes — `Get-Process ollama`, port
// 11434, `/api/tags` — which is forensics on a running machine, not a record. An
// hour after that process exited there would have been no answer at all.
//
// The root cause was HELMION_LOCAL_ENABLED=1 in .env, which routed trivial turns
// to a 4-billion-parameter local model (src/agent/local-provider.mjs:156). That
// flag is now 0. But the flag was never the real defect: the real defect is that
// a product whose pitch is knowing which model you are talking to could not
// answer that question about itself. Turning the flag off fixes one machine on
// one day. This file fixes the question.
//
// WHY IT LIVES BESIDE THE BLOCK LEDGER, IN THE SAME DIRECTORY, IN THE SAME SHAPE
//
// src/core/audit-log.mjs already established how this codebase writes durable
// evidence: append-only JSONL, one object per line, under <workspace>/.helmion/
// audit/, rotated daily on a UTC boundary, never throwing, malformed lines
// REPORTED rather than skipped. Every reason given in that file's header applies
// here without modification — a completion arrives at a moment that must not
// depend on a network, a connection string, or a migrated schema, and a torn
// write must cost at most the last line. So this reuses that shape exactly,
// including its redactor, rather than inventing a second logging format.
//
// It is a separate FILE because a provenance row is not a block row: it has a
// different required key set, and `layer` (browser|execution) is meaningless
// here. Folding completions into blocks-*.jsonl would have broken
// summarizeBlockEvents' layer counts and made "what did this thing block" and
// "who answered me" the same query. Same directory, same format, same reader
// discipline; different question.
//
// WHO IS ALLOWED TO WRITE HERE
//
// Only code that has a completion IN HAND. Not code that decided which model to
// call — that record is wrong the moment a fallback fires, and a fallback is
// exactly when this matters most. src/agent/providers.mjs calls recordCompletion
// after the provider's response has been parsed, using the URL it actually
// fetched and the model id it actually sent.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { AUDIT_DIR, auditDir, redactForAudit } from './audit-log.mjs';

export { AUDIT_DIR, auditDir };
export const PROVENANCE_SCHEMA_VERSION = 1;

/**
 * Troy's question is "which model answered me", so these are the keys that must
 * be present for a row to be an answer to it. Anything missing is a programming
 * error and is reported rather than written half-formed — the same rule
 * audit-log.mjs applies to REQUIRED.
 */
const REQUIRED = Object.freeze([
  'timestamp', 'sessionId', 'provider', 'providerId', 'model', 'endpointHost', 'isLocal',
]);

/**
 * Vendor names as a person would say them, keyed by the provider id the agent
 * uses internally. 'xai' is the id; "Grok" is the word Troy used when he said
 * "hello Grok" to a local qwen model. A ledger that answers his question has to
 * be readable in his vocabulary, so BOTH are recorded — `provider` for reading,
 * `providerId` for querying.
 */
export const PROVIDER_NAMES = Object.freeze({
  anthropic: 'claude',
  openai: 'openai',
  gemini: 'gemini',
  xai: 'grok',
  custom: 'custom',
});

/** The name a local endpoint reports, regardless of the wire format it speaks. */
export const LOCAL_PROVIDER_NAME = 'local';

/**
 * Human-facing provider name for one completion.
 *
 * A local endpoint reports 'local' and nothing else. It speaks the
 * OpenAI-compatible wire format and therefore arrives here as providerId
 * 'custom' (local-provider.mjs:162), so a name derived from providerId alone
 * would file the qwen turn under "custom" and leave Troy's question unanswered
 * for a second time. `isLocal` wins outright.
 */
export function providerName(providerId, { isLocal = false } = {}) {
  if (isLocal) return LOCAL_PROVIDER_NAME;
  const id = String(providerId ?? '').trim().toLowerCase();
  return PROVIDER_NAMES[id] ?? (id || 'unknown');
}

/**
 * Split a request URL into the two fields the ledger records.
 *
 * THE QUERY STRING IS DROPPED, ALWAYS. Gemini authenticates by putting the API
 * key in the URL (`?key=…`, providers.mjs geminiTurn), so a ledger that recorded
 * whole URLs would write a live credential into a file customers are meant to
 * hand to an auditor. Dropping the query makes that structurally impossible
 * rather than dependent on a pattern matching. The path survives the same
 * redactor the block ledger uses, for a key embedded somewhere unusual.
 *
 * @returns {{endpointHost: string, endpoint: string, redacted: boolean}}
 */
export function endpointParts(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return { endpointHost: '', endpoint: '', redacted: false };
  try {
    const parsed = new URL(raw);
    const { text, redacted } = redactForAudit(`${parsed.origin}${parsed.pathname}`);
    return { endpointHost: parsed.host, endpoint: text, redacted };
  } catch {
    // Not a parseable URL. Record what we were given, redacted, rather than
    // dropping the only evidence of where the answer came from.
    const { text, redacted } = redactForAudit(raw);
    return { endpointHost: text, endpoint: text, redacted };
  }
}

/**
 * The id every row carries when nobody supplied one.
 *
 * A session, for this ledger's purpose, is one running agent process: the NDJSON
 * bridge is one long-lived process per app run (src/agent/bridge.mjs), and the
 * CLI REPL is one process per sitting. So pid plus process start time identifies
 * exactly the thing Troy means by "who was I talking to just now", and it stays
 * stable for every completion in that sitting without anything having to thread
 * an id through five call sites and get it right at each one.
 *
 * Deliberately NOT random-per-call: rows that cannot be grouped answer "which
 * model" but not "in which conversation".
 */
let cachedSessionId = null;
export function processSessionId() {
  if (cachedSessionId) return cachedSessionId;
  // process.uptime() at module load fixes the start instant well enough to
  // separate two runs that reuse a pid, without needing a random source.
  const startedAt = Math.round(Date.now() - process.uptime() * 1000);
  cachedSessionId = `pid${process.pid}-${startedAt.toString(36)}`;
  return cachedSessionId;
}

/** One file per UTC day, matching audit-log.mjs:103 exactly. */
export function provenanceFile(workspace, { now = new Date() } = {}) {
  const day = new Date(now).toISOString().slice(0, 10);
  return path.join(auditDir(workspace), `provenance-${day}.jsonl`);
}

/**
 * Write one completion's provenance.
 *
 * NEVER THROWS. A ledger failure must not turn a successful answer into a
 * crashed turn — but it is never silent either: the result is returned so the
 * caller can put "the model answered but was not recorded" on screen, which is
 * a materially different statement from "nothing answered".
 *
 * @param {string} workspace
 * @param {object} event
 * @param {string}  event.providerId   internal id: anthropic|openai|gemini|xai|custom
 * @param {string}  event.model        the exact model id that was sent
 * @param {string}  event.url          the URL that was fetched (query is dropped)
 * @param {boolean} event.isLocal      true when the answer did not come from a
 *                                     frontier vendor API — see providers.mjs,
 *                                     which derives it from the endpoint dialled
 * @param {boolean} [event.routedLocal] the router's own claim, for comparison
 * @param {string}  [event.sessionId]  defaults to this process's session
 * @param {string}  [event.providerLabel] the label the UI shows for the provider
 * @param {string}  [event.tier]       router tier: fast|standard|deep|local
 * @param {string}  [event.reason]     why the router chose it
 * @param {number}  [event.round]      tool round within the turn, 0-based
 * @param {number}  [event.latencyMs]  measured wall time of the request
 * @param {number}  [event.toolCalls]  how many tool calls the reply carried
 * @param {number}  [event.contentChars] how much prose the reply carried
 * @returns {{logged: boolean, file: string|null, entry: object|null, reason: string}}
 */
export function recordCompletion(workspace, event = {}, { now = new Date() } = {}) {
  // `isLocal` is checked before anything else and demanded as a real boolean.
  // This is the one field the whole ledger exists for: a qwen answer that is
  // merely MISSING an isLocal flag reads, to every reader and every filter,
  // exactly like a frontier answer. Coercing a stray undefined to false here
  // would reproduce the original defect inside the fix.
  if (typeof event.isLocal !== 'boolean') {
    return {
      logged: false,
      file: null,
      entry: null,
      reason: `isLocal must be a boolean, got ${JSON.stringify(event.isLocal)}`,
    };
  }

  const { endpointHost, endpoint, redacted } = endpointParts(event.url);
  const entry = {
    schema: PROVENANCE_SCHEMA_VERSION,
    timestamp: new Date(now).toISOString(),
    sessionId: String(event.sessionId || processSessionId()),
    provider: providerName(event.providerId, { isLocal: event.isLocal }),
    providerId: String(event.providerId ?? ''),
    model: String(event.model ?? ''),
    endpointHost,
    endpoint,
    isLocal: event.isLocal,
  };
  // Additive fields, recorded when supplied. Same discipline as audit-log.mjs:
  // the required schema above is what a reader can rely on; these enrich a row
  // without any reader having to handle their absence.
  if (redacted) entry.redacted = true;
  // The router's own verdict, recorded next to the endpoint-derived `isLocal`.
  // Only written when the caller actually had one, so its ABSENCE is honest
  // ("nobody told me") rather than a fabricated false.
  if (typeof event.routedLocal === 'boolean') entry.routedLocal = event.routedLocal;
  if (event.providerLabel) entry.providerLabel = String(event.providerLabel);
  if (event.tier) entry.tier = String(event.tier);
  if (event.reason) entry.reason = String(event.reason);
  if (Number.isFinite(event.round)) entry.round = Math.trunc(event.round);
  if (Number.isFinite(event.latencyMs)) entry.latencyMs = Math.round(event.latencyMs);
  if (Number.isFinite(event.toolCalls)) entry.toolCalls = Math.trunc(event.toolCalls);
  if (Number.isFinite(event.contentChars)) entry.contentChars = Math.trunc(event.contentChars);

  // An empty model id is treated as missing. "Something answered, from this
  // host, and I did not record what" is not an answer to Troy's question.
  const missing = REQUIRED.filter((key) => {
    const value = entry[key];
    if (typeof value === 'boolean') return false;
    return value === undefined || value === null || value === '';
  });
  if (missing.length) {
    return { logged: false, file: null, entry, reason: `missing required field(s): ${missing.join(', ')}` };
  }

  const file = provenanceFile(workspace, { now });
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return { logged: true, file, entry, reason: '' };
  } catch (err) {
    return { logged: false, file, entry, reason: `could not append to ${file} (${err.message})` };
  }
}

/**
 * Write a provider-attempt failure without pretending that a model answered.
 * Failed rows carry the completion identity fields plus outcome='failed'; the
 * thrown error and provider response body are deliberately never persisted.
 */
export function recordFailure(workspace, event = {}, { now = new Date() } = {}) {
  if (typeof event.isLocal !== 'boolean') {
    return { logged: false, file: null, entry: null, reason: `isLocal must be a boolean, got ${JSON.stringify(event.isLocal)}` };
  }
  const { endpointHost, endpoint, redacted } = endpointParts(event.url);
  const entry = {
    schema: PROVENANCE_SCHEMA_VERSION,
    outcome: 'failed',
    timestamp: new Date(now).toISOString(),
    sessionId: String(event.sessionId || processSessionId()),
    provider: providerName(event.providerId, { isLocal: event.isLocal }),
    providerId: String(event.providerId ?? ''),
    model: String(event.model ?? ''),
    endpointHost,
    endpoint,
    isLocal: event.isLocal,
    failureCode: /^[a-z0-9_.-]{1,64}$/u.test(String(event.failureCode ?? '')) ? String(event.failureCode) : 'provider_call_failed',
  };
  if (redacted) entry.redacted = true;
  if (typeof event.routedLocal === 'boolean') entry.routedLocal = event.routedLocal;
  if (event.providerLabel) entry.providerLabel = String(event.providerLabel);
  if (event.tier) entry.tier = String(event.tier);
  if (event.reason) entry.reason = String(event.reason);
  if (Number.isInteger(event.httpStatus) && event.httpStatus >= 100 && event.httpStatus <= 599) entry.httpStatus = event.httpStatus;
  if (Number.isFinite(event.round)) entry.round = Math.trunc(event.round);
  if (Number.isFinite(event.latencyMs)) entry.latencyMs = Math.round(event.latencyMs);
  const missing = REQUIRED.filter((key) => {
    const value = entry[key];
    if (typeof value === 'boolean') return false;
    return value === undefined || value === null || value === '';
  });
  if (missing.length) return { logged: false, file: null, entry, reason: `missing required field(s): ${missing.join(', ')}` };
  const file = provenanceFile(workspace, { now });
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return { logged: true, file, entry, reason: '' };
  } catch (err) {
    return { logged: false, file, entry, reason: `could not append to ${file} (${err.message})` };
  }
}

/**
 * Read completions back — for `helmion provenance`, for the Pilot's Console, and
 * for anyone who has to answer "who answered me in the last hour".
 *
 * A malformed line is REPORTED, not skipped silently, for the same reason
 * readBlockEvents reports it: a log that quietly drops what it cannot parse is
 * not evidence.
 *
 * @param {object} [options]
 * @param {number|null} [options.limit]     newest N, after filtering
 * @param {string|null} [options.provider]  human name: claude|openai|gemini|grok|local|custom
 * @param {boolean|null} [options.isLocal]  true → local only, false → remote only
 * @param {string|null} [options.since]     ISO timestamp, or anything Date.parse takes
 * @param {string|null} [options.sessionId] one session only
 * @returns {{entries: object[], malformed: {file: string, line: number, raw: string}[], files: string[]}}
 */
export function readCompletions(workspace, {
  limit = null, provider = null, isLocal = null, since = null, sessionId = null, outcome = 'completed',
} = {}) {
  const dir = auditDir(workspace);
  let names;
  try {
    names = readdirSync(dir)
      .filter((name) => /^provenance-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort();
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
      if (outcome === 'completed' && parsed.outcome === 'failed') continue;
      if (outcome && outcome !== 'completed' && parsed.outcome !== outcome) continue;
      if (provider && parsed.provider !== provider) continue;
      if (isLocal !== null && Boolean(parsed.isLocal) !== isLocal) continue;
      if (sessionId && parsed.sessionId !== sessionId) continue;
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
 * Counts, for a status panel or a one-line answer.
 *
 * `local` is broken out as its own top-level number rather than left to be
 * summed out of byProvider. The single question this ledger was built to answer
 * fast is "did a local model answer me", and a number a reader has to derive is
 * a number a reader gets wrong.
 */
export function summarizeCompletions(workspace, options = {}) {
  const { entries, malformed, files } = readCompletions(workspace, options);
  const byProvider = {};
  const byModel = {};
  const sessions = new Set();
  let local = 0;
  for (const entry of entries) {
    byProvider[entry.provider] = (byProvider[entry.provider] ?? 0) + 1;
    if (entry.model) byModel[entry.model] = (byModel[entry.model] ?? 0) + 1;
    if (entry.sessionId) sessions.add(entry.sessionId);
    if (entry.isLocal) local += 1;
  }
  return {
    total: entries.length,
    local,
    remote: entries.length - local,
    byProvider,
    byModel,
    sessions: sessions.size,
    malformed: malformed.length,
    files: files.length,
    newest: entries[0]?.timestamp ?? null,
    oldest: entries[entries.length - 1]?.timestamp ?? null,
    bytes: files.reduce((sum, file) => {
      try { return sum + statSync(file).size; } catch { return sum; }
    }, 0),
  };
}

/**
 * "Who answered me?" in one line, from the newest row.
 *
 * Returns null when nothing is recorded — and the CALLER must say so out loud
 * rather than rendering a blank. "Nothing is recorded" and "a frontier model
 * answered" are the two states this whole feature exists to keep apart.
 */
export function lastAnswerer(workspace, options = {}) {
  const { entries } = readCompletions(workspace, { ...options, limit: 1 });
  const entry = entries[0];
  if (!entry) return null;
  return {
    timestamp: entry.timestamp,
    provider: entry.provider,
    model: entry.model,
    isLocal: Boolean(entry.isLocal),
    endpointHost: entry.endpointHost,
    sessionId: entry.sessionId,
    label: `${entry.provider} · ${entry.model}${entry.isLocal ? ' (LOCAL)' : ''}`,
  };
}
