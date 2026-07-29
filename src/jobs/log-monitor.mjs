/**
 * JOB 3 — LOG / ERROR MONITORING.
 *
 * Watches Unity console output and session logs for known error patterns.
 *
 * ═══ WHY THE MODEL DOES NOT DECIDE WHAT COUNTS AS AN ERROR ═══
 * A monitor that flags everything is worse than no monitor: it trains the
 * reader to ignore it, and then it misses the one that mattered. A 4B model
 * asked "is this line bad?" thousands of times a day will drift, and there is
 * no way to notice the drift without reading every line yourself — which is the
 * job you were trying to avoid.
 *
 * So the decision is DETERMINISTIC. `scanLogLines` is a pure regex matcher: no
 * model, no network, no cost, same answer every time, fully unit-testable in
 * both directions. The local model is only asked to write a one-sentence
 * summary of lines the matcher ALREADY flagged. If the model is down, wrong, or
 * returns garbage, the finding still stands — it just arrives without prose.
 * The model can never create a flag and can never suppress one.
 *
 * ═══ THE PATTERNS ARE ANCHORED, NOT KEYWORD SEARCHES ═══
 * `/error/i` is the naive version and it is wrong: it fires on
 * `Assets/Scripts/ErrorHandler.cs`, on `-logFile unity-error.log`, and on the
 * word "error" inside a benign progress message. Every pattern below is
 * anchored to a shape that only appears in a real failure — `error CS1061`,
 * `NullReferenceException` with a trailing word boundary so
 * `NullReferenceExceptionTests.cs` does not match, `Shader error in` at the
 * start of a line. Each was written against a counter-example first.
 *
 * ═══ WHERE UNITY ACTUALLY WRITES THESE, ON THIS MACHINE ═══
 * Found by listing the directories, not by assuming the documented path:
 *   %LOCALAPPDATA%\Unity\Editor\Editor.log        — the editor console
 *   %LOCALAPPDATA%\Unity\Editor\Editor-prev.log   — previous session
 *   <project>\Logs\AssetImportWorker*.log         — per-project import workers
 * `unityLogPaths()` returns the ones that exist; a machine without Unity gets
 * an empty list and the job does nothing.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runLocalJob, JSON_ONLY } from './local-job.mjs';

export const NAME = 'log-monitor';

/**
 * Known failure shapes. `id` is stable and used for de-duplication.
 *
 * Every entry names the counter-example it was written to survive — the benign
 * line that a looser pattern would have flagged.
 */
export const PATTERNS = Object.freeze([
  // Must not match: "Assets/Scripts/ErrorHandler.cs", "error_log.txt"
  { id: 'cs-compile', severity: 'error', re: /\berror CS\d{3,4}\b/ },
  // Must not match: "NullReferenceExceptionTests.cs", "docs/exceptions.md"
  {
    id: 'runtime-exception',
    severity: 'error',
    re: /\b(?:NullReference|MissingReference|IndexOutOfRange|InvalidOperation|InvalidCast|StackOverflow|FileNotFound|ArgumentNull|ArgumentOutOfRange|Argument)Exception\b(?!\w)/,
  },
  // Must not match: "Compiling shader variants", "shaders/error-fallback.shader"
  { id: 'shader', severity: 'error', re: /^\s*Shader error in\b/m },
  { id: 'unhandled', severity: 'critical', re: /\bUnhandled Exception\b/ },
  { id: 'fatal', severity: 'critical', re: /\bFatal Error\b/i },
  // Must not match: "Assertions enabled", "assert.cs"
  { id: 'assert', severity: 'error', re: /\bAssertion failed\b/i },
  // Must not match: "Import worker 0 ready", "Reloading assemblies"
  { id: 'import-fail', severity: 'error', re: /\b(?:Failed to import|Import error|Asset import failed)\b/i },
  { id: 'missing-script', severity: 'warning', re: /The referenced script .{0,60} is missing/ },
]);

/**
 * Lines that DO hit a pattern but are known noise. Checked after the patterns,
 * so adding one here is an explicit, reviewable suppression rather than a
 * quietly loosened regex.
 */
export const BENIGN_OVERRIDES = Object.freeze([
  // Unity prints its own crash-handler registration on every healthy start.
  /Registering .{0,40}(?:Fatal Error|crash) handler/i,
]);

/**
 * Deterministic scan. Pure: no model, no I/O, no clock.
 *
 * @param {string|string[]} input  log text or lines
 * @returns {Array<{id, severity, line, lineNumber, count}>} one entry per
 *   distinct pattern, carrying the FIRST matching line and how many lines hit
 *   it. Collapsing matters: one compile error repeats across four import
 *   workers, and four identical alerts is how a monitor gets muted.
 */
export function scanLogLines(input) {
  const lines = Array.isArray(input) ? input : String(input ?? '').split(/\r?\n/);
  const byId = new Map();

  lines.forEach((line, i) => {
    if (!line || !line.trim()) return;
    if (BENIGN_OVERRIDES.some((re) => re.test(line))) return;
    for (const p of PATTERNS) {
      if (!p.re.test(line)) continue;
      const hit = byId.get(p.id);
      if (hit) hit.count += 1;
      else byId.set(p.id, { id: p.id, severity: p.severity, line: line.trim().slice(0, 500), lineNumber: i + 1, count: 1 });
    }
  });

  const rank = { critical: 0, error: 1, warning: 2 };
  return [...byId.values()].sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Unity log files that exist on THIS machine. Empty list when Unity is absent. */
export function unityLogPaths(env = process.env, projectDirs = []) {
  const local = env.LOCALAPPDATA;
  const candidates = [];
  if (local) {
    candidates.push(join(local, 'Unity', 'Editor', 'Editor.log'));
    candidates.push(join(local, 'Unity', 'Editor', 'Editor-prev.log'));
  }
  for (const dir of projectDirs) {
    for (let i = 0; i < 4; i += 1) {
      candidates.push(join(dir, 'Logs', `AssetImportWorker${i}.log`));
    }
  }
  return candidates.filter((p) => existsSync(p));
}

export const SCHEMA = Object.freeze({
  severity: { enum: ['critical', 'error', 'warning'] },
  summary: { string: { min: 1, max: 200 } },
});

export const SYSTEM = [
  'You explain a single log line that has ALREADY been identified as an error.',
  'Do not judge whether it is an error — that decision is made.',
  '',
  'summary: one sentence, under 200 characters, saying what went wrong in plain',
  'language. No advice, no speculation about the cause, no code.',
  'severity: critical, error, or warning.',
  JSON_ONLY,
  'Shape: {"severity":"error","summary":"..."}',
].join('\n');

/**
 * Add a human sentence to a finding the matcher already made.
 *
 * The finding's own severity WINS over the model's — the model is allowed to
 * describe, not to re-rank. On any failure the finding is returned unchanged
 * with `summary: null`, so a caller always has the raw line.
 */
export async function explainFinding(finding, opts = {}) {
  const res = await runLocalJob({
    name: NAME,
    system: SYSTEM,
    input: finding.line,
    schema: SCHEMA,
    ...opts,
  });
  return {
    ...finding,
    summary: res.ok ? res.data.summary : null,
    summaryFailure: res.ok ? null : res.skippedReason,
  };
}
