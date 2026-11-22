// CLAIM EVIDENCE — the production caller for provenance verification,
// and the anti-sybil weighting both it and the investigator stand on.
//
// The properties under test, in plain words:
//   - copies of one origin count ONCE, however many times they repeat
//     (the same syndicated text, the same author on the same domain
//     family, the same address) — repetition is not agreement;
//   - a brand-new origin and a poor-history origin earn less weight
//     than an established one;
//   - a reply sentence a consulted source stands behind carries that
//     source's record and a who-said-it citation weighted by
//     independent origins; a sentence nothing stands behind carries
//     no record, so the guardrail core labels it instead of passing
//     it silently.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTurnClaims, groupSourcesByOrigin, renderVerificationFooter } from '../src/core/claim-evidence.mjs';
import { runPreResponseVerification } from '../src/core/provenance-verification.mjs';

const WIRE_TEXT = 'The city council voted on Tuesday to approve the new transit budget worth forty million dollars for the coming year ahead.';
const wire = (i) => ({
  url: `https://wire${i}.example.net/story`,
  text: WIRE_TEXT,
  publisher: 'Wire Service',
  author: 'Staff Reports',
});

test('syndicated copies of one story are one origin, counted once', () => {
  const groups = groupSourcesByOrigin([wire(1), wire(2), wire(3), wire(4), wire(5)]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].members.length, 5);
  assert.equal(groups[0].weight, 1, 'five copies still weigh one source');
});

test('the same author on the same domain family is one origin; a different author is not', () => {
  const a = { url: 'https://news.example.com/a', text: 'First story about harbour dredging and the ferry contract dispute downtown.', author: 'J. Scribe', publisher: 'Example News' };
  const b = { url: 'https://blog.example.com/b', text: 'Entirely different words concerning mountain weather patterns and ski season forecasts.', author: 'J. Scribe', publisher: 'Example News' };
  const c = { url: 'https://news.example.com/c', text: 'Another unrelated piece regarding orchard harvest yields and cider pressing season.', author: 'R. Field', publisher: 'Example News' };
  const groups = groupSourcesByOrigin([a, b, c]);
  assert.equal(groups.length, 2, 'the two J. Scribe pieces group; the other author stands alone');
});

test('a brand-new origin weighs half; a poor-history origin weighs less than an established one', () => {
  const now = new Date('2026-11-21T12:00:00Z');
  const fresh = groupSourcesByOrigin([{ url: 'https://new.example.com/x', text: 'Some reporting text here.', createdAt: '2026-11-21T11:00:00Z' }], { now });
  assert.equal(fresh[0].weight, 0.5);
  const poor = groupSourcesByOrigin([{ url: 'https://old.example.com/x', text: 'Some reporting text here.', historyScore: 0 }], { now });
  assert.equal(poor[0].weight, 0.25);
  const established = groupSourcesByOrigin([{ url: 'https://old.example.com/x', text: 'Some reporting text here.', historyScore: 1 }], { now });
  assert.equal(established[0].weight, 1);
});

test('a supported claim carries its source and citation; an unsupported claim is labelled, not passed', async () => {
  const reply = 'The city council voted on Tuesday to approve the new transit budget worth forty million dollars. The mayor also promised a stadium referendum before the winter holidays begin.';
  const built = buildTurnClaims({ text: reply, sources: [wire(1)] });
  assert.equal(built.claims.length, 2);
  assert.ok(built.claims[0].provenanceRecord, 'the sourced sentence carries a record');
  assert.equal(built.claims[1].provenanceRecord, null, 'the unsourced sentence carries none');
  assert.equal(built.citations.length, 1);
  assert.equal(built.citations[0].publisher, 'Wire Service');

  const verdict = await runPreResponseVerification({ text: reply, claims: built.claims }, {});
  assert.equal(verdict.action, 'annotate');
  assert.match(verdict.text, /Unverified Provenance/);
});

test('many duplicate sources end with one source\u2019s weight, not a crowd\u2019s', () => {
  const sources = [wire(1), wire(2), wire(3), wire(4), wire(5), wire(6), wire(7), wire(8), wire(9),
    { url: 'https://other.example.org/report', text: 'A separate investigation into ferry maintenance costs and harbour safety inspections.', publisher: 'Other Org' }];
  const built = buildTurnClaims({ text: 'The city council voted on Tuesday to approve the new transit budget worth forty million dollars.', sources });
  assert.equal(built.totals.sources, 10);
  assert.equal(built.totals.groups, 2, 'nine copies collapse into one origin beside the independent one');
  const claim = built.claims[0];
  assert.ok(claim.contestationVector);
  assert.equal(claim.contestationVector.independenceScore, 0.5, 'the supporting origin weighs one of two independent weights, not nine of ten');
  const footer = renderVerificationFooter({ claims: built.claims, groups: built.groups, totals: built.totals, verdict: { action: 'annotate' } });
  assert.match(footer, /9 copies, counted once/);
  assert.match(footer, /independent weight 0\.50/);
});
