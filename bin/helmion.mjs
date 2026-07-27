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
if (command === 'guard') await guard();
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
  process.stdout.write(`Helmion Agent Governance Kernel

Usage:
  helmion init [workspace]
  helmion guard                 # reads a tool-hook JSON payload on stdin
  helmion validate-proof        # reads resolution evidence JSON on stdin
  helmion consensus             # reads operation/actionHash/reviews JSON on stdin
  helmion distill               # reads a resolved blocker JSON on stdin
  helmion confirmation-action-hash
                                # reads projectSlug/handoffId/operation JSON on stdin
  helmion pilot-policy          # reads operation/guardState JSON on stdin
                                # exits 0 auto-run, 2 owner pause, or 3 blocked
  helmion owner-key init --provider <id> --subject <id>
      --public-output <path> --recovery-output <outside-workspace-path>
      [--key-dir <outside-workspace\\owner-keys>]
                                # interactive DPAPI key + protected recovery setup
  helmion owner-key inspect --key <local-key-path>
  helmion owner-key export-public --key <local-key-path> --output <path>
  helmion owner-key restore --recovery <path> [--key-dir <...\\owner-keys>]
                                # interactive protected recovery
  helmion owner-key approve --key <local-key-path>
      --request <request.json> --output <outside-workspace\\confirmations\\file.json>
                                # interactive APPROVE/DECLINE; never accepts a flag
  helmion db-inspect --expect-endpoint <ep-id>
                                # read-only target and migration inventory
  helmion migrate --expect-endpoint <ep-id> [--require-empty-helmion]
                                # applies checksummed SQL migrations
  helmion phase-two-switch-test --expect-endpoint <ep-id> [--project <slug>]
                                # isolated lease/checkpoint/transfer/release test
  helmion blockers [project]    # lists active blockers from Neon
  helmion maestro-state <project>
  helmion maestro-handoff <project>

Environment:
  HELMION_DATABASE_URL
  HELMION_EXPECTED_ENDPOINT_ID
  HELMION_RULES_PATH
`);
}
