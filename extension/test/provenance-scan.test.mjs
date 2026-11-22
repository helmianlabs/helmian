// The Guard extension runs the same provenance verification as the
// agent loop (the core file is synced byte-for-byte; kernel-sync
// pins that). These tests pin the extension lane's own discipline:
// it labels, it reports the core's action, and it NEVER blocks —
// the literal false is asserted, not inferred.

import test from 'node:test';
import assert from 'node:assert/strict';

import { scanPassageProvenance, scanProseProvenance } from '../background/claims.js';

const PASSAGE = 'The city council voted on Tuesday to approve the new transit budget worth forty million dollars. The mayor also promised a stadium referendum before the winter holidays begin.';

test('a passage with no sources offered is labelled Unverified Provenance, and never blocked', () => {
  const result = scanPassageProvenance(PASSAGE, []);
  assert.equal(result.blocked, false);
  assert.equal(result.flagged, true);
  assert.equal(result.action, 'annotate');
  assert.ok(result.annotations.some((a) => a.includes('Unverified Provenance')));
  assert.ok(result.evaluations.every((e) => e.reasons.some((r) => r.includes('no provenance record'))));
});

test('a sentence a supplied source stands behind carries that source\u2019s record', () => {
  const source = {
    url: 'https://news.example/story',
    text: 'The city council voted on Tuesday to approve the new transit budget worth forty million dollars for the coming year ahead.',
    publisher: 'Example News',
  };
  const result = scanPassageProvenance(PASSAGE, [source]);
  assert.equal(result.blocked, false);
  const supported = result.evaluations[0];
  assert.ok(!supported.reasons.some((r) => r.includes('no provenance record')), 'the supported claim is not charged with a missing record');
  assert.equal(supported.unverifiedProvenance, true, 'honestly still unverified: the extension checks no signature and takes no hash');
});

test('the batch shape mirrors the claims lane', () => {
  const results = scanProseProvenance([{ id: 'p1', text: PASSAGE }]);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'p1');
  assert.equal(results[0].blocked, false);
  assert.match(results[0].summary, /Unverified Provenance/);
});
