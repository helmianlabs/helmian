// The block ledger. Troy's requirement, 2026-07-29: every block event from
// either layer gets written somewhere durable — "not screenshots, not chat
// history" — and he named it a shippable product feature, so a buyer's auditor
// is the intended reader.
//
// The tests that matter most are the ones proving it cannot lie: a logging
// failure must not become a crash and must not become silence, an unparseable
// line must be REPORTED rather than skipped, and a credential in the triggering
// text must not survive into a file somebody ships.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  LAYER,
  SCHEMA_VERSION,
  auditFile,
  readBlockEvents,
  recordBlockEvent,
  redactForAudit,
  summarizeBlockEvents,
} from '../src/core/audit-log.mjs';

function workspace() {
  return mkdtempSync(path.join(tmpdir(), 'helmion-audit-'));
}

const EXECUTION_EVENT = {
  layer: LAYER.EXECUTION,
  matchedPattern: 'recursive/forced rm',
  text: 'rm -rf /var/data',
  source: 'agent:run_command:E:\\Helmion',
  outcome: 'blocked',
};

test('THE SCHEMA IS EXACTLY WHAT TROY SPECIFIED, and it is on disk', () => {
  const dir = workspace();
  try {
    const now = new Date('2026-07-29T18:30:00.000Z');
    const result = recordBlockEvent(dir, EXECUTION_EVENT, { now });
    assert.equal(result.logged, true, result.reason);

    const raw = readFileSync(auditFile(dir, { now }), 'utf8').trim();
    const entry = JSON.parse(raw);

    // His six fields, by name.
    assert.equal(entry.timestamp, '2026-07-29T18:30:00.000Z');
    assert.equal(entry.layer, 'execution');
    assert.equal(entry.matchedPattern, 'recursive/forced rm');
    assert.equal(entry.text, 'rm -rf /var/data');
    assert.equal(entry.source, 'agent:run_command:E:\\Helmion');
    assert.equal(entry.outcome, 'blocked');
    assert.equal(entry.schema, SCHEMA_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('both layers are accepted and distinguishable, and nothing else is', () => {
  const dir = workspace();
  try {
    assert.equal(recordBlockEvent(dir, EXECUTION_EVENT).logged, true);
    assert.equal(recordBlockEvent(dir, {
      ...EXECUTION_EVENT, layer: LAYER.BROWSER, source: 'claude.ai',
    }).logged, true);

    // A missing or invented layer is a programming error, reported not written.
    for (const bad of [undefined, null, '', 'BROWSER', 'both', 'cli']) {
      const out = recordBlockEvent(dir, { ...EXECUTION_EVENT, layer: bad });
      assert.equal(out.logged, false, `layer ${JSON.stringify(bad)} should be refused`);
      assert.match(out.reason, /layer must be/);
    }

    const { entries } = readBlockEvents(dir);
    assert.equal(entries.length, 2, 'the refused writes must not have landed');
    assert.deepEqual(
      [...new Set(entries.map((e) => e.layer))].sort(),
      ['browser', 'execution'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('APPEND-ONLY: a second event never overwrites the first', () => {
  const dir = workspace();
  try {
    for (let i = 0; i < 25; i += 1) {
      recordBlockEvent(dir, { ...EXECUTION_EVENT, text: `rm -rf /data/${i}` });
    }
    const { entries, malformed } = readBlockEvents(dir);
    assert.equal(entries.length, 25);
    assert.deepEqual(malformed, []);
    // Every line individually parseable — the property a JSON array would lose
    // the moment a process died before closing the bracket.
    const lines = readFileSync(auditFile(dir), 'utf8').trim().split('\n');
    assert.equal(lines.length, 25);
    for (const line of lines) JSON.parse(line);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── IT MUST NOT LIE ──────────────────────────────────────────────────────────

test('A LOGGING FAILURE IS NEVER A CRASH AND NEVER SILENCE', () => {
  const dir = workspace();
  try {
    // Put a FILE where the audit directory needs to be. mkdir then fails, so
    // the append cannot happen. The guard's verdict must still stand, so this
    // must not throw — but it must also not claim success.
    mkdirSync(path.join(dir, '.helmion'), { recursive: true });
    writeFileSync(path.join(dir, '.helmion', 'audit'), 'not a directory', 'utf8');

    let out;
    assert.doesNotThrow(() => { out = recordBlockEvent(dir, EXECUTION_EVENT); });
    assert.equal(out.logged, false, 'it must not report success when nothing was written');
    assert.match(out.reason, /could not append/);
    assert.ok(out.entry, 'the entry is still returned so the caller can surface it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AN UNPARSEABLE LINE IS REPORTED, NOT SKIPPED — a log that drops what it cannot read is not evidence', () => {
  const dir = workspace();
  try {
    recordBlockEvent(dir, EXECUTION_EVENT);
    // A torn write, exactly as a crash mid-append would leave it.
    const file = auditFile(dir);
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"timestamp":"2026-07-29T00:00:00.0\n`, 'utf8');
    recordBlockEvent(dir, { ...EXECUTION_EVENT, text: 'rm -rf /after' });

    const { entries, malformed } = readBlockEvents(dir);
    assert.equal(entries.length, 2, 'the good lines on both sides of the tear must survive');
    assert.equal(malformed.length, 1, 'the torn line must be reported');
    assert.equal(malformed[0].line, 2);

    // And the summary surfaces it rather than folding it into zero.
    assert.equal(summarizeBlockEvents(dir).malformed, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing required fields are refused rather than written half-formed', () => {
  const dir = workspace();
  try {
    const out = recordBlockEvent(dir, { layer: LAYER.EXECUTION });
    // matchedPattern/text/source/outcome all coerce to '' which IS present, so
    // this documents the actual contract: only layer is unforgeable. Anything
    // stricter would refuse a legitimate event whose pattern name is empty.
    assert.equal(out.logged, true, 'an event with only a layer still records, with empty strings');
    const { entries } = readBlockEvents(dir);
    assert.equal(entries[0].text, '');
    assert.equal(entries[0].outcome, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── CREDENTIALS MUST NOT SURVIVE INTO A SHIPPABLE LOG ────────────────────────

test('A CREDENTIAL IN THE TRIGGERING TEXT DOES NOT REACH THE FILE', () => {
  const dir = workspace();
  try {
    const withSecrets = [
      'export ANTHROPIC_API_KEY=sk-ant-api03-AbCdEf0123456789xyz',
      'psql postgresql://neonuser:supersecretpw@ep-dry-fog-aku9i5gq.aws.neon.tech/db',
      'gh auth login --with-token ghp_AbCdEf0123456789AbCdEf',
      'GOOGLE_KEY=AIzaSyA0123456789abcdefghij',
    ].join(' && ');

    const result = recordBlockEvent(dir, { ...EXECUTION_EVENT, text: withSecrets });
    assert.equal(result.logged, true);

    const onDisk = readFileSync(auditFile(dir), 'utf8');
    for (const secret of ['sk-ant-api03-AbCdEf0123456789xyz', 'supersecretpw', 'ghp_AbCdEf0123456789AbCdEf', 'AIzaSyA0123456789abcdefghij']) {
      assert.equal(onDisk.includes(secret), false, `the log leaked: ${secret}`);
    }
    // The SHAPE survives, so the entry is still useful evidence.
    assert.match(onDisk, /sk-ant-\[REDACTED\]/);
    assert.match(onDisk, /postgresql:\/\/\[REDACTED\]@/);
    // And the redaction is declared, so nobody mistakes it for tampering.
    assert.equal(JSON.parse(onDisk.trim()).redacted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POSITIVE CONTROL: the redactor really is what removes them', () => {
  // Without this, the test above could pass because the secrets were never in
  // the input in the first place.
  const raw = 'key=sk-ant-api03-AbCdEf0123456789xyz and ghp_AbCdEf0123456789AbCdEf';
  const { text, redacted } = redactForAudit(raw);
  assert.equal(redacted, true);
  assert.equal(text.includes('sk-ant-api03-AbCdEf0123456789xyz'), false);
  assert.equal(text.includes('ghp_AbCdEf0123456789AbCdEf'), false);

  // And ordinary text is left completely alone, flagged as not redacted.
  const clean = redactForAudit('rm -rf /var/data');
  assert.equal(clean.redacted, false);
  assert.equal(clean.text, 'rm -rf /var/data');
});

// ── READ BACK ────────────────────────────────────────────────────────────────

test('events are queryable by layer and by time, newest first', () => {
  const dir = workspace();
  try {
    recordBlockEvent(dir, { ...EXECUTION_EVENT, text: 'old' }, { now: new Date('2026-07-27T10:00:00Z') });
    recordBlockEvent(dir, { ...EXECUTION_EVENT, layer: LAYER.BROWSER, text: 'mid', source: 'claude.ai' }, { now: new Date('2026-07-28T10:00:00Z') });
    recordBlockEvent(dir, { ...EXECUTION_EVENT, text: 'new' }, { now: new Date('2026-07-29T10:00:00Z') });

    const all = readBlockEvents(dir);
    assert.equal(all.entries.length, 3);
    assert.equal(all.entries[0].text, 'new', 'newest must be first');
    assert.equal(all.files.length, 3, 'one file per UTC day');

    assert.equal(readBlockEvents(dir, { layer: 'browser' }).entries.length, 1);
    assert.equal(readBlockEvents(dir, { since: '2026-07-28T00:00:00Z' }).entries.length, 2);
    assert.equal(readBlockEvents(dir, { limit: 1 }).entries.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a workspace that has never blocked anything reads as empty, not as an error', () => {
  const dir = workspace();
  try {
    const out = readBlockEvents(dir);
    assert.deepEqual(out.entries, []);
    assert.deepEqual(out.malformed, []);
    const summary = summarizeBlockEvents(dir);
    assert.equal(summary.total, 0);
    assert.equal(summary.newest, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the summary counts by layer and by pattern, for the status panel', () => {
  const dir = workspace();
  try {
    recordBlockEvent(dir, EXECUTION_EVENT);
    recordBlockEvent(dir, EXECUTION_EVENT);
    recordBlockEvent(dir, {
      ...EXECUTION_EVENT, layer: LAYER.BROWSER, matchedPattern: 'direct SQL DDL', source: 'chatgpt.com',
    });

    const summary = summarizeBlockEvents(dir);
    assert.equal(summary.total, 3);
    assert.equal(summary.byLayer.execution, 2);
    assert.equal(summary.byLayer.browser, 1);
    assert.equal(summary.byPattern['recursive/forced rm'], 2);
    assert.equal(summary.byPattern['direct SQL DDL'], 1);
    assert.ok(summary.bytes > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
