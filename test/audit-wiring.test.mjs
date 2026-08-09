// PROOF THAT THE BLOCK LEDGER IS ACTUALLY WIRED TO THE TWO GUARDS.
//
// src/core/audit-log.mjs had 11 passing tests and zero callers: every one of
// them called recordBlockEvent directly, so the suite proved the writer worked
// and proved nothing about whether anything ever asked it to write. This file is
// the other half.
//
// THE RULE EVERY TEST HERE FOLLOWS: prove the wiring by the DURABLE SIDE EFFECT.
// A refusal that returns `audit: {logged:true}` has told us what it intends, not
// what happened. Every execution-layer assertion below reads the JSONL file back
// off disk. Where the block travels through the CLI, the CLI is spawned as a
// real process so nothing about the wiring is simulated.
//
// WHAT IS NOT PROVEN HERE, AND CANNOT BE: that a browser block reaches a file.
// It does not. extension/background/scan.js shapes and queues the event, and
// there is no permission-free, network-free route from a Chrome extension to the
// filesystem — see the long comment at the top of that file. The browser tests
// below prove the shaping is correct and that the real writer accepts it; they
// deliberately do not claim durability that does not exist.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUDIT_TEXT_LIMIT,
  auditTextForPayload,
  evaluateToolCall,
  executionBlockEvent,
} from '../src/core/governance-gate.mjs';
import {
  LAYER, auditDir, readBlockEvents, recordBlockEvent,
} from '../src/core/audit-log.mjs';
import {
  AUDIT_QUEUE_LIMIT,
  browserAuditState,
  browserBlockEvent,
  clearRecordedBrowserBlocks,
  recordedBrowserBlocks,
  scanBlocks,
} from '../extension/background/scan.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'helmion.mjs');
const isWindows = process.platform === 'win32';

/** A command that really matches a built-in destructive pattern on this OS. */
const DESTRUCTIVE = isWindows ? 'Remove-Item -Recurse -Force build' : 'rm -rf build';

function makeWorkspace() {
  return mkdtempSync(path.join(tmpdir(), 'helmion-audit-wire-'));
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked temp dir */ }
}

function writeRules(workspace, rules) {
  const dir = path.join(workspace, '.helmion');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'autonomy_rules.json'),
    typeof rules === 'string' ? rules : JSON.stringify({ promoted_rules: rules }, null, 2),
    'utf8',
  );
}

/** Every row on disk, read back through the module's own reader. */
function rows(workspace) {
  return readBlockEvents(workspace).entries;
}

/** The CLI, as a real process, with HELMION_RULES_PATH out of the way. */
function runCli(args, { cwd, input = '' } = {}) {
  const env = { ...process.env };
  delete env.HELMION_RULES_PATH;
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, input, env, encoding: 'utf8',
  });
}

// ═══ 1. THE EXECUTION LAYER, THROUGH evaluateToolCall ════════════════════════

test('A DESTRUCTIVE REFUSAL LANDS ON DISK, and the row says what was refused', () => {
  const workspace = makeWorkspace();
  try {
    const verdict = evaluateToolCall({
      tool: 'run_command',
      args: { command: DESTRUCTIVE },
      workspace,
      auditWorkspace: workspace,
    });

    // The verdict is untouched by the recording.
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason, /destructive operation the kernel always blocks/);
    assert.equal(verdict.audit.logged, true, verdict.audit.reason);

    // THE ASSERTION THAT MATTERS: it is on disk.
    const entries = rows(workspace);
    assert.equal(entries.length, 1, 'the refusal did not reach the ledger');
    const [entry] = entries;
    assert.equal(entry.layer, LAYER.EXECUTION);
    assert.equal(entry.outcome, 'blocked');
    assert.equal(entry.text, DESTRUCTIVE, 'the recorded text is not what was evaluated');
    assert.equal(entry.source, `governance-gate:run_command:${workspace}`);
    assert.match(entry.matchedPattern, isWindows ? /Remove-Item/ : /recursive\/forced rm/);
    assert.ok(entry.hits.length > 0, 'the kernel hits were dropped');
    assert.match(entry.detail, /destructive operation/);
    assert.ok(Date.parse(entry.timestamp) > 0, 'the timestamp is not parseable');
  } finally {
    cleanup(workspace);
  }
});

test('a promoted-rule refusal records the rule pattern that fired', () => {
  const workspace = makeWorkspace();
  try {
    writeRules(workspace, [{ pattern: 'secrets\\.env', severity: 'block' }]);
    const verdict = evaluateToolCall({
      tool: 'read_file',
      args: { path: 'config/secrets.env' },
      workspace,
      auditWorkspace: workspace,
    });

    assert.equal(verdict.allowed, false);
    assert.equal(verdict.audit.logged, true, verdict.audit.reason);
    const [entry] = rows(workspace);
    assert.equal(entry.matchedPattern, '/secrets\\.env/');
    assert.equal(entry.text, 'config/secrets.env');
    assert.equal(entry.source, `governance-gate:read_file:${workspace}`);
  } finally {
    cleanup(workspace);
  }
});

test('a FAIL-CLOSED refusal is recorded under a countable label, not an empty pattern', () => {
  const workspace = makeWorkspace();
  try {
    // A rules file that cannot be parsed. The gate refuses; nothing "matched".
    writeRules(workspace, '{ this is not json');
    const verdict = evaluateToolCall({
      tool: 'run_command',
      args: { command: 'echo hello' },
      workspace,
      auditWorkspace: workspace,
    });

    assert.equal(verdict.allowed, false);
    assert.equal(verdict.failedClosed, true);
    const [entry] = rows(workspace);
    assert.equal(entry.matchedPattern, 'fail-closed:promoted-rules-unusable');
    // An empty matchedPattern would make this row invisible to
    // summarizeBlockEvents().byPattern — the whole point of the label.
    assert.notEqual(entry.matchedPattern, '');
    assert.match(entry.detail, /governance fails closed/);
    assert.equal(entry.hits, undefined, 'no pattern fired, so no hits may be claimed');
  } finally {
    cleanup(workspace);
  }
});

test('a write-lease refusal is recorded and distinguishable from a rule match', () => {
  const workspace = makeWorkspace();
  try {
    // write_file needs the lease; no leaseToken is passed, so it is refused.
    const verdict = evaluateToolCall({
      tool: 'write_file',
      args: { path: 'notes.md', content: 'hello' },
      workspace,
      auditWorkspace: workspace,
    });

    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason, /write lease/);
    const [entry] = rows(workspace);
    assert.equal(entry.matchedPattern, 'write-lease:not-held');
    assert.equal(entry.source, `governance-gate:write_file:${workspace}`);
    // Both strings the rules would have been matched against are recorded,
    // because both are what the kernel looked at.
    assert.match(entry.text, /notes\.md/);
    assert.match(entry.text, /hello/);
  } finally {
    cleanup(workspace);
  }
});

test('RECORDING IS OFF BY DEFAULT: the gate stays a pure evaluator unless asked', () => {
  const workspace = makeWorkspace();
  try {
    const verdict = evaluateToolCall({
      tool: 'run_command',
      args: { command: DESTRUCTIVE },
      workspace,
      // no auditWorkspace
    });
    assert.equal(verdict.allowed, false, 'the block itself must still happen');
    assert.equal('audit' in verdict, false, 'an unasked-for audit field would be a surprise');
    assert.equal(
      existsSync(auditDir(workspace)),
      false,
      'the gate wrote to disk without being given a workspace to write to',
    );
  } finally {
    cleanup(workspace);
  }
});

test('AN ALLOWED CALL RECORDS NOTHING — this is a block ledger, not a tool log', () => {
  const workspace = makeWorkspace();
  try {
    const verdict = evaluateToolCall({
      tool: 'read_file',
      args: { path: 'README.md' },
      workspace,
      auditWorkspace: workspace,
    });
    assert.equal(verdict.allowed, true);
    assert.equal('audit' in verdict, false);
    assert.deepEqual(rows(workspace), []);
  } finally {
    cleanup(workspace);
  }
});

test('A LEDGER THAT CANNOT BE WRITTEN NEVER CHANGES THE VERDICT AND NEVER THROWS', () => {
  const workspace = makeWorkspace();
  try {
    // A FILE where the audit directory has to be, so mkdir + append both fail.
    mkdirSync(path.join(workspace, '.helmion'), { recursive: true });
    writeFileSync(path.join(workspace, '.helmion', 'audit'), 'not a directory', 'utf8');

    let verdict;
    assert.doesNotThrow(() => {
      verdict = evaluateToolCall({
        tool: 'run_command',
        args: { command: DESTRUCTIVE },
        workspace,
        auditWorkspace: workspace,
      });
    });

    // The block STANDS. This is the property that matters most in this file.
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason, /destructive operation/);
    // And the failure is surfaced, not swallowed.
    assert.equal(verdict.audit.logged, false);
    assert.match(verdict.audit.reason, /could not append/);
    assert.ok(verdict.audit.entry, 'the entry is returned so a caller can report it');
  } finally {
    cleanup(workspace);
  }
});

test('a credential in the blocked command does not survive into the ledger file', () => {
  const workspace = makeWorkspace();
  try {
    const secret = 'sk-ant-api03-AbCdEf0123456789xyz';
    evaluateToolCall({
      tool: 'run_command',
      args: { command: `${DESTRUCTIVE} && export ANTHROPIC_API_KEY=${secret}` },
      workspace,
      auditWorkspace: workspace,
    });

    const onDisk = readFileSync(readBlockEvents(workspace).files[0], 'utf8');
    assert.equal(onDisk.includes(secret), false, `the ledger leaked: ${secret}`);
    assert.match(onDisk, /sk-ant-\[REDACTED\]/);
    assert.equal(rows(workspace)[0].redacted, true, 'the masking must declare itself');
  } finally {
    cleanup(workspace);
  }
});

test('AN OVERSIZED WRITE IS CAPPED AND THE TRUNCATION DECLARES ITSELF', () => {
  const workspace = makeWorkspace();
  try {
    writeRules(workspace, [{ pattern: 'FORBIDDEN', severity: 'block' }]);
    const content = `FORBIDDEN ${'x'.repeat(AUDIT_TEXT_LIMIT * 2)}`;
    const verdict = evaluateToolCall({
      tool: 'read_file',
      args: { path: 'big.txt', content },
      workspace,
      auditWorkspace: workspace,
    });
    assert.equal(verdict.allowed, false);

    const [entry] = rows(workspace);
    assert.ok(entry.text.length < content.length, 'an unbounded write reached the ledger');
    assert.match(entry.text, /\[truncated by the Helmion audit log: \d+ of \d+ characters recorded\]/);
    // Silently shortened evidence is worse than none: the reader must be able to
    // see that something was cut and how much.
    assert.match(entry.text, new RegExp(`${AUDIT_TEXT_LIMIT} of \\d+ characters`));

    // And short text is left exactly alone.
    assert.equal(auditTextForPayload({ tool_input: { command: 'rm -rf /' } }), 'rm -rf /');
  } finally {
    cleanup(workspace);
  }
});

// ═══ 2. THE EXECUTION LAYER, THROUGH THE REAL `helmion guard` HOOK ════════════

test('THE PRETOOLUSE HOOK WRITES A LEDGER ROW: real process, real file', () => {
  const workspace = makeWorkspace();
  try {
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: DESTRUCTIVE },
      project_slug: 'helmion',
    });
    const run = runCli(['guard'], { cwd: workspace, input: payload });

    assert.equal(run.status, 2, `guard should exit 2 on a block: ${run.stderr}`);
    const reported = JSON.parse(run.stdout);
    assert.equal(reported.allowed, false);
    assert.equal(reported.audit.logged, true, reported.audit.reason);

    const entries = rows(workspace);
    assert.equal(entries.length, 1, 'the hook refused without recording anything');
    assert.equal(entries[0].layer, LAYER.EXECUTION);
    assert.equal(entries[0].source, `guard-hook:Bash:${workspace}`);
    assert.equal(entries[0].text, DESTRUCTIVE);
    assert.equal(entries[0].outcome, 'blocked');
    assert.ok(entries[0].hits.length > 0);
  } finally {
    cleanup(workspace);
  }
});

test('the hook records its FAIL-CLOSED refusal too, not just pattern matches', () => {
  const workspace = makeWorkspace();
  try {
    writeRules(workspace, '{ not json at all');
    const run = runCli(['guard'], {
      cwd: workspace,
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' } }),
    });

    assert.equal(run.status, 2);
    const [entry] = rows(workspace);
    assert.equal(entry.matchedPattern, 'fail-closed:governance-unevaluatable');
    assert.match(entry.detail, /governance could not be evaluated/);
  } finally {
    cleanup(workspace);
  }
});

test('the hook records nothing when it allows a call', () => {
  const workspace = makeWorkspace();
  try {
    const run = runCli(['guard'], {
      cwd: workspace,
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' } }),
    });
    assert.equal(run.status, 0);
    const reported = JSON.parse(run.stdout);
    assert.equal(reported.allowed, true);
    assert.equal('audit' in reported, false);
    assert.equal(existsSync(auditDir(workspace)), false);
  } finally {
    cleanup(workspace);
  }
});

// ═══ 3. `helmion audit` ═══════════════════════════════════════════════════════

test('`helmion audit list` shows the rows both layers wrote', () => {
  const workspace = makeWorkspace();
  try {
    recordBlockEvent(workspace, {
      layer: LAYER.EXECUTION,
      matchedPattern: 'recursive/forced rm',
      text: 'rm -rf /var/data',
      source: 'guard-hook:Bash:E:\\Helmion',
      outcome: 'blocked',
    });
    recordBlockEvent(workspace, {
      layer: LAYER.BROWSER,
      matchedPattern: 'direct SQL DDL',
      text: 'DROP TABLE loads;',
      source: 'claude.ai',
      outcome: 'blocked',
    });

    const run = runCli(['audit', 'list', '--workspace', workspace]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /2 event\(s\)/);
    assert.match(run.stdout, /rm -rf \/var\/data/);
    assert.match(run.stdout, /DROP TABLE loads;/);
    assert.match(run.stdout, /execution/);
    assert.match(run.stdout, /browser/);
    assert.match(run.stdout, /By layer:\s+.*execution 1/);
    assert.match(run.stdout, /By pattern:\s+.*recursive\/forced rm 1/);
  } finally {
    cleanup(workspace);
  }
});

test('`--layer` filters, and a layer that does not exist is REFUSED not silently empty', () => {
  const workspace = makeWorkspace();
  try {
    recordBlockEvent(workspace, {
      layer: LAYER.EXECUTION, matchedPattern: 'p', text: 'exec row', source: 's', outcome: 'blocked',
    });
    recordBlockEvent(workspace, {
      layer: LAYER.BROWSER, matchedPattern: 'p', text: 'browser row', source: 's', outcome: 'blocked',
    });

    const browser = runCli(['audit', 'list', '--workspace', workspace, '--layer', 'browser']);
    assert.equal(browser.status, 0, browser.stderr);
    assert.match(browser.stdout, /browser row/);
    assert.equal(browser.stdout.includes('exec row'), false, 'the filter leaked the other layer');

    // A typo must NOT print a clean-looking zero. That is the worst failure an
    // audit tool can have.
    const typo = runCli(['audit', 'list', '--workspace', workspace, '--layer', 'Browser']);
    assert.notEqual(typo.status, 0, 'a misspelled layer was accepted');
    assert.match(typo.stderr, /--layer must be one of/);
  } finally {
    cleanup(workspace);
  }
});

test('`helmion audit summary` reports counts, and empty reads as empty not as an error', () => {
  const workspace = makeWorkspace();
  try {
    const empty = runCli(['audit', 'summary', '--workspace', workspace]);
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /0 event\(s\)/);

    recordBlockEvent(workspace, {
      layer: LAYER.EXECUTION, matchedPattern: 'git force push', text: 'git push --force', source: 's', outcome: 'blocked',
    });
    const json = runCli(['audit', 'summary', '--workspace', workspace, '--json']);
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.summary.total, 1);
    assert.equal(parsed.summary.byLayer.execution, 1);
    assert.equal(parsed.summary.malformed, 0);
    assert.equal('entries' in parsed, false, 'summary must not dump the whole ledger');
  } finally {
    cleanup(workspace);
  }
});

test('AN UNREADABLE LINE IS PRINTED AND EXITS NON-ZERO — a torn ledger is not clean evidence', () => {
  const workspace = makeWorkspace();
  try {
    recordBlockEvent(workspace, {
      layer: LAYER.EXECUTION, matchedPattern: 'p', text: 'good row', source: 's', outcome: 'blocked',
    });
    const file = readBlockEvents(workspace).files[0];
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"timestamp":"2026-07-29T00:00:00.0\n`, 'utf8');

    const run = runCli(['audit', 'list', '--workspace', workspace]);
    assert.equal(run.status, 2, 'a corrupt ledger printed a tidy zero-exit report');
    assert.match(run.stdout, /1 UNREADABLE line\(s\)/);
    assert.match(run.stdout, /good row/, 'the intact rows must still be reported');
  } finally {
    cleanup(workspace);
  }
});

test('`helmion audit` rejects a subcommand it does not have, rather than guessing', () => {
  const run = runCli(['audit', 'delete']);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /audit subcommand must be one of: list, summary/);
});

// ═══ 4. THE BROWSER LAYER ════════════════════════════════════════════════════

test('A BROWSER BLOCK IS SHAPED INTO TROY\'S SCHEMA AND QUEUED', () => {
  clearRecordedBrowserBlocks();
  const [result] = scanBlocks([
    { id: 'b1', text: 'cd /var/www\nrm -rf html/*\nnpm run build', source: 'claude.ai' },
  ]);

  assert.equal(result.blocked, true);
  assert.equal(result.audit.recorded, 1);
  assert.equal(result.audit.reason, '');

  const [event] = result.audit.events;
  assert.equal(event.layer, 'browser');
  assert.equal(event.source, 'claude.ai');
  assert.equal(event.outcome, 'blocked');
  assert.equal(event.text, 'rm -rf html/*');
  assert.equal(event.lineNumber, 2);
  assert.match(event.matchedPattern, /rm/);
  assert.ok(Date.parse(event.timestamp) > 0);

  // And it is readable from inside the worker without any permission.
  assert.deepEqual(recordedBrowserBlocks(), result.audit.events);
  assert.equal(browserAuditState().queued, 1);
  assert.equal(browserAuditState().dropped, 0);
});

test('several dangerous lines in one block produce one ledger row each', () => {
  clearRecordedBrowserBlocks();
  const [result] = scanBlocks([
    { id: 'b1', text: 'DROP TABLE loads;\nDROP TABLE drivers;', source: 'chatgpt.com' },
  ]);
  assert.equal(result.audit.recorded, 2);
  assert.deepEqual(result.audit.events.map((e) => e.lineNumber), [1, 2]);
  assert.equal(recordedBrowserBlocks().length, 2);
});

test('a clean block records nothing at all', () => {
  clearRecordedBrowserBlocks();
  const [result] = scanBlocks([{ id: 'b1', text: 'npm install\nnpm run dev', source: 'claude.ai' }]);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.audit.events, []);
  assert.equal(result.audit.recorded, 0);
  assert.equal(result.audit.reason, '', 'nothing was blocked, so there is nothing to explain');
  assert.equal(recordedBrowserBlocks().length, 0);
});

test('A SOURCELESS SCAN RECORDS NOTHING AND SAYS SO — the self-test probes must not flood it', () => {
  clearRecordedBrowserBlocks();
  // Exactly the shape content/guard.js selfTest() sends: no source, on every
  // page load and every 60 seconds thereafter.
  const results = scanBlocks([
    { id: 'selftest-dangerous', text: 'rm -rf /helmion-selftest-probe' },
    { id: 'selftest-clean', text: 'echo helmion-selftest-probe' },
  ]);

  assert.equal(results[0].blocked, true, 'the probe must still be detected');
  assert.equal(results[0].audit.recorded, 0);
  assert.match(results[0].audit.reason, /named no source/);
  assert.equal(recordedBrowserBlocks().length, 0, 'the self-test flooded the ledger');
});

test('THE QUEUE IS CAPPED AND COUNTS WHAT IT DROPPED — a silent loss is not evidence', () => {
  clearRecordedBrowserBlocks();
  const overflow = AUDIT_QUEUE_LIMIT + 5;
  const blocks = [];
  for (let i = 0; i < overflow; i += 1) {
    blocks.push({ id: `b${i}`, text: `rm -rf /data/${i}`, source: 'claude.ai' });
  }
  scanBlocks(blocks);

  const state = browserAuditState();
  assert.equal(state.queued, AUDIT_QUEUE_LIMIT);
  assert.equal(state.dropped, 5, 'the dropped rows were forgotten instead of counted');
  // The OLDEST went, not the newest: the most recent evidence is the evidence
  // somebody is most likely to be asking about.
  assert.match(recordedBrowserBlocks()[0].text, new RegExp(`/data/5$`));
  assert.match(recordedBrowserBlocks()[AUDIT_QUEUE_LIMIT - 1].text, new RegExp(`/data/${overflow - 1}$`));
});

test('THE REAL DURABLE WRITER ACCEPTS A BROWSER EVENT UNCHANGED', () => {
  // The browser layer cannot call recordBlockEvent from Chrome. This proves the
  // event it produces is nonetheless exactly what that writer takes, so the day
  // a sink exists, no reshaping is needed.
  const workspace = makeWorkspace();
  try {
    const event = browserBlockEvent(
      { lineNumber: 3, text: 'DROP TABLE loads;', hits: ['direct SQL DDL'] },
      { source: 'gemini.google.com' },
    );
    const written = recordBlockEvent(workspace, event);
    assert.equal(written.logged, true, written.reason);

    const [entry] = rows(workspace);
    assert.equal(entry.layer, 'browser');
    assert.equal(entry.matchedPattern, 'direct SQL DDL');
    assert.equal(entry.text, 'DROP TABLE loads;');
    assert.equal(entry.source, 'gemini.google.com');
    assert.equal(entry.outcome, 'blocked');
    assert.equal(entry.lineNumber, 3);
  } finally {
    cleanup(workspace);
  }
});

test('the browser layer never imports node:fs — it would break the extension at load', () => {
  const source = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'background', 'scan.js'),
    'utf8',
  );
  // scan.js shapes audit events without importing src/core/audit-log.mjs on
  // purpose. Chrome cannot load node:fs, and the extension's own package test
  // will not catch an import that merely fails at runtime.
  assert.equal(/from ['"]node:/.test(source), false, 'scan.js imports a node builtin');
  assert.equal(/from ['"]\.\.\/\.\.\/src\//.test(source), false, 'scan.js reaches into src/');
});

// ═══ 5. content/guard.js → worker.js → scan.js, END TO END ═══════════════════
//
// The `source` has to travel from the page to the scanner, and the only route
// that does not require editing background/worker.js is a per-block field:
// worker.js:53 hands `message.blocks` straight to scanBlocks. This proves that
// route works against the real files Chrome loads, not a copy of them.

test('THE CONTENT SCRIPT NAMES THE SITE ON EVERY REAL SCAN, AND NOT ON ITS PROBES', async () => {
  clearRecordedBrowserBlocks();

  const { loadContentScripts } = await import('../extension/test-support/load-content-script.mjs');
  const { element, createDocument } = await import('../extension/test-support/mini-dom.mjs');
  const { chrome, fake, installWorker } = await import('../extension/test-support/fake-chrome.mjs');
  await installWorker();
  fake.reset();

  // Record every message the content script sends. Registered AFTER the worker,
  // so the worker still answers; this listener only watches.
  const sent = [];
  chrome.runtime.onMessage.addListener((message) => { sent.push(message); return false; });

  const pre = element('pre', {}, [element('code', {}, ['cd /var/www\nrm -rf html/*'])]);
  const doc = createDocument([element('div', {}, ['Clear the build output:']), pre]);
  const warnings = [];

  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; }

    observe() {}

    disconnect() {}
  }

  // Same order as manifest.json content_scripts — omit prompt-risk and
  // startPromptGuard throws before selfTest / page scan ever run.
  await loadContentScripts([
    'content/prompt-risk.js',
    'content/extract.js',
    'content/stream-watch.js',
    'content/ui.js',
    'content/guard.js',
  ], {
    document: doc,
    chrome,
    MutationObserver: FakeMutationObserver,
    window: {
      addEventListener() {},
      // The real page's hostname, which is what has to reach the ledger.
      location: { hostname: 'claude.ai' },
    },
    // The 60-second health check would keep this process alive.
    setInterval() { return 1; },
    console: {
      log: () => {},
      info: () => {},
      warn: (...args) => { warnings.push(args.join(' ')); },
      error: (...args) => { warnings.push(args.join(' ')); },
    },
  });

  // Self-test is async + sendMessage uses setTimeout(0); stream-watch debounce
  // can add a page pass. 80ms was tight under load and flaked to zero messages.
  await new Promise((done) => { setTimeout(done, 400); });

  const scans = sent.filter((message) => message.type === 'helmion:scan');
  assert.ok(scans.length >= 2, `expected a self-test and a page scan, saw ${scans.length}`);

  const probes = scans.filter((scan) => scan.blocks.some((b) => String(b.id).startsWith('selftest-')));
  const pageScans = scans.filter((scan) => !scan.blocks.some((b) => String(b.id).startsWith('selftest-')));
  assert.ok(probes.length >= 1, 'the self-test never ran');
  assert.ok(pageScans.length >= 1, 'the page was never scanned');

  for (const scan of pageScans) {
    for (const block of scan.blocks) {
      assert.equal(block.source, 'claude.ai', 'a real scan reached the worker with no source');
    }
  }
  for (const scan of probes) {
    for (const block of scan.blocks) {
      assert.equal(block.source, undefined, 'a self-test probe named a source and will be recorded');
    }
  }

  // THE SIDE EFFECT: the page's block is in the worker's queue, attributed to
  // the site, and the probe's identical `rm -rf` is not.
  const queued = recordedBrowserBlocks();
  assert.equal(queued.length, 1, `expected exactly the page block, got ${JSON.stringify(queued)}`);
  assert.equal(queued[0].layer, 'browser');
  assert.equal(queued[0].source, 'claude.ai');
  assert.equal(queued[0].text, 'rm -rf html/*');

  // A recorded block produces no ledger complaint. If noteAudit misread the
  // field it would warn here.
  assert.equal(
    warnings.some((line) => /block ledger/.test(line)),
    false,
    `the guard complained about the ledger: ${warnings.join(' | ')}`,
  );
});

// ═══ 6. THE SHAPER BOTH EXECUTION PATHS SHARE ════════════════════════════════

test('executionBlockEvent is the single shape both execution refusal paths write', () => {
  const shared = {
    tool: 'run_command',
    workspace: 'E:\\Helmion',
    payload: { tool_input: { command: 'rm -rf /' } },
    matchedPattern: 'recursive/forced rm',
    reason: 'it matches a destructive operation the kernel always blocks',
    hits: ['recursive/forced rm'],
  };
  const fromGate = executionBlockEvent({ ...shared, source: 'governance-gate' });
  const fromHook = executionBlockEvent({ ...shared, source: 'guard-hook' });

  // Identical evidence; the ONLY difference is which path says it wrote it.
  assert.equal(fromGate.source, 'governance-gate:run_command:E:\\Helmion');
  assert.equal(fromHook.source, 'guard-hook:run_command:E:\\Helmion');
  assert.deepEqual(
    { ...fromGate, source: null },
    { ...fromHook, source: null },
  );
  assert.equal(fromGate.layer, LAYER.EXECUTION);
  assert.equal(fromGate.outcome, 'blocked');
  assert.equal(fromGate.text, 'rm -rf /');
});
