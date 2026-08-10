// WHEN A BACKGROUND AGENT FINISHES, SOMETHING HAS TO SAY SO.
//
// THE GAP THIS CLOSES. Helmion can start work that outlives the session that
// started it — `src/core/detached-worker.mjs:90` spawns it `detached` with
// `stdio:'ignore'` and records a pid at `.helmion/workers/<name>.pid` (:74). Its
// own header states the consequence plainly at :63: "with stdio ignored, a
// detached worker has no channel home. It reports by writing files … or it
// reports nothing at all." The jobs loop makes the same choice even harder —
// `src/jobs/runner.mjs:4-10` is titled "SILENT BY CONSTRUCTION" and says it
// "raises no notification". Both are defensible on their own. Together they
// mean the orchestration product never once tells you your work is done.
//
// THE RULE, TAKEN FROM THE ONE PRODUCT THAT GOT IT RIGHT. Devin's
// `devin.agentNotifications` fires ONE OS notification on "finished OR needs
// input", and nothing else. Not per-step, not per-log-line, not on start. The
// research this repo collected found notifications failing in BOTH directions
// at once — long jobs silently missed while short ones spam — and one rule
// avoids both failure modes simultaneously. So: exactly one notification per
// agent per terminal event, enforced by `notified` below, and no notification
// for anything that is merely still running.
//
// WHY LIVENESS IS POLLED AND NOT AWAITED. The worker is not our child. It was
// deliberately `unref`'d and detached so it survives us, which means there is no
// 'exit' event to listen for — the only honest question is "is that pid still
// alive", and `process.kill(pid, 0)` is how you ask it. A worker that vanishes
// between two polls is finished; that is the whole state machine.
//
// WHAT THIS CANNOT KNOW, STATED RATHER THAN IMPLIED. A dead pid means the
// process ENDED. It does not mean the work SUCCEEDED — nothing in the detached
// contract reports an exit code back, because stdio was thrown away by design.
// So the notification says "finished", never "succeeded", and points at the
// evidence rather than summarising an outcome it did not observe.

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

/** Mirrors `src/core/detached-worker.mjs:71`. */
export const WORKER_DIR = path.join('.helmion', 'workers');

/**
 * A worker announces it is blocked by dropping this next to its pid file.
 *
 * 🔴 CONVENTION WITH NO PRODUCER IN THIS REPO YET — said out loud so nobody
 * reads it as wired. Nothing in Helmion writes a `.needs-input` marker today;
 * the "needs input" half of Devin's rule is implemented and tested here, and
 * the first detached worker that can actually block is expected to write one.
 * A file is the right shape for it because a detached worker's only channel
 * home is the filesystem (`detached-worker.mjs:63`).
 */
export const NEEDS_INPUT_SUFFIX = '.needs-input';

export const DEFAULT_POLL_MS = 5_000;

/** Where the pid files live for a workspace. */
export function workersDir(root) {
  return path.join(path.resolve(root), WORKER_DIR);
}

/**
 * Every worker the registry knows about, with liveness probed rather than
 * assumed — the behaviour of `detached-worker.mjs:133` and
 * `bin/helmion-jobs.mjs:41-51`, kept identical so two parts of the product do
 * not disagree about who is running.
 *
 * @returns {Array<{name: string, pid: number|null, alive: boolean, needsInput: boolean}>}
 */
export function listWorkers(root) {
  const dir = workersDir(root);
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.pid'));
  } catch {
    return []; // no registry yet is not an error; it is the normal empty case
  }
  const out = [];
  for (const file of names) {
    const name = file.slice(0, -'.pid'.length);
    let pid = null;
    try {
      const parsed = Number(readFileSync(path.join(dir, file), 'utf8').trim());
      if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
    } catch { /* unreadable pid file reads as "gone" */ }

    let alive = false;
    if (pid !== null) {
      try {
        process.kill(pid, 0); // existence probe; delivers no signal
        alive = true;
      } catch (err) {
        // EPERM means it exists and belongs to somebody else, which is alive
        // enough — the same call this repo already makes at
        // detached-worker.mjs:148.
        alive = err.code === 'EPERM';
      }
    }
    out.push({
      name,
      pid,
      alive,
      needsInput: existsSync(path.join(dir, `${name}${NEEDS_INPUT_SUFFIX}`)),
    });
  }
  return out;
}

/**
 * Fire a Windows toast without putting a console window on Troy's screen.
 *
 * A visible console window is not a cosmetic problem in this repo: a prior
 * session was KILLED mid-run for surfacing them (SESSION_BOARD row
 * `f3673e34/agent-M-moshi-duplex`). Hence `windowsHide` AND `-WindowStyle
 * Hidden` AND `detached` AND `stdio:'ignore'` — and the notifier is fired and
 * forgotten, never awaited, so a toast subsystem that hangs cannot wedge a
 * voice turn.
 *
 * 🔴 WHAT IS AND IS NOT PROVEN: the tests assert the COMMAND that gets built
 * and that the call is non-throwing and non-blocking. That a toast visibly
 * appeared on Troy's screen is not something a test on this machine can
 * assert, and no test here claims it.
 */
export function deliverOsNotification({ title, body, spawnFn = spawn } = {}) {
  if (process.platform !== 'win32') return { delivered: false, reason: 'not windows' };
  const escape = (s) => String(s ?? '').replace(/'/g, "''");
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null;',
    '$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(',
    '[Windows.UI.Notifications.ToastTemplateType]::ToastText02);',
    `$n=$t.GetElementsByTagName('text');`,
    `$n.Item(0).AppendChild($t.CreateTextNode('${escape(title)}')) > $null;`,
    `$n.Item(1).AppendChild($t.CreateTextNode('${escape(body)}')) > $null;`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Helmion').Show(`,
    '[Windows.UI.Notifications.ToastNotification]::new($t));',
  ].join(' ');
  try {
    const child = spawnFn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true, detached: true, stdio: 'ignore' },
    );
    child.unref?.();
    return { delivered: true, reason: '' };
  } catch (err) {
    // A failed toast must never propagate. The durable record is the real
    // deliverable; the toast is the courtesy on top of it.
    return { delivered: false, reason: err?.message ?? 'spawn failed' };
  }
}

/** One short sentence, for a voice that must not monologue. */
export function summarizeEvent({ name, event, pid }) {
  if (event === 'needs-input') {
    return `The background agent ${name} is waiting on you before it can carry on.`;
  }
  return `The background agent ${name} has finished${pid ? '' : ''}. `
    + 'I did not see how it ended, so check the activity log for what it left behind.';
}

/**
 * The watcher.
 *
 * Deliberately POLL-ON-DEMAND as well as on a timer: `poll()` is exported and
 * synchronous-ish so a test drives the exact transitions it wants instead of
 * sleeping and hoping, which is the difference between a test that proves the
 * one-notification rule and a test that usually passes.
 *
 * @param {object} options
 * @param {string} options.root workspace whose `.helmion/workers` is watched
 * @param {(n: object) => void} [options.deliver] where a notification goes
 * @param {(text: string) => boolean} [options.speak] say it out loud; returns
 *   whether it was actually spoken. Wired by the CLM server to a live socket.
 * @param {() => boolean} [options.isBusy] true while a voice turn is in flight
 */
export function createBackgroundAgentNotifier({
  root,
  deliver = null,
  speak = null,
  isBusy = () => false,
  pollMs = DEFAULT_POLL_MS,
  logger = () => {},
} = {}) {
  /** Workers seen ALIVE at least once. Only these can later "finish". */
  const seenAlive = new Map(); // name -> pid
  /** `${name}:${pid}:${event}` for every notification already fired. THE Devin rule. */
  const notified = new Set();
  /** Notifications that could not be spoken yet, drained at the next turn. */
  const pendingSpoken = [];
  let timer = null;
  let started = false;

  const fire = (entry) => {
    const key = `${entry.name}:${entry.pid ?? 'none'}:${entry.event}`;
    // THE ONE-NOTIFICATION RULE, in one line. Every later poll sees the same
    // finished worker and must stay silent about it forever.
    if (notified.has(key)) return null;
    notified.add(key);

    const notification = {
      name: entry.name,
      pid: entry.pid ?? null,
      event: entry.event,
      at: new Date().toISOString(),
      title: entry.event === 'needs-input'
        ? `Helmion — ${entry.name} needs input`
        : `Helmion — ${entry.name} finished`,
      body: summarizeEvent(entry),
      spoken: false,
    };

    // The OS notification ALWAYS fires. It is the half that works when Troy is
    // in another window, which is the entire situation this feature exists for.
    try {
      (deliver ?? ((n) => deliverOsNotification({ title: n.title, body: n.body })))(notification);
    } catch (err) {
      logger({ level: 'warn', event: 'notify_deliver_failed', message: err?.message });
    }

    // Speaking is the half that must NOT barge in. A turn in flight owns the
    // conversation; interrupting it would talk over the answer Troy asked for,
    // so the line waits and is said at the start of the next turn instead.
    if (isBusy()) {
      pendingSpoken.push(notification.body);
      logger({ level: 'debug', event: 'notify_deferred_speech', name: entry.name });
    } else if (speak) {
      let said = false;
      try { said = Boolean(speak(notification.body)); } catch { said = false; }
      notification.spoken = said;
      if (!said) pendingSpoken.push(notification.body);
    } else {
      pendingSpoken.push(notification.body);
    }

    logger({ level: 'info', event: 'notified', name: entry.name, kind: entry.event, spoken: notification.spoken });
    return notification;
  };

  return {
    /** @returns {Array<object>} notifications fired by THIS poll (usually none). */
    poll() {
      const fired = [];
      const workers = listWorkers(root);
      const present = new Set(workers.map((w) => w.name));

      for (const worker of workers) {
        if (worker.alive) {
          seenAlive.set(worker.name, worker.pid);
          if (worker.needsInput) {
            const n = fire({ name: worker.name, pid: worker.pid, event: 'needs-input' });
            if (n) fired.push(n);
          }
          continue;
        }
        // A pid file whose process is gone. Only counts as "finished" if this
        // watcher ever saw it running — otherwise it is a stale file from a
        // previous boot, and announcing it would be announcing history.
        if (seenAlive.has(worker.name)) {
          const pid = seenAlive.get(worker.name);
          const n = fire({ name: worker.name, pid, event: 'finished' });
          if (n) fired.push(n);
          seenAlive.delete(worker.name);
          try { rmSync(path.join(workersDir(root), `${worker.name}.pid`), { force: true }); } catch { /* ignore */ }
        }
      }

      // The pid file was removed outright — `stopDetachedWorker` does exactly
      // this (detached-worker.mjs:166), so a worker stopped on purpose still
      // reports, rather than disappearing without a word.
      for (const [name, pid] of [...seenAlive]) {
        if (present.has(name)) continue;
        const n = fire({ name, pid, event: 'finished' });
        if (n) fired.push(n);
        seenAlive.delete(name);
      }
      return fired;
    },

    /**
     * Lines that were never spoken, handed over exactly once. The CLM server
     * drains this at the START of a turn so Troy hears about finished work in
     * the same breath as his answer, instead of never.
     */
    drainSpoken() {
      const out = pendingSpoken.slice();
      pendingSpoken.length = 0;
      return out;
    },

    start() {
      if (started) return;
      started = true;
      // Baseline first: everything already running is recorded as alive so the
      // very first tick cannot report a worker that started before we did.
      this.poll();
      timer = setInterval(() => {
        try { this.poll(); } catch (err) {
          logger({ level: 'warn', event: 'notify_poll_failed', message: err?.message });
        }
      }, pollMs);
      // Never hold the process open for a courtesy feature.
      timer.unref?.();
    },

    stop() {
      started = false;
      if (timer) clearInterval(timer);
      timer = null;
    },

    /** Test/inspection surface — never used on the live path. */
    stats() {
      return { tracked: seenAlive.size, notified: notified.size, pendingSpoken: pendingSpoken.length };
    },
  };
}
