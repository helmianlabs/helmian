import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { shelfDrag, shelfCeiling } from '../app/envoy-workspace.js';

// Shelves bite (Troy, 2026-11-08): the sections stacked inside the
// channels and Guard panes resize against each other — the crew shelf
// against the channel list, the approvals shelf against the Guard
// feed — so a long crew or a pile of approvals can no longer squeeze
// the flexible sibling away. shelfDrag / shelfCeiling are the pure
// geometry the pointer and keyboard paths share (the wireShelfSplitter
// DOM half is exercised live, like the width splitters' dragLayout).

test('shelf drag: the bottom edge grows and shrinks 1:1 with the pointer', () => {
  assert.equal(shelfDrag({ startH: 200, dy: 60, edge: 'bottom', min: 100, max: 600 }), 260);
  assert.equal(shelfDrag({ startH: 200, dy: -45, edge: 'bottom', min: 100, max: 600 }), 155);
  assert.equal(shelfDrag({ startH: 200, dy: 0, edge: 'bottom', min: 100, max: 600 }), 200);
});

test('shelf drag: the top edge is the same boundary seen from the other side', () => {
  // Dragging the crew shelf's top edge DOWN moves the boundary down:
  // the channel list gains exactly what the crew loses.
  assert.equal(shelfDrag({ startH: 200, dy: 60, edge: 'top', min: 100, max: 600 }), 140);
  assert.equal(shelfDrag({ startH: 200, dy: -45, edge: 'top', min: 100, max: 600 }), 245);
});

test('shelf drag: both edges clamp at the floor and the ceiling', () => {
  assert.equal(shelfDrag({ startH: 200, dy: -500, edge: 'bottom', min: 112, max: 600 }), 112);
  assert.equal(shelfDrag({ startH: 200, dy: 900, edge: 'bottom', min: 112, max: 600 }), 600);
  assert.equal(shelfDrag({ startH: 200, dy: 500, edge: 'top', min: 104, max: 600 }), 104);
  assert.equal(shelfDrag({ startH: 200, dy: -900, edge: 'top', min: 104, max: 600 }), 600);
});

test('shelf drag: the floor wins when the pane is too short for both clamps', () => {
  // max < min (a short pane): the shelf keeps its floor rather than
  // being dragged out of existence.
  assert.equal(shelfDrag({ startH: 200, dy: 40, edge: 'bottom', min: 112, max: 80 }), 112);
  assert.equal(shelfDrag({ startH: 200, dy: -40, edge: 'top', min: 112, max: 80 }), 112);
});

test('shelf ceiling: pane height minus the fixed share minus the sibling floor', () => {
  // 900px pane, 330px of heads/buttons/foot, sibling keeps 120.
  assert.equal(shelfCeiling({ paneH: 900, fixedH: 330, flexMin: 120, min: 112 }), 450);
  // A roomy pane is bounded by the same arithmetic, not by a cap.
  assert.equal(shelfCeiling({ paneH: 1600, fixedH: 330, flexMin: 120, min: 104 }), 1150);
});

test('shelf ceiling: never below the shelf floor, however short the pane', () => {
  assert.equal(shelfCeiling({ paneH: 300, fixedH: 330, flexMin: 120, min: 112 }), 112);
  assert.equal(shelfCeiling({ paneH: 0, fixedH: 0, flexMin: 120, min: 104 }), 104);
});

test('shelves are wired like the width splitters: storage, restore, narrow guard', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.match(js, /export function shelfDrag/, 'shelfDrag is exported for tests');
  assert.match(js, /export function shelfCeiling/, 'shelfCeiling is exported for tests');
  assert.ok(js.includes('wireShelves();'), 'wire() wires the shelves next to the width splitters');
  assert.ok(js.includes('applyHeights();'), 'applyLayout restores stored shelf heights');
  assert.ok(js.includes("ls.get('heights', {})"), "heights restore from the ls 'heights' key");
  assert.ok(js.includes("ls.set('heights', heights)"), "drags persist to the ls 'heights' key");
  assert.ok(js.includes('data-shelf'), 'separators carry the data-shelf identity');
  // Every live path (pointer + keyboard) consults narrow() so the
  // ≤900px stacked layout is never resized.
  const wire = js.slice(js.indexOf('function wireShelfSplitter'));
  assert.ok((wire.match(/narrow\(\)/g) ?? []).length >= 2, 'pointer and keyboard shelf paths both stop when narrow');
});

test('shelf CSS: grip strip, sized states scroll inside, phones hide the strips', async () => {
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  assert.match(css, /\.ew-hsplit \{[^}]*cursor:row-resize/, 'the strip is a row-resize grip');
  assert.match(css, /\.ew-hsplit:hover::before[^{]*\{[^}]*var\(--accent\)/, 'the grip line lights in the theme accent on hover');
  assert.match(css, /\.ew-channels\.crew-sized \.ew-crew \{[^}]*height:var\(--ew-crew-h\)/, 'the crew shelf takes its var height when sized');
  assert.match(css, /\.ew-channels\.crew-sized \.ew-crew-list \{[^}]*max-height:none/, 'the sized crew list scrolls inside, past its default 38vh cap');
  assert.match(css, /\.ew-guard\.appr-sized \.ew-approvals \{[^}]*height:var\(--ew-appr-h\)/, 'the approvals shelf takes its var height when sized');
  assert.match(css, /\.ew-guard\.appr-sized \.ew-approvals-list \{[^}]*overflow:auto/, 'the sized approvals list scrolls inside its shelf');
  const narrowBlock = css.slice(css.indexOf('@media (max-width: 900px)'));
  assert.match(narrowBlock, /\.ew-hsplit \{ display:none; \}/, 'the strips hide at ≤900px with the width splitters');
});
