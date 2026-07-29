/**
 * JOB 2 — COMMIT MESSAGES + CHANGELOG.
 *
 * Reads a real diff and writes the "what changed" half of a commit message.
 *
 * ═══ THE LINE THIS JOB MUST NOT CROSS ═══
 * The model writes WHAT CHANGED. It never writes WHAT WAS VERIFIED.
 *
 * `hook_block_commit_qa.ps1:158` gates every commit on the message containing
 * one of `qa|tested|verified|proof`, and the hook's own header explains why:
 * the message must "state what was actually run and what it returned - not that
 * it 'should' work" (hook_block_commit_qa.ps1:176). A language model reading a
 * diff has no idea what was run. If it were allowed to write that line it would
 * write a plausible one, the gate would pass, and the gate would from then on be
 * measuring nothing. So the proof text is a REQUIRED INPUT from the caller, and
 * `formatCommitMessage` throws when it is missing rather than filling it in.
 * The model cannot satisfy the QA gate. Only a caller with real evidence can.
 *
 * ═══ TWO MORE HOOK FACTS, READ OUT OF THE HOOK, NOT ASSUMED ═══
 * 1. QUOTING THE -F PATH BREAKS THE GATE. The hook finds the message file with
 *    `(?:-F|--file)\s+(?!-\s)([^\s"']+)` (hook_block_commit_qa.ps1:117). The
 *    capture class excludes `"` and `'`, so `git commit -F "C:\path\msg.txt"`
 *    matches nothing, the hook reads no message, `$qaFound` is false
 *    (:158) and the commit is BLOCKED (:170-178) — even though the file it
 *    refused to open contained perfect evidence. Pass the path UNQUOTED.
 *    `writeCommitMessageFile` therefore writes to a space-free path.
 * 2. DELETIONS NEED A SEPARATE ACKNOWLEDGEMENT. QA wording alone does not clear
 *    a commit that removes tracked files; the message also needs a literal
 *    `DELETES-FILES:` line (:168, :181-190). `formatCommitMessage` adds one
 *    when the caller reports deletions, and refuses to invent the reason.
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLocalJob, JSON_ONLY } from './local-job.mjs';

export const NAME = 'commit-message';

export const SCHEMA = Object.freeze({
  type: { enum: ['feat', 'fix', 'docs', 'test', 'refactor', 'chore', 'perf'] },
  subject: { string: { min: 3, max: 72 } },
  body: { string: { min: 1, max: 500 } },
  changelog: { array: { of: { string: { min: 1, max: 160 } }, max: 8 } },
});

export const SYSTEM = [
  'You write the descriptive part of a git commit message from a diff.',
  '',
  'Describe ONLY what the diff shows. Never claim anything was tested, run,',
  'verified or proven — you cannot see test output and must not imply you can.',
  'Never mention files that are not in the diff.',
  '',
  'type: one of feat, fix, docs, test, refactor, chore, perf.',
  'subject: imperative mood, under 72 characters, no trailing period.',
  'body: 1-3 plain sentences on what changed and why, under 500 characters.',
  'changelog: one short bullet per distinct change, at most 8.',
  JSON_ONLY,
  'Shape: {"type":"fix","subject":"...","body":"...","changelog":["..."]}',
].join('\n');

/**
 * Trim a diff to something a 4B model can read.
 *
 * Keeps the `diff --git` / `+++` / `---` headers and the changed lines, drops
 * unchanged context. Context is most of a diff's bytes and carries almost none
 * of its meaning for this task.
 */
export function condenseDiff(diff, maxChars = 1800) {
  const kept = String(diff ?? '')
    .split(/\r?\n/)
    .filter((l) => /^(diff --git|\+\+\+|---|@@|[+-])/.test(l))
    .filter((l) => l.trim() !== '+' && l.trim() !== '-')
    .join('\n');
  return kept.length > maxChars ? `${kept.slice(0, maxChars)}\n…[diff trimmed]…` : kept;
}

/** Ask the local model for the descriptive half. */
export async function describeDiff(diff, opts = {}) {
  return runLocalJob({
    name: NAME,
    system: SYSTEM,
    input: condenseDiff(diff),
    schema: SCHEMA,
    ...opts,
  });
}

/**
 * Assemble a commit message that will pass the QA hook.
 *
 * @param {object} described   validated model output (SCHEMA shape)
 * @param {string} verification  what the CALLER actually ran and what it
 *   returned. Real text, real numbers. Required — there is no default.
 * @param {string[]} [deletedFiles]  tracked files this commit removes
 * @param {string} [deletionReason]  why each removal is intended and safe
 * @throws when verification is missing, or when deletions are reported without
 *   a reason. Both are refusals to fabricate, not bugs.
 */
export function formatCommitMessage(described, verification, deletedFiles = [], deletionReason = '') {
  const proof = String(verification ?? '').trim();
  if (!proof) {
    throw new Error(
      'formatCommitMessage: `verification` is required — the model cannot write '
      + 'the QA evidence line (hook_block_commit_qa.ps1:158 gates on real proof).',
    );
  }
  if (deletedFiles.length > 0 && !String(deletionReason).trim()) {
    throw new Error(
      `formatCommitMessage: ${deletedFiles.length} deletion(s) reported without a `
      + 'reason — hook_block_commit_qa.ps1:168 requires an explicit DELETES-FILES: line.',
    );
  }

  const lines = [`${described.type}: ${described.subject}`, '', described.body];
  if (described.changelog?.length) {
    lines.push('', 'Changelog:', ...described.changelog.map((c) => `- ${c}`));
  }
  // The literal word "Verified" is what clears hook_block_commit_qa.ps1:158.
  // It is attached to the caller's text so the word is never present without
  // the evidence it refers to.
  lines.push('', `Verified: ${proof}`);
  if (deletedFiles.length > 0) {
    lines.push('', `DELETES-FILES: ${String(deletionReason).trim()}`, ...deletedFiles.map((f) => `- ${f}`));
  }
  return lines.join('\n');
}

/**
 * Write a message to a path with NO spaces and return it, ready for an
 * UNQUOTED `git commit -F <path>`. See the header note on
 * hook_block_commit_qa.ps1:117 — quoting this path makes the hook block the
 * commit. A path containing a space would force quoting, so one is never used.
 */
export function writeCommitMessageFile(message, dir = tmpdir()) {
  const path = join(dir, `helmion-commit-${Date.now()}.txt`);
  if (/\s/.test(path)) {
    throw new Error(`writeCommitMessageFile: path contains whitespace and would need quoting: ${path}`);
  }
  writeFileSync(path, message, 'utf8');
  return path;
}
