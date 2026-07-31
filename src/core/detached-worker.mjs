// WORK THAT OUTLIVES THE SESSION THAT STARTED IT.
//
// Troy's requirement: "If I close you out, whatever Maestro I have active is
// coding things." Before this file, nothing in this repo could do that. Measured
// 2026-07-30:
//
//   - Every executor was bound to stdin. `src/agent/bridge.mjs:481` is the whole
//     lifetime rule in one line — `rl.once('close', resolveClose)` — so when the
//     parent dies the pipe closes and the process goes with it. (That line was
//     at :463 when this was written and moved to :481 within the hour, because
//     another session was editing the same file. Grep the call, not the number.)
//   - `desktop/Helmion.Desktop.Core/AgentBridge.cs:525` kills the bridge with
//     `Kill(entireProcessTree: true)`.
//   - `desktop/Helmion.LocalService/Program.cs:10-30` takes a `--parent-pid` and
//     cancels ITSELF when that parent exits.
//
// Three independent mechanisms, all pointing the same way. Surviving is not a
// missing flag; it was a deliberate posture, and this is the first thing in the
// repo that opts out of it.
//
// THE PATTERN IS NOT NEW HERE. `bin/helmion-jobs.mjs:69-75` has been starting a
// surviving background process this way since 2026-07-29. Nothing about that is
// invented; the only thing missing was a caller that pointed it at real work.
// This file is that pattern, extracted, with the one thing the jobs runner has
// and an inline spawn does not: a pid file, so a process that outlives its
// parent can still be FOUND and STOPPED by whoever comes next.
//
// TWO OF THESE OPTIONS CARRY THE SURVIVAL, AND IT IS BOTH OF THEM. Measured on
// this machine 2026-07-30, four variants, parent killed 700ms in, "did the work
// finish" as the outcome:
//
//   detached:true  + stdio:'ignore'   → YES     ← the only one that works
//   detached:FALSE + stdio:'ignore'   → no
//   detached:true  + stdin pipe       → no
//   detached:FALSE + stdin pipe       → no      (today's bridge)
//
// So this is not one flag with three pieces of ceremony around it. Drop EITHER
// and the work dies, for two unrelated reasons:
//
//   detached: true    without it the child does not survive its parent's death
//                     on Windows even with no pipes at all. I measured the
//                     necessity; I did not chase the mechanism, and I am not
//                     going to claim one I did not verify.
//   stdio: 'ignore'   an inherited stdin pipe closes when the parent dies, and
//                     that is precisely what kills the bridge at
//                     `src/agent/bridge.mjs:481`. A detached child still holding
//                     one dies anyway — row 3 above.
//
// The other two are not about survival at all:
//
//   windowsHide: true no console window. A detached process that flashes a
//                     window onto Troy's screen is worse than no feature
//   child.unref()     drops the child from the parent's event loop so the PARENT
//                     can exit. Costs nothing here and matters to callers who
//                     want to exit cleanly rather than be killed.
//
// If you ever add a pipe to this — for logs, for progress, for anything — you
// have silently turned survival back off. That is row 3, and no test currently
// guards it. Reproduce the table before believing otherwise.
//
// CONSEQUENCE THE CALLER MUST DESIGN FOR: with stdio ignored, a detached worker
// has no channel home. It reports by writing files, the way
// `src/jobs/runner.mjs:56` records findings, or it reports nothing at all. A
// worker that throws into a closed stdout is a silent failure, so anything
// started through here owns its own durable error path.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const WORKER_DIR = path.join('.helmion', 'workers');

/** Where a worker's pid is recorded. Mirrors `src/jobs/runner.mjs:43`. */
export function workerPidPath(root, name = 'worker') {
  return path.join(root, WORKER_DIR, `${name}.pid`);
}

/**
 * Start work that survives this process exiting.
 *
 * @param {object} options
 * @param {string} options.script     absolute path to the module to run
 * @param {string[]} [options.args]   arguments passed to it
 * @param {string} [options.cwd]      working directory (defaults to `root`)
 * @param {string} [options.root]     where the pid file lives (defaults to `cwd`)
 * @param {string} [options.name]     pid file name, so two workers can coexist
 * @param {object} [options.env]      extra environment for the child
 * @returns {import('node:child_process').ChildProcess} unref'd; `.pid` is the handle
 */
export function spawnDetachedWorker({
  script,
  args = [],
  cwd = process.cwd(),
  root = null,
  name = 'worker',
  env = null,
} = {}) {
  if (!script || typeof script !== 'string') {
    throw new TypeError('a detached worker needs the path of a script to run');
  }
  const stateRoot = root ?? cwd;

  const child = spawn(process.execPath, [script, ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
  });

  // Record the pid BEFORE unref'ing. A surviving process nobody can name is not
  // a feature, it is a leak — this file is the only thing that will ever know
  // where it went.
  try {
    mkdirSync(path.dirname(workerPidPath(stateRoot, name)), { recursive: true });
    writeFileSync(workerPidPath(stateRoot, name), String(child.pid), 'utf8');
  } catch {
    // A pid file we cannot write costs us the ability to stop it later; it does
    // not make the work invalid. The caller still holds `child.pid`.
  }

  child.unref();
  return child;
}

/**
 * Who is still running? Probes liveness rather than trusting the file, and
 * clears a stale pid instead of reporting it — the behaviour of
 * `bin/helmion-jobs.mjs:41-51`.
 *
 * @returns {number|null} a live pid, or null
 */
export function readWorkerPid(root, name = 'worker') {
  const file = workerPidPath(root, name);
  if (!existsSync(file)) return null;
  let pid;
  try {
    pid = Number(readFileSync(file, 'utf8').trim());
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0); // existence probe; sends nothing
    return pid;
  } catch (err) {
    // EPERM means it exists and belongs to somebody else, which is alive enough.
    if (err.code === 'EPERM') return pid;
    try { rmSync(file, { force: true }); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Stop a surviving worker. Safe to call when nothing is running — a stale pid
 * file is cleaned up rather than reported as a failure.
 */
export function stopDetachedWorker(root, name = 'worker') {
  const pid = readWorkerPid(root, name);
  if (pid === null) return { stopped: false, pid: null, reason: 'no worker was running' };
  try {
    process.kill(pid);
  } catch {
    // Already gone between the probe and the signal. Still a success.
  }
  try { rmSync(workerPidPath(root, name), { force: true }); } catch { /* ignore */ }
  return { stopped: true, pid, reason: '' };
}
