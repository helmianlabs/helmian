import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { footCollapsedFrom } from '../app/envoy-workspace.js';

// Rail-bottom bite (2026-11-08, owner's live dictation + screenshot
// image-460): three findings pinned here.
// 1. The foot of the channels pane (identity row + source lines +
//    action buttons) folds to its identity row, in the shelves'
//    patterns: state in the `ls` store, default expanded.
// 2. The crew shelf's bottom separator is anchored before the foot
//    and drives ONLY the crew var — each separator moves its own
//    shelf; the foot has no separator and is not resizable.
// 3. The unsized crew section can never spill its ADD pills over
//    the foot: its height is content-driven (no fixed height outside
//    the *-sized rule) and its one bounded child scrolls internally.
//    The spill on the owner's screen is therefore the sized state —
//    a stored height — which the shelf-floor fix's restore gate and
//    clip already cover.

const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');

test('collapse state: only a stored boolean true folds the foot — default is expanded', () => {
  assert.equal(footCollapsedFrom(true), true);
  assert.equal(footCollapsedFrom(false), false);
  assert.equal(footCollapsedFrom(undefined), false, 'nothing stored = expanded, today\'s look');
  assert.equal(footCollapsedFrom(null), false);
  assert.equal(footCollapsedFrom('true'), false, 'a stray string never folds the foot');
  assert.equal(footCollapsedFrom(1), false);
});

test('collapse state persists through the shelves\' own store', () => {
  assert.match(js, /ls\.get\('footCollapsed', false\)/, 'the state reads from the ls store with an expanded default');
  assert.match(js, /ls\.set\('footCollapsed', !footCollapsed\(\)\)/, 'the toggle writes the negated state back to the same store');
});

test('the toggle rides the identity row, so re-rendering that row can never lose it', () => {
  const render = js.match(/function renderMeFace\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(render, /ew-foot-toggle/, 'renderMeFace renders the collapse toggle');
  assert.match(render, /'aria-expanded': 'true'/, 'the toggle starts expanded (applyFootCollapse corrects it from the store)');
  assert.match(render, /'aria-controls': 'ew-channels-foot'/, 'the toggle names the foot it controls');
  assert.match(render, /applyFootCollapse\(\)/, 'every identity-row render re-applies the stored state');
  assert.match(html, /<footer class="ew-foot" id="ew-channels-foot">/, 'the foot carries the id the toggle controls');
});

test('applying the state is store-driven and touches only the foot + its toggle', () => {
  const apply = js.match(/function applyFootCollapse\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(apply, /classList\.toggle\('foot-collapsed', collapsed\)/, 'the collapsed class follows the stored state');
  assert.match(apply, /querySelector\('#ew-channels \.ew-foot'\)/, 'the class lands on the channels pane foot only');
});

test('collapsed foot folds the source lines and action buttons, keeps the identity row', () => {
  assert.match(css, /\.ew-foot\.foot-collapsed \.ew-source, \.ew-foot\.foot-collapsed \.ew-foot-actions \{ display:none; \}/,
    'the Helmian/Discord/Slack/GitHub lines and the Custom Agent / Sync Profile / Phone QR buttons fold away');
  const collapsedRules = css.split('\n').filter((l) => l.includes('foot-collapsed'));
  assert.ok(collapsedRules.length >= 1, 'a collapsed rule exists');
  for (const rule of collapsedRules) {
    assert.ok(!rule.includes('.ew-me-face'), `no collapsed rule touches the identity row: ${rule.trim()}`);
  }
});

test('drag mapping: each shelf separator drives only its own shelf var', () => {
  assert.match(js, /wireShelfSplitter\(ew, \{ key: 'crew', edge: 'bottom', label: 'Resize crew section', before: \(\) => document\.querySelector\('#ew-channels \.ew-foot'\) \}\)/,
    'the crew bottom separator anchors before the foot and belongs to the crew shelf');
  const setH = js.match(/const setH = \(px\) => \{[\s\S]*?\};/)?.[0] ?? '';
  assert.match(setH, /setProperty\(def\.varName/, 'a drag sets the dragged shelf\'s own var');
  assert.ok(!setH.includes('--ew-appr-h') && !setH.includes('--ew-crew-h'), 'setH names no other shelf\'s var literally');
});

test('unsized crew section is content-driven: no fixed height outside the sized rule', () => {
  const base = css.match(/(?:^|\n)\.ew-crew \{[^}]*\}/)?.[0] ?? '';
  assert.ok(base && !/height:/.test(base), `the default crew section sizes to its content: ${base}`);
  assert.equal((css.match(/height:var\(--ew-crew-h\)/g) ?? []).length, 1, 'the var height exists only in the crew-sized rule');
  assert.match(css, /\.ew-crew-list \{[^}]*max-height:38vh[^}]*overflow:auto/, 'the one bounded child in default flow scrolls internally');
});
