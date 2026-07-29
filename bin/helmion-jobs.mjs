#!/usr/bin/env node
/**
 * CLI for the four local background jobs.
 *
 *   node bin/helmion-jobs.mjs start     — turn them on  (detached, silent)
 *   node bin/helmion-jobs.mjs stop      — turn them off
 *   node bin/helmion-jobs.mjs status    — running? findings so far?
 *   node bin/helmion-jobs.mjs run <job> — one shot, prints JSON, changes nothing
 *
 * OFF BY DEFAULT. Nothing starts this. There is no autostart entry, no service
 * registration, no login hook — `start` is the only thing that begins the loop,
 * and `stop` is the only thing needed to end it.
 *
 * `start` DETACHES with stdio 'ignore', so no console window appears and the
 * loop survives this shell closing. `stop` reads the pid file and signals that
 * process; a stale pid file (the process already died) is cleaned up rather
 * than reported as an error.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { loadHelmionEnv } from '../src/agent/env.mjs';
import { pidPath, findingsPath, inboxDir, runForever, runCycle } from '../src/jobs/runner.mjs';
import { triageVerdict } from '../src/jobs/triage.mjs';
import { summarizeDictation } from '../src/jobs/dictation-summary.mjs';
import { describeDiff, formatCommitMessage } from '../src/jobs/commit-message.mjs';
import { scanLogLines, explainFinding } from '../src/jobs/log-monitor.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Reads E:\Helmion\.env so HELMION_LOCAL_ENABLED is honoured the same way the
// agent honours it. applyEnvFile (env.mjs:133-140) does not clobber a variable
// already set in the real environment, so `HELMION_LOCAL_ENABLED=0 helmion-jobs …`
// still wins — which is how the jobs are proven to degrade with the model off.
loadHelmionEnv(ROOT);

function readPid() {
  try {
    const pid = Number(readFileSync(pidPath(ROOT), 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0); // existence probe, sends nothing
    return pid;
  } catch (err) {
    if (err?.code === 'ESRCH') { try { unlinkSync(pidPath(ROOT)); } catch { /* ignore */ } }
    return null;
  }
}

async function readInput(args) {
  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1 && args[fileIdx + 1]) return readFile(args[fileIdx + 1], 'utf8');
  const textIdx = args.indexOf('--input');
  if (textIdx !== -1 && args[textIdx + 1]) return args[textIdx + 1];
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === 'start') {
    const existing = readPid();
    if (existing) { console.log(`already running (pid ${existing})`); return; }
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '__loop'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: ROOT,
    });
    child.unref();
    console.log(`local jobs started (pid ${child.pid}) — silent; findings in ${findingsPath(ROOT)}`);
    return;
  }

  if (cmd === '__loop') {
    const controller = new AbortController();
    process.on('SIGTERM', () => controller.abort());
    process.on('SIGINT', () => controller.abort());
    await runForever({ root: ROOT, signal: controller.signal, projectDirs: projectDirsFromEnv() });
    return;
  }

  if (cmd === 'stop') {
    const pid = readPid();
    if (!pid) { console.log('not running'); return; }
    try { process.kill(pid); } catch { /* already gone */ }
    try { unlinkSync(pidPath(ROOT)); } catch { /* ignore */ }
    console.log(`local jobs stopped (pid ${pid})`);
    return;
  }

  if (cmd === 'status') {
    const pid = readPid();
    const f = findingsPath(ROOT);
    const size = existsSync(f) ? statSync(f).size : 0;
    const lines = size ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    console.log(pid ? `running (pid ${pid})` : 'stopped');
    console.log(`findings: ${lines} in ${f}`);
    console.log(`inbox:    ${inboxDir(ROOT)}`);
    return;
  }

  if (cmd === 'once') {
    console.log(JSON.stringify(await runCycle({ root: ROOT, projectDirs: projectDirsFromEnv() }), null, 2));
    return;
  }

  if (cmd === 'run') {
    const job = args[0];
    const input = await readInput(args.slice(1));
    if (job === 'triage') {
      console.log(JSON.stringify(await triageVerdict(input), null, 2));
    } else if (job === 'dictation') {
      console.log(JSON.stringify(await summarizeDictation(input), null, 2));
    } else if (job === 'commit') {
      const res = await describeDiff(input);
      if (!res.ok) { console.log(JSON.stringify(res, null, 2)); return; }
      const vIdx = args.indexOf('--verification');
      const verification = vIdx !== -1 ? args[vIdx + 1] : '';
      console.log(JSON.stringify(res, null, 2));
      if (verification) {
        console.log('\n--- commit message ---');
        console.log(formatCommitMessage(res.data, verification));
      } else {
        console.log('\n(no --verification given: no commit message assembled — '
          + 'the QA evidence line cannot be written by the model)');
      }
    } else if (job === 'log') {
      const findings = scanLogLines(input);
      const out = [];
      for (const f of findings) out.push(await explainFinding(f));
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.error('run <triage|commit|log|dictation> [--file P | --input T | stdin]');
      process.exitCode = 1;
    }
    return;
  }

  console.log(`helmion-jobs — four local background jobs (Ollama, zero API cost)

  start                  turn them on (detached, silent, no window)
  stop                   turn them off
  status                 running? how many findings?
  once                   run a single cycle in the foreground
  run <job> [input]      one shot; job = triage | commit | log | dictation
                         input = --file <path> | --input <text> | stdin

Requires HELMION_LOCAL_ENABLED=1 and Ollama on 127.0.0.1:11434.
Watched Unity projects: HELMION_UNITY_PROJECTS (semicolon-separated).`);
}

function projectDirsFromEnv() {
  return String(process.env.HELMION_UNITY_PROJECTS || '')
    .split(';').map((s) => s.trim()).filter(Boolean);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exitCode = 1;
});
