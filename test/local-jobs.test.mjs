/**
 * Tests for the four local background jobs.
 *
 * NO NETWORK. Every test injects a fake `fetchImpl` and a fake provider, so the
 * suite is deterministic and runs on a machine with no Ollama. The live proof
 * that the real model works is separate (documented in docs/LOCAL_JOBS.md);
 * what is proven HERE is the thing that actually matters — that a 4B model
 * behaving badly cannot produce a bad outcome.
 *
 * The bulk of these are ADVERSARIAL: garbage JSON, half a JSON object, the
 * right shape with a wrong enum, a timeout, an HTTP 500, and a deny-listed
 * input. A suite that only feeds well-formed replies proves nothing about a
 * small model.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runLocalJob, extractJson, validateAgainstSchema, clampInput, SKIP,
} from '../src/jobs/local-job.mjs';
import { triageVerdict, SCHEMA as TRIAGE_SCHEMA } from '../src/jobs/triage.mjs';
import { summarizeDictation } from '../src/jobs/dictation-summary.mjs';
import {
  describeDiff, formatCommitMessage, condenseDiff, writeCommitMessageFile,
} from '../src/jobs/commit-message.mjs';
import { scanLogLines, explainFinding, unityLogPaths } from '../src/jobs/log-monitor.mjs';
import { readNewBytes, runCycle, readState } from '../src/jobs/runner.mjs';

const PROVIDER = {
  id: 'custom',
  url: 'http://127.0.0.1:11434/v1/chat/completions',
  model: 'qwen3.5:4b',
  apiKey: 'no-key-required',
  timeoutMs: 5000,
  isLocal: true,
};

/** A fetch that returns whatever content string you give it. */
function fakeFetch(content, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ choices: [{ message: { content } }] }),
    };
  };
  fn.calls = calls;
  return fn;
}

function throwingFetch(name) {
  const fn = async () => { const e = new Error('boom'); e.name = name; throw e; };
  fn.calls = [];
  return fn;
}

// ─────────────────────────────────────────────────────────────────────────────
// extractJson — the model never returns clean JSON
// ─────────────────────────────────────────────────────────────────────────────

test('extractJson pulls an object out of a markdown fence', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
});

test('extractJson pulls an object out of surrounding prose', () => {
  assert.deepEqual(
    extractJson('Sure! Here is the JSON you asked for:\n{"verdict":"escalate"}\nHope that helps.'),
    { verdict: 'escalate' },
  );
});

test('extractJson handles nested objects and braces inside strings', () => {
  assert.deepEqual(
    extractJson('{"a":{"b":2},"note":"a } brace and a { brace"}'),
    { a: { b: 2 }, note: 'a } brace and a { brace' },
  );
});

test('extractJson returns null for a TRUNCATED object rather than guessing', () => {
  assert.equal(extractJson('{"verdict":"escal'), null);
});

test('extractJson returns null for prose with no JSON at all', () => {
  assert.equal(extractJson('I think this one is probably fine, honestly.'), null);
});

test('extractJson returns null for a bare array (jobs require an object)', () => {
  assert.equal(extractJson('[1,2,3]'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// validateAgainstSchema — strict where it counts
// ─────────────────────────────────────────────────────────────────────────────

test('schema rejects a value outside the enum', () => {
  const r = validateAgainstSchema(
    { verdict: 'maybe', category: 'complex', reason: 'x' }, TRIAGE_SCHEMA,
  );
  assert.equal(r.ok, false);
});

test('schema rejects a missing required field', () => {
  const r = validateAgainstSchema({ verdict: 'escalate', category: 'complex' }, TRIAGE_SCHEMA);
  assert.equal(r.ok, false);
});

test('schema rejects a string where a boolean is declared', () => {
  const r = validateAgainstSchema({ flag: 'true' }, { flag: { boolean: true } });
  assert.equal(r.ok, false);
});

test('schema DROPS keys the model invented rather than failing on them', () => {
  const r = validateAgainstSchema(
    { verdict: 'escalate', category: 'complex', reason: 'x', confidence: 0.9, notes: 'hi' },
    TRIAGE_SCHEMA,
  );
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.value).sort(), ['category', 'reason', 'verdict']);
});

test('schema accepts enum values in the wrong case', () => {
  const r = validateAgainstSchema(
    { verdict: 'ESCALATE', category: 'Complex', reason: 'x' }, TRIAGE_SCHEMA,
  );
  assert.equal(r.ok, true);
  assert.equal(r.value.verdict, 'escalate');
});

test('schema truncates an over-long free-text field instead of discarding the verdict', () => {
  const r = validateAgainstSchema(
    { verdict: 'escalate', category: 'complex', reason: 'x'.repeat(900) }, TRIAGE_SCHEMA,
  );
  assert.equal(r.ok, true);
  assert.equal(r.value.reason.length, 200);
  assert.ok(r.value.reason.endsWith('…'));
});

test('schema drops a bad array element but keeps the good ones', () => {
  const r = validateAgainstSchema(
    { items: ['ok', 42, null, 'also ok'] },
    { items: { array: { of: { string: { min: 1, max: 50 } }, max: 10 } } },
  );
  assert.deepEqual(r.value.items, ['ok', 'also ok']);
});

test('clampInput keeps the head AND the tail', () => {
  const out = clampInput(`START${'x'.repeat(5000)}END`, 200);
  assert.ok(out.startsWith('START'));
  assert.ok(out.endsWith('END'));
  assert.ok(out.includes('[trimmed]'));
});

// ─────────────────────────────────────────────────────────────────────────────
// runLocalJob — every failure mode degrades to "nothing", never to a crash
// ─────────────────────────────────────────────────────────────────────────────

const SIMPLE = { verdict: { enum: ['a', 'b'] } };

test('no local provider configured → skipped, not thrown', async () => {
  const r = await runLocalJob({
    name: 't', system: 's', input: 'hello', schema: SIMPLE, env: {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.skippedReason, SKIP.NO_PROVIDER);
});

test('GARBAGE reply → discarded silently', async () => {
  const r = await runLocalJob({
    name: 't', system: 's', input: 'hello', schema: SIMPLE,
    provider: PROVIDER, fetchImpl: fakeFetch('lol i am a language model 🙂'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.skippedReason, SKIP.MALFORMED);
  assert.equal(r.data, undefined);
});

test('HALF a JSON object → discarded, never half-applied', async () => {
  const r = await runLocalJob({
    name: 't', system: 's', input: 'hello', schema: SIMPLE,
    provider: PROVIDER, fetchImpl: fakeFetch('{"verdict":"a"'),
  });
  assert.equal(r.skippedReason, SKIP.MALFORMED);
});

test('right shape, WRONG enum value → discarded', async () => {
  const r = await runLocalJob({
    name: 't', system: 's', input: 'hello', schema: SIMPLE,
    provider: PROVIDER, fetchImpl: fakeFetch('{"verdict":"c"}'),
  });
  assert.equal(r.skippedReason, SKIP.MALFORMED);
});

test('HTTP 500 → unreachable, not an exception', async () => {
  const r = await runLocalJob({
    name: 't', system: 's', input: 'hello', schema: SIMPLE,
    provider: PROVIDER, fetchImpl: fakeFetch('{}', { status: 500 }),
  });
  assert.equal(r.skippedReason, SKIP.UNREACHABLE);
});

test('timeout → reported as a timeout, not a crash', async () => {
  const r = await runLocalJob({
    name: 't', system: 's', input: 'hello', schema: SIMPLE,
    provider: PROVIDER, fetchImpl: throwingFetch('TimeoutError'),
  });
  assert.equal(r.skippedReason, SKIP.TIMEOUT);
});

test('connection refused → unreachable, not a crash', async () => {
  const r = await runLocalJob({
    name: 't', system: 's', input: 'hello', schema: SIMPLE,
    provider: PROVIDER, fetchImpl: throwingFetch('TypeError'),
  });
  assert.equal(r.skippedReason, SKIP.UNREACHABLE);
});

test('deny-listed input is NEVER SENT — the model is not contacted at all', async () => {
  const f = fakeFetch('{"verdict":"a"}');
  const r = await runLocalJob({
    name: 't', system: 's', schema: SIMPLE, provider: PROVIDER, fetchImpl: f,
    input: 'rotate the api_key and then deploy to production',
  });
  assert.equal(r.skippedReason, SKIP.DENIED);
  assert.equal(f.calls.length, 0, 'deny-listed text must not reach any endpoint');
});

test('a valid reply carries reasoning_effort:none and NO tools', async () => {
  const f = fakeFetch('{"verdict":"a"}');
  const r = await runLocalJob({
    name: 't', system: 's', input: 'hello', schema: SIMPLE, provider: PROVIDER, fetchImpl: f,
  });
  assert.equal(r.ok, true);
  assert.equal(f.calls[0].body.reasoning_effort, 'none');
  assert.equal(f.calls[0].body.tools, undefined);
  assert.equal(f.calls[0].body.tool_choice, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// JOB 1 — triage. The bias is one-directional and must stay that way.
// ─────────────────────────────────────────────────────────────────────────────

test('triage passes through a valid handle-locally verdict', async () => {
  const r = await triageVerdict('fix a typo', {
    provider: PROVIDER,
    fetchImpl: fakeFetch('{"verdict":"handle-locally","category":"formatting","reason":"typo"}'),
  });
  assert.equal(r.verdict, 'handle-locally');
});

test('triage fails to ESCALATE on garbage — never to handle-locally', async () => {
  const r = await triageVerdict('anything', {
    provider: PROVIDER, fetchImpl: fakeFetch('¯\\_(ツ)_/¯'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'escalate');
  assert.equal(r.data.category, 'unclear');
});

test('triage fails to ESCALATE when the model is down', async () => {
  const r = await triageVerdict('anything', {
    provider: PROVIDER, fetchImpl: throwingFetch('TypeError'),
  });
  assert.equal(r.verdict, 'escalate');
});

test('triage fails to ESCALATE when there is no local model at all', async () => {
  const r = await triageVerdict('anything', { env: {} });
  assert.equal(r.verdict, 'escalate');
});

test('a model claiming handle-locally in a MALFORMED reply still escalates', async () => {
  // The word is present but the JSON is not valid — the text must not leak through.
  const r = await triageVerdict('anything', {
    provider: PROVIDER, fetchImpl: fakeFetch('verdict: handle-locally, trust me'),
  });
  assert.equal(r.verdict, 'escalate');
});

// ─────────────────────────────────────────────────────────────────────────────
// JOB 2 — commit messages. The QA gate cannot be satisfied by the model.
// ─────────────────────────────────────────────────────────────────────────────

const DESCRIBED = { type: 'fix', subject: 'do the thing', body: 'because', changelog: ['a'] };

test('formatCommitMessage REFUSES to write a message without real verification', () => {
  assert.throws(() => formatCommitMessage(DESCRIBED, ''), /verification` is required/);
});

test('formatCommitMessage embeds the QA word the hook greps for', () => {
  const msg = formatCommitMessage(DESCRIBED, 'npm test 346 pass 0 fail');
  // hook_block_commit_qa.ps1:158 — /(?i)(qa|tested|verified|proof)/
  assert.match(msg, /(?:qa|tested|verified|proof)/i);
  assert.match(msg, /npm test 346 pass 0 fail/);
});

test('the QA word never appears without the evidence it refers to', () => {
  const msg = formatCommitMessage(DESCRIBED, 'ran X, got Y');
  const idx = msg.indexOf('Verified:');
  assert.ok(idx !== -1);
  assert.equal(msg.slice(idx), 'Verified: ran X, got Y');
});

test('deletions without a stated reason are REFUSED, not silently allowed', () => {
  assert.throws(
    () => formatCommitMessage(DESCRIBED, 'tested', ['a.txt']),
    /DELETES-FILES/,
  );
});

test('deletions with a reason produce the acknowledgement the hook requires', () => {
  const msg = formatCommitMessage(DESCRIBED, 'tested', ['a.txt'], 'obsolete, regenerated by build');
  // hook_block_commit_qa.ps1:168 greps for this literal.
  assert.match(msg, /DELETES-FILES: obsolete, regenerated by build/);
  assert.match(msg, /- a\.txt/);
});

test('the message file path has NO whitespace (a quoted -F path fails the hook)', () => {
  // hook_block_commit_qa.ps1:117 captures [^\s"']+ — a quoted path matches nothing.
  const p = writeCommitMessageFile('hello', mkdtempSync(join(tmpdir(), 'hj-')));
  assert.doesNotMatch(p, /\s/);
  assert.equal(readFileSync(p, 'utf8'), 'hello');
});

test('condenseDiff keeps changed lines and drops unchanged context', () => {
  const diff = [
    'diff --git a/x.js b/x.js',
    '--- a/x.js',
    '+++ b/x.js',
    '@@ -1,3 +1,3 @@',
    ' unchanged context line',
    '-const a = 1;',
    '+const a = 2;',
    ' more unchanged context',
  ].join('\n');
  const out = condenseDiff(diff);
  assert.ok(out.includes('-const a = 1;'));
  assert.ok(out.includes('+const a = 2;'));
  assert.ok(!out.includes('unchanged context'));
});

test('describeDiff degrades silently on a garbage reply', async () => {
  const r = await describeDiff('diff --git a/x b/x\n+hello', {
    provider: PROVIDER, fetchImpl: fakeFetch('here you go!'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.skippedReason, SKIP.MALFORMED);
});

test('describeDiff refuses a diff that touches credentials or deploys', async () => {
  const f = fakeFetch('{}');
  const r = await describeDiff('diff --git a/deploy.sh b/deploy.sh\n+export API_KEY=abc', {
    provider: PROVIDER, fetchImpl: f,
  });
  assert.equal(r.skippedReason, SKIP.DENIED);
  assert.equal(f.calls.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// JOB 3 — log monitor. Both directions, deterministically.
// ─────────────────────────────────────────────────────────────────────────────

test('flags a real Unity compile error', () => {
  // Verbatim from C:\Users\troyh\AppData\Local\Unity\Editor\Editor.log:3191
  const line = "(44,52): error CS1061: 'TakeInfo' does not contain a definition for 'duration'";
  const f = scanLogLines(line);
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'cs-compile');
});

test('flags a real runtime exception', () => {
  const f = scanLogLines('NullReferenceException: Object reference not set to an instance of an object');
  assert.equal(f[0].id, 'runtime-exception');
});

test('does NOT flag benign Unity startup lines', () => {
  const benign = [
    '    "memorysetup-typetree-allocator-block-size=2097152"',
    'Refreshing native plugins compatible for Editor',
    'Loading GUID <-> Path mappings...',
    'Initialize mono',
  ].join('\n');
  assert.deepEqual(scanLogLines(benign), []);
});

test('does NOT flag a FILENAME containing the word error', () => {
  assert.deepEqual(scanLogLines('Importing Assets/Scripts/ErrorHandler.cs'), []);
  assert.deepEqual(scanLogLines('Unity -logFile C:\\logs\\unity-error.log -batchmode'), []);
});

test('does NOT flag a TEST FILE named after an exception', () => {
  assert.deepEqual(scanLogLines('Compiling Assets/Tests/NullReferenceExceptionTests.cs'), []);
});

test('does NOT flag the word error on its own', () => {
  assert.deepEqual(scanLogLines('0 errors, 3 warnings'), []);
  assert.deepEqual(scanLogLines('Error reporting is enabled'), []);
});

test('collapses the SAME error repeated across import workers into one finding', () => {
  const line = "(44,52): error CS1061: 'TakeInfo' does not contain a definition for 'duration'";
  const f = scanLogLines([line, line, line, line].join('\n'));
  assert.equal(f.length, 1);
  assert.equal(f[0].count, 4);
});

test('sorts critical above error', () => {
  const f = scanLogLines(['NullReferenceException: x', 'Unhandled Exception: y'].join('\n'));
  assert.equal(f[0].severity, 'critical');
});

test('a finding SURVIVES the model failing — it just loses its summary', async () => {
  const [finding] = scanLogLines('NullReferenceException: boom');
  const out = await explainFinding(finding, { provider: PROVIDER, fetchImpl: fakeFetch('nonsense') });
  assert.equal(out.id, 'runtime-exception');
  assert.equal(out.line, 'NullReferenceException: boom');
  assert.equal(out.summary, null);
  assert.equal(out.summaryFailure, SKIP.MALFORMED);
});

test('the model cannot downgrade a finding it was asked to describe', async () => {
  const [finding] = scanLogLines('Unhandled Exception: boom');
  const out = await explainFinding(finding, {
    provider: PROVIDER,
    fetchImpl: fakeFetch('{"severity":"warning","summary":"probably nothing"}'),
  });
  assert.equal(out.severity, 'critical', 'the deterministic severity wins');
});

test('unityLogPaths returns nothing on a machine with no Unity', () => {
  assert.deepEqual(unityLogPaths({ LOCALAPPDATA: join(tmpdir(), 'definitely-not-here') }, []), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// JOB 4 — dictation summarizer
// ─────────────────────────────────────────────────────────────────────────────

test('summarizes and reports the before/after size', async () => {
  const raw = 'ok so '.repeat(200);
  const r = await summarizeDictation(raw, {
    provider: PROVIDER,
    fetchImpl: fakeFetch('{"summary":"He repeated himself.","actions":[],"questions":[]}'),
  });
  assert.equal(r.ok, true);
  assert.equal(r.originalChars, raw.length);
  assert.equal(r.summaryChars, 'He repeated himself.'.length);
});

test('a garbage reply yields NO summary rather than a truncation posing as one', async () => {
  const raw = 'ok so '.repeat(200);
  const r = await summarizeDictation(raw, { provider: PROVIDER, fetchImpl: fakeFetch('uhh') });
  assert.equal(r.ok, false);
  assert.equal(r.data, undefined);
  assert.equal(r.summaryChars, 0);
  assert.equal(r.originalChars, raw.length, 'the original length is still reported');
});

test('missing actions/questions arrays are rejected, not defaulted to empty', async () => {
  const r = await summarizeDictation('hello there', {
    provider: PROVIDER, fetchImpl: fakeFetch('{"summary":"hi"}'),
  });
  assert.equal(r.ok, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Runner — reads only new bytes, and a dead model cannot stall a cycle
// ─────────────────────────────────────────────────────────────────────────────

test('readNewBytes returns only what was appended since last time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hj-run-'));
  const f = join(dir, 'a.log');
  writeFileSync(f, 'line one\n');
  const first = readNewBytes(f, 0);
  assert.equal(first.text, 'line one\n');

  appendFileSync(f, 'line two\n');
  const second = readNewBytes(f, first.offset);
  assert.equal(second.text, 'line two\n', 'must not re-read line one');

  const third = readNewBytes(f, second.offset);
  assert.equal(third.text, '', 'nothing new means nothing read');
});

test('readNewBytes restarts when a log is ROTATED (file got smaller)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hj-rot-'));
  const f = join(dir, 'a.log');
  writeFileSync(f, 'x'.repeat(500));
  writeFileSync(f, 'fresh\n');
  const r = readNewBytes(f, 500);
  assert.equal(r.text, 'fresh\n');
  assert.equal(r.offset, 6);
});

test('readNewBytes on a missing file returns nothing and keeps the offset', () => {
  const r = readNewBytes(join(tmpdir(), 'nope-does-not-exist.log'), 42);
  assert.equal(r.text, '');
  assert.equal(r.offset, 42);
});

test('a cycle with the local model DOWN completes and writes state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hj-cycle-'));
  const counts = await runCycle({
    root,
    env: {},                       // no LOCALAPPDATA → no Unity logs
    jobOpts: { env: {} },          // no local provider → every job no-ops
  });
  assert.equal(counts.logFindings, 0);
  assert.equal(counts.dictations, 0);
  assert.deepEqual(readState(root).offsets, {});
});

test('a dictation dropped in the inbox is processed and the RAW FILE IS KEPT', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hj-inbox-'));
  const { mkdirSync } = await import('node:fs');
  const inbox = join(root, '.helmion', 'jobs', 'inbox');
  mkdirSync(inbox, { recursive: true });
  const src = join(inbox, 'note.txt');
  writeFileSync(src, 'ok so we need the thing done and also the other thing');

  const counts = await runCycle({
    root,
    env: {},
    jobOpts: {
      provider: PROVIDER,
      fetchImpl: fakeFetch('{"summary":"two things","actions":["thing"],"questions":[]}'),
    },
  });

  assert.equal(counts.dictations, 1);
  assert.equal(existsSync(src), false, 'processed file is renamed');
  assert.equal(existsSync(`${src}.done`), true, 'the raw transcript is NEVER deleted');
  const findings = readFileSync(join(root, '.helmion', 'jobs', 'findings.jsonl'), 'utf8');
  assert.match(findings, /"job":"dictation"/);
});
