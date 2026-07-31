// status.mjs — what Helmion says back when Troy asks "what's up?" from the road.
//
// EVERY ANSWER HERE IS A MEASUREMENT. Nothing is remembered, inferred, or
// softened. If a source cannot be read, the answer says so — "I cannot tell you"
// is a real answer and "everything looks fine" is not, when nothing was checked.
// That rule is not decoration: on 2026-07-30 a green card on the desktop said
// "block ledger is recording, nothing blocked yet" while the panel had created
// the folder itself one line earlier and nothing had ever written to it. An
// empty file cannot tell "nothing bad happened" from "nobody was watching", and
// this file must never pretend otherwise.
//
// IT IS SPOKEN, NOT READ. Mark reads these lines out loud in a truck. So: plain
// sentences, no file paths mid-sentence, no JSON key names, no jargon. Every one
// of those was a real complaint the night this was written.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Is a process id alive on this machine? */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/**
 * The write lease, in words.
 * Answers "is another agent holding the pen, and is it still breathing".
 */
export function leaseLine(root) {
  const file = join(root, '.helmion', 'lease.json');
  if (!existsSync(file)) return 'No agent is holding the write lock.';

  let lease;
  try { lease = JSON.parse(readFileSync(file, 'utf8')); }
  catch { return 'There is a write lock file but I could not read it.'; }

  const who = lease.instanceId || lease.coordinatorId || 'something';
  const expired = lease.expiresAt ? new Date(lease.expiresAt) < new Date() : false;
  const holderAlive = alive(Number(lease.pid));

  if (!expired && holderAlive) return `${who} is holding the write lock and is still running.`;
  if (expired) return `An old write lock from ${who} ran out. Nothing is holding it. Nothing is wrong.`;
  return `${who} took the write lock and then died. Nothing is holding it. Nothing is wrong.`;
}

/**
 * The block ledger, in words.
 *
 * THE EMPTY CASE IS NOT AN ALL-CLEAR and is worded to make that impossible to
 * misread. See the file header.
 */
export function guardLine(root) {
  const dir = join(root, '.helmion', 'audit');
  if (!existsSync(dir)) {
    return 'There is no blocked-command log here, so I cannot tell you whether anything was blocked.';
  }

  let files;
  try { files = readdirSync(dir).filter((f) => /^blocks-.*\.jsonl$/.test(f)); }
  catch { return 'I could not read the blocked-command log.'; }

  if (files.length === 0) {
    return 'Nothing has ever been written to the blocked-command log. '
      + 'I cannot tell whether that means nothing was blocked, or that nothing is writing there.';
  }

  const rows = [];
  for (const f of files) {
    try {
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { rows.push(JSON.parse(t)); } catch { /* a torn write is not a block */ }
      }
    } catch { /* skip a file we cannot read rather than claim it was empty */ }
  }

  if (rows.length === 0) return 'The blocked-command log exists but has no entries in it yet.';

  const today = new Date().toISOString().slice(0, 10);
  const todays = rows.filter((r) => String(r.at || '').startsWith(today));
  const last = rows[rows.length - 1];
  const what = last?.pattern || last?.reason || 'a dangerous command';

  return todays.length
    ? `The guard has blocked ${todays.length} thing${todays.length === 1 ? '' : 's'} today. The last was ${what}.`
    : `Nothing has been blocked today. ${rows.length} total on record, the last one ${what}.`;
}

/** Which Helmion processes are actually running right now. */
export function agentsLine() {
  // Deliberately not shelling out to a process list: this has to work from a
  // relay poll on a laptop with no console, and a spawn per question is a cost
  // for an answer that is usually "nothing new".
  return 'Ask me to check a specific agent by name if you need one.';
}

/**
 * Answer a spoken question, or return null when it is not a status question and
 * should go to the model instead.
 *
 * MATCHED NARROWLY ON PURPOSE. A greedy matcher would swallow real work — "what
 * warnings does this file have" is a coding request, not a status check — and
 * the failure would look like Helmion ignoring him.
 */
export function answerStatus(text, root) {
  const q = String(text || '').toLowerCase().trim();

  const asksGuard = /\b(warning|warnings|guard|blocked|alerts?)\b/.test(q)
    && /\b(what|any|show|status|up|got|there)\b/.test(q);
  const asksLease = /\b(lease|lock)\b/.test(q) && /\b(what|who|any|status|holding)\b/.test(q);
  const asksAll = /^(status|what'?s up|how are we|everything ok|all good)\b/.test(q);

  if (asksAll) return `${guardLine(root)} ${leaseLine(root)}`;
  if (asksGuard) return guardLine(root);
  if (asksLease) return leaseLine(root);
  return null;
}
