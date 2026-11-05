import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

// The light palette is specified verbatim by B0
// (theme-B0-light-palette-2026-11-04.md §2.1); these are its values, not
// a second invention. Dark stays the default everywhere.
const LIGHT_TOKENS = {
  '--canvas': '#F4F6F8',
  '--canvas-deep': '#E9EDF1',
  '--sidebar': '#FFFFFF',
  '--surface': '#FFFFFF',
  '--raised': '#EEF1F4',
  '--panel': '#F7F9FB',
  '--line': '#D5DBE3',
  '--line-strong': '#71869D',
  '--ink': '#121820',
  '--soft': '#2F3A47',
  '--muted': '#5C6B7A',
  '--faint': '#5A6B7D',
  '--accent': '#0B6E99',
  '--accent-ink': '#FFFFFF',
  '--accent-panel': '#D8EEF8',
  '--accent-dark': '#085A80',
  '--shadow': '0 24px 60px rgba(13, 42, 67, 0.14)',
};

function lightBlock(css) {
  const match = css.match(/\[data-theme="light"\]\s*\{([^}]*)\}/u);
  assert.ok(match, 'missing [data-theme="light"] block');
  return match[1];
}

test('styles.css carries the B0 light palette verbatim, dark untouched', () => {
  const css = read('../styles.css');
  const block = lightBlock(css);
  assert.match(block, /color-scheme:\s*light/u);
  for (const [token, value] of Object.entries(LIGHT_TOKENS)) {
    assert.ok(block.includes(`${token}: ${value};`), `light block must set ${token}: ${value}`);
  }
  // The dark default block keeps its shipped values (verify.mjs also pins
  // the Midnight accent; the light block must be purely additive).
  const dark = css.match(/:root\s*\{([^}]*)\}/u)[1];
  assert.ok(dark.includes('--canvas: #07111d;'), 'dark canvas changed');
  assert.ok(dark.includes('--accent: #65d5f5;'), 'dark accent changed');
  assert.ok(dark.includes('color-scheme: dark;'), 'dark color-scheme changed');
});

test('theme-init resolves system-by-default and remembers the choice', () => {
  const js = read('../theme-init.js');
  assert.ok(js.includes("'helmian.marketing.theme'"), 'storage key missing');
  assert.ok(js.includes('prefers-color-scheme: light'), 'OS preference not consulted');
  assert.ok(js.includes("'#F4F6F8'") || js.includes('#F4F6F8'), 'light chrome color missing');
  assert.ok(js.includes('data-theme-toggle'), 'toggle wiring missing');
  assert.ok(js.includes("setAttribute('data-theme', 'light')"), 'light attribute not set');
});

test('every public marketing page loads the pre-paint theme script', () => {
  const pages = [
    '../index.html',
    '../envoy.html',
    '../pricing.html',
    '../guard.html',
    '../get-started/index.html',
    '../sign-out/index.html',
    '../join/index.html',
  ];
  for (const page of pages) {
    const html = read(page);
    assert.ok(html.includes('theme-init.js'), `${page} does not load theme-init.js`);
    assert.ok(html.includes('name="theme-color"'), `${page} has no theme-color meta for the script to drive`);
    // The CSP-strict rule verify.mjs enforces: scripts are external only.
    for (const tag of html.match(/<script\b[^>]*>/gu) ?? []) {
      if (tag.includes('application/ld+json')) continue;
      assert.ok(/\bsrc=/u.test(tag), `${page} gained an inline script: ${tag}`);
    }
  }
});

test('header pages carry the theme toggle', () => {
  for (const page of ['../index.html', '../envoy.html', '../pricing.html', '../guard.html']) {
    const html = read(page);
    assert.ok(html.includes('data-theme-toggle'), `${page} is missing the header theme toggle`);
    assert.ok(html.includes('class="icon-sun"') && html.includes('class="icon-moon"'), `${page} toggle icons incomplete`);
  }
});

test('guard.html light block takes the shared palette on its own tokens', () => {
  const html = read('../guard.html');
  const block = lightBlock(html);
  for (const declaration of [
    '--bg:#F4F6F8',
    '--panel:#FFFFFF',
    '--ink:#121820',
    '--muted:#5C6B7A',
    '--lime:#1A774B',
    '--red:#B33A36',
    '--amber:#895E0D',
  ]) {
    assert.ok(block.includes(declaration), `guard light block must include ${declaration}`);
  }
  // Dark Guard values are untouched.
  assert.ok(html.includes('--lime:#c8ff58'), 'guard dark accent changed');
  assert.ok(html.includes('--bg:#070b12'), 'guard dark canvas changed');
});

test('join.css light block takes the shared palette on its tokens', () => {
  const css = read('../join/join.css');
  const block = lightBlock(css);
  for (const declaration of [
    '--bg:#F4F6F8',
    '--panel:#FFFFFF',
    '--border:#71869D',
    '--text:#121820',
    '--accent:#0B6E99',
    '--accent-hover:#085A80',
  ]) {
    assert.ok(block.includes(declaration), `join light block must include ${declaration}`);
  }
  assert.ok(css.includes('--bg:#0B1120'), 'join dark canvas changed');
});
