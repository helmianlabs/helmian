// Peek grip (panel slide fix, 2026-11-15): the channels pane rests as
// a rail and opens as a hover peek, and in that state its in-flow
// width splitter is parked (flex-basis 0, pointer-events none), so
// the column width Troy ordered on 2026-11-08 could not be slid at
// all: grabbing the peek's edge only ended the hover. The fix gives
// the peek its own drag grip on the pane's right edge, writing the
// same --ew-channels var and the same ls 'widths' store the pinned
// splitter uses. These tests pin the wiring in source; the drag
// itself is desk-proven against the real rendered app (headless
// Chromium over the real markup, CSS and module) and on the live
// screen, the same split the shelves tests use.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const js = await readFile(new URL('app/envoy-workspace.js', root), 'utf8');
const css = await readFile(new URL('app/envoy.css', root), 'utf8');

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

test('the grip is built inside wireChannelsRail as a keyboard-reachable separator', () => {
  const fn = js.slice(js.indexOf('function wireChannelsRail()'), js.indexOf('function applyLayout()'));
  assert.match(fn, /class: 'ew-peek-grip'/);
  assert.match(fn, /role: 'separator'/);
  assert.match(fn, /'aria-label': 'Resize channels'/);
  assert.match(fn, /tabindex: '0'/);
  assert.match(fn, /pane\.append\(grip\)/);
});

test('the grip only engages on the peeking pane, never on touch layouts', () => {
  const fn = js.slice(js.indexOf('function wireChannelsRail()'), js.indexOf('function applyLayout()'));
  assert.match(fn, /if \(narrow\(\) \|\| !pane\.classList\.contains\('peeking'\)\) return;/);
});

test('dragging writes the shared var and persists to the shared widths store', () => {
  const fn = js.slice(js.indexOf('function wireChannelsRail()'), js.indexOf('function applyLayout()'));
  assert.match(fn, /root\.style\.setProperty\('--ew-channels'/);
  assert.match(fn, /widths\.channels = Math\.round\(w\)/);
  assert.match(fn, /ls\.set\('widths', widths\)/);
  assert.match(fn, /setPointerCapture/);
});

test('clamps: the pane floor below, the chat floor and the pane cap above', () => {
  const fn = js.slice(js.indexOf('function wireChannelsRail()'), js.indexOf('function applyLayout()'));
  assert.match(fn, /Math\.max\(PANE_MIN\.channels, Math\.min\(cap, target\)\)/);
  assert.match(fn, /Math\.min\(PANE_MAX, startW \+ Math\.max\(0, chat\.getBoundingClientRect\(\)\.width - chatFloor\)\)/);
  // The budget is measured once per drag, not per move: the chat
  // shrinks as the var grows, so a per-move read halves the travel.
  assert.match(fn, /const cap = budgetMax\(startW\);/);
});

test('the peek cannot fold away mid-drag, and settles to the rail when the drag ends outside', () => {
  const fn = js.slice(js.indexOf('function wireChannelsRail()'), js.indexOf('function applyLayout()'));
  assert.match(fn, /if \(!peekDragging\) pane\.classList\.remove\('peeking'\)/);
  assert.match(fn, /lastX < r\.left \|\| lastX > r\.right/);
});

test('double-click and keyboard reset match the pinned splitter contract', () => {
  const fn = js.slice(js.indexOf('function wireChannelsRail()'), js.indexOf('function applyLayout()'));
  assert.match(fn, /grip\.addEventListener\('dblclick', resetW\)/);
  assert.match(fn, /delete widths\.channels/);
  assert.match(fn, /e\.key === 'ArrowRight' \? 24 : -24/);
  assert.match(fn, /e\.key === 'Home'\) \{ e\.preventDefault\(\); setChannelsRest\(true, \{ user: true \}\)/);
});

test('css: the grip is hidden by default and shown only on the peeking pane', () => {
  assert.match(css, /\.ew-peek-grip \{ display:none; \}/);
  assert.match(css, /\.ew-channels\.rail-rest\.peeking \.ew-peek-grip \{ display:block;[^}]*cursor:col-resize;/);
  // The parked splitter in the resting state is the reason the grip
  // exists; if that parking ever goes away this test should be
  // revisited, not silently kept.
  assert.match(css, /\.ew\.channels-rest \.ew-split\[data-split="channels"\] \{ flex-basis:0; pointer-events:none; \}/);
});

console.log(`peek-grip: ${passed} tests passed`);
