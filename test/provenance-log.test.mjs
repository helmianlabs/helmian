// THE PROVENANCE LEDGER'S OWN BEHAVIOUR — the writer, the reader, and the CLI.
//
// test/provenance-wiring.test.mjs proves the agent actually calls this module.
// This file proves the module is worth calling: that it refuses to write a row
// it cannot stand behind, that it reports what it cannot parse instead of
// swallowing it, and that `helmion provenance` answers "who answered me in the
// last hour" as a real process against a real file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  endpointParts,
  lastAnswerer,
  processSessionId,
  providerName,
  provenanceFile,
  readCompletions,
  recordCompletion,
  summarizeCompletions,
} from '../src/core/provenance-log.mjs';
import { auditDir } from '../src/core/audit-log.mjs';
import {
  cleanProvenanceWorkspace,
  makeProvenanceWorkspace,
} from '../test-support/provenance-workspace.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'helmion.mjs');

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

/** A minimal valid completion. Tests override only the field under test. */
function completion(overrides = {}) {
  return {
    providerId: 'anthropic',
    model: 'claude-sonnet-5',
    url: 'https://api.anthropic.com/v1/messages',
    isLocal: false,
    ...overrides,
  };
}

function withWorkspace(fn) {
  const workspace = makeProvenanceWorkspace('helmion-prov-unit-');
  try {
    return fn(workspace);
  } finally {
    cleanProvenanceWorkspace(workspace);
  }
}

// ═══ 1. NAMING ═══════════════════════════════════════════════════════════════

test('provider ids become the words a person would use', () => {
  assert.equal(providerName('anthropic'), 'claude');
  assert.equal(providerName('xai'), 'grok');
  assert.equal(providerName('openai'), 'openai');
  assert.equal(providerName('gemini'), 'gemini');
  assert.equal(providerName('custom'), 'custom');
});

test('LOCAL OVERRIDES THE PROVIDER ID — a local box arrives here as "custom"', () => {
  // resolveLocalProvider returns id 'custom' (local-provider.mjs:162). A name
  // derived from the id alone would have filed the qwen turn under "custom" and
  // left Troy's question unanswered a second time.
  assert.equal(providerName('custom', { isLocal: true }), 'local');
  assert.equal(providerName('openai', { isLocal: true }), 'local');
});

test('an unknown provider id is reported, not silently renamed', () => {
  assert.equal(providerName('mystery-vendor'), 'mystery-vendor');
  assert.equal(providerName(''), 'unknown');
  assert.equal(providerName(undefined), 'unknown');
});

// ═══ 2. THE ENDPOINT, AND THE CREDENTIAL IN IT ═══════════════════════════════

test('THE QUERY STRING IS DROPPED — Gemini puts its API key there', () => {
  const parts = endpointParts(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=AIzaSyLIVEKEY123456',
  );
  assert.equal(parts.endpointHost, 'generativelanguage.googleapis.com');
  assert.equal(parts.endpoint.includes('AIzaSy'), false, 'the key survived into the ledger');
  assert.equal(parts.endpoint.includes('?'), false, 'a query string survived');
  assert.match(parts.endpoint, /\/v1beta\/models\/gemini-2\.5-flash:generateContent$/);
});

test('a key hidden in the PATH is redacted and the redaction declares itself', () => {
  const parts = endpointParts('https://example.com/v1/sk-ant-abcdefgh12345678/chat');
  assert.equal(parts.endpoint.includes('sk-ant-abcdefgh12345678'), false);
  assert.match(parts.endpoint, /sk-ant-\[REDACTED\]/);
  assert.equal(parts.redacted, true, 'a masked endpoint must say it was masked');
});

test('a host with a port is kept whole — the port is how you tell Ollama apart', () => {
  assert.equal(endpointParts('http://127.0.0.1:11434/v1/chat/completions').endpointHost, '127.0.0.1:11434');
});

test('an unparseable URL is recorded rather than dropped', () => {
  // Losing the only evidence of where an answer came from is worse than
  // recording something ugly.
  const parts = endpointParts('not a url at all');
  assert.equal(parts.endpointHost, 'not a url at all');
});

// ═══ 3. THE WRITER ═══════════════════════════════════════════════════════════

test('a complete row lands on disk, newline-terminated, one JSON object per line', () => {
  withWorkspace((workspace) => {
    const first = recordCompletion(workspace, completion());
    const second = recordCompletion(workspace, completion({ providerId: 'openai', model: 'gpt-5.6-sol', url: 'https://api.openai.com/v1/chat/completions' }));
    assert.equal(first.logged, true, first.reason);
    assert.equal(second.logged, true, second.reason);
    assert.equal(first.file, second.file, 'both rows belong in the same daily file');

    const raw = readFileSync(first.file, 'utf8');
    assert.match(raw, /\n$/, 'a torn last line would make every later append unparseable');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 2);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  });
});

test('MISSING isLocal IS REFUSED — a boolean nobody set must not default to false', () => {
  withWorkspace((workspace) => {
    // This is the defect reproduced inside the fix: coercing an absent flag to
    // false makes a qwen answer read exactly like a frontier one.
    for (const bad of [undefined, null, 'true', 1, 0]) {
      const result = recordCompletion(workspace, { ...completion(), isLocal: bad });
      assert.equal(result.logged, false, `isLocal=${JSON.stringify(bad)} was accepted`);
      assert.match(result.reason, /isLocal must be a boolean/);
    }
    assert.deepEqual(readCompletions(workspace).entries, []);
  });
});

test('a row with no model is refused — "something answered and I did not record what" is not an answer', () => {
  withWorkspace((workspace) => {
    const result = recordCompletion(workspace, completion({ model: '' }));
    assert.equal(result.logged, false);
    assert.match(result.reason, /missing required field\(s\).*model/);
    // The half-formed entry is returned so a caller can report it.
    assert.ok(result.entry, 'the rejected entry must be visible to the caller');
  });
});

test('a row with no endpoint is refused', () => {
  withWorkspace((workspace) => {
    const result = recordCompletion(workspace, completion({ url: '' }));
    assert.equal(result.logged, false);
    assert.match(result.reason, /endpointHost/);
  });
});

test('AN UNWRITABLE LEDGER NEVER THROWS — it returns its failure', () => {
  withWorkspace((workspace) => {
    // A FILE where the audit directory has to be, so mkdir and append both fail.
    mkdirSync(path.join(workspace, '.helmion'), { recursive: true });
    writeFileSync(path.join(workspace, '.helmion', 'audit'), 'not a directory', 'utf8');

    let result;
    assert.doesNotThrow(() => { result = recordCompletion(workspace, completion()); });
    assert.equal(result.logged, false);
    assert.match(result.reason, /could not append/);
    assert.ok(result.entry, 'the entry is returned so the caller can say what went unrecorded');
  });
});

test('the session id is stable within a process and names the pid', () => {
  assert.equal(processSessionId(), processSessionId());
  assert.match(processSessionId(), new RegExp(`^pid${process.pid}-`));
});

test('an explicit session id wins over the process default', () => {
  withWorkspace((workspace) => {
    recordCompletion(workspace, completion({ sessionId: 'desktop-session-7' }));
    assert.equal(readCompletions(workspace).entries[0].sessionId, 'desktop-session-7');
  });
});

test('routedLocal is recorded only when a caller actually claimed it', () => {
  withWorkspace((workspace) => {
    recordCompletion(workspace, completion({ sessionId: 'a' }));
    recordCompletion(workspace, completion({ sessionId: 'b', routedLocal: false }));
    const rows = readCompletions(workspace).entries;
    const noClaim = rows.find((r) => r.sessionId === 'a');
    const claimed = rows.find((r) => r.sessionId === 'b');
    // Absent means "nobody told me", which is honest. Writing false would be a
    // claim the code never had grounds to make.
    assert.equal('routedLocal' in noClaim, false);
    assert.equal(claimed.routedLocal, false);
  });
});

test('the daily file rotates on a UTC boundary', () => {
  withWorkspace((workspace) => {
    const before = provenanceFile(workspace, { now: new Date('2026-07-30T23:59:59Z') });
    const after = provenanceFile(workspace, { now: new Date('2026-07-31T00:00:01Z') });
    assert.match(before, /provenance-2026-07-30\.jsonl$/);
    assert.match(after, /provenance-2026-07-31\.jsonl$/);
  });
});

test('it writes into the same .helmion/audit directory as the block ledger', () => {
  withWorkspace((workspace) => {
    const { file } = recordCompletion(workspace, completion());
    assert.equal(path.dirname(file), auditDir(workspace));
  });
});

// ═══ 4. THE READER ═══════════════════════════════════════════════════════════

function seed(workspace) {
  const rows = [
    completion({ sessionId: 's1', url: 'https://api.anthropic.com/v1/messages' }),
    completion({
      sessionId: 's1', providerId: 'custom', model: 'qwen3.5:4b', isLocal: true,
      url: 'http://127.0.0.1:11434/v1/chat/completions',
    }),
    completion({
      sessionId: 's2', providerId: 'xai', model: 'grok-4.5',
      url: 'https://api.x.ai/v1/chat/completions',
    }),
  ];
  rows.forEach((row, i) => {
    // Distinct, ordered timestamps so newest-first is actually testable.
    recordCompletion(workspace, row, { now: new Date(Date.UTC(2026, 6, 30, 12, i)) });
  });
}

test('entries come back newest first', () => {
  withWorkspace((workspace) => {
    seed(workspace);
    const models = readCompletions(workspace).entries.map((e) => e.model);
    assert.deepEqual(models, ['grok-4.5', 'qwen3.5:4b', 'claude-sonnet-5']);
  });
});

test('filters: provider, local, remote, session, since', () => {
  withWorkspace((workspace) => {
    seed(workspace);
    assert.equal(readCompletions(workspace, { provider: 'claude' }).entries.length, 1);
    assert.equal(readCompletions(workspace, { provider: 'local' }).entries.length, 1);
    assert.equal(readCompletions(workspace, { isLocal: true }).entries.length, 1);
    assert.equal(readCompletions(workspace, { isLocal: false }).entries.length, 2);
    assert.equal(readCompletions(workspace, { sessionId: 's1' }).entries.length, 2);
    assert.equal(
      readCompletions(workspace, { since: '2026-07-30T12:01:00Z' }).entries.length,
      2,
      'since is inclusive of the boundary row',
    );
  });
});

test('the summary breaks LOCAL out as its own number', () => {
  withWorkspace((workspace) => {
    seed(workspace);
    const summary = summarizeCompletions(workspace);
    assert.equal(summary.total, 3);
    // A number a reader has to derive is a number a reader gets wrong.
    assert.equal(summary.local, 1);
    assert.equal(summary.remote, 2);
    assert.equal(summary.sessions, 2);
    assert.deepEqual(summary.byProvider, { claude: 1, local: 1, grok: 1 });
    assert.equal(summary.byModel['qwen3.5:4b'], 1);
    assert.ok(summary.bytes > 0);
  });
});

test('AN UNREADABLE LINE IS REPORTED, NOT SKIPPED — a log that drops what it cannot parse is not evidence', () => {
  withWorkspace((workspace) => {
    seed(workspace);
    const file = readCompletions(workspace).files[0];
    appendFileSync(file, '{"timestamp":"2026-07-30T12:05:00.0\n', 'utf8');

    const { entries, malformed } = readCompletions(workspace);
    assert.equal(entries.length, 3, 'the intact rows must still be readable');
    assert.equal(malformed.length, 1);
    assert.equal(malformed[0].line, 4);
    assert.equal(summarizeCompletions(workspace).malformed, 1);
  });
});

test('an absent ledger reads as empty, not as an error', () => {
  withWorkspace((workspace) => {
    assert.deepEqual(readCompletions(workspace), { entries: [], malformed: [], files: [] });
    assert.equal(summarizeCompletions(workspace).total, 0);
    assert.equal(lastAnswerer(workspace), null);
  });
});

test('lastAnswerer names the newest answer and flags a local one', () => {
  withWorkspace((workspace) => {
    seed(workspace);
    assert.equal(lastAnswerer(workspace).model, 'grok-4.5');
    assert.equal(lastAnswerer(workspace).label, 'grok · grok-4.5');

    const local = lastAnswerer(workspace, { isLocal: true });
    assert.equal(local.model, 'qwen3.5:4b');
    assert.match(local.label, /\(LOCAL\)$/, 'a local answer must announce itself in the label');
  });
});

test('the block ledger and the provenance ledger do not read each other', async () => {
  await withWorkspace(async (workspace) => {
    const { recordBlockEvent, readBlockEvents, LAYER } = await import('../src/core/audit-log.mjs');
    seed(workspace);
    recordBlockEvent(workspace, {
      layer: LAYER.EXECUTION, matchedPattern: 'p', text: 'rm -rf /', source: 's', outcome: 'blocked',
    });
    // Same directory, two questions. Neither may answer with the other's rows.
    assert.equal(readBlockEvents(workspace).entries.length, 1);
    assert.equal(readCompletions(workspace).entries.length, 3);
  });
});

// ═══ 5. `helmion provenance` ═════════════════════════════════════════════════

test('`helmion provenance list` shows the rows, and marks the local one', () => {
  withWorkspace((workspace) => {
    seed(workspace);
    const run = runCli(['provenance', 'list', '--workspace', workspace]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /3 completion\(s\), 1 LOCAL, 2 remote/);
    assert.match(run.stdout, /LOCAL\s+local\s+qwen3\.5:4b/);
    assert.match(run.stdout, /127\.0\.0\.1:11434/);
    assert.match(run.stdout, /By provider:/);
  });
});

test('`helmion provenance last` answers "who answered me" in one command', () => {
  withWorkspace((workspace) => {
    seed(workspace);
    const run = runCli(['provenance', 'last', '--workspace', workspace]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /grok · grok-4\.5/);
    assert.match(run.stdout, /api\.x\.ai/);
  });
});

test('AN EMPTY LEDGER SAYS "nothing answered OR nothing was recording" — never a bare blank', () => {
  withWorkspace((workspace) => {
    const run = runCli(['provenance', 'last', '--workspace', workspace]);
    assert.equal(run.status, 0, run.stderr);
    // Collapsing these two states is the original defect. The output must not.
    assert.match(run.stdout, /No completion is recorded/);
    assert.match(run.stdout, /nothing was recording/);
  });
});

test('`--since 1h` answers the question Troy actually asked', () => {
  withWorkspace((workspace) => {
    // One answer just now, one answer yesterday.
    recordCompletion(workspace, completion({ model: 'answered-just-now' }));
    recordCompletion(
      workspace,
      completion({ model: 'answered-yesterday' }),
      { now: new Date(Date.now() - 26 * 3600_000) },
    );

    const run = runCli(['provenance', 'list', '--workspace', workspace, '--since', '1h', '--json']);
    assert.equal(run.status, 0, run.stderr);
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.summary.total, 1);
    assert.equal(parsed.entries[0].model, 'answered-just-now');
  });
});

test('`--local` isolates answers that came from this machine', () => {
  withWorkspace((workspace) => {
    seed(workspace);
    const run = runCli(['provenance', 'list', '--workspace', workspace, '--local', '--json']);
    assert.equal(run.status, 0, run.stderr);
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0].model, 'qwen3.5:4b');
    assert.equal(parsed.entries[0].isLocal, true);
  });
});

test('A MISSPELLED FILTER IS REFUSED, not answered with a clean-looking zero', () => {
  withWorkspace((workspace) => {
    seed(workspace);
    // The worst possible failure for a tool whose job is saying who was there.
    const badProvider = runCli(['provenance', 'list', '--workspace', workspace, '--provider', 'Claude']);
    assert.notEqual(badProvider.status, 0, 'a misspelled provider was accepted');
    assert.match(badProvider.stderr, /--provider must be one of/);

    const badSince = runCli(['provenance', 'list', '--workspace', workspace, '--since', 'lastweek']);
    assert.notEqual(badSince.status, 0, 'an unparseable --since was accepted');
    assert.match(badSince.stderr, /--since must be a duration/);

    const badSub = runCli(['provenance', 'delete', '--workspace', workspace]);
    assert.notEqual(badSub.status, 0);
    assert.match(badSub.stderr, /provenance subcommand must be one of: list, summary, last/);
  });
});

test('`helmion provenance summary` reports counts without dumping the ledger', () => {
  withWorkspace((workspace) => {
    seed(workspace);
    const run = runCli(['provenance', 'summary', '--workspace', workspace, '--json']);
    assert.equal(run.status, 0, run.stderr);
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.summary.total, 3);
    assert.equal(parsed.summary.local, 1);
    assert.equal('entries' in parsed, false, 'summary must not dump the whole ledger');
  });
});

test('AN UNREADABLE LINE EXITS NON-ZERO — a torn ledger is not clean evidence', () => {
  withWorkspace((workspace) => {
    seed(workspace);
    appendFileSync(readCompletions(workspace).files[0], '{"timestamp":"2026-07-30T12:0\n', 'utf8');
    const run = runCli(['provenance', 'list', '--workspace', workspace]);
    assert.equal(run.status, 2, 'a corrupt ledger printed a tidy zero-exit report');
    assert.match(run.stdout, /1 UNREADABLE line\(s\)/);
    assert.match(run.stdout, /grok-4\.5/, 'the intact rows must still be reported');
  });
});

test('a disagreement between the router and the endpoint is surfaced, not resolved silently', () => {
  withWorkspace((workspace) => {
    // The router says it went local; the endpoint says api.anthropic.com. One
    // of them is wrong and the reader has to be told, not handed a verdict.
    recordCompletion(workspace, completion({ routedLocal: true }));
    const run = runCli(['provenance', 'list', '--workspace', workspace]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /the router said routedLocal=true but the endpoint says isLocal=false/);
  });
});
