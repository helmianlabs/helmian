// Envoy Guard evaluation: the second step of the Guard spine
// (GUARD-TRACE-2026-11-06, bite 2 — findings G1 and G4).
//
// Bite 1 (envoy-actions.mjs) classifies a seat ask into a typed action and
// stamps it on the work item. This module is the evaluation that stamp
// exists for: before the mesh hands a work item to an executor
// (envoy-mesh.mjs agentWork), the typed action is run through the SAME
// governance gate the desktop paths call — evaluateToolCall in
// src/core/governance-gate.mjs, fed the same contract src/agent/tools.mjs
// feeds it (tool, args, workspace, projectSlug, leaseToken). The kernel's
// own tiers decide, in the kernel's own order: destructive patterns over
// the payload, the promoted rules for the workspace, then the write-lease
// tier for mutating tools. Nothing here adds a pattern, and nothing here
// renames a call to step around a refusal the gate would have given.
//
// How a typed action is presented to the gate follows what completing it
// would be:
//
//   file.delete, shell — completion is a mutating execution outside the
//     channel, so the call is the gate's command tool, run_command, with
//     the ask text as the command. Command-shaped destruction is blocked
//     by the kernel with the pattern named. A plain-words destructive ask
//     passes the pattern tier and reaches the lease tier, where it is
//     refused: a channel dispatch holds no write lease (leaseToken is
//     null, stated rather than hidden), and the gate fails closed on a
//     mutating call nobody holds the lease for. These asks are not dead —
//     their road is the hands / Guard-service path with its own approvals,
//     not an ordinary channel job.
//   file.write, send — completion is the seat's reply in the channel (the
//     workbench renders what seats post; the bridge mirrors it), so the
//     call carries the action's own name. The gate has no lease rule for
//     such calls; the destructive tier and the tenant's promoted rules
//     decide, exactly as they decide a desktop read-class call.
//   credential.resolve — evaluated like the others first (a destructive
//     payload or a block rule refuses it on the kernel's own say), and
//     then the vault gate's existing posture is applied at this intent
//     step: a stored credential is revealed only through the credential
//     vault, whose password resolves are Guard-gated
//     (src/cloud/credential-vault.mjs refuses an unapproved resolve), and
//     no Guard approval accompanies a channel ask. So the class refuses
//     here and never reaches an executor as an ordinary job; routing the
//     ask to the vault gate itself is bite 4.
//   chat — the null action. It is never evaluated and leaves no record.
//
// The verdict becomes an outcome record: { action, verdict, reason,
// match, hits, flags, failedClosed }. The mesh carries it on the work
// item when the ask is allowed, and on the refusal message when it is
// not, so the next bite can ingest every evaluation into the Guard
// findings feed from the records alone. This module writes nothing: no
// findings (that is bite 3's wire), no block-ledger file (auditWorkspace
// is deliberately not passed — the ledger is the desktop paths' road).

import { evaluateToolCall } from '../core/governance-gate.mjs';

// The classes whose completion is a mutating execution outside the
// channel. They are evaluated under the gate's command tool so the full
// gate profile — patterns, rules, and the write lease — applies to them.
const COMMAND_PROFILE = new Set(['file.delete', 'shell']);

// What each class is, in the plain words the refusal surface names.
const CLASS_NOUN = Object.freeze({
  'credential.resolve': 'revealing a stored credential',
  'file.delete': 'deleting files',
  'file.write': 'writing a file',
  send: 'sending a message onward',
  shell: 'running a command',
});

function outcomeRecord(action, verdict, reason, gate) {
  return Object.freeze({
    action: Object.freeze({ type: action.type, match: action.match ?? null }),
    verdict,
    reason,
    match: action.match ?? null,
    hits: Object.freeze([...(gate?.hits ?? [])]),
    flags: Object.freeze([...(gate?.flags ?? [])]),
    failedClosed: Boolean(gate?.failedClosed),
  });
}

/**
 * Evaluate one classified seat ask. Returns null for the chat (null)
 * action — no evaluation happens and no record exists. For every typed
 * action it returns a frozen outcome record whose verdict is 'allow' or
 * 'refuse'. The gate is written never to throw; if it ever does, the
 * verdict is a fail-closed refusal, mirroring src/agent/tools.mjs.
 */
export function evaluateSeatAction(action, { body = '', workspace } = {}) {
  const type = action?.type ?? 'chat';
  if (type === 'chat') return null;
  const text = String(body ?? '');
  const tool = COMMAND_PROFILE.has(type) ? 'run_command' : type;
  let gate;
  try {
    gate = evaluateToolCall({
      tool,
      args: { command: text, action: type, match: action.match ?? null },
      workspace,
      projectSlug: null,
      // A channel dispatch holds no project write lease. Stated, not
      // hidden: for the command-profile classes this is what the lease
      // tier will refuse on, and the refusal reason says so.
      leaseToken: null,
    });
  } catch (err) {
    gate = {
      allowed: false,
      reason: `the governance gate itself failed (${err.message}); governance fails closed`,
      hits: [],
      blocks: [],
      flags: [],
      failedClosed: true,
    };
  }
  if (!gate.allowed) return outcomeRecord(action, 'refuse', gate.reason, gate);
  if (type === 'credential.resolve') {
    return outcomeRecord(
      action,
      'refuse',
      'a stored credential is revealed only through the credential vault, whose password '
      + 'resolves are Guard-gated, and no Guard approval accompanies a channel ask, so the '
      + 'resolve is refused (the vault posture: guard_approval_required)',
      gate,
    );
  }
  return outcomeRecord(action, 'allow', '', gate);
}

/**
 * The refusal as the seat's reply text: what was refused and why, in
 * plain words, carrying the gate's (or the vault posture's) own reason.
 */
export function guardRefusalText(outcome) {
  const what = CLASS_NOUN[outcome?.action?.type] ?? 'carrying out this ask';
  const why = outcome?.reason ? ` Why: ${outcome.reason}.` : '';
  return `The Executive Guard refused this ask before it was handed to a seat. What was refused: ${what}.${why} Nothing was run and nothing was changed.`;
}
