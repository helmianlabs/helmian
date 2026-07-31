// DOES THE WORK SURVIVE THE SESSION THAT STARTED IT?
//
// Troy's requirement, in his words: "If I close you out, whatever Maestro I have
// active is coding things."
//
// The lease suite next door (test/lease.test.mjs) spawns twelve real processes
// and proves exactly one wins. It has never once asked what happens when the
// PARENT dies. That is the question here, and it is the only question here.
//
// TWO TESTS, ON PURPOSE.
//
//   1. THE STATUS QUO. A worker wired the way this repo wires one today — its
//      lifetime bounded by stdin — is killed by its parent's death, mid-work,
//      and its checkpoint never lands. This test PASSES before any fix. It is
//      the positive control: without it, a survival test that goes green proves
//      nothing, because it could be green for a reason that has nothing to do
//      with detaching (a parent that failed to die, a race that finished early).
//
//   2. THE REQUIREMENT. A worker spawned detached survives, still holds the
//      lease, and lands its checkpoint. This test FAILS before the fix.
//
// WHAT TEST 1 MODELS, STATED PLAINLY SO NOBODY OVERREADS IT.
//
// It does not run `helmion agent-bridge`. It runs a six-line stand-in for the
// one line that decides the bridge's lifetime:
//
//     src/agent/bridge.mjs:481
//     await new Promise((resolveClose) => rl.once('close', resolveClose));
//
// The real bridge needs an API key, a provider, and a network. Reproducing the
// lifetime rule needs none of those, and the lifetime rule is the entire
// mechanism under test. Modelling it is a deliberate narrowing, not an
// oversight — the cited line is the thing being modelled, and if that line
// changes this comment is wrong.
//
// NOTHING HERE MAY OUTLIVE THE TEST. A detached process is exactly the kind of
// thing that gets orphaned on somebody's machine and quietly holds a lease
// forever. Every path through this file ends in stopAndReap().

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { verifyLeaseHeld } from '../src/core/lease.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const LEASE_URL = pathToFileURL(path.join(REPO, 'src', 'core', 'lease.mjs')).href;
const DETACH_URL = pathToFileURL(path.join(REPO, 'src', 'core', 'detached-worker.mjs')).href;

// Six steps of 400ms. Long enough that killing the parent a few hundred
// milliseconds in lands WELL before the checkpoint would be written, so "the
// checkpoint is missing" means "the worker was killed", not "we looked early".
const WORK_STEPS = 6;
const STEP_MS = 400;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function waitFor(predicate, timeoutMs, everyMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return predicate();
}

/**
 * The unit of work. Takes the lease, works for a couple of seconds renewing it,
 * writes a checkpoint, then HOLDS until told to stop — holding is what lets the
 * test assert "still alive and still holding" rather than "finished and exited",
 * which a dead pid would make indistinguishable from a crash.
 */
function workerSource() {
  return `
import { writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLease, renewLease } from ${JSON.stringify(LEASE_URL)};

const [workspace, mode, stopFile] = process.argv.slice(2);
const at = (name) => join(workspace, name);

try {
  // MODELS src/agent/bridge.mjs:481 — the whole of the bridge's lifetime rule.
  // stdin closes when the parent dies, and the process goes with it.
  if (mode === 'stdin-bound') {
    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.once('close', () => process.exit(0));
  }

  const { record } = acquireLease(workspace, { projectSlug: 'survival' });
  writeFileSync(at('worker.lease'), record.leaseToken, 'utf8');
  writeFileSync(at('worker.pid'), String(process.pid), 'utf8');

  for (let step = 1; step <= ${WORK_STEPS}; step += 1) {
    await new Promise((r) => setTimeout(r, ${STEP_MS}));
    renewLease(workspace, { leaseToken: record.leaseToken });
    appendFileSync(at('work.log'), 'step ' + step + '\\n', 'utf8');
  }

  // THE CHECKPOINT. Written only after every step, so its presence is proof the
  // work ran to completion rather than proof the process merely started.
  writeFileSync(at('checkpoint.json'), JSON.stringify({
    work_completed: 'six steps of survival work',
    steps: ${WORK_STEPS},
    lease_token: record.leaseToken,
    pid: process.pid,
  }, null, 2), 'utf8');

  const deadline = Date.now() + 30000;
  while (!existsSync(stopFile) && Date.now() < deadline) {
    renewLease(workspace, { leaseToken: record.leaseToken });
    await new Promise((r) => setTimeout(r, 100));
  }
} catch (err) {
  try { writeFileSync(at('worker.error'), String(err && err.stack || err), 'utf8'); } catch {}
  process.exitCode = 1;
}
`;
}

/**
 * The parent. Stands in for the Claude Code session: it starts the work, then
 * stays up until somebody kills it. It never exits on its own — every exit in
 * this test is a kill, which is the event under test.
 */
function parentSource() {
  return `
import { spawn } from 'node:child_process';

const [workerScript, workspace, mode, stopFile] = process.argv.slice(2);

let child;
if (mode === 'detached') {
  const { spawnDetachedWorker } = await import(${JSON.stringify(DETACH_URL)});
  child = spawnDetachedWorker({
    script: workerScript,
    args: [workspace, mode, stopFile],
    cwd: workspace,
  });
} else {
  // Exactly how desktop/Helmion.Desktop.Core/AgentBridge.cs:61-73 starts the
  // bridge today: a redirected stdin pipe, no detach, no job object.
  child = spawn(process.execPath, [workerScript, workspace, mode, stopFile], {
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
    cwd: workspace,
  });
}

process.stdout.write('WORKER ' + child.pid + '\\n');
// A TIMER, not a never-resolving promise. A pending promise is not a handle, so
// once spawnDetachedWorker unrefs the child this process has nothing keeping its
// event loop alive and exits on its own — which would make the test measure a
// clean parent exit instead of a KILL. Found by this test failing with ESRCH.
setInterval(() => {}, 1000);
`;
}

/**
 * Run one scenario: start the parent, wait until the worker owns the lease, kill
 * the PARENT, and hand back what survived.
 */
async function killTheParent(mode) {
  const workspace = mkdtempSync(path.join(tmpdir(), `helmion-survive-${mode}-`));
  const workerScript = path.join(workspace, 'worker.mjs');
  const parentScript = path.join(workspace, 'parent.mjs');
  const stopFile = path.join(workspace, 'STOP');
  writeFileSync(workerScript, workerSource(), 'utf8');
  writeFileSync(parentScript, parentSource(), 'utf8');

  const at = (name) => path.join(workspace, name);
  const read = (name) => (existsSync(at(name)) ? readFileSync(at(name), 'utf8').trim() : null);

  const parent = spawn(
    process.execPath,
    [parentScript, workerScript, workspace, mode, stopFile],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: workspace },
  );
  let parentOut = '';
  let parentErr = '';
  parent.stdout.on('data', (c) => { parentOut += c; });
  parent.stderr.on('data', (c) => { parentErr += c; });

  // Surface the parent's stderr on every failure path. A parent that dies on an
  // import error looks identical to a worker that never survived, and telling
  // those apart without this took longer than writing it did.
  const context = () => `mode=${mode} parentStdout=${JSON.stringify(parentOut.trim())} `
    + `parentStderr=${JSON.stringify(parentErr.trim().split('\n').slice(0, 4).join(' | '))} `
    + `workerError=${JSON.stringify(read('worker.error'))}`;

  const stopAndReap = (workerPid) => {
    try { writeFileSync(stopFile, 'over', 'utf8'); } catch { /* ignore */ }
    for (const pid of [workerPid, parent.pid]) {
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
        try { process.kill(pid); } catch { /* already gone */ }
      }
    }
  };

  try {
    // Wait for the lease to be TAKEN, not merely for the process to exist —
    // killing the parent before the worker owns anything would test nothing.
    const started = await waitFor(() => existsSync(at('worker.lease')), 15_000);
    const workerPid = Number(read('worker.pid'));

    if (!started) {
      stopAndReap(workerPid);
      return { started: false, context: context(), workspace, stopAndReap: () => {} };
    }

    // THE EVENT UNDER TEST.
    process.kill(parent.pid);
    await waitFor(() => !pidAlive(parent.pid), 5_000);
    assert.equal(pidAlive(parent.pid), false, `the parent must actually be dead; ${context()}`);

    // Give the work its full remaining span plus slack. In the surviving case
    // the checkpoint lands inside this window; in the killed case nothing ever
    // arrives, and the worker's death is what ends the wait early.
    await waitFor(
      () => existsSync(at('checkpoint.json')) || !pidAlive(workerPid),
      WORK_STEPS * STEP_MS + 6_000,
    );
    // A worker that died can never write the checkpoint later; one that lived
    // may still be a step away from it.
    if (pidAlive(workerPid)) await waitFor(() => existsSync(at('checkpoint.json')), 5_000);

    const leaseToken = read('worker.lease');
    return {
      started: true,
      workerPid,
      workerAlive: pidAlive(workerPid),
      checkpoint: existsSync(at('checkpoint.json'))
        ? JSON.parse(readFileSync(at('checkpoint.json'), 'utf8'))
        : null,
      steps: (read('work.log') ?? '').split('\n').filter(Boolean).length,
      leaseHeld: leaseToken ? verifyLeaseHeld(workspace, { leaseToken }) : null,
      context: context(),
      workspace,
      stopAndReap: () => stopAndReap(workerPid),
    };
  } catch (err) {
    // Reap AND remove. The first version only reaped, so the two runs that threw
    // before returning a result left their workspaces behind in %TEMP% — the
    // test's own `finally` never saw them, because there was no result to clean.
    stopAndReap(Number(read('worker.pid')));
    try { rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }
}

// Cleanup runs AFTER the awaited scenario and after the worker is reaped — the
// lesson test/lease.test.mjs:6-9 paid for, where a synchronous cleanup deleted
// the workspace out from under children that were still starting.
//
// AND IT MUST WAIT FOR THE WORKER TO ACTUALLY DIE. The first version killed and
// deleted in the same tick, which on Windows cannot work: the workspace is the
// worker's cwd, and Windows refuses to remove a directory a live process is
// sitting in. rmSync threw, the catch swallowed it, and three workspaces from
// three GREEN runs were still in %TEMP% afterwards. A leak that only happens on
// the success path is the kind nobody goes looking for.
async function cleanup(result) {
  result.stopAndReap?.();
  if (Number.isInteger(result.workerPid)) {
    await waitFor(() => !pidAlive(result.workerPid), 5_000);
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(result.workspace, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

test('THE STATUS QUO: a stdin-bound worker dies with its parent and its checkpoint never lands', async () => {
  const result = await killTheParent('stdin-bound');
  try {
    assert.equal(result.started, true, `the worker never took the lease; ${result.context}`);
    assert.equal(
      result.workerAlive,
      false,
      `a stdin-bound worker must not outlive its parent; if this passes, the survival `
      + `test below is not measuring what it claims; ${result.context}`,
    );
    assert.equal(
      result.checkpoint,
      null,
      `the killed worker must not have reached its checkpoint; ${result.context}`,
    );
    assert.ok(
      result.steps < WORK_STEPS,
      `the work must have been cut short; it completed ${result.steps} of ${WORK_STEPS} steps`,
    );
  } finally {
    await cleanup(result);
  }
});

test('THE REQUIREMENT: a detached worker survives the parent, keeps the lease, and lands its checkpoint', async () => {
  const result = await killTheParent('detached');
  try {
    assert.equal(result.started, true, `the worker never took the lease; ${result.context}`);
    assert.equal(
      result.workerAlive,
      true,
      `the detached worker must still be running after the parent died; ${result.context}`,
    );
    assert.notEqual(
      result.checkpoint,
      null,
      `the detached worker's checkpoint never landed; ${result.context}`,
    );
    assert.equal(result.checkpoint.steps, WORK_STEPS, 'every step of the work must have run');
    assert.equal(
      result.leaseHeld?.held,
      true,
      `the surviving worker must still hold the write lease; reason=${result.leaseHeld?.reason}`,
    );
    assert.equal(
      result.leaseHeld.record.pid,
      result.workerPid,
      'the lease on disk must still name the surviving worker',
    );
  } finally {
    await cleanup(result);
  }
});
