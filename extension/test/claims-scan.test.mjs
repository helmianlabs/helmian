// The advisory lane, checked at the seam where the extension meets the copied
// detector.
//
// extension/test/reply-cases.test.mjs and test/unverified-claims.test.mjs both
// exercise the detector itself. This file is about the wrapper: that the copy
// behaves like the original, that the lane cannot block, and that a passage it
// refuses to read says so rather than coming back clean.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { scanPassage, scanProse, MAX_PASSAGE_LENGTH } from '../background/claims.js';
import { scanCodeBlock } from '../background/scan.js';
import * as original from '../../src/core/unverified-claims.mjs';

test('a hedge welded to a checkable fact is flagged, with what to go and check', () => {
  const result = scanPassage('The retry limit is probably set in config.json.');

  assert.equal(result.flagged, true);
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].referentKind, 'file-path');
  assert.equal(result.claims[0].referent, 'config.json');
  assert.equal(result.claims[0].needsLookup, true, 'stage two would not know what to look up');
});

test('a hedge with nothing checkable in it is left alone', () => {
  // The two-signal rule, at the extension boundary. Uncertainty honestly stated
  // is the behaviour Helmion wants, not the behaviour it flags.
  assert.equal(scanPassage('I think we should go with the second approach.').flagged, false);
});

test('a checkable fact with no hedge is left alone', () => {
  assert.equal(scanPassage('The retry limit is set in config.json.').flagged, false);
});

test('THE LANE NEVER BLOCKS, for anything', () => {
  const passages = [
    'The retry limit is probably set in config.json.',
    'rm -rf / is probably what you want here in deploy.sh.',
    'DROP TABLE loads; is likely the fastest way to clear it in schema.sql.',
    '',
    null,
    undefined,
  ];
  for (const passage of passages) {
    assert.equal(scanPassage(passage).blocked, false, `blocked was not false for: ${String(passage)}`);
  }
  for (const result of scanProse(passages.map((text, index) => ({ id: index, text })))) {
    assert.equal(result.blocked, false);
  }
});

test('POSITIVE CONTROL: a detector that DOES block cannot make this lane block', () => {
  // `blocked: false` is spelled literally in claims.js rather than forwarded
  // from the detector. This proves that literal is load-bearing: run the same
  // wrapper against a detector that returns blocked:true and the answer out of
  // the wrapper is still false.
  //
  // Done against a copy in a temp directory. Tampering with the shipped
  // generated file would corrupt a module that sibling suites import
  // concurrently — kernel-sync.test.mjs was observed failing exactly that way.
  return (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'helmion-claims-control-'));
    try {
      await writeFile(
        join(dir, 'poisoned.js'),
        'export function detectUnverifiedClaims() {\n'
        + '  return { blocked: true, flagged: true, claims: [{ sentence: "x", marker: "probably",\n'
        + '    referentKind: "file-path", referent: "a.mjs", reason: "poisoned", needsLookup: true }] };\n'
        + '}\n'
        + 'export function describeFindings() { return "poisoned"; }\n',
        'utf8',
      );
      // Harm lane is a second import; stub it so the positive control still loads
      // in an isolated temp dir without the real generated tree.
      await writeFile(
        join(dir, 'harm-stub.js'),
        'export function detectHarmfulContent() {\n'
        + '  return { blocked: false, flagged: false, hits: [] };\n'
        + '}\n'
        + 'export function describeHarmFindings() { return ""; }\n',
        'utf8',
      );

      const wrapper = await readFile(new URL('../background/claims.js', import.meta.url), 'utf8');
      let rewired = wrapper.replace(
        '../generated/helmion-unverified-claims.generated.js',
        './poisoned.js',
      );
      rewired = rewired.replace(
        '../generated/helmion-harmful-content.generated.js',
        './harm-stub.js',
      );
      assert.notEqual(rewired, wrapper, 'the import specifier was not rewritten — this control tests nothing');
      await writeFile(join(dir, 'claims.js'), rewired, 'utf8');

      const poisoned = await import(pathToFileURL(join(dir, 'claims.js')).href);
      const detector = await import(pathToFileURL(join(dir, 'poisoned.js')).href);

      // The control is only worth anything if the poison is real.
      assert.equal(detector.detectUnverifiedClaims().blocked, true, 'the poisoned detector does not block');

      assert.equal(poisoned.scanPassage('anything at all').blocked, false);
      assert.equal(poisoned.scanProse([{ id: 'a', text: 'anything at all' }])[0].blocked, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
});

test('the copy agrees with src/core/unverified-claims.mjs on every verdict', () => {
  // The extension imports a generated copy. If the copy and the original ever
  // disagreed, the browser and the CLI would give Troy different answers about
  // the same sentence, which is worse than either answer alone.
  const passages = [
    'The setting is probably under Preferences > Advanced.',
    "It's called flushSync() I think.",
    'The endpoint is probably /api/loads.',
    'Timeouts are usually 30 seconds by default.',
    'I believe HELMION_WORKSPACE is the variable.',
    'I think that design is cleaner.',
    'I am not sure — let me check the file.',
    'Node 22 shipped it, as far as I know.',
  ];

  for (const passage of passages) {
    const mine = scanPassage(passage);
    const theirs = original.detectUnverifiedClaims(passage);
    assert.equal(mine.flagged, theirs.flagged, `disagreement on: ${passage}`);
    assert.deepEqual(mine.claims, theirs.claims, `different claims on: ${passage}`);
  }
});

test('the human-facing sentence comes from the shared module, not a second copy of the wording', () => {
  const [result] = scanProse([{ id: 'a', text: 'The retry limit is probably set in config.json.' }]);
  // Claim-only summary matches core; harm section empty when no harm hits.
  assert.equal(
    result.summary,
    original.describeFindings({ flagged: true, claims: result.claims }),
  );
  assert.equal(result.harmHits?.length ?? 0, 0, 'clean hedge claim has no harm hits');
  assert.match(result.summary, /Consider requesting a source check/);
});

test('a clean passage carries no summary at all', () => {
  const [result] = scanProse([{ id: 'a', text: 'The retry limit is set in config.json.' }]);
  assert.equal(result.flagged, false);
  assert.equal(result.summary, '');
});

test('a passage too long to read says so instead of coming back clean', () => {
  const huge = `${'a '.repeat(MAX_PASSAGE_LENGTH)}probably in config.json.`;
  const result = scanPassage(huge);
  assert.equal(result.flagged, false);
  assert.match(result.skipped, /over the 1000000 limit/);
});

test('a short passage is still read — there is no minimum length', () => {
  // A 12-character floor was written and then removed: "iirc a.mjs" is ten
  // characters, carries both signals, and would have been silently discarded.
  const result = scanPassage('iirc a.mjs');
  assert.equal(result.flagged, true, 'a real finding was dropped for being short');
  assert.equal(result.claims[0].marker, 'iirc');
});

test('ids survive the round trip, so the page can put a note in the right place', () => {
  const results = scanProse([
    { id: 'hp-1', text: 'Nothing to see here.' },
    { id: 'hp-2', text: 'The retry limit is probably set in config.json.' },
  ]);
  assert.deepEqual(results.map((r) => r.id), ['hp-1', 'hp-2']);
  assert.equal(results[0].flagged, false);
  assert.equal(results[1].flagged, true);
});

test('scanProse refuses anything that is not a list of passages', () => {
  assert.throws(() => scanProse('a paragraph'), /expects an array/);
  assert.throws(() => scanProse(null), /expects an array/);
});

test('THE TWO LANES ANSWER DIFFERENTLY ON THE SAME SENTENCE, AND THAT IS THE POINT', () => {
  // This one sentence is why the extension splits its input at all. Handed to
  // the destructive-command kernel it reports a destructive command, because the
  // kernel is built to read a command and this is English about one. Handed to
  // the claim detector it is correctly nothing: no hedge is welded to a fact.
  //
  // Neither lane is wrong. Feeding either lane the other's input is.
  const sentence = 'You should never run rm -rf on a production server without a backup.';

  assert.equal(scanCodeBlock(sentence).blocked, true, 'the kernel stopped reading prose as a command');
  assert.equal(scanPassage(sentence).flagged, false, 'the claim lane fired on a sentence with no unsourced fact');
});
