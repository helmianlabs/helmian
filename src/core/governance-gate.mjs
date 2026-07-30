import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { collectStrings, detectDestructiveOperation, evaluateRules } from './governance.mjs';
import { LAYER, recordBlockEvent } from './audit-log.mjs';
import { verifyLeaseHeld } from './lease.mjs';

/**
 * The seam between the governance kernel and anything that actually executes.
 *
 * `governance.mjs` decides; this module is how a caller ASKS. Before this
 * existed the kernel had exactly one caller — the `helmion guard` subcommand,
 * driven by an external PreToolUse hook — so an agent running through
 * `src/agent/tools.mjs` was ungoverned: the destructive-operation detector was
 * dead code on that path.
 *
 * SECURITY POSTURE: FAIL CLOSED. Every outcome that is not a positive,
 * completed "the kernel evaluated this and found nothing to block" is a
 * refusal. An unreadable rule set, a rule whose regular expression does not
 * compile, a rule entry with no usable pattern, a kernel that throws — all
 * refuse. There is deliberately no branch that reaches an execution because
 * the check could not be completed.
 *
 * This is a HARD block and it is not the human-approval tier. `approval.mjs`
 * asks a person; this refuses outright, and it runs first precisely so that a
 * person cannot approve something the kernel forbids.
 */

/** Marker every refusal carries, so callers and tests can recognise one. */
export const GOVERNANCE_BLOCK_MARKER = 'BLOCKED by Helmion governance';

/**
 * The tools that MUTATE, and therefore the tools that need the project's write
 * lease.
 *
 * WHY THIS EXISTS. `README.md:19` advertises "a database-enforced single active
 * write lease per project" and the desktop UI repeats it as a "Lease invariant".
 * Measured 2026-07-29, neither was true of a file write:
 *
 *   - `requireActiveLease` (src/adapters/neon.mjs:151) had exactly four callers
 *     — :736, :875, :923, :978 — and every one is a Postgres write to Helmion's
 *     own coordination tables. Not one guards a file write.
 *   - `grep -c lease` over src/agent/tools.mjs and this file returned 0 and 0.
 *
 * So the invariant was a sentence. This set is where it becomes a mechanism.
 *
 * It deliberately mirrors `src/agent/tools.mjs:22` WRITE_TOOLS, which until now
 * was a dead policy table kept alive by a `void WRITE_TOOLS;` statement at :492
 * purely so lint would not drop it. Read tools are absent on purpose: reading a
 * file cannot conflict with another writer, and requiring a lease to read would
 * make a second session useless rather than safe.
 *
 * NOT included: Claude Code's own tool names (Write, Edit, Bash). The
 * `helmion guard` hook path shares this evaluator, and adding those would make
 * every Claude Code write in every workspace require a Helmion lease. That is a
 * deliberate scope line, not an oversight — the agent runtime is governed, the
 * host harness is not, and enabling it needs a decision rather than a commit.
 */
export const LEASE_REQUIRED_TOOLS = new Set(['write_file', 'run_command']);

/** True when this tool may not proceed without a held write lease. */
export function requiresWriteLease(tool) {
  return LEASE_REQUIRED_TOOLS.has(String(tool ?? ''));
}

/**
 * Same resolution order as `bin/helmion.mjs` loadRules: an explicit
 * HELMION_RULES_PATH wins, otherwise `<base>/.helmion/autonomy_rules.json`.
 * `bin/helmion.mjs` passes process.cwd(); the agent runtime passes its
 * workspace root, because a workspace-confined agent must be governed by the
 * rules of the project it is editing, not of whatever directory Helmion
 * happened to be launched from.
 */
export function resolveRulesPath(baseDir = process.cwd()) {
  const override = process.env.HELMION_RULES_PATH;
  if (override) return resolve(override);
  return join(resolve(baseDir), '.helmion', 'autonomy_rules.json');
}

/**
 * Read the promoted rules. Accepts the three shapes `bin/helmion.mjs` accepts:
 * a bare array, `{promoted_rules: [...]}`, or `{rules: [...]}`.
 *
 * An ABSENT file returns [] — that is a defined state in the existing contract
 * (bin/helmion.mjs:405), not a failure, and it does not disable governance:
 * the built-in destructive-pattern kernel still runs. Anything else that goes
 * wrong THROWS, and every caller here treats a throw as a refusal.
 */
export function loadPromotedRules(baseDir = process.cwd()) {
  const path = resolveRulesPath(baseDir);
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const rules = Array.isArray(parsed) ? parsed : parsed?.promoted_rules ?? parsed?.rules ?? [];
  if (!Array.isArray(rules)) {
    throw new TypeError(`promoted rules in ${path} are not a list`);
  }
  return rules;
}

/**
 * Refuse a rule set that cannot be evaluated exactly as written.
 *
 * `evaluateRules` downgrades an unparseable pattern to a FLAG (governance.mjs:
 * 208-212). That is right for a reporting hook and wrong for an execution
 * gate: a rule an operator wrote to BLOCK would silently become a no-op
 * because of one typo, and the work it was written to stop would run. Here a
 * rule that cannot be compiled makes the whole call refuse.
 */
export function assertRulesUsable(rules, path) {
  rules.forEach((rule, index) => {
    const where = `${path} rule #${index + 1}`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new TypeError(`${where} is not a rule object`);
    }
    if (typeof rule.pattern !== 'string' || !rule.pattern.trim()) {
      throw new TypeError(`${where} has no usable pattern string`);
    }
    try {
      // eslint-disable-next-line no-new
      new RegExp(rule.pattern, rule.flags ?? 'i');
    } catch (err) {
      throw new SyntaxError(
        `${where} has an invalid regular expression (${rule.pattern}): ${err.message}`,
      );
    }
  });
  return rules;
}

function refuse(reason, extra = {}) {
  return {
    allowed: false, reason, hits: [], blocks: [], flags: [], failedClosed: false, ...extra,
  };
}

/* ─── THE BLOCK LEDGER: recording an execution-layer refusal ──────────────────
 *
 * Troy's requirement, 2026-07-29: every time either layer blocks something it
 * gets written somewhere durable — "not screenshots, not chat history."
 * `src/core/audit-log.mjs` is that durable writer. This is the execution half.
 *
 * WHY THE RECORDING IS OPT-IN, AND WHY THE OPTION IS A PATH
 *
 * `evaluateToolCall` was a PURE evaluator: same inputs, same verdict, no I/O.
 * That is worth keeping, because a gate with an unconditional side effect is a
 * gate whose behaviour depends on the filesystem — and the one thing this
 * module must never do is let a disk problem change a verdict. So recording is
 * off unless a caller names a workspace to record into, and a caller that names
 * one gets `audit` back on the refusal so it can SEE whether the write landed.
 *
 * The option is `auditWorkspace` — a path — rather than `audit: true` or an
 * injected recorder function, for two reasons:
 *
 *   1. A boolean would let a caller enable auditing without deciding WHERE the
 *      evidence goes. A path makes the location an explicit decision. It is
 *      separate from the existing `workspace` parameter on purpose: `workspace`
 *      answers "whose rules govern this call", which is not necessarily the
 *      directory the evidence belongs in.
 *   2. An injected recorder could be substituted by one that returns
 *      {logged:true} and writes nothing, and this module would have no way to
 *      tell. With a path, the gate always calls the one audited implementation,
 *      and a test that wants to prove recording has to look at the disk.
 *
 * A LOGGING FAILURE NEVER CHANGES THE VERDICT AND NEVER THROWS.
 * `recordBlockEvent` returns {logged, reason} instead of throwing, and the
 * result is attached to the refusal rather than swallowed — the caller can say
 * "the block stood but was not recorded", which is a materially different
 * statement from "nothing was blocked".
 */

/**
 * A cap on the recorded triggering text, because `write_file` content is
 * unbounded and an append-only ledger must not be turned into a disk-filler by
 * one 50 MB write. When it fires, the truncation DECLARES ITSELF inside the
 * recorded text: silently shortened evidence is worse than none.
 */
export const AUDIT_TEXT_LIMIT = 20000;

/**
 * The exact material the kernel evaluated, so the evidence corresponds to the
 * verdict. `detectDestructiveOperation` reads `tool_input.command`
 * (governance.mjs:120) and `evaluateRules` matches every string in the args
 * (governance.mjs:249) — so the honest "full triggering text" is that same
 * flattened string set, not just the command.
 */
export function auditTextForPayload(payload = {}) {
  const text = collectStrings(payload?.tool_input ?? {}).join('\n');
  if (text.length <= AUDIT_TEXT_LIMIT) return text;
  return `${text.slice(0, AUDIT_TEXT_LIMIT)}\n[truncated by the Helmion audit log: `
    + `${AUDIT_TEXT_LIMIT} of ${text.length} characters recorded]`;
}

/**
 * Shape one execution-layer block event in Troy's schema.
 *
 * Exported because there are two execution-layer refusal paths and they must
 * produce identical evidence: this evaluator (the agent runtime's gate) and the
 * `helmion guard` PreToolUse hook in bin/helmion.mjs, which does its own
 * evaluation to keep its long-standing stdout contract. One shaping function,
 * so a reviewer reading the ledger cannot tell which path wrote a row apart
 * from the `source` field that says so.
 *
 * `matchedPattern` is passed in rather than guessed, because the fail-closed
 * refusals have no pattern that fired — the check could not be completed at all
 * — and writing '' there would make them uncountable in
 * `summarizeBlockEvents`. They get an explicit `fail-closed:<why>` label so a
 * compliance reviewer can count "refused because the check broke" separately
 * from "refused because a rule matched".
 */
export function executionBlockEvent({
  tool,
  workspace,
  payload = {},
  matchedPattern,
  reason = '',
  hits = [],
  source = 'governance-gate',
}) {
  const event = {
    layer: LAYER.EXECUTION,
    matchedPattern: String(matchedPattern ?? ''),
    text: auditTextForPayload(payload),
    // Identifies the tool and the workspace, prefixed by which refusal path
    // recorded it.
    source: `${source}:${tool ?? 'unknown-tool'}:${workspace ?? ''}`,
    // The call did not run, in every branch that reaches here.
    outcome: 'blocked',
    detail: reason,
  };
  if (Array.isArray(hits) && hits.length) event.hits = hits;
  return event;
}

/**
 * Evaluate ONE tool call against the kernel.
 *
 * The payload is the same shape the PreToolUse hook feeds `helmion guard`
 * (`{tool_name, tool_input, project_slug}`), so both callers are governed by
 * one contract and one rule syntax.
 *
 * When `auditWorkspace` is given, a refusal also carries
 * `audit: {logged, file, entry, reason}` from src/core/audit-log.mjs. It is
 * absent when auditing is off, and absent on an allow — nothing is recorded for
 * a call that was permitted.
 *
 * @returns {{allowed: boolean, reason: string, hits: string[], blocks: object[],
 *            flags: object[], failedClosed: boolean, audit?: object}}
 */
export function evaluateToolCall({
  tool,
  args,
  workspace,
  projectSlug = null,
  // The write lease this session believes it holds. Absent means "this session
  // holds no lease", which refuses every mutating tool — see LEASE_REQUIRED_TOOLS.
  // The `helmion guard` hook path passes nothing and is unaffected, because the
  // tool names it sees are not in that set.
  leaseToken = null,
  // Where to record a refusal in the durable block ledger. null = record
  // nothing, which keeps this a pure evaluator by default. See the long comment
  // above executionBlockEvent for why this is a path and not a boolean.
  auditWorkspace = null,
  // Who is asking, for the recorded `source` field.
  auditSource = 'governance-gate',
} = {}) {
  const payload = {
    tool_name: tool ?? null,
    tool_input: args ?? {},
    project_slug: projectSlug ?? null,
  };

  // Record the refusal, then hand it back unchanged apart from the `audit`
  // field. Deliberately NOT allowed to alter `allowed` or to throw: a ledger
  // that cannot be written must never turn a block into an allow, and
  // recordBlockEvent returns its failure instead of raising it.
  const denied = (verdict, matchedPattern) => {
    if (!auditWorkspace) return verdict;
    const audit = recordBlockEvent(auditWorkspace, executionBlockEvent({
      tool,
      workspace: workspace ?? auditWorkspace,
      payload,
      matchedPattern,
      reason: verdict.reason,
      hits: verdict.hits,
      source: auditSource,
    }));
    return { ...verdict, audit };
  };

  // 1. Built-in destructive patterns. No file I/O, so nothing can make this
  //    unavailable; it governs even a workspace that has no rules file.
  let destructive;
  try {
    destructive = detectDestructiveOperation(payload);
  } catch (err) {
    return denied(refuse(
      `the destructive-operation kernel failed to evaluate this call (${err.message}); `
      + 'governance fails closed',
      { failedClosed: true },
    ), 'fail-closed:destructive-kernel-error');
  }
  if (destructive?.blocked) {
    return denied({
      allowed: false,
      reason: `it matches a destructive operation the kernel always blocks: ${destructive.hits.join(', ')}`,
      hits: destructive.hits,
      blocks: [],
      flags: [],
      failedClosed: false,
    }, destructive.hits.join(', '));
  }

  // 2. Promoted rules for this workspace.
  const path = resolveRulesPath(workspace);
  let rules;
  try {
    rules = assertRulesUsable(loadPromotedRules(workspace), path);
  } catch (err) {
    return denied(refuse(
      `the promoted rule set could not be evaluated (${err.message}); governance fails closed`,
      { failedClosed: true },
    ), 'fail-closed:promoted-rules-unusable');
  }

  let verdict;
  try {
    verdict = evaluateRules(payload, rules);
  } catch (err) {
    return denied(refuse(
      `the governance kernel failed to evaluate this call (${err.message}); governance fails closed`,
      { failedClosed: true },
    ), 'fail-closed:rule-evaluation-error');
  }

  // Belt and braces: assertRulesUsable already rejects uncompilable patterns,
  // so this can only fire if evaluateRules starts flagging invalid for some
  // other reason. Unknown reason -> refuse.
  const invalid = (verdict.flags ?? []).filter((rule) => rule?.invalid);
  if (invalid.length) {
    return denied(refuse(
      `${invalid.length} promoted rule(s) have an invalid regular expression and could not be `
      + 'evaluated; governance fails closed',
      { failedClosed: true, flags: verdict.flags ?? [] },
    ), 'fail-closed:invalid-rule-pattern');
  }

  if (verdict.blocked) {
    const patterns = verdict.blocks.map((rule) => `/${rule.pattern}/`).join(', ');
    return denied({
      allowed: false,
      reason: `it matches a promoted block rule: ${patterns}`,
      hits: [],
      blocks: verdict.blocks,
      flags: verdict.flags ?? [],
      failedClosed: false,
    }, patterns);
  }

  // 3. THE WRITE LEASE. Last, and only for mutating tools.
  //
  // Ordering is deliberate. A destructive command is refused whether or not this
  // session holds the lease, because holding a lease is permission to be the one
  // writer — never permission to do something the kernel forbids. Putting the
  // lease first would let "I hold the lease" read as an authorization.
  //
  // A missing lease REFUSES. It does not fall through to "no lease file, so
  // nobody is holding it, carry on" — that reading is how a single-writer
  // guarantee becomes decoration.
  if (requiresWriteLease(tool)) {
    const lease = verifyLeaseHeld(workspace, { leaseToken });
    if (!lease.held) {
      return denied(refuse(
        `it needs the project's write lease and this session does not hold it: ${lease.reason}`,
        { failedClosed: Boolean(lease.failedClosed) },
      ), 'write-lease:not-held');
    }
  }

  return {
    allowed: true,
    reason: '',
    hits: [],
    blocks: [],
    flags: verdict.flags ?? [],
    failedClosed: false,
  };
}

/**
 * The refusal text the model reads. It has to do three jobs: say the call did
 * not run, say WHY in terms of the rule that matched, and make clear that
 * retrying or asking a human to approve it is not a route around this.
 */
export function governanceRefusalMessage(tool, verdict) {
  return (
    `Error: tool '${tool}' was ${GOVERNANCE_BLOCK_MARKER} — ${verdict.reason}. `
    + 'It did NOT run and nothing was changed. This is a hard block from the deterministic '
    + 'governance kernel, not a permission prompt: no human approval can override it and '
    + 'retrying the same call will fail the same way. Do something else — propose a '
    + 'non-destructive alternative, narrow the operation, or explain what you needed and let '
    + 'the user run it themselves.'
  );
}
