/**
 * A throwaway workspace for any test that causes a real completion.
 *
 * WHY EVERY SUCH TEST NEEDS ONE. src/agent/providers.mjs records the provenance
 * of every completion it receives, and when no workspace is supplied it falls
 * back to process.cwd() — deliberately, so that a completion is never left
 * unrecorded just because a caller forgot to thread a path. In the product that
 * fallback is right. In a test run it means `node --test` appends rows to
 * E:\Helmion\.helmion\audit\provenance-*.jsonl, and `helmion provenance` then
 * reports that OpenAI answered Troy at 17:31 when what actually happened was a
 * stub server answering a unit test.
 *
 * A ledger holding invented rows is worse than no ledger: it is evidence that
 * lies. So a test that triggers a completion sends its rows here instead, and
 * the assertions that care read them back from here.
 *
 * Each call makes its own directory, so tests running in parallel cannot read
 * each other's rows.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A fresh workspace directory. Callers clean it up. */
export function makeProvenanceWorkspace(prefix = 'helmion-prov-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Best-effort removal; a locked temp dir must never fail a passing test. */
export function cleanProvenanceWorkspace(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked */ }
}

/**
 * One workspace shared by every test in a file, removed when that file's process
 * exits. For suites where the rows are noise rather than the thing under test.
 */
export function sharedProvenanceWorkspace(prefix) {
  const dir = makeProvenanceWorkspace(prefix);
  process.once('exit', () => cleanProvenanceWorkspace(dir));
  return dir;
}
