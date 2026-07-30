#!/usr/bin/env node
import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import {
  consensusStatus,
  detectDestructiveOperation,
  evaluateRules,
  validateResolutionEvidence,
} from '../src/core/governance.mjs';
import {
  assertRulesUsable,
  executionBlockEvent,
  loadPromotedRules,
  resolveRulesPath,
} from '../src/core/governance-gate.mjs';
import { LAYER, recordBlockEvent } from '../src/core/audit-log.mjs';
import { distillResolvedBlocker } from '../src/core/distiller.mjs';
import { createCodexAdapter } from '../src/adapters/codex.mjs';
import { createNeonStore } from '../src/adapters/neon.mjs';
import {
  HUMAN_CONFIRMATION_AUDIENCE,
  handoffActionHash,
} from '../src/core/human-confirmation.mjs';
import { PILOT_DECISION, evaluatePilotAction } from '../src/core/pilot-policy.mjs';
import {
  PHASE_TWO_TEST_DEFAULTS,
  runPhaseTwoSwitchTest,
} from '../src/core/phase-two-verification.mjs';
import {
  assertConfirmedPassphrase,
  defaultOwnerKeyDirectory,
  exportOwnerPublicEnrollment,
  initializeOwnerKey,
  inspectOwnerKey,
  restoreOwnerKey,
  reviewAndSignOwnerConfirmation,
} from '../src/windows/owner-key-store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function requiredOption(name) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function expectedEndpointId() {
  const value = option('--expect-endpoint', process.env.HELMION_EXPECTED_ENDPOINT_ID);
  if (!value) {
    throw new Error(
      'Set HELMION_EXPECTED_ENDPOINT_ID or pass --expect-endpoint; no connection was opened',
    );
  }
  return value;
}

async function guardedNeonStore() {
  return createNeonStore(undefined, { expectedEndpointId: expectedEndpointId() });
}

async function stdinJson() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw.trim() ? JSON.parse(raw) : {};
}

async function readHiddenAscii(prompt, label = 'Passphrase') {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error('A real interactive Windows terminal is required for secret entry');
  }
  process.stdout.write(prompt);
  const bytes = [];
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return await new Promise((resolveSecret, reject) => {
      const onData = (chunk) => {
        for (const byte of Buffer.from(chunk)) {
          if (byte === 3) {
            cleanup();
            reject(new Error('Secret entry cancelled'));
            return;
          }
          if (byte === 13 || byte === 10) {
            cleanup();
            process.stdout.write('\n');
            resolveSecret(Buffer.from(bytes));
            return;
          }
          if (byte === 8 || byte === 127) {
            bytes.pop();
            continue;
          }
          if (byte < 32 || byte > 126) {
            cleanup();
            reject(new Error(`${label} passphrase must use printable ASCII characters`));
            return;
          }
          bytes.push(byte);
        }
      };
      const cleanup = () => {
        process.stdin.off('data', onData);
        process.stdin.setRawMode(wasRaw);
        process.stdin.pause();
      };
      process.stdin.on('data', onData);
    });
  } catch (error) {
    bytes.fill(0);
    process.stdout.write('\n');
    throw error;
  }
}

async function confirmedPassphrase(label) {
  const first = await readHiddenAscii(
    `${label} passphrase (hidden, 16+ characters): `,
    label,
  );
  let second;
  try {
    second = await readHiddenAscii(
      `Confirm ${label.toLowerCase()} passphrase: `,
      label,
    );
    assertConfirmedPassphrase(first, second, label);
    return first;
  } catch (error) {
    first.fill(0);
    throw error;
  } finally {
    second?.fill(0);
  }
}

async function ownerDecision(review) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Owner approval requires a real interactive terminal');
  }
  process.stdout.write(`\nOWNER DECISION REQUIRED
Project: ${review.project_slug}
Handoff: ${review.handoff_id}
Action: ${review.plain_english_action}
Risk: ${review.risk_tier} — ${review.risk_reasons.join('; ')}
Exact action hash: ${review.exact_action_hash}
Operation:
${JSON.stringify(review.operation, null, 2)}

`);
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await input.question('Type APPROVE to sign this exact action, or DECLINE: ');
  } finally {
    input.close();
  }
}

async function ownerKeyCommand() {
  const subcommand = process.argv[3] ?? 'help';
  if (subcommand === 'init') {
    const provider = requiredOption('--provider');
    const subject = requiredOption('--subject');
    const publicOutput = requiredOption('--public-output');
    const recoveryOutput = requiredOption('--recovery-output');
    const approvalPassphrase = await confirmedPassphrase('Owner signing');
    let recoveryPassphrase;
    try {
      recoveryPassphrase = await confirmedPassphrase('Recovery');
      return initializeOwnerKey({
        provider,
        subject,
        keyDirectory: option('--key-dir', defaultOwnerKeyDirectory()),
        publicOutput,
        recoveryOutput,
        approvalPassphrase,
        recoveryPassphrase,
        workspaceRoot: root,
      });
    } finally {
      approvalPassphrase.fill(0);
      recoveryPassphrase?.fill(0);
    }
  }
  if (subcommand === 'inspect') {
    return inspectOwnerKey({ keyPath: requiredOption('--key') });
  }
  if (subcommand === 'export-public') {
    return exportOwnerPublicEnrollment({
      keyPath: requiredOption('--key'),
      output: requiredOption('--output'),
    });
  }
  if (subcommand === 'restore') {
    const recoveryPath = requiredOption('--recovery');
    const recoveryPassphrase = await readHiddenAscii(
      'Recovery passphrase (hidden): ',
      'Recovery',
    );
    let approvalPassphrase;
    try {
      approvalPassphrase = await confirmedPassphrase('New owner signing');
      return restoreOwnerKey({
        recoveryPath,
        keyDirectory: option('--key-dir', defaultOwnerKeyDirectory()),
        recoveryPassphrase,
        approvalPassphrase,
        workspaceRoot: root,
      });
    } finally {
      recoveryPassphrase.fill(0);
      approvalPassphrase?.fill(0);
    }
  }
  if (subcommand === 'approve') {
    return reviewAndSignOwnerConfirmation({
      keyPath: requiredOption('--key'),
      requestPath: requiredOption('--request'),
      output: requiredOption('--output'),
      decisionProvider: ownerDecision,
      workspaceRoot: root,
      approvalPassphraseProvider: () => readHiddenAscii(
        'Owner signing passphrase (hidden): ',
        'Owner signing',
      ),
    });
  }
  throw new Error(
    'owner-key subcommand must be init, inspect, export-public, restore, or approve',
  );
}

async function agentOs() {
  const { installAgentOsTargets, resolveTargets } = await import('../src/core/agent-os.mjs');
  const subcommand = process.argv[3] ?? 'help';
  if (subcommand !== 'install') {
    throw new Error('agent-os subcommand must be install');
  }

  const targets = resolveTargets(option('--target', 'all'));
  const apply = hasFlag('--yes');
  const asJson = hasFlag('--json');
  const report = await installAgentOsTargets({
    targets,
    dir: option('--dir', null),
    apply,
  });

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const verb = apply ? 'Installed' : 'Would install (dry run — pass --yes to write)';
  process.stdout.write(`${verb}\n`);
  for (const result of report.targets) {
    process.stdout.write(`\n${result.label} — ${result.directory}\n`);
    for (const file of result.files) {
      process.stdout.write(`  ${file.action.padEnd(9)} ${file.path}${file.action === 'skip' || file.action === 'append' ? `  (${file.reason})` : ''}\n`);
    }
    process.stdout.write(
      `  Hooks are NOT wired automatically. Merge ${result.settingsSnippet}\n`
      + `  into ${result.settingsFile} — see agent-os/MERGE_HOOKS.md.\n`,
    );
  }
}

// Project scaffold — the planning folder that has to exist BEFORE any coding
// tool opens the project. Dry run by default; --yes writes.
//
// Nothing is ever overwritten. An existing file is reported as preserved, the
// command still succeeds, and there is deliberately no flag that changes that:
// these files accumulate the operator's own reasoning, which no template can
// reconstruct.
async function projectCommand() {
  const { scaffoldProject } = await import('../src/core/project-scaffold.mjs');
  const subcommand = process.argv[3] ?? 'help';
  if (subcommand !== 'init') {
    throw new Error('project subcommand must be init');
  }

  const name = process.argv[4];
  if (!name || name.startsWith('--')) {
    throw new Error('project init requires a name, e.g. helmion project init "Invoice Importer"');
  }

  const apply = hasFlag('--yes');
  const asJson = hasFlag('--json');
  const report = await scaffoldProject({
    name,
    dir: option('--dir', null),
    sprintNumber: Number(option('--sprint', '1')),
    apply,
  });

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const verb = apply ? 'Created' : 'Would create (dry run — pass --yes to write)';
  process.stdout.write(`${verb} ${report.project} (${report.slug})\n  ${report.directory}\n\n`);
  for (const file of report.files) {
    process.stdout.write(`  ${file.action.padEnd(9)} ${file.path}${file.action === 'preserve' ? `  (${file.reason})` : ''}\n`);
  }
  process.stdout.write(
    `\n  ${report.counts.create ?? 0} new, ${report.counts.preserve ?? 0} already there and left untouched.\n`
    + '  Nothing is ever overwritten — there is no flag that changes that.\n'
    + '  Next: fill in planning/requirements.md, then give\n'
    + `  sprints/${report.sprint}/handoff-prompt.md to the session that will build.\n`,
  );
}

// Advisory lane read path — docs/FLYWHEEL_AUDIT_2026-07-28.md finding #2.
//
// bigsister.advisory_outputs lives on a DIFFERENT Neon endpoint from
// HELMION_DATABASE_URL (audit finding #19: bigsister ep-dry-fog-aku9i5gq vs
// helmion ep-divine-leaf-ay38p1af), so this takes its own connection string and
// never reuses the Helmion one.
async function advisory() {
  const { Client } = await import('pg');
  const {
    createAdvisoryLane,
    confirmationPhrase,
  } = await import('../src/core/advisory-lane.mjs');

  const subcommand = process.argv[3] ?? 'help';
  if (!['list', 'show', 'promote', 'reject'].includes(subcommand)) {
    throw new Error('advisory subcommand must be list, show, promote, or reject');
  }

  const connectionString = option('--database-url', process.env.BIGSISTER_DATABASE_URL);
  if (!connectionString) {
    throw new Error(
      'Set BIGSISTER_DATABASE_URL (the bigsister endpoint, not HELMION_DATABASE_URL) '
      + 'or pass --database-url. No connection was opened.',
    );
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const lane = createAdvisoryLane({ client });

    if (subcommand === 'list') {
      const result = await lane.list({
        state: option('--state', 'unreviewed'),
        projectSlug: option('--project', null),
        limit: option('--limit', '20'),
      });
      if (hasFlag('--json')) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      if (!result.rows.length) {
        process.stdout.write(`No ${result.state} advisory rows.\n`);
        return;
      }
      process.stdout.write(`${result.rows.length} ${result.state} advisory row(s)\n\n`);
      for (const row of result.rows) {
        process.stdout.write(
          `  #${row.id}  ${String(row.advisor).padEnd(8)} ${String(row.project_slug ?? '-').padEnd(14)}`
          + ` ${row.response_chars} chars  ${new Date(row.created_at).toISOString().slice(0, 16)}\n`
          + `      Q: ${row.question}\n`
          + `      A: ${row.response_preview}\n`,
        );
      }
      if (!result.capabilities.hasReviewState) {
        process.stdout.write(
          '\n  Note: this database has no review_decision column yet, so only the\n'
          + '  promoted boolean is tracked on the row. Attribution still goes to\n'
          + '  bigsister.agent_logs. Apply sql/bigsister/001_advisory_output_review_state.sql\n'
          + '  (Tier B — needs Troy) for full review state.\n',
        );
      }
      process.stdout.write(
        `\n  Review one:  helmion advisory promote <id> --reviewer "<name>" --note "<why>"\n`
        + `               helmion advisory reject  <id> --reviewer "<name>" --note "<why>"\n`,
      );
      return;
    }

    if (subcommand === 'show') {
      const row = await lane.show(process.argv[4]);
      process.stdout.write(`${JSON.stringify(row, null, 2)}\n`);
      return;
    }

    // promote / reject — Rule 0.27: never automatic, never implicit.
    const decision = subcommand === 'promote' ? 'PROMOTED' : 'REJECTED';
    const id = process.argv[4];
    const row = await lane.show(id);

    process.stdout.write(`\nADVISORY REVIEW — this is a human decision, not an automatic one.
Row:      #${row.id}
Advisor:  ${row.advisor}  (low-trust lane, CLAUDE.md Rule 0.27)
Project:  ${row.project_slug ?? '-'}
Asked:    ${row.question}

${row.response}

Decision: ${decision}
Reviewer: ${option('--reviewer', '(missing --reviewer)')}
Why:      ${option('--note', '(missing --note)')}

`);

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        'Advisory promotion requires a real interactive terminal so a human types '
        + 'the confirmation. Nothing was written.',
      );
    }
    const input = createInterface({ input: process.stdin, output: process.stdout });
    let typed;
    try {
      typed = await input.question(
        `Type exactly "${confirmationPhrase(decision, id)}" to record this, or anything else to abort: `,
      );
    } finally {
      input.close();
    }

    const result = await lane.review({
      id,
      decision,
      reviewer: option('--reviewer', null),
      note: option('--note', null),
      confirmation: typed,
    });
    process.stdout.write(`\nRecorded: #${result.data.id} ${result.decision} by ${result.reviewer}\n`);
  } finally {
    await client.end();
  }
}

async function loadRules() {
  // One loading path, shared with the agent runtime's governance gate, so the
  // hook and an in-process tool call are governed by the same rules read the
  // same way. This resolves HELMION_RULES_PATH first and otherwise
  // <cwd>/.helmion/autonomy_rules.json, exactly as before.
  return assertRulesUsable(loadPromotedRules(process.cwd()), resolveRulesPath(process.cwd()));
}

/**
 * Shape this hook's refusal for the block ledger.
 *
 * `guard` keeps its own evaluation rather than calling evaluateToolCall, because
 * its stdout shape ({allowed, destructive, rules}) is the PreToolUse contract
 * hooks/pretooluse.ps1 relays. The EVIDENCE is shared, though: this goes through
 * the same executionBlockEvent shaper the gate uses, so a reviewer reading the
 * ledger sees identical rows from both execution paths, distinguished only by
 * the `source` field that names which one wrote it.
 */
function guardAuditEvent(payload, result) {
  const hits = result.destructive?.hits ?? [];
  let matchedPattern;
  let reason;
  if (result.destructive?.blocked) {
    matchedPattern = hits.join(', ');
    reason = `it matches a destructive operation the kernel always blocks: ${matchedPattern}`;
  } else if (result.rules?.blocked) {
    matchedPattern = (result.rules.blocks ?? []).map((rule) => `/${rule.pattern}/`).join(', ');
    reason = `it matches a promoted block rule: ${matchedPattern}`;
  } else {
    // The fail-closed path below: nothing matched because nothing could be
    // evaluated. Labelled so a reviewer can count "the check broke" separately
    // from "a rule fired" — an empty matchedPattern would be uncountable.
    matchedPattern = 'fail-closed:governance-unevaluatable';
    reason = result.error ?? 'governance could not be evaluated';
  }
  return executionBlockEvent({
    tool: payload?.tool_name ?? null,
    workspace: process.cwd(),
    payload,
    matchedPattern,
    reason,
    hits,
    source: 'guard-hook',
  });
}

async function guard() {
  const payload = await stdinJson();
  let result;
  try {
    const destructive = detectDestructiveOperation(payload);
    const rules = evaluateRules(payload, await loadRules());
    result = {
      allowed: !destructive.blocked && !rules.blocked,
      destructive,
      rules,
    };
  } catch (err) {
    // FAIL CLOSED. A rule set that cannot be read, parsed, or compiled used to
    // throw out of here, which exits 1 — and a PreToolUse hook treats 1 as a
    // non-blocking error, so a broken rules file silently let everything
    // through. An unevaluatable rule set now BLOCKS with exit 2.
    result = {
      allowed: false,
      error: `governance could not be evaluated: ${err.message}`,
      destructive: { blocked: false, hits: [], approved: false, reason: '' },
      rules: { blocked: false, blocks: [], flags: [], approved: false, approvalReason: '' },
    };
  }

  // THE BLOCK LEDGER. Troy 2026-07-29: every block from either layer gets
  // written somewhere durable, "not screenshots, not chat history." This is the
  // hook path — the one that actually refuses things in a live Claude Code
  // session — so it records by default rather than behind a flag.
  //
  // It writes into <cwd>/.helmion/audit/, the same resolution base loadRules
  // already uses, so the evidence lands in the project the hook is guarding.
  // The result is REPORTED on stdout, never swallowed: a refusal that could not
  // be recorded has to be visible, and a logging failure must not change the
  // verdict or the exit code. recordBlockEvent returns its failure rather than
  // throwing, so neither can happen.
  if (!result.allowed) {
    const written = recordBlockEvent(process.cwd(), guardAuditEvent(payload, result));
    result.audit = { logged: written.logged, file: written.file, reason: written.reason };
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.allowed) process.exitCode = 2;
}

// The block ledger read path — src/core/audit-log.mjs, whose docstring names
// this command. READ-ONLY: it never writes an event, it reports what the two
// guards wrote. `helmion mcp-install audit` is a different thing entirely
// (stage 2 of the MCP install pipeline) and is unaffected.
async function auditLedger() {
  const subcommand = process.argv[3] ?? 'list';
  const valid = ['list', 'summary'];
  if (!valid.includes(subcommand)) {
    throw new Error(`audit subcommand must be one of: ${valid.join(', ')}`);
  }
  const { readBlockEvents, summarizeBlockEvents } = await import('../src/core/audit-log.mjs');
  const workspace = resolve(option('--workspace', process.cwd()));
  const asJson = hasFlag('--json');

  // A misspelled layer must NOT read as "nothing was blocked". `--layer Browser`
  // would filter every row out and print a clean-looking zero, which is the
  // worst possible failure for an audit tool, so an unknown value is refused.
  const layer = option('--layer', null);
  const layers = Object.values(LAYER);
  if (layer !== null && !layers.includes(layer)) {
    throw new Error(`--layer must be one of: ${layers.join(', ')} (got "${layer}")`);
  }

  const filter = { layer, since: option('--since', null) };
  const summary = summarizeBlockEvents(workspace, filter);
  const { entries, malformed, files } = readBlockEvents(workspace, {
    ...filter,
    limit: subcommand === 'summary' ? 0 : Number(option('--limit', '20')),
  });

  if (asJson) {
    // `summary` reports counts; it does not dump the ledger. `list` does.
    process.stdout.write(`${JSON.stringify({
      workspace,
      filter,
      summary,
      files,
      malformed,
      ...(subcommand === 'list' ? { entries } : {}),
    }, null, 2)}\n`);
  } else if (subcommand === 'summary' || entries.length) {
    const scope = layer ? `layer ${layer}` : 'both layers';
    process.stdout.write(
      `Block ledger — ${workspace}\n`
      + `${summary.total} event(s), ${scope}, ${summary.files} file(s), ${summary.bytes} bytes\n`,
    );
    if (subcommand === 'list') {
      process.stdout.write('\n');
      for (const entry of entries) {
        const text = String(entry.text ?? '').replace(/\s+/g, ' ');
        // Declared truncation. The full text is in the file and in --json.
        const shown = text.length > 160 ? `${text.slice(0, 160)}… (${text.length} chars)` : text;
        process.stdout.write(
          `  ${String(entry.timestamp).slice(0, 19)}  ${String(entry.layer).padEnd(9)}`
          + ` ${entry.matchedPattern || '(no pattern)'}\n`
          + `      outcome: ${entry.outcome}${entry.redacted ? '  [credentials redacted]' : ''}\n`
          + `      source:  ${entry.source}\n`
          + `      text:    ${shown}\n`,
        );
      }
      if (summary.total > entries.length) {
        process.stdout.write(`  … ${summary.total - entries.length} older event(s) — raise --limit\n`);
      }
    }
    process.stdout.write(
      `\nBy layer:   ${Object.entries(summary.byLayer).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}\n`
      + `By pattern: ${Object.entries(summary.byPattern)
        .sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}\n`
      + `Newest:     ${summary.newest ?? '-'}\n`
      + `Oldest:     ${summary.oldest ?? '-'}\n`,
    );
  } else {
    process.stdout.write(
      `Block ledger — ${workspace}\n`
      + `No block events${layer ? ` from the ${layer} layer` : ''}.\n`
      + 'Either nothing has been blocked, or nothing has written here yet: the\n'
      + 'execution layer records from `helmion guard` and from the agent gate when\n'
      + 'a caller passes auditWorkspace. Files live in .helmion/audit/.\n',
    );
  }

  // Unreadable lines are surfaced and made to matter. A ledger nobody can fully
  // parse is not clean evidence, so this exits non-zero rather than printing a
  // tidy report with a footnote.
  if (malformed.length) {
    process.stdout.write(`\n! ${malformed.length} UNREADABLE line(s) — this ledger is not intact:\n`);
    for (const bad of malformed.slice(0, 20)) {
      process.stdout.write(`    ${bad.file}:${bad.line}  ${bad.raw}\n`);
    }
    if (malformed.length > 20) process.stdout.write(`    … and ${malformed.length - 20} more\n`);
    process.exitCode = 2;
  }
}

async function init() {
  const targetArg = process.argv[3] ?? process.cwd();
  const target = resolve(targetArg);
  const configDir = join(target, '.helmion');
  const hookDir = join(configDir, 'hooks');
  await mkdir(hookDir, { recursive: true });
  const rulesPath = join(configDir, 'autonomy_rules.json');
  if (!existsSync(rulesPath)) await writeFile(rulesPath, '{\n  "promoted_rules": []\n}\n', 'utf8');
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify({
    version: 1,
    projectRoot: target,
    rulesPath,
    codexAdapterMode: 'read-only',
  }, null, 2)}\n`, 'utf8');
  await copyFile(join(root, 'hooks', 'pretooluse.ps1'), join(hookDir, 'pretooluse.ps1'));
  process.stdout.write(`Helmion initialized at ${configDir}\n`);
}

async function migrate() {
  const store = await guardedNeonStore();
  try {
    const before = await store.inspectDatabase();
    if (hasFlag('--require-empty-helmion') && before.helmion.schemaExists) {
      throw new Error(
        'The helmion schema already exists; refusing --require-empty-helmion migration',
      );
    }
    const results = await store.migrate();
    const after = await store.inspectDatabase();
    if (!after.migrationsReady) {
      throw new Error('Migration completed without a fully matching migration inventory');
    }
    process.stdout.write(`${JSON.stringify({
      target: after.target,
      identity: after.identity,
      before: {
        helmionSchemaExists: before.helmion.schemaExists,
        migrations: before.migrations,
      },
      results,
      after: {
        migrationsReady: after.migrationsReady,
        migrations: after.migrations,
      },
    }, null, 2)}\n`);
  } finally {
    await store.close();
  }
}

async function inspectDatabase() {
  const store = await guardedNeonStore();
  try {
    process.stdout.write(`${JSON.stringify(await store.inspectDatabase(), null, 2)}\n`);
  } finally {
    await store.close();
  }
}

async function phaseTwoSwitchTest() {
  const store = await guardedNeonStore();
  try {
    const before = await store.inspectDatabase();
    if (!before.migrationsReady) {
      throw new Error('All checked-in migrations must be applied and match before the switch test');
    }
    const projectSlug = option('--project', PHASE_TWO_TEST_DEFAULTS.projectSlug);
    const project = await store.ensureProject({
      projectSlug,
      name: 'Helmion Phase Two isolated switch test',
      rootPath: null,
    });
    const result = await runPhaseTwoSwitchTest({ store, projectSlug });
    process.stdout.write(`${JSON.stringify({
      target: before.target,
      identity: before.identity,
      projectCreated: project.created,
      ...result,
    }, null, 2)}\n`);
  } finally {
    await store.close();
  }
}

async function blockers() {
  const slug = process.argv[3] ?? null;
  const store = await createNeonStore();
  try {
    process.stdout.write(`${JSON.stringify(await store.listActiveBlockers(slug), null, 2)}\n`);
  } finally {
    await store.close();
  }
}

async function maestroRead(method) {
  const slug = process.argv[3];
  if (!slug) throw new Error('A project slug is required');
  const store = await createNeonStore();
  try {
    const adapter = createCodexAdapter({ store });
    const value = method === 'handoff'
      ? await adapter.getLatestHandoff(slug)
      : await adapter.getProjectState(slug);
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } finally {
    await store.close();
  }
}

// MCP server install security pipeline. Five gated stages; nothing is
// installed without an interactive human yes. See src/core/mcp-*.mjs.
async function mcpInstall() {
  const subcommand = process.argv[3] ?? 'help';
  const valid = ['discover', 'audit', 'sandbox', 'review', 'drift'];
  if (!valid.includes(subcommand)) {
    throw new Error(`mcp-install subcommand must be one of: ${valid.join(', ')}`);
  }
  const asJson = hasFlag('--json');

  if (subcommand === 'discover') {
    const { discoverMcpServers, formatDiscoveryReport } = await import('../src/core/mcp-discovery.mjs');
    const need = process.argv[4];
    if (!need) throw new Error('mcp-install discover requires a stated need, e.g. "read local sqlite"');
    const report = await discoverMcpServers({
      need,
      limit: Number(option('--limit', '10')),
      token: process.env.GITHUB_TOKEN ?? null,
    });
    process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `${formatDiscoveryReport(report)}\n`);
    return;
  }

  const target = process.argv[4];
  if (!target) throw new Error(`mcp-install ${subcommand} requires a path to the candidate directory`);
  const candidateRoot = resolve(target);
  const { loadDeclaredManifest } = await import('../src/core/mcp-install-pipeline.mjs');
  const declared = await loadDeclaredManifest(candidateRoot);

  if (subcommand === 'audit') {
    const { auditCandidate, formatAuditReport } = await import('../src/core/mcp-code-audit.mjs');
    const report = await auditCandidate({ root: candidateRoot, declared });
    process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `${formatAuditReport(report)}\n`);
    if (report.blocking) process.exitCode = 2;
    return;
  }

  if (subcommand === 'sandbox') {
    const { runSandboxedCandidate, formatSandboxReport } = await import('../src/core/mcp-sandbox.mjs');
    const report = await runSandboxedCandidate({
      root: candidateRoot,
      entry: option('--entry', 'index.mjs'),
      declared,
    });
    process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `${formatSandboxReport(report)}\n`);
    if (report.verdict !== 'no-observed-misbehaviour') process.exitCode = 2;
    return;
  }

  const { defaultLedgerDirectory } = await import('../src/core/mcp-install-ledger.mjs');
  const ledgerDir = option('--ledger-dir', defaultLedgerDirectory(option('--workspace', process.cwd())));

  if (subcommand === 'drift') {
    const { checkForDrift } = await import('../src/core/mcp-install-ledger.mjs');
    const serverName = option('--name', declared.name ?? candidateRoot.split(/[\\/]/).filter(Boolean).pop());
    const result = await checkForDrift({ ledgerDir, serverName, root: candidateRoot, declared });
    process.stdout.write(asJson ? `${JSON.stringify(result, null, 2)}\n` : `${result.status.toUpperCase()}: ${result.message}\n`);
    if (result.status === 'drift-detected') process.exitCode = 2;
    return;
  }

  // review — the full five-stage pipeline. Stage 4 requires a real terminal.
  const { runInstallPipeline, formatPipelineOutcome } = await import('../src/core/mcp-install-pipeline.mjs');
  const report = await runInstallPipeline({
    root: candidateRoot,
    serverName: option('--name', null),
    ledgerDir,
    projectSlug: option('--project', null),
    haltOnCritical: !hasFlag('--review-blocked-candidate'),
  });
  process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `${formatPipelineOutcome(report)}\n`);
  // Anything short of an installed server exits non-zero, so a caller that only
  // checks the exit code can never mistake a refusal for a success.
  if (report.finalDecision !== 'installed') process.exitCode = 2;
}

// Plugins / connectors. A plugin is a local directory carrying commands/ and
// optionally an .mcp.json. This command NEVER fetches and NEVER executes plugin
// code: a remote spec is refused, and every declared MCP server is refused
// unless the install ledger (helmion mcp-install) already approved that exact
// code. There is deliberately no second install path here.
async function plugin() {
  const subcommand = process.argv[3] ?? 'list';
  const valid = ['list', 'add', 'remove', 'commands'];
  if (!valid.includes(subcommand)) {
    throw new Error(`plugin subcommand must be one of: ${valid.join(', ')}`);
  }
  const workspace = resolve(option('--workspace', process.cwd()));
  const asJson = hasFlag('--json');
  const {
    addPlugin, formatPluginReport, loadEnabledPlugins, removePlugin,
  } = await import('../src/agent/plugins.mjs');

  if (subcommand === 'add') {
    const spec = process.argv[4];
    if (!spec) throw new Error('plugin add requires a local directory path');
    let result;
    try {
      result = await addPlugin({ workspace, spec });
    } catch (error) {
      // A refusal is a decision, not a crash. Print the reason plainly rather
      // than burying it in a stack trace the reader has to decode.
      if (error.name === 'RemoteSourceRefusedError') {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 2;
        return;
      }
      throw error;
    }
    if (asJson) {
      process.stdout.write(`${JSON.stringify(result.plugin, null, 2)}\n`);
    } else {
      process.stdout.write(
        `${result.replaced ? 'Updated' : 'Added'} plugin "${result.plugin.name}"\n`
        + `${formatPluginReport([result.plugin])}`,
      );
    }
    // A plugin whose MCP servers were all refused still registers its commands,
    // but the caller should be able to notice the refusal without parsing prose.
    if (result.plugin.refusals.length) process.exitCode = 3;
    return;
  }

  if (subcommand === 'remove') {
    const name = process.argv[4];
    if (!name) throw new Error('plugin remove requires a plugin name');
    const { removed } = await removePlugin({ workspace, name });
    process.stdout.write(removed ? `Removed "${name}"\n` : `No plugin named "${name}"\n`);
    if (!removed) process.exitCode = 1;
    return;
  }

  const { plugins, errors } = await loadEnabledPlugins({ workspace });

  if (subcommand === 'commands') {
    const {
      discoverCommands, formatCommandList, serializeRegistry,
    } = await import('../src/agent/commands.mjs');
    const registry = await discoverCommands({ workspace, plugins });
    process.stdout.write(asJson
      ? `${JSON.stringify(serializeRegistry(registry), null, 2)}\n`
      : `Slash commands (workspace ${workspace}):\n${formatCommandList(registry)}`);
    return;
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ plugins, errors }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Plugins (workspace ${workspace}):\n${formatPluginReport(plugins)}`);
  for (const err of errors) process.stdout.write(`  ! ${err.name ?? '?'}: ${err.message}\n`);
}

const command = process.argv[2] ?? 'help';
if (command === 'agent' || command === 'chat' || command === 'code') {
  const { runAgentCli } = await import('../src/agent/session.mjs');
  await runAgentCli(process.argv.slice(3));
} else if (command === 'agent-bridge') {
  // Long-lived NDJSON protocol for the Windows Pilot EXE.
  const { runAgentBridge } = await import('../src/agent/bridge.mjs');
  await runAgentBridge();
} else if (command === 'guard') await guard();
else if (command === 'audit') await auditLedger();
else if (command === 'agent-os') await agentOs();
else if (command === 'project') await projectCommand();
else if (command === 'mcp-install') await mcpInstall();
else if (command === 'plugin' || command === 'plugins') await plugin();
else if (command === 'advisory') await advisory();
else if (command === 'init') await init();
else if (command === 'db-inspect') await inspectDatabase();
else if (command === 'migrate') await migrate();
else if (command === 'phase-two-switch-test') await phaseTwoSwitchTest();
else if (command === 'owner-key') {
  const result = await ownerKeyCommand();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result?.decision === 'DECLINED') process.exitCode = 2;
}
else if (command === 'blockers') await blockers();
else if (command === 'maestro-state') await maestroRead('state');
else if (command === 'maestro-handoff') await maestroRead('handoff');
else if (command === 'validate-proof') {
  const result = validateResolutionEvidence(await stdinJson());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 2;
} else if (command === 'consensus') {
  const input = await stdinJson();
  const result = consensusStatus(input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.approved) process.exitCode = 2;
} else if (command === 'distill') {
  process.stdout.write(`${JSON.stringify(distillResolvedBlocker(await stdinJson()), null, 2)}\n`);
} else if (command === 'confirmation-action-hash') {
  const input = await stdinJson();
  process.stdout.write(`${JSON.stringify({
    audience: HUMAN_CONFIRMATION_AUDIENCE,
    action_hash: handoffActionHash(input),
  }, null, 2)}\n`);
} else if (command === 'pilot-policy') {
  const input = await stdinJson();
  const result = evaluatePilotAction(input.operation, input.guardState);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.decision === PILOT_DECISION.PAUSE_FOR_OWNER) process.exitCode = 2;
  if (result.decision === PILOT_DECISION.BLOCK) process.exitCode = 3;
} else {
  process.stdout.write(`Helmion

Coding agent (what you want day-to-day):
  helmion agent                 # interactive REPL — tools on disk
  helmion chat                  # same as agent
  helmion code                  # same as agent
  helmion agent --provider grok
  helmion agent --workspace E:\\MyProject -p "fix the login bug"

Agent OS (self-improvement loop — rules, lessons, blockers, wins, hooks):
  helmion agent-os install                    # dry run: shows every file first
  helmion agent-os install --yes              # write it (all three targets)
  helmion agent-os install --target claude --yes
  helmion agent-os install --target claude,codex --dir E:\\scratch --yes
  helmion agent-os install --yes --json       # machine-readable, for the UI
    Targets: claude | codex | gemini | all (default all)
    Never overwrites your files and never edits a settings file.

Project scaffold (the planning folder, written BEFORE any coding tool opens it):
  helmion project init "Invoice Importer"        # dry run: shows every file first
  helmion project init "Invoice Importer" --yes  # write it
  helmion project init "Invoice Importer" --dir E:\\work\\importer --yes
  helmion project init "Invoice Importer" --sprint 2 --yes
  helmion project init "Invoice Importer" --yes --json   # machine-readable
    Creates PROJECT.md, planning/ (requirements, blueprint, acceptance
    criteria, STATE, DECISIONS, RISKS), sprints/sprint-001/ (the four-file
    architect pack), docs/ with a handoff template, and prompts/ for the
    architect and builder roles.
    Default directory is ./<slug>. Never overwrites: an existing file is
    reported as preserved and the run still succeeds, so re-running is safe.

Slash commands (your own, in markdown — same format as Claude Code's):
  Put files in .helmion/commands/ (this project) or ~/.helmion/commands/ (all
  projects). deploy.md becomes /deploy; frontend/component.md becomes
  /frontend:component. Optional frontmatter: description, argument-hint,
  arguments, allowed-tools, model, user-invocable.
  In the body: $ARGUMENTS is everything typed; $0 is the first argument and $1
  the second (0-based, as documented); named args come from "arguments:".
  Type /help in the agent REPL to list everything discovered.
  Built-in commands (/exit, /help, /clear, …) cannot be overridden; a file that
  tries is listed as IGNORED rather than silently dropped.

Plugins / connectors (a directory with commands/ and optionally .mcp.json):
  helmion plugin list                         # what is registered, and its MCP verdicts
  helmion plugin add E:\\path\\to\\my-plugin     # LOCAL directories only
  helmion plugin remove <name>
  helmion plugin commands                     # every slash command, plugins included
    A remote source (URL, git, owner/repo) is REFUSED, not fetched.
    Plugin code is never executed by this command — it reads markdown and JSON.
    A declared MCP server is REFUSED unless "helmion mcp-install review" already
    approved that exact code, and is refused again if the code changed since.

MCP server install security (never install third-party code unreviewed):
  helmion mcp-install discover "read local sqlite"   # stage 1: search GitHub
  helmion mcp-install audit <path>                   # stage 2: read every source file
  helmion mcp-install sandbox <path>                 # stage 3: run with no credentials
  helmion mcp-install review <path>                  # all 5 stages, asks you to approve
  helmion mcp-install drift <path> --name <server>   # stage 5: changed since you approved it?
    review REQUIRES an interactive terminal. Piped or redirected stdin is
    refused and nothing is installed. There is no --yes and no auto-approve.
    Installing never edits your MCP config — it prints the snippet for you.
    Exit code is non-zero for anything other than a completed install.

Advisory lane (Grok / Gemini / ChatGPT output — low-trust until a human reviews it):
  helmion advisory list                       # unreviewed rows, oldest first
  helmion advisory list --state all --json
  helmion advisory list --project sitevector --limit 5
  helmion advisory show <id>
  helmion advisory promote <id> --reviewer "Troy" --note "<why this is trustworthy>"
  helmion advisory reject  <id> --reviewer "Troy" --note "<why it is not>"
    Promotion is NEVER automatic (Rule 0.27). It needs a named reviewer, a
    written reason, and an exact typed confirmation in a real terminal.
    Reads BIGSISTER_DATABASE_URL — a DIFFERENT endpoint from HELMION_DATABASE_URL.

Block ledger (durable record of every block, both layers — .helmion/audit/*.jsonl):
  helmion audit                               # 20 most recent, newest first
  helmion audit list --limit 100
  helmion audit list --layer execution        # execution | browser, nothing else
  helmion audit list --since 2026-07-01 --json
  helmion audit summary                       # counts by layer and by pattern
  helmion audit --workspace E:\\MyProject
    Written by "helmion guard" on every refusal, and by the agent governance
    gate when its caller passes auditWorkspace. Credentials in the triggering
    text are masked before the line is written, and the masking is declared on
    the row so a redacted log is not mistaken for a tampered one.
    Unreadable lines are printed and exit non-zero — a ledger that cannot be
    fully parsed is not clean evidence.
    Browser-layer rows need a sink Chrome does not have without a permission;
    see the comment at the top of extension/background/scan.js.

Governance / Maestro (existing kernel):
  helmion init [workspace]
  helmion guard                 # tool-hook JSON on stdin
  helmion validate-proof
  helmion consensus
  helmion distill
  helmion confirmation-action-hash
  helmion pilot-policy
  helmion owner-key …
  helmion db-inspect --expect-endpoint <ep-id>
  helmion migrate --expect-endpoint <ep-id>
  helmion phase-two-switch-test --expect-endpoint <ep-id>
  helmion blockers [project]
  helmion maestro-state <project>
  helmion maestro-handoff <project>

Environment (.env walk-up or process env):
  OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / XAI_API_KEY
  HELMION_MAESTRO_COORDINATOR   # default provider for agent
  WORKSPACE_PATH                # default workspace for agent
  HELMION_DATABASE_URL
  HELMION_EXPECTED_ENDPOINT_ID
  HELMION_RULES_PATH

Install on PATH (from E:\\Helmion):
  npm link
`);
}
