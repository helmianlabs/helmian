import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { shelfDrag } from '../app/envoy-workspace.js';

// Shelf floor fix (2026-11-08, from the burst-3 live gate): at the
// old crew floor of 112px the section rendered broken — the crew rows
// went invisible and the ADD TO THIS CHANNEL pills overlapped the
// footer. Root cause: the floor was computed before the panes-removal
// port moved the subhead + pill block inside #ew-crew, and the sized
// section had no clip. These tests pin the repair: the floor covers
// the section's fixed content plus one row, the fixed children are
// pinned (the pill block capped with its own scroll), and both sized
// sections clip at their own box.

const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');

const crewFloor = Number(js.match(/const SHELF_MIN = \{ crew: (\d+), approvals: (\d+) \};/)?.[1]);
const apprFloor = Number(js.match(/const SHELF_MIN = \{ crew: (\d+), approvals: (\d+) \};/)?.[2]);
const addCap = Number(css.match(/\.ew-channels\.crew-sized #ew-crew-add \{[^}]*max-height:(\d+)px/)?.[1]);

test('floor arithmetic: the crew floor fits the fixed content plus one row', () => {
  // Measured from the CSS, border-box (app.css * rule): section
  // padding 8+6 and its 1px top border; crew head padding 2+6 around
  // an 11px title line (~15px); the subhead's 10+6 padding around the
  // same line; one crew row = 28px face + 5+5 padding. The pill
  // block's cap is read from the stylesheet, not restated here, so
  // raising the cap without redoing this sum fails the test.
  const FIXED = { section: 14 + 1, head: 8 + 15, subhead: 16 + 15, oneRow: 38 };
  const sum = FIXED.section + FIXED.head + FIXED.subhead + addCap + FIXED.oneRow;
  assert.equal(addCap, 60, 'the pill block is capped at two 24px pill rows + gap + padding');
  assert.ok(crewFloor >= sum, `crew floor ${crewFloor} covers fixed content + one row (${sum})`);
  assert.ok(crewFloor <= sum + 8, `crew floor ${crewFloor} is not padded past the sum (${sum})`);
});

test('floor arithmetic: the approvals floor covers its fixed content', () => {
  // Subhead ~31 (16 padding + ~15 line), the Open-approvals link
  // ~34 (.ew-btn.sm box + its 8px top margin), section padding 8 +
  // border 1 — the list clips and scrolls in what remains.
  assert.ok(apprFloor >= 31 + 34 + 9, `approvals floor ${apprFloor} covers its fixed content (~74)`);
});

test('shelf drag clamps at the raised floors read from the source', () => {
  assert.equal(shelfDrag({ startH: 400, dy: -9999, edge: 'bottom', min: crewFloor, max: 1200 }), crewFloor);
  assert.equal(shelfDrag({ startH: 400, dy: 9999, edge: 'top', min: apprFloor, max: 1200 }), apprFloor);
});

test('sized crew section clips at its own box and scrolls its list', () => {
  assert.match(css, /\.ew-channels\.crew-sized \.ew-crew \{[^}]*overflow:hidden/, 'the sized crew section clips its content');
  assert.match(css, /\.ew-channels\.crew-sized \.ew-crew-list \{[^}]*flex:1 1 auto[^}]*min-height:0/, 'the crew list is the one flexible child');
  assert.match(css, /\.ew-crew-list \{[^}]*overflow:auto/, 'the crew list carries its own scroll region');
});

test('the fixed children inside the crew section are pinned, the pill block capped', () => {
  assert.match(css, /\.ew-channels\.crew-sized \.ew-crew-head \{ flex:none; \}/, 'the head is pinned');
  assert.match(css, /\.ew-channels\.crew-sized \.ew-crew \.ew-subhead \{ flex:none; \}/, 'the ADD TO THIS CHANNEL subhead is pinned');
  assert.match(css, /\.ew-channels\.crew-sized #ew-crew-add \{[^}]*flex:none[^}]*overflow:auto/, 'the pill block is pinned and scrolls past its cap instead of spilling');
});

test('sized approvals section clips at its own box the same way', () => {
  assert.match(css, /\.ew-guard\.appr-sized \.ew-approvals \{[^}]*overflow:hidden/, 'the sized approvals section clips its content');
  assert.match(css, /\.ew-guard\.appr-sized \.ew-approvals-list \{[^}]*overflow:auto/, 'the approvals list scrolls inside');
  assert.match(css, /\.ew-guard\.appr-sized \.ew-approvals-open \{ flex:none;/, 'the Open-approvals link is pinned');
});

test('a height stored under the old floor restores to natural, never to broken', () => {
  // applyHeights only applies a stored value inside [floor, 2400];
  // anything below the raised floor drops the var + sized class, so
  // the section falls back to its natural height on the next load.
  const restore = js.slice(js.indexOf('function applyHeights'), js.indexOf('function wireShelves'));
  assert.match(restore, /v >= SHELF_MIN\[key\] && v <= 2400/, 'restore is gated on the shelf floor');
  assert.match(restore, /removeProperty\(def\.varName\)/, 'an out-of-range stored height removes the var');
});
