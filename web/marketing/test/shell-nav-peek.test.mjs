// Nav peek push (2026-11-09). The unpinned shell rail peeks open on hover
// or keyboard focus (app.js wireRail adds .peek; envoy.css makes the
// peeked sidebar position:fixed). Fixed takes the sidebar out of the
// #shell grid, and the shell children carried no explicit placement, so
// #main auto-placed into the vacated 60px rail track and the content
// column stood empty — hovering the menu blacked out the whole view.
// These tests pin the app.css contract that fixes it, in the same
// source-reading style as sw-update-nudge.test.mjs (the shell cannot be
// executed whole under a harness): the three shell columns are pinned to
// their tracks at desktop widths, and while the rail peeks the track
// widens to the full sidebar width so the content is pushed right and
// stays visible beside the open menu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../app/app.css', import.meta.url), 'utf8');
const js = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');

const marker = css.indexOf('/* Nav peek push (2026-11-09)');
assert.ok(marker > 0, 'the nav peek push block exists in app.css');
const block = css.slice(marker, marker + 2600);

test('the peek block is desktop-widths only, so the mobile drawer grid is untouched', () => {
  assert.match(block, /@media \(min-width: 901px\) \{/, 'the block opens with the min-width: 901px guard');
});

test('the three shell columns are pinned to their tracks', () => {
  assert.match(block, /#shell > #sidebar \{ grid-column: 1; \}/, 'sidebar pinned to track 1');
  assert.match(block, /#shell > #main \{ grid-column: 2; \}/, 'main pinned to the content track');
  assert.match(block, /#shell > #guard \{ grid-column: 3; \}/, 'guard pinned to track 3');
});

test('while the rail peeks, the track widens to the full sidebar width', () => {
  assert.match(
    block,
    /\.shell:has\(> \.sidebar\.rail\.peek\) \{ --side-w: var\(--side-full-w\); \}/,
    'the :has peek rule flips --side-w to the full width (the push)',
  );
  // The widening hangs off .peek only: no rule in the block widens the
  // track for the resting rail, so the rest state is unchanged.
  assert.doesNotMatch(block, /\.sidebar\.rail \{[^}]*--side-w/, 'no resting-rail widening rule');
});

test('hover and keyboard focus ride the same .peek class', () => {
  assert.ok(js.includes("sidebar.addEventListener('mouseenter', () => sidebar.classList.add('peek'))"), 'hover adds .peek');
  assert.ok(js.includes("sidebar.addEventListener('focusin', () => sidebar.classList.add('peek'))"), 'keyboard focus adds .peek');
});
