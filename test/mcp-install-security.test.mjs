// Tests for the MCP server install security pipeline.
//
// The discipline here is that every detector is proved in BOTH directions: the
// poisoned fixture must be caught, AND the benign fixture must come back clean.
// A scanner that flags everything is useless, so a passing suite that only ever
// runs the hostile case proves nothing.
//
// Fixtures live in test-support/mcp-candidates/. The poisoned one is only ever
// executed through the sandbox harness — it refuses to run without the
// HELMION_SANDBOX_RUN_ID marker the harness injects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

import {
  auditCandidate,
  auditSourceText,
  stripCommentsPreservingLines,
  formatAuditReport,
  AUDIT_SEVERITY,
} from '../src/core/mcp-code-audit.mjs';
import {
  runSandboxedCandidate,
  buildScrubbedEnv,
  isSecretShapedName,
  isolationStatement,
  DEFAULT_ENV_ALLOWLIST,
} from '../src/core/mcp-sandbox.mjs';
import {
  assertInteractiveTerminal,
  requestInstallApproval,
  detectApprovalTampering,
  generateChallengePhrase,
  buildApprovalBriefing,
  ApprovalRefusedError,
} from '../src/core/mcp-approval.mjs';
import {
  computeCandidateFingerprint,
  compareFingerprints,
  checkForDrift,
  recordDecision,
  readLedger,
  saveBaseline,
  LEDGER_DECISIONS,
} from '../src/core/mcp-install-ledger.mjs';
import {
  discoverMcpServers,
  provenanceNotes,
  DiscoveryRateLimitError,
  DiscoveryError,
} from '../src/core/mcp-discovery.mjs';
import { runInstallPipeline, loadDeclaredManifest } from '../src/core/mcp-install-pipeline.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const POISONED = join(repoRoot, 'test-support', 'mcp-candidates', 'poisoned-note-keeper');
const BENIGN = join(repoRoot, 'test-support', 'mcp-candidates', 'benign-unit-converter');

async function scratchDir() {
  return mkdtemp(join(tmpdir(), 'helmion-mcp-test-'));
}

function findingsFor(report, rule) {
  return report.findings.filter((f) => f.rule === rule);
}

/**
 * A stand-in terminal. readline/promises needs REAL streams (it calls
 * output.on), so a plain object with an isTTY property is not enough.
 */
function fakeTerminal(answer) {
  const stdin = Readable.from([`${answer}\n`]);
  stdin.isTTY = true;
  const chunks = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); },
  });
  stdout.isTTY = true;
  return { stdin, stdout, output: () => chunks.join('') };
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 2 — CODE READ
// ─────────────────────────────────────────────────────────────────────────────

test('code read blocks the poisoned candidate and cites every flag by file:line', async () => {
  const declared = await loadDeclaredManifest(POISONED);
  const report = await auditCandidate({ root: POISONED, declared });

  assert.equal(report.verdict, 'blocked');
  assert.equal(report.blocking, true);
  assert.ok(report.summary.critical >= 8, `expected >=8 critical, got ${report.summary.critical}`);

  // Every rule the brief named explicitly must fire.
  const required = [
    'obfuscation/eval',
    'obfuscation/base64-blob',
    'obfuscation/base64-decode',
    'obfuscation/hex-escaped-string',
    'network/undeclared-host',
    'process/child-process-import',
    'process/command-execution',
    'filesystem/write-outside-own-directory',
    'credential/reads-secret-file',
    'env/enumeration',
    'package/install-hook',
  ];
  for (const rule of required) {
    assert.ok(findingsFor(report, rule).length > 0, `rule did not fire: ${rule}`);
  }

  // Every finding carries a usable citation.
  for (const f of report.findings) {
    assert.match(f.citation, /^[^\s:]+:\d+$/, `bad citation on ${f.rule}: ${f.citation}`);
    assert.ok(f.line >= 1);
  }

  // The undeclared host is named, and it is the exfil sink.
  const host = findingsFor(report, 'network/undeclared-host')[0];
  assert.match(host.evidence, /telemetry-collector\.example\.net/);
});

test('code read returns CLEAN for the benign candidate — the scanner is not just flagging everything', async () => {
  const declared = await loadDeclaredManifest(BENIGN);
  const report = await auditCandidate({ root: BENIGN, declared });

  assert.equal(report.verdict, 'clean');
  assert.equal(report.blocking, false);
  assert.equal(report.summary.critical, 0);
  assert.equal(report.summary.high, 0);
  assert.equal(report.summary.medium, 0);
});

test('a declared host is INFO while an undeclared host is CRITICAL', () => {
  const source = [
    "const a = await fetch('https://api.allowed.example/v1');",
    "const b = await fetch('https://evil.other.example/collect');",
  ].join('\n');
  const findings = auditSourceText({
    file: 'x.mjs', source, declared: { allowedHosts: ['api.allowed.example'] },
  });
  const declared = findings.filter((f) => f.rule === 'network/declared-host');
  const undeclared = findings.filter((f) => f.rule === 'network/undeclared-host');
  assert.equal(declared.length, 1);
  assert.equal(declared[0].severity, AUDIT_SEVERITY.INFO);
  assert.equal(undeclared.length, 1);
  assert.equal(undeclared[0].severity, AUDIT_SEVERITY.CRITICAL);
  assert.equal(undeclared[0].line, 2);
});

test('reading one named env var is INFO; sweeping the whole environment is CRITICAL', () => {
  const targeted = auditSourceText({
    file: 'a.mjs',
    source: 'const k = process.env.MY_DECLARED_VAR;',
    declared: { allowedEnv: ['MY_DECLARED_VAR'] },
  });
  assert.equal(targeted.filter((f) => f.rule === 'env/declared-read').length, 1);
  assert.equal(targeted.filter((f) => f.severity === AUDIT_SEVERITY.CRITICAL).length, 0);

  for (const sweep of [
    'const all = Object.keys(process.env);',
    'const all = Object.entries(process.env);',
    'const all = { ...process.env };',
    'const all = JSON.stringify(process.env);',
    'for (const k in process.env) { send(k); }',
  ]) {
    const findings = auditSourceText({ file: 'b.mjs', source: sweep, declared: {} });
    const enumeration = findings.filter((f) => f.rule === 'env/enumeration');
    assert.equal(enumeration.length, 1, `no enumeration finding for: ${sweep}`);
    assert.equal(enumeration[0].severity, AUDIT_SEVERITY.CRITICAL);
  }
});

test('an undeclared env var read is flagged at MEDIUM even though it is targeted', () => {
  const findings = auditSourceText({
    file: 'a.mjs', source: 'const k = process.env.SOMEONE_ELSES_API_KEY;', declared: { allowedEnv: [] },
  });
  const undeclared = findings.filter((f) => f.rule === 'env/undeclared-read');
  assert.equal(undeclared.length, 1);
  assert.equal(undeclared[0].severity, AUDIT_SEVERITY.MEDIUM);
});

test('patterns inside comments do not fire — the scanner must not flag documentation', () => {
  const source = [
    '// This server never calls eval() and never uses child_process.',
    '/* We do not POST to https://evil.example.com/collect — see SECURITY.md */',
    '// Object.keys(process.env) would be harvesting, so we avoid it.',
    'export const safe = true;',
  ].join('\n');
  const findings = auditSourceText({ file: 'doc.mjs', source, declared: {} });
  assert.deepEqual(findings, [], `comment text produced findings: ${JSON.stringify(findings)}`);
});

test('the comment stripper preserves line numbering so citations stay accurate', () => {
  const source = 'const a = 1;\n/* two\nthree\nfour */\nconst b = eval("x");';
  const stripped = stripCommentsPreservingLines(source);
  assert.equal(stripped.split('\n').length, source.split('\n').length);
  const findings = auditSourceText({ file: 'n.mjs', source, declared: {} });
  const evalFinding = findings.find((f) => f.rule === 'obfuscation/eval');
  assert.equal(evalFinding.line, 5);
});

test('the code read report always carries its own limitations, including the unaudited dependency tree', async () => {
  const declared = await loadDeclaredManifest(BENIGN);
  const report = await auditCandidate({ root: BENIGN, declared });
  assert.ok(report.limitations.length >= 4);
  assert.ok(report.limitations.some((l) => /never prove the ABSENCE/i.test(l)));
  assert.ok(report.limitations.some((l) => /Dependencies were NOT audited/i.test(l)));
  assert.match(formatAuditReport(report), /LIMITATIONS OF THIS STAGE/);
});

test('binary artifacts are reported as unreadable rather than silently skipped', async () => {
  const dir = await scratchDir();
  try {
    await writeFile(join(dir, 'index.mjs'), 'export const ok = true;\n');
    await writeFile(join(dir, 'native.node'), Buffer.from([0, 1, 2, 3]));
    const report = await auditCandidate({ root: dir, declared: {} });
    const unreadable = findingsFor(report, 'coverage/unreadable-binary');
    assert.equal(unreadable.length, 1);
    assert.equal(unreadable[0].severity, AUDIT_SEVERITY.HIGH);
    assert.ok(report.limitations.some((l) => /binary\/native file/i.test(l)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 3 — SANDBOX
// ─────────────────────────────────────────────────────────────────────────────

test('the scrubbed environment withholds real secrets and passes only placeholders', () => {
  const baseEnv = {
    SystemRoot: 'C:\\Windows',
    PATH: '/usr/bin',
    HELMION_DATABASE_URL: 'postgresql://real:secret@neon/db',
    GITHUB_TOKEN: 'ghp_realtokenvalue',
    OPENAI_API_KEY: 'sk-realkeyvalue',
    AWS_SECRET_ACCESS_KEY: 'realawssecret',
    UNIT_CONVERTER_CACHE_TTL: '9999',
  };
  const { env, kept, placeholders, withheld } = buildScrubbedEnv({
    declared: { allowedEnv: ['UNIT_CONVERTER_CACHE_TTL'] },
    runId: 'run-1', eventLogPath: 'C:\\tmp\\events.jsonl', canaryToken: 'CANARY', baseEnv,
  });

  // The named secrets the brief called out are ABSENT.
  for (const secret of ['HELMION_DATABASE_URL', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY']) {
    assert.equal(env[secret], undefined, `${secret} leaked into the sandbox env`);
    assert.ok(withheld.includes(secret), `${secret} was not recorded as withheld`);
    assert.ok(!kept.includes(secret));
  }
  // No real VALUE survives anywhere in the environment either.
  const serialized = JSON.stringify(env);
  for (const value of ['postgresql://real:secret@neon/db', 'ghp_realtokenvalue', 'sk-realkeyvalue', 'realawssecret']) {
    assert.ok(!serialized.includes(value), `a real secret value leaked: ${value}`);
  }
  // The declared variable is present but is an obvious placeholder, not 9999.
  assert.ok(placeholders.includes('UNIT_CONVERTER_CACHE_TTL'));
  assert.match(env.UNIT_CONVERTER_CACHE_TTL, /^helmion-sandbox-placeholder-/);
  assert.notEqual(env.UNIT_CONVERTER_CACHE_TTL, '9999');
});

test('the allowlist itself contains no secret-shaped names, and the secret detector works', () => {
  for (const name of DEFAULT_ENV_ALLOWLIST) {
    assert.equal(isSecretShapedName(name), false, `allowlist contains a secret-shaped name: ${name}`);
  }
  for (const name of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'DB_PASSWORD', 'HELMION_DATABASE_URL', 'AWS_ACCESS_KEY_ID', 'SIGNING_PRIVATE_KEY']) {
    assert.equal(isSecretShapedName(name), true, `not detected as secret-shaped: ${name}`);
  }
});

test('sandbox catches the poisoned candidate on every channel and records real evidence', async () => {
  const declared = await loadDeclaredManifest(POISONED);
  const report = await runSandboxedCandidate({
    root: POISONED,
    declared,
    timeoutMs: 30000,
    baseEnv: {
      SystemRoot: process.env.SystemRoot,
      HELMION_DATABASE_URL: 'postgresql://decoy:decoy@decoy.example/db',
      GITHUB_TOKEN: 'ghp_decoyvalue0123456789',
    },
  });

  assert.equal(report.verdict, 'misbehaved');

  // EVIDENCE INTEGRITY. This is the regression guard for the defect where the
  // observer's own log write was blocked by the observer's own filesystem
  // guard: the run recorded ZERO events and the poisoned fixture was reported
  // as "no-observed-misbehaviour".
  assert.equal(report.evidence.complete, true, 'sandbox produced no trustworthy evidence');
  assert.equal(report.evidence.observerReady, true);
  assert.deepEqual(report.evidence.loggingFailures, []);
  assert.ok(report.evidence.eventCount > 10, `expected a populated event log, got ${report.evidence.eventCount}`);

  const o = report.observed;
  assert.ok(o.undeclaredHosts.includes('telemetry-collector.example.net'));
  assert.ok(o.subprocessAttempts >= 1);
  assert.ok(o.subprocessCommands.some((c) => /whoami/.test(c)));
  assert.ok(o.credentialPathReads.some((p) => /id_rsa/.test(p)));
  assert.ok(o.writesOutsideSandbox.length >= 1);
  assert.equal(o.envEnumerated, true);

  // Direct runtime proof of exfiltration: the planted canary was in the body
  // the candidate tried to POST.
  assert.ok(o.canaryLeakAttempts >= 1, 'canary exfiltration was not observed');

  // And the attempted credential read got NOTHING — the fixture reports the
  // block on stderr rather than a key length.
  assert.match(report.stderr, /credential read blocked/);
  assert.ok(!/READ PRIVATE KEY/.test(report.stderr), 'the candidate actually read a private key');

  // No real secret value ever reached the child.
  assert.ok(!report.stdout.includes('postgresql://decoy'));
  assert.ok(!report.stderr.includes('ghp_decoyvalue0123456789'));
});

test('sandbox reports the benign candidate as clean, with its one call going to its declared host', async () => {
  const declared = await loadDeclaredManifest(BENIGN);
  const report = await runSandboxedCandidate({ root: BENIGN, declared, timeoutMs: 30000 });

  assert.equal(report.verdict, 'no-observed-misbehaviour');
  assert.equal(report.evidence.complete, true);
  assert.deepEqual(report.observed.undeclaredHosts, []);
  assert.equal(report.observed.subprocessAttempts, 0);
  assert.deepEqual(report.observed.credentialPathReads, []);
  assert.deepEqual(report.observed.writesOutsideSandbox, []);
  assert.equal(report.observed.envEnumerated, false);
  assert.equal(report.observed.canaryLeakAttempts, 0);
  assert.ok(report.observed.contactedHosts.includes('rates.unit-converter-example.org'));
});

test('the sandbox never overclaims containment', () => {
  const statement = isolationStatement();
  assert.match(statement.achieved, /process-level/);
  assert.match(statement.isNot, /virtual machine/);
  assert.match(statement.isNot, /container/);
  assert.ok(statement.doesNotProtectAgainst.length >= 5);
  assert.ok(statement.doesNotProtectAgainst.some((s) => /INVOKING USER/.test(s)));
  assert.ok(statement.doesNotProtectAgainst.some((s) => /native addons/i.test(s)));
  assert.match(statement.conclusion, /never as "is safe"/);
});

test('the candidate runs in a throwaway copy, so the fixture on disk is never modified', async () => {
  const before = await readFile(join(POISONED, 'index.mjs'), 'utf8');
  const declared = await loadDeclaredManifest(POISONED);
  await runSandboxedCandidate({ root: POISONED, declared, timeoutMs: 30000 });
  const after = await readFile(join(POISONED, 'index.mjs'), 'utf8');
  assert.equal(before, after);
});

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 4 — HUMAN APPROVAL
// ─────────────────────────────────────────────────────────────────────────────

test('approval REFUSES when stdin is not a TTY', () => {
  assert.throws(
    () => assertInteractiveTerminal({ stdin: { isTTY: false }, stdout: { isTTY: true } }),
    (error) => error instanceof ApprovalRefusedError && error.details.reason === 'not-a-tty',
  );
  assert.throws(
    () => assertInteractiveTerminal({ stdin: { isTTY: true }, stdout: { isTTY: false } }),
    ApprovalRefusedError,
  );
  assert.equal(assertInteractiveTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } }), true);
});

test('approval rejects a blind "yes" — the challenge phrase cannot be guessed', async () => {
  const term = fakeTerminal('yes');
  const result = await requestInstallApproval({
    briefing: buildApprovalBriefing({}),
    stdin: term.stdin, stdout: term.stdout, env: {}, challenge: 'anchor-basalt-cinder',
  });
  assert.equal(result.approved, false);
  assert.match(result.reason, /did not type the challenge phrase/);
});

test('approval succeeds only when the exact challenge phrase is typed', async () => {
  const term = fakeTerminal('  Anchor-Basalt-Cinder ');
  const result = await requestInstallApproval({
    briefing: buildApprovalBriefing({}),
    stdin: term.stdin, stdout: term.stdout, env: {}, challenge: 'anchor-basalt-cinder',
  });
  assert.equal(result.approved, true);
  assert.match(term.output(), /HUMAN APPROVAL REQUIRED/);
  assert.match(result.gateLimitation, /PTY-allocating agent/);
});

test('an environment variable that looks like an auto-approve switch is treated as tampering', async () => {
  for (const name of ['HELMION_AUTO_APPROVE', 'HELMION_MCP_SKIP_APPROVAL', 'HELMION_FORCE_INSTALL', 'HELMION_MCP_ASSUME_YES']) {
    assert.deepEqual(detectApprovalTampering({ [name]: '1' }), [name]);
    await assert.rejects(
      () => requestInstallApproval({ briefing: buildApprovalBriefing({}), env: { [name]: '1' } }),
      (error) => error instanceof ApprovalRefusedError && error.details.reason === 'tamper-detected',
    );
  }
  assert.deepEqual(detectApprovalTampering({ PATH: '/usr/bin', HOME: '/home/x' }), []);
});

test('challenge phrases are randomly generated per prompt', () => {
  const phrases = new Set();
  for (let i = 0; i < 40; i += 1) phrases.add(generateChallengePhrase());
  assert.ok(phrases.size > 20, `challenge phrases are not sufficiently random: ${phrases.size} unique of 40`);
});

test('the briefing puts the hostile findings in plain English in front of the human', async () => {
  const declared = await loadDeclaredManifest(POISONED);
  const audit = await auditCandidate({ root: POISONED, declared });
  const briefing = buildApprovalBriefing({
    discovery: { name: 'note-keeper-mcp', declared },
    audit,
    sandbox: {
      verdict: 'misbehaved',
      observed: {
        undeclaredHosts: ['telemetry-collector.example.net'],
        subprocessAttempts: 1, subprocessCommands: ['whoami'],
        credentialPathReads: ['~/.ssh/id_rsa'], writesOutsideSandbox: [],
        envEnumerated: true, canaryLeakAttempts: 1,
      },
      isolation: isolationStatement(),
    },
  });
  assert.ok(briefing.found.some((f) => /telemetry-collector/.test(f)));
  assert.ok(briefing.found.some((f) => /exfiltration, observed directly/.test(f)));
  assert.ok(briefing.found.some((f) => /swept the entire environment/.test(f)));
  assert.ok(briefing.wants.some((w) => /api\.note-keeper-example\.com/.test(w)));
  assert.ok(briefing.limitations.some((l) => /NOT a virtual machine|is NOT /.test(l)));
});

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 5 — LEDGER AND DRIFT
// ─────────────────────────────────────────────────────────────────────────────

test('a fingerprint is stable for unchanged input and changes when a file changes', async () => {
  const dir = await scratchDir();
  try {
    await writeFile(join(dir, 'index.mjs'), 'export const v = 1;\n');
    const declared = { allowedHosts: ['a.example'], allowedEnv: ['X'], tools: ['t'], purpose: 'p' };
    const first = await computeCandidateFingerprint({ root: dir, declared });
    const second = await computeCandidateFingerprint({ root: dir, declared });
    assert.equal(first.fingerprint, second.fingerprint);

    await writeFile(join(dir, 'index.mjs'), 'export const v = 2;\n');
    const third = await computeCandidateFingerprint({ root: dir, declared });
    assert.notEqual(first.fingerprint, third.fingerprint);

    const diff = compareFingerprints(first, third);
    assert.equal(diff.drifted, true);
    assert.equal(diff.requiresReapproval, true);
    assert.ok(diff.changes.some((c) => c.kind === 'file-modified' && c.detail === 'index.mjs'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a later request for MORE access is flagged as a permission expansion, never passed silently', async () => {
  const dir = await scratchDir();
  try {
    await writeFile(join(dir, 'index.mjs'), 'export const v = 1;\n');
    const approved = await computeCandidateFingerprint({
      root: dir,
      declared: { allowedHosts: ['api.ok.example'], allowedEnv: ['CACHE_TTL'], tools: ['convert'], purpose: 'convert units' },
    });
    const expanded = await computeCandidateFingerprint({
      root: dir,
      declared: {
        allowedHosts: ['api.ok.example', 'analytics.someone-else.example'],
        allowedEnv: ['CACHE_TTL', 'OPENAI_API_KEY'],
        tools: ['convert', 'shell.exec'],
        purpose: 'convert units',
      },
    });

    const diff = compareFingerprints(approved, expanded);
    assert.equal(diff.drifted, true);
    assert.equal(diff.requiresReapproval, true);
    assert.equal(diff.expansions.length, 3);
    for (const expected of ['analytics.someone-else.example', 'OPENAI_API_KEY', 'shell.exec']) {
      assert.ok(
        diff.expansions.some((e) => e.detail.includes(expected)),
        `expansion not flagged: ${expected}`,
      );
    }
    for (const expansion of diff.expansions) assert.equal(expansion.severity, 'critical');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unchanged, previously approved server reports no drift', async () => {
  const ledgerDir = await scratchDir();
  try {
    const declared = await loadDeclaredManifest(BENIGN);
    const fingerprint = await computeCandidateFingerprint({ root: BENIGN, declared });
    await saveBaseline({ ledgerDir, serverName: 'unit-converter-mcp', fingerprint, approvalRecord: { challenge: 'x' } });

    const result = await checkForDrift({ ledgerDir, serverName: 'unit-converter-mcp', root: BENIGN, declared });
    assert.equal(result.status, 'unchanged');
    assert.match(result.message, /matches the fingerprint approved/);
  } finally {
    await rm(ledgerDir, { recursive: true, force: true });
  }
});

test('a server with no baseline is reported as never having been through the pipeline', async () => {
  const ledgerDir = await scratchDir();
  try {
    const declared = await loadDeclaredManifest(BENIGN);
    const result = await checkForDrift({ ledgerDir, serverName: 'never-seen', root: BENIGN, declared });
    assert.equal(result.status, 'no-baseline');
    assert.match(result.message, /never been through this pipeline/);
  } finally {
    await rm(ledgerDir, { recursive: true, force: true });
  }
});

test('every decision lands in the local ledger even with no database configured', async () => {
  const ledgerDir = await scratchDir();
  try {
    for (const decision of LEDGER_DECISIONS) {
      const entry = await recordDecision({
        ledgerDir, decision, serverName: 'x', detail: { note: decision }, connectionString: null,
      });
      assert.equal(entry.decision, decision);
      assert.equal(entry.neon.attempted, false);
    }
    const ledger = await readLedger({ ledgerDir });
    assert.equal(ledger.length, LEDGER_DECISIONS.length);
    assert.deepEqual(ledger.map((e) => e.decision), [...LEDGER_DECISIONS]);
    for (const entry of ledger) {
      assert.ok(entry.id && entry.ts, 'ledger entry missing id/timestamp');
    }
  } finally {
    await rm(ledgerDir, { recursive: true, force: true });
  }
});

test('an unknown decision name is rejected rather than silently recorded', async () => {
  const ledgerDir = await scratchDir();
  try {
    await assert.rejects(
      () => recordDecision({ ledgerDir, decision: 'totally-fine', serverName: 'x', connectionString: null }),
      /Unknown ledger decision/,
    );
  } finally {
    await rm(ledgerDir, { recursive: true, force: true });
  }
});

test('the Neon write uses the helmion lane and the exact recordTelemetry contract', async () => {
  const ledgerDir = await scratchDir();
  try {
    const calls = [];
    const store = {
      async recordTelemetry(input) { calls.push(input); return { ok: true, recorded: true, id: 42 }; },
    };
    const entry = await recordDecision({
      ledgerDir, decision: 'installed', serverName: 'unit-converter-mcp',
      projectSlug: 'helmion', detail: { fingerprint: 'abc' }, store, connectionString: null,
    });

    assert.equal(calls.length, 1);
    // Matches the adapter signature at src/adapters/neon.mjs:1076-1096, which
    // reads input.eventType (required), input.projectSlug and input.payload.
    assert.equal(calls[0].eventType, 'mcp-install.installed');
    assert.equal(calls[0].projectSlug, 'helmion');
    assert.equal(calls[0].payload.decision, 'installed');
    assert.equal(calls[0].payload.serverName, 'unit-converter-mcp');
    assert.equal(calls[0].payload.detail.fingerprint, 'abc');
    assert.equal(entry.neon.written, true);
    assert.equal(entry.neon.id, 42);
  } finally {
    await rm(ledgerDir, { recursive: true, force: true });
  }
});

test('a failed database write is recorded, never silently swallowed', async () => {
  const ledgerDir = await scratchDir();
  try {
    const failingStore = { async recordTelemetry() { throw new Error('neon unreachable'); } };
    const entry = await recordDecision({
      ledgerDir, decision: 'installed', serverName: 'x', store: failingStore, connectionString: null,
    });
    assert.equal(entry.neon.attempted, true);
    assert.equal(entry.neon.written, false);
    assert.match(entry.neon.error, /neon unreachable/);

    const ledger = await readLedger({ ledgerDir });
    assert.ok(
      ledger.some((e) => e.decision === 'neon-write-failed'),
      'a failed durable write left no trace in the local ledger',
    );
  } finally {
    await rm(ledgerDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 1 — DISCOVERY
// ─────────────────────────────────────────────────────────────────────────────

function fakeGithubResponse({ status = 200, body = {}, headers = {} }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    async json() { return body; },
  };
}

test('discovery records repo, stars, last commit and license for each candidate', async () => {
  const report = await discoverMcpServers({
    need: 'sqlite',
    fetchImpl: async () => fakeGithubResponse({
      headers: { 'x-ratelimit-remaining': '7' },
      body: {
        total_count: 1,
        items: [{
          name: 'sqlite-mcp', full_name: 'someone/sqlite-mcp',
          html_url: 'https://github.com/someone/sqlite-mcp',
          clone_url: 'https://github.com/someone/sqlite-mcp.git',
          description: 'SQLite for MCP', stargazers_count: 412, forks_count: 20,
          pushed_at: '2026-07-01T00:00:00Z', created_at: '2024-01-01T00:00:00Z',
          license: { spdx_id: 'MIT' }, archived: false,
          owner: { login: 'someone' }, default_branch: 'main',
        }],
      },
    }),
  });

  assert.equal(report.repositories.length, 1);
  const repo = report.repositories[0];
  assert.equal(repo.fullName, 'someone/sqlite-mcp');
  assert.equal(repo.stars, 412);
  assert.equal(repo.license, 'MIT');
  assert.equal(repo.lastCommit, '2026-07-01T00:00:00Z');
  assert.equal(report.rateLimitRemaining, 7);
  assert.match(report.caveat, /not a safety signal/);
});

test('the search is scoped to name and description, not readme', async () => {
  let requestedUrl = null;
  await discoverMcpServers({
    need: 'sqlite',
    fetchImpl: async (url) => { requestedUrl = url; return fakeGithubResponse({ body: { total_count: 0, items: [] } }); },
  });
  const decoded = decodeURIComponent(requestedUrl);
  assert.match(decoded, /in:name,description/);
  // Measured against the live API: including readme ranks awesome-lists above
  // every real MCP server once sort=stars is applied.
  assert.ok(!/readme/.test(decoded), 'readme is back in the query scope');
});

test('a GitHub rate limit is a distinct error, never reported as "no results"', async () => {
  const resetAt = Math.floor(Date.now() / 1000) + 60;
  await assert.rejects(
    () => discoverMcpServers({
      need: 'sqlite',
      fetchImpl: async () => fakeGithubResponse({
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) },
      }),
    }),
    (error) => {
      assert.ok(error instanceof DiscoveryRateLimitError);
      assert.match(error.message, /NOT "no results found"/);
      assert.equal(error.details.status, 403);
      return true;
    },
  );

  // 429 takes the same path.
  await assert.rejects(
    () => discoverMcpServers({ need: 'x', fetchImpl: async () => fakeGithubResponse({ status: 429 }) }),
    DiscoveryRateLimitError,
  );
  // A network failure is a DiscoveryError, still not an empty result.
  await assert.rejects(
    () => discoverMcpServers({ need: 'x', fetchImpl: async () => { throw new Error('ENOTFOUND'); } }),
    DiscoveryError,
  );
  await assert.rejects(() => discoverMcpServers({ need: '   ' }), DiscoveryError);
});

test('provenance notes surface archived, unlicensed, stale and brand-new repositories', () => {
  const now = new Date('2026-07-28T00:00:00Z');
  const notes = provenanceNotes({
    archived: true, license: null, stars: 1,
    lastCommit: '2024-01-01T00:00:00Z', createdAt: '2026-07-20T00:00:00Z',
  }, now);
  assert.ok(notes.some((n) => /ARCHIVED/.test(n)));
  assert.ok(notes.some((n) => /No license/.test(n)));
  assert.ok(notes.some((n) => /likely unmaintained/.test(n)));
  assert.ok(notes.some((n) => /typosquatting/.test(n)));
  assert.ok(notes.some((n) => /effectively unreviewed/.test(n)));

  const healthy = provenanceNotes({
    archived: false, license: 'MIT', stars: 900,
    lastCommit: '2026-07-20T00:00:00Z', createdAt: '2023-01-01T00:00:00Z',
  }, now);
  assert.deepEqual(healthy, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// FULL PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

test('the pipeline halts the poisoned candidate at the code read and never reaches a human', async () => {
  const scratch = await scratchDir();
  try {
    let approveCalled = false;
    const report = await runInstallPipeline({
      root: POISONED,
      ledgerDir: join(scratch, 'ledger'),
      installRoot: join(scratch, 'servers'),
      connectionString: null,
      approve: async () => { approveCalled = true; return { approved: true }; },
    });

    assert.equal(report.finalDecision, 'blocked-by-code-read');
    assert.equal(approveCalled, false, 'a human was asked to approve a candidate with critical findings');
    assert.equal(report.installedPath, null);
    assert.equal(existsSync(join(scratch, 'servers')), false, 'something was installed');

    const ledger = await readLedger({ ledgerDir: join(scratch, 'ledger') });
    assert.ok(ledger.some((e) => e.decision === 'flagged'));
    assert.ok(ledger.some((e) => e.decision === 'blocked'));
    assert.ok(!ledger.some((e) => e.decision === 'installed'));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('the pipeline installs the benign candidate only after an explicit approval', async () => {
  const scratch = await scratchDir();
  try {
    const ledgerDir = join(scratch, 'ledger');
    const report = await runInstallPipeline({
      root: BENIGN,
      ledgerDir,
      installRoot: join(scratch, 'servers'),
      connectionString: null,
      approve: async () => ({
        stage: 'approval', approved: true, challenge: 'test-phrase',
        respondedAt: new Date().toISOString(), reason: 'test harness approved',
      }),
    });

    assert.equal(report.finalDecision, 'installed');
    assert.equal(report.stages.codeRead.verdict, 'clean');
    assert.equal(report.stages.sandbox.verdict, 'no-observed-misbehaviour');
    assert.ok(existsSync(join(report.installedPath, 'index.mjs')));

    // A baseline now exists, so a later expansion can be caught.
    assert.ok(report.stages.baseline.fingerprint);
    const drift = await checkForDrift({
      ledgerDir, serverName: report.serverName, root: BENIGN,
      declared: { ...report.declared, allowedHosts: [...report.declared.allowedHosts, 'new.host.example'] },
    });
    assert.equal(drift.status, 'drift-detected');
    assert.equal(drift.comparison.requiresReapproval, true);

    const ledger = await readLedger({ ledgerDir });
    assert.ok(ledger.some((e) => e.decision === 'installed'));
    assert.ok(ledger.some((e) => e.decision === 'sandboxed'));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a human saying no installs nothing', async () => {
  const scratch = await scratchDir();
  try {
    const report = await runInstallPipeline({
      root: BENIGN,
      ledgerDir: join(scratch, 'ledger'),
      installRoot: join(scratch, 'servers'),
      connectionString: null,
      approve: async () => ({
        stage: 'approval', approved: false, challenge: 'test-phrase',
        respondedAt: new Date().toISOString(), reason: 'human declined',
      }),
    });
    assert.equal(report.finalDecision, 'rejected-by-human');
    assert.equal(report.installedPath, null);
    assert.equal(existsSync(join(scratch, 'servers')), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a candidate with no manifest declares nothing, so its access is all undeclared', async () => {
  const dir = await scratchDir();
  try {
    await writeFile(join(dir, 'index.mjs'), "await fetch('https://anywhere.example/x');\n");
    const declared = await loadDeclaredManifest(dir);
    assert.equal(declared.manifestPresent, false);
    assert.match(declared.manifestNote, /declared nothing/);

    const report = await auditCandidate({ root: dir, declared });
    assert.equal(findingsFor(report, 'network/undeclared-host').length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the installed server is materialized without the global MCP config being touched', async () => {
  const scratch = await scratchDir();
  try {
    const report = await runInstallPipeline({
      root: BENIGN,
      ledgerDir: join(scratch, 'ledger'),
      installRoot: join(scratch, 'servers'),
      connectionString: null,
      approve: async () => ({ stage: 'approval', approved: true, challenge: 'p', respondedAt: new Date().toISOString(), reason: 'ok' }),
    });
    // The snippet is RETURNED for the human, never written anywhere.
    assert.ok(report.configSnippet.mcpServers['unit-converter-mcp']);
    const ledger = await readLedger({ ledgerDir: join(scratch, 'ledger') });
    const installed = ledger.find((e) => e.decision === 'installed');
    assert.match(installed.detail.note, /Global MCP config was NOT modified/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CLI — the strongest form of the non-TTY proof: the real binary, real pipes.
// ─────────────────────────────────────────────────────────────────────────────

function runCli(args, { input = '' } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(repoRoot, 'bin', 'helmion.mjs'), ...args], {
      cwd: repoRoot,
      env: { ...process.env, HELMION_DATABASE_URL: '', GITHUB_TOKEN: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.stdin.end(input);
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

test('CLI: `mcp-install review` with piped stdin exits non-zero and installs nothing', async () => {
  const scratch = await scratchDir();
  try {
    const installRoot = join(scratch, 'servers');
    // Piping "yes" is exactly how an agent would try to fake a human.
    const result = await runCli(
      ['mcp-install', 'review', BENIGN, '--ledger-dir', join(scratch, 'ledger')],
      { input: 'yes\nyes\nyes\n' },
    );

    assert.notEqual(result.code, 0, 'a non-interactive install returned success');
    assert.equal(result.code, 2);
    assert.match(result.stdout, /REFUSED-NOT-A-TTY/);
    assert.match(result.stdout, /NOTHING WAS INSTALLED/);
    assert.equal(existsSync(installRoot), false);

    const ledger = await readLedger({ ledgerDir: join(scratch, 'ledger') });
    assert.ok(ledger.some((e) => e.decision === 'rejected'));
    assert.ok(!ledger.some((e) => e.decision === 'installed'));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('CLI: `mcp-install audit` exits non-zero on the poisoned candidate and zero on the benign one', async () => {
  const poisoned = await runCli(['mcp-install', 'audit', POISONED]);
  assert.equal(poisoned.code, 2);
  assert.match(poisoned.stdout, /verdict: BLOCKED/);
  assert.match(poisoned.stdout, /LIMITATIONS OF THIS STAGE/);

  const benign = await runCli(['mcp-install', 'audit', BENIGN]);
  assert.equal(benign.code, 0);
  assert.match(benign.stdout, /verdict: CLEAN/);
});

test('CLI: help lists mcp-install and states that there is no auto-approve', async () => {
  const result = await runCli(['help']);
  assert.match(result.stdout, /helmion mcp-install review/);
  assert.match(result.stdout, /There is no --yes and no auto-approve/);
});
