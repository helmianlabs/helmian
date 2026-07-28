#!/usr/bin/env node
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
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
  const path = process.env.HELMION_RULES_PATH
    ? resolve(process.env.HELMION_RULES_PATH)
    : join(process.cwd(), '.helmion', 'autonomy_rules.json');
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  return Array.isArray(parsed) ? parsed : parsed.promoted_rules ?? parsed.rules ?? [];
}

async function guard() {
  const payload = await stdinJson();
  const destructive = detectDestructiveOperation(payload);
  const rules = evaluateRules(payload, await loadRules());
  const result = {
    allowed: !destructive.blocked && !rules.blocked,
    destructive,
    rules,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.allowed) process.exitCode = 2;
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

const command = process.argv[2] ?? 'help';
if (command === 'agent' || command === 'chat' || command === 'code') {
  const { runAgentCli } = await import('../src/agent/session.mjs');
  await runAgentCli(process.argv.slice(3));
} else if (command === 'agent-bridge') {
  // Long-lived NDJSON protocol for the Windows Pilot EXE.
  const { runAgentBridge } = await import('../src/agent/bridge.mjs');
  await runAgentBridge();
} else if (command === 'guard') await guard();
else if (command === 'agent-os') await agentOs();
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
