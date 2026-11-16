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
//     decide, exactly as they decide a desktop read-class call. A send
//     is ordinary in that shape only when its target stays inside the
//     tenant's own world — the guarded tier below covers the rest.
//   credential.resolve — evaluated like the others first (a destructive
//     payload or a block rule refuses it on the kernel's own say), and
//     then the vault gate's existing posture is applied at this intent
//     step: a stored credential is revealed only through the credential
//     vault, whose password resolves are Guard-gated
//     (src/cloud/credential-vault.mjs refuses an unapproved resolve), and
//     no Guard approval accompanies a channel ask. So the class refuses
//     here and never reaches an executor as an ordinary job; routing the
//     ask to the vault gate itself is bite 4.
//   charge — the same shape as credential.resolve, for money: evaluated
//     like the others first, then the payment posture is applied at this
//     intent step. A charge or refund is taken only through the
//     Guard-gated payment road, and no Guard approval accompanies a
//     channel ask, so the class refuses here and never reaches an
//     executor as an ordinary job. Before FIX-A4 the classifier had no
//     charge type at all, so a charge ask in any phrasing was ordinary
//     conversation to every layer (AT-4 T11, items C1–C4).
//   send, guarded tier — a send is evaluated like the others first, and
//     then, when the gate allows, the send posture is applied at this
//     intent step (audit bite AT-4, finding T11.4: the send class had
//     no destructive tier, so a typed send was allowed whatever its
//     target). A send whose target stays inside the tenant's own
//     world — the room's own surfaces and people, the destinations the
//     classifier's target vocabulary names — is ordinary, as above. A
//     send whose target leaves that world is not: one naming a mailbox
//     address (the product keeps no tenant-domain registry, so no
//     address can be shown from anything the gate can read to be one
//     of the tenant's own), or one addressing a mass audience (a list,
//     "everyone", a customer list, staff addressed as a group). Those
//     take the same Guard-gated shape credential.resolve gets: the
//     send does not reach a seat as an ordinary job, it waits for the
//     Guard's decision on the approval road, and the outcome record is
//     the attempt's record either way.
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

// The send posture's target tiers. The tenant's own world, as the
// product models it at this layer, is the room: its channels, groups
// and teams, its linked Slack/Discord, and the people in it — the
// destinations envoy-actions.mjs's SEND_TARGET names. Two shapes
// leave that world:
//   external — the ask names a mailbox address. The product keeps no
//     registry of a tenant's own domains, so an address cannot be
//     shown to be internal from anything the gate can read; an
//     addressed send is treated as leaving the room.
//   mass — the ask addresses an audience rather than a destination: a
//     list (a staff list, a customer list, a mailing list), a
//     universal (everyone, everybody, all staff, all customers), or
//     the staff or the company named as a whole group.
const SEND_EXTERNAL_ADDRESS = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/;
const SEND_MASS_AUDIENCE = /\bevery(?:one|body)\b|\b(?:staff|customer|client|employee|member|subscriber|mailing|distribution|email|contact)s?\s+list\b|\blist\s+of\s+(?:all\s+)?(?:staff|customers?|clients?|employees?|members?|subscribers?|users?)\b|\ball\s+(?:the\s+)?(?:staff|employees?|customers?|clients?|subscribers?|users?)\b|\b(?:the\s+)?whole\s+(?:staff|company|office)\b/i;

// Which guarded tier a send's target falls in, if any: { tier,
// target } naming the shape that fired (the address itself, or the
// audience phrase), or null for a send that stays in the room.
function sendTargetTier(text) {
  const address = text.match(SEND_EXTERNAL_ADDRESS);
  if (address) return { tier: 'external', target: address[0] };
  const audience = text.match(SEND_MASS_AUDIENCE);
  if (audience) return { tier: 'mass', target: audience[0].toLowerCase() };
  return null;
}

// What each class is, in the plain words the refusal surface names.
// Exported so bite 3's findings (envoy-findings.mjs) title their rows
// with the same words the channel refusal uses.
export const SEAT_ACTION_NOUN = Object.freeze({
  'credential.resolve': 'revealing a stored credential',
  charge: 'charging or refunding a card',
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
  if (type === 'charge') {
    return outcomeRecord(
      action,
      'refuse',
      'money is charged or refunded only through the Guard-gated payment road, and no '
      + 'Guard approval accompanies a channel ask, so the charge is refused (the payment '
      + 'posture: guard_approval_required)',
      gate,
    );
  }
  if (type === 'send') {
    const guarded = sendTargetTier(text);
    if (guarded) {
      const where = guarded.tier === 'external'
        ? `addressed outside the tenant's own world (to ${guarded.target})`
        : `addressed to a mass audience (${guarded.target})`;
      return outcomeRecord(
        action,
        'refuse',
        `a send ${where} is Guard-gated: sends of this tier go through the Executive Guard `
        + 'approval road, and no Guard approval accompanies a channel ask, so the send is '
        + 'refused here and waits for the Guard decision (the send posture: '
        + 'guard_approval_required)',
        gate,
      );
    }
  }
  return outcomeRecord(action, 'allow', '', gate);
}

/**
 * The refusal as the seat's reply text: what was refused and why, in
 * plain words, carrying the gate's (or the vault posture's) own reason.
 */
export function guardRefusalText(outcome) {
  const what = SEAT_ACTION_NOUN[outcome?.action?.type] ?? 'carrying out this ask';
  const why = outcome?.reason ? ` Why: ${outcome.reason}.` : '';
  return `The Executive Guard refused this ask before it was handed to a seat. What was refused: ${what}.${why} Nothing was run and nothing was changed.`;
}
