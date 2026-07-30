import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { detectDestructiveOperation, evaluateRules } from './governance.mjs';
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

/**
 * Evaluate ONE tool call against the kernel.
 *
 * The payload is the same shape the PreToolUse hook feeds `helmion guard`
 * (`{tool_name, tool_input, project_slug}`), so both callers are governed by
 * one contract and one rule syntax.
 *
 * @returns {{allowed: boolean, reason: string, hits: string[], blocks: object[],
 *            flags: object[], failedClosed: boolean}}
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
} = {}) {
  const payload = {
    tool_name: tool ?? null,
    tool_input: args ?? {},
    project_slug: projectSlug ?? null,
  };

  // 1. Built-in destructive patterns. No file I/O, so nothing can make this
  //    unavailable; it governs even a workspace that has no rules file.
  let destructive;
  try {
    destructive = detectDestructiveOperation(payload);
  } catch (err) {
    return refuse(
      `the destructive-operation kernel failed to evaluate this call (${err.message}); `
      + 'governance fails closed',
      { failedClosed: true },
    );
  }
  if (destructive?.blocked) {
    return {
      allowed: false,
      reason: `it matches a destructive operation the kernel always blocks: ${destructive.hits.join(', ')}`,
      hits: destructive.hits,
      blocks: [],
      flags: [],
      failedClosed: false,
    };
  }

  // 2. Promoted rules for this workspace.
  const path = resolveRulesPath(workspace);
  let rules;
  try {
    rules = assertRulesUsable(loadPromotedRules(workspace), path);
  } catch (err) {
    return refuse(
      `the promoted rule set could not be evaluated (${err.message}); governance fails closed`,
      { failedClosed: true },
    );
  }

  let verdict;
  try {
    verdict = evaluateRules(payload, rules);
  } catch (err) {
    return refuse(
      `the governance kernel failed to evaluate this call (${err.message}); governance fails closed`,
      { failedClosed: true },
    );
  }

  // Belt and braces: assertRulesUsable already rejects uncompilable patterns,
  // so this can only fire if evaluateRules starts flagging invalid for some
  // other reason. Unknown reason -> refuse.
  const invalid = (verdict.flags ?? []).filter((rule) => rule?.invalid);
  if (invalid.length) {
    return refuse(
      `${invalid.length} promoted rule(s) have an invalid regular expression and could not be `
      + 'evaluated; governance fails closed',
      { failedClosed: true, flags: verdict.flags ?? [] },
    );
  }

  if (verdict.blocked) {
    const patterns = verdict.blocks.map((rule) => `/${rule.pattern}/`).join(', ');
    return {
      allowed: false,
      reason: `it matches a promoted block rule: ${patterns}`,
      hits: [],
      blocks: verdict.blocks,
      flags: verdict.flags ?? [],
      failedClosed: false,
    };
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
      return refuse(
        `it needs the project's write lease and this session does not hold it: ${lease.reason}`,
        { failedClosed: Boolean(lease.failedClosed) },
      );
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
