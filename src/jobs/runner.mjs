/**
 * The always-on loop that drives the four jobs.
 *
 * ═══ SILENT BY CONSTRUCTION ═══
 * This process has no console window, prints nothing on a normal cycle, and
 * raises no notification. Findings are APPENDED TO A FILE and wait to be read.
 * That is deliberate: recurring background chatter gets muted, and a muted
 * monitor is a dead one. The only thing written to stderr is a genuine runner
 * fault (cannot write its own state directory), because a monitor that has
 * stopped monitoring must not do so quietly.
 *
 * ═══ IT CANNOT BLOCK ANYTHING ═══
 * Nothing calls into this loop. It owns no lock, holds no handle open across a
 * cycle, and never touches the git index or the agent's turn path. A cycle that
 * throws is caught, counted, and forgotten. If the local model is down every
 * job degrades to a no-op and the loop keeps ticking at the same rate — there
 * is no retry storm, because each cycle simply tries once.
 *
 * ═══ IT ONLY EVER READS NEW BYTES ═══
 * Editor.log is 715 KB and grows; re-scanning it every minute would re-flag the
 * same compile error forever. State (`.helmion/jobs/state.json`) records the
 * byte offset reached in each file. A file that SHRANK was rotated, so the
 * offset resets to 0. A file that has not grown is not opened at all.
 */

import {
  appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync,
  readFileSync, writeFileSync, statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { scanLogLines, explainFinding, unityLogPaths } from './log-monitor.mjs';
import { summarizeDictation } from './dictation-summary.mjs';
import { triageVerdict } from './triage.mjs';

export const DEFAULT_INTERVAL_MS = 60_000;
/** Never read more than this from one file in one cycle. */
const MAX_TAIL_BYTES = 256 * 1024;

export function jobsDir(root) { return join(root, '.helmion', 'jobs'); }
export function findingsPath(root) { return join(jobsDir(root), 'findings.jsonl'); }
export function statePath(root) { return join(jobsDir(root), 'state.json'); }
export function pidPath(root) { return join(jobsDir(root), 'runner.pid'); }
export function inboxDir(root) { return join(jobsDir(root), 'inbox'); }

function ensureDir(p) { if (!existsSync(p)) mkdirSync(p, { recursive: true }); }

export function readState(root) {
  try { return JSON.parse(readFileSync(statePath(root), 'utf8')); } catch { return { offsets: {} }; }
}
export function writeState(root, state) {
  ensureDir(jobsDir(root));
  writeFileSync(statePath(root), JSON.stringify(state, null, 2), 'utf8');
}

/** Append one finding. Best-effort: a failed write must not kill the loop. */
export function recordFinding(root, finding) {
  try {
    ensureDir(jobsDir(root));
    appendFileSync(findingsPath(root), `${JSON.stringify({ at: new Date().toISOString(), ...finding })}\n`, 'utf8');
    return true;
  } catch { return false; }
}

/**
 * Read only the bytes appended since last cycle.
 * @returns {{text: string, offset: number}}
 */
export function readNewBytes(file, previousOffset) {
  let size;
  try { size = statSync(file).size; } catch { return { text: '', offset: previousOffset }; }
  // Rotated or truncated — start over rather than seeking past the end.
  const from = size < previousOffset ? 0 : previousOffset;
  if (size <= from) return { text: '', offset: size };
  const start = Math.max(from, size - MAX_TAIL_BYTES);
  const length = size - start;
  const buf = Buffer.alloc(length);
  let fd;
  try {
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, length, start);
  } catch {
    return { text: '', offset: previousOffset };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
  return { text: buf.toString('utf8'), offset: size };
}

/**
 * One pass. Returns a count summary; writes findings to disk.
 * Never throws — every job is individually guarded.
 */
export async function runCycle({
  root,
  env = process.env,
  projectDirs = [],
  jobOpts = {},
} = {}) {
  const state = readState(root);
  state.offsets = state.offsets || {};
  const counts = { logFindings: 0, dictations: 0, errors: 0 };

  // ---- Job 3: log monitoring -------------------------------------------
  for (const file of unityLogPaths(env, projectDirs)) {
    try {
      const { text, offset } = readNewBytes(file, state.offsets[file] || 0);
      state.offsets[file] = offset;
      if (!text) continue;
      for (const finding of scanLogLines(text)) {
        const explained = await explainFinding(finding, jobOpts);
        recordFinding(root, { job: 'log-monitor', file, ...explained });
        counts.logFindings += 1;
      }
    } catch { counts.errors += 1; }
  }

  // ---- Jobs 1 + 4: dictation dropped into the inbox ---------------------
  // A .txt written here is triaged and summarized, then renamed .done. The raw
  // file is never deleted — a compressed note must stay re-checkable.
  try {
    ensureDir(inboxDir(root));
    const { readdirSync, renameSync } = await import('node:fs');
    for (const name of readdirSync(inboxDir(root)).filter((n) => n.endsWith('.txt'))) {
      const full = join(inboxDir(root), name);
      const raw = readFileSync(full, 'utf8');
      const [triage, summary] = await Promise.all([
        triageVerdict(raw, jobOpts),
        summarizeDictation(raw, jobOpts),
      ]);
      recordFinding(root, {
        job: 'dictation',
        source: full,
        verdict: triage.verdict,
        triage: triage.data,
        summary: summary.ok ? summary.data : null,
        summaryFailure: summary.ok ? null : summary.skippedReason,
        originalChars: summary.originalChars,
        summaryChars: summary.summaryChars,
      });
      renameSync(full, `${full}.done`);
      counts.dictations += 1;
    }
  } catch { counts.errors += 1; }

  writeState(root, state);
  return counts;
}

/**
 * The loop. Resolves only when `signal` aborts.
 * A cycle that throws is swallowed; the interval never changes.
 */
export async function runForever({
  root,
  intervalMs = DEFAULT_INTERVAL_MS,
  signal,
  ...rest
} = {}) {
  ensureDir(jobsDir(root));
  try { writeFileSync(pidPath(root), String(process.pid), 'utf8'); } catch { /* ignore */ }
  while (!signal?.aborted) {
    try { await runCycle({ root, ...rest }); } catch { /* a cycle never kills the loop */ }
    await new Promise((resolve) => {
      const t = setTimeout(resolve, intervalMs);
      signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}

export { ensureDir, dirname };
