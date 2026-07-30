// Tests for the unsupported-confidence detector.
//
// The standard this suite is held to: every case that MUST flag is paired with a
// near-identical case that MUST NOT, because the only way this feature dies is by
// being noisy. A detector that flags everything is indistinguishable from a
// detector that is off, except that it costs more and teaches people to ignore it.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectUnverifiedClaims,
  describeFindings,
  CONFIDENCE_MARKERS,
  CHECKABLE_REFERENTS,
  LIMITATIONS,
  NEVER_BLOCKS,
} from '../src/core/unverified-claims.mjs';

const flags = (text) => detectUnverifiedClaims(text);
const flagged = (text) => flags(text).flagged;

/* ── BOTH SIGNALS PRESENT: these are the claims worth catching ─────────────── */

test('a hedged menu location is flagged', () => {
  const result = flags('The setting is probably under Preferences > Advanced.');
  assert.equal(result.flagged, true);
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].referentKind, 'menu-location');
});

test('a hedged symbol name is flagged', () => {
  const result = flags("It's called flushSync() I think.");
  assert.equal(result.flagged, true);
  assert.equal(result.claims[0].referentKind, 'symbol');
  assert.equal(result.claims[0].referent, 'flushSync()');
});

test('a hedged file path is flagged, and the longest marker is the one reported', () => {
  const result = flags('If I recall correctly the config lives at ./config/app.json.');
  assert.equal(result.flagged, true);
  assert.equal(result.claims[0].referentKind, 'file-path');
  assert.equal(result.claims[0].marker, 'if i recall correctly');
});

test('a hedged command is flagged', () => {
  const result = flags('You should be able to run npm run build --force.');
  assert.equal(result.flagged, true);
  assert.equal(result.claims[0].referentKind, 'command-syntax');
});

test('a hedged version claim is flagged', () => {
  assert.equal(flagged('That was added in v3.2, I believe.'), true);
});

test('a hedged quantity is flagged', () => {
  const result = flags('The timeout is probably 30 seconds.');
  assert.equal(result.flagged, true);
  assert.equal(result.claims[0].referentKind, 'quantity');
});

test('a hedged environment variable is flagged', () => {
  const result = flags("It's likely DATABASE_URL that's missing.");
  assert.equal(result.flagged, true);
  assert.equal(result.claims[0].referentKind, 'config-key');
});

test('a hedged endpoint is flagged', () => {
  const result = flags('Presumably it POSTs to /api/loads.');
  assert.equal(result.flagged, true);
  assert.equal(result.claims[0].referentKind, 'endpoint');
});

test('an abbreviated marker still counts', () => {
  assert.equal(flagged('iirc the flag is --no-verify.'), true);
});

test('a Windows path counts as a path', () => {
  assert.equal(flagged('Run it in E:\\Helmion\\src and it should work.'), true);
});

/* ── ONE SIGNAL ONLY: these must stay silent ───────────────────────────────── */

test('a confident factual claim is NOT flagged - no marker, not this gate', () => {
  assert.equal(flagged('The config lives at ./config/app.json.'), false);
});

test('a hedge with nothing checkable is NOT flagged', () => {
  assert.equal(flagged('You should probably get some rest.'), false);
  assert.equal(flagged("It'll probably rain tomorrow."), false);
});

test('honest uncertainty with an offer to check is NOT flagged', () => {
  assert.equal(flagged('I am not sure - let me go and read the file.'), false);
});

test('an opinion about a real file is NOT flagged, even with both signals', () => {
  const result = flags('I think governance.mjs is cleaner than the old one.');
  assert.equal(result.flagged, false, 'a judgment is not a checkable claim');
});

test('rhetorical numbers are NOT a quantity claim', () => {
  assert.equal(flagged('There are probably 3 reasons for that.'), false);
});

// The judgment list was tightened from substring to word-bounded matching on
// 2026-07-29 because "prefer" was matching inside "Preferences" and silently
// discarding a true positive. These two cases pin both directions of that fix:
// the suppression must still work on a real judgment word, and must no longer
// reach inside a longer, unrelated word.
test('a genuine judgment word still suppresses, after the word-boundary fix', () => {
  assert.equal(flagged('I think ./config/app.json is preferable.'), false);
});

test('a judgment word embedded in a longer word no longer suppresses', () => {
  const result = flags('The option is probably under Preferences > Advanced.');
  assert.equal(result.flagged, true, '"prefer" inside "Preferences" must not suppress');
});

test('an API route is reported as an endpoint, not as a file path', () => {
  // Both patterns match "/api/loads"; reporting a path would send stage two
  // looking on disk for a route.
  assert.equal(flags('Presumably it POSTs to /api/loads.').claims[0].referentKind, 'endpoint');
  assert.equal(flags('It is probably in ./src/core/lease.mjs.').claims[0].referentKind, 'file-path');
});

/* ── SCOPE: the marker and the fact must be in the SAME sentence ──────────── */

test('a marker in one sentence and a fact in the next is NOT flagged', () => {
  const result = flags("It's probably fine. The file is ./config/app.json.");
  assert.equal(result.flagged, false);
});

/* ── CODE IS NOT PROSE ────────────────────────────────────────────────────── */

test('a marker inside a fenced code block is NOT a hedge', () => {
  const text = ['Here is the fix:', '```', '# probably ./config/app.json', 'echo hi', '```'].join('\n');
  assert.equal(flagged(text), false);
});

test('a marker inside an inline code span is NOT a hedge', () => {
  assert.equal(flagged('The literal string `probably ./config/app.json` is in the file.'), false);
});

/* ── WORD BOUNDARIES: the classic false-positive family ───────────────────── */

test('"unlikely" does not fire the "likely" marker', () => {
  assert.equal(flagged('It is unlikely that ./config/app.json exists.'), false);
});

test('"maybe" does not fire the "may be" marker', () => {
  assert.equal(flagged('Maybe ./config/app.json, maybe not.'), false);
});

/* ── IT FLAGS AND NEVER BLOCKS ────────────────────────────────────────────── */

test('blocked is false even when several claims fire', () => {
  const text = [
    'The setting is probably under Preferences > Advanced.',
    "It's called flushSync() I think.",
    'The timeout is probably 30 seconds.',
  ].join('\n');
  const result = flags(text);
  assert.equal(result.claims.length, 3);
  assert.equal(result.blocked, false);
  assert.equal(NEVER_BLOCKS, false);
});

test('every claim carries what stage two needs', () => {
  const result = flags('The setting is probably under Preferences > Advanced.');
  for (const claim of result.claims) {
    assert.equal(claim.needsLookup, true);
    assert.ok(claim.referent.length > 0, 'a claim names the thing to check');
    assert.ok(claim.reason.includes(claim.marker), 'the reason names the marker that fired');
    assert.ok(claim.sentence.length > 0);
  }
});

/* ── OUTPUT SHAPE AND DEGENERATE INPUT ────────────────────────────────────── */

test('describeFindings is empty when nothing fired and advisory when something did', () => {
  assert.equal(describeFindings(flags('All good.')), '');
  assert.equal(describeFindings(null), '');
  const text = describeFindings(flags('The timeout is probably 30 seconds.'));
  assert.match(text, /unverified claim detected/i);
  assert.match(text, /consider requesting a source check/i);
  assert.doesNotMatch(text, /blocked|refused|denied/i);
});

test('degenerate input does not throw', () => {
  for (const value of [undefined, null, '', '   ', '\n\n', 0, {}]) {
    const result = detectUnverifiedClaims(value);
    assert.equal(result.blocked, false);
    assert.equal(Array.isArray(result.claims), true);
  }
});

test('the tables and limitations are populated and the limits are stated', () => {
  assert.ok(CONFIDENCE_MARKERS.length > 20);
  assert.ok(CHECKABLE_REFERENTS.length >= 8);
  assert.ok(CHECKABLE_REFERENTS.every((r) => r.kind && r.what && r.pattern instanceof RegExp));
  assert.ok(LIMITATIONS.length >= 4);
  assert.throws(() => LIMITATIONS.push('x'), 'the limitations list is frozen');
});

test('a long reply stays fast enough to run on every message', () => {
  const filler = 'This sentence contains nothing of interest at all. '.repeat(2000);
  const text = `${filler}The timeout is probably 30 seconds.`;
  const started = process.hrtime.bigint();
  const result = flags(text);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(result.flagged, true, 'the claim is still found at the end of a long reply');
  assert.ok(ms < 250, `stage one took ${ms.toFixed(1)} ms on ${text.length} chars`);
});
