// App theme tests (B2): the /app light theme is the B0 §2.2 palette,
// verbatim — every token value, the computed WCAG pairs from B0 §3, the
// §4.1 dark-island decisions (code blocks + tooltips stay dark, with
// explicit light text), and the switcher wiring (Light + System in both
// selects, a pre-paint script, applyTheme resolving 'system'). The dark
// themes' values are pinned too: adding light must not move them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const appCss = read('../web/marketing/app/app.css');
const envoyCss = read('../web/marketing/app/envoy.css');
const indexHtml = read('../web/marketing/app/index.html');
const appJs = read('../web/marketing/app/app.js');

// The rule body for an exact selector (first match), whitespace-folded.
function ruleBody(css, selector) {
  const i = css.indexOf(selector);
  assert.ok(i >= 0, `selector not found: ${selector}`);
  const open = css.indexOf('{', i);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close).replace(/\s+/g, ' ');
}
function varsOf(body) {
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim().toLowerCase();
  return out;
}
function lum(hex) {
  const c = hex.replace('#', '');
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(parseInt(c.slice(0, 2), 16)) + 0.7152 * f(parseInt(c.slice(2, 4), 16)) + 0.0722 * f(parseInt(c.slice(4, 6), 16));
}
function ratio(a, b) { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); }

const light = varsOf(ruleBody(appCss, '[data-theme="light"]'));

test('app.css light block is the B0 §2.2 palette, verbatim', () => {
  const spec = {
    '--bg': '#f4f6f8', '--panel': '#ffffff', '--panel-2': '#eef1f4', '--border': '#71869d',
    '--text': '#121820', '--muted': '#5c6b7a', '--faint': '#5a6b7d', '--accent': '#0b6e99',
    '--accent-hover': '#085a80', '--red': '#b33a36', '--amber': '#895e0d', '--green': '#1a774b',
  };
  for (const [k, v] of Object.entries(spec)) assert.equal(light[k], v, `${k} must be the B0 value`);
  assert.match(ruleBody(appCss, '[data-theme="light"]'), /color-scheme:\s*light/);
});

test('light palette passes the B0 §3 computed pairs', () => {
  const textPairs = [
    ['--text', '--bg'], ['--text', '--panel'], ['--text', '--panel-2'],
    ['--muted', '--bg'], ['--muted', '--panel'], ['--muted', '--panel-2'],
    ['--faint', '--bg'], ['--faint', '--panel'], ['--faint', '--panel-2'],
    ['--accent', '--bg'], ['--accent', '--panel'], ['--accent', '--panel-2'],
    ['--red', '--bg'], ['--red', '--panel'], ['--red', '--panel-2'],
    ['--amber', '--bg'], ['--amber', '--panel'], ['--amber', '--panel-2'],
    ['--green', '--bg'], ['--green', '--panel'], ['--green', '--panel-2'],
  ];
  for (const [fg, bg] of textPairs) assert.ok(ratio(light[fg], light[bg]) >= 4.5, `${fg} on ${bg} must reach AA text`);
  assert.ok(ratio('#ffffff', light['--accent']) >= 4.5, 'white on accent');
  assert.ok(ratio('#ffffff', light['--accent-hover']) >= 4.5, 'white on accent-hover');
  assert.ok(ratio(light['--accent-hover'], light['--panel']) >= 4.5, 'accent-hover on panel');
  for (const bg of ['--bg', '--panel', '--panel-2']) assert.ok(ratio(light['--border'], light[bg]) >= 3.0, `--border carries structure on ${bg}`);
  // B0 §2.0/§2.2 flat severity + badge pairs.
  assert.ok(ratio(light['--red'], '#fdeceb') >= 4.5, 'red text on red tint');
  assert.ok(ratio(light['--amber'], '#fbf0da') >= 4.5, 'amber text on amber tint');
  assert.ok(ratio(light['--green'], '#e4f4eb') >= 4.5, 'green text on green tint');
  assert.ok(ratio('#1a1205', '#f6c453') >= 4.5, 'badge ink on the light amber fill');
  // B0 §4.1 dark islands.
  assert.ok(ratio('#dce7ee', '#0f141c') >= 4.5, 'code text on the code island');
  assert.ok(ratio('#f2f7fa', '#0b1220') >= 4.5, 'tooltip text on the tooltip island');
});

test('the dark themes are untouched', () => {
  assert.ok(ruleBody(appCss, ':root').includes('--bg:#0B1120'), 'default (midnight) bg unchanged');
  assert.ok(ruleBody(appCss, '[data-theme="black"]').includes('--bg:#000'), 'black bg unchanged');
  assert.ok(ruleBody(appCss, '[data-theme="slate"]').includes('--bg:#0F172A'), 'slate bg unchanged');
  assert.ok(ruleBody(envoyCss, 'html[data-theme="midnight"]').includes('--bg:#1A202C'), 'envoy midnight bg unchanged');
});

test('B0 §4.1: code islands and tooltips stay dark with explicit light text', () => {
  const pre = ruleBody(envoyCss, '.ew-body pre');
  assert.ok(pre.includes('background:#0F141C') && pre.includes('color:#DCE7EE'), 'code block keeps its dark bg and gains explicit text color');
  const canvas = ruleBody(envoyCss, '.ew-canvas-body textarea');
  assert.ok(canvas.includes('background:#0F141C') && canvas.includes('color:#DCE7EE'), 'canvas editor is the same dark island');
  const tip = ruleBody(envoyCss, '.sidebar.rail .nav-item[data-tip]:hover::after');
  assert.ok(tip.includes('background:#0B1220') && tip.includes('color:#F2F7FA'), 'rail tooltip keeps its dark bg with the spec text color');
});

test('B0 §2.2 note: the amber badge keeps dark ink on the light fill', () => {
  const badge = ruleBody(appCss, '[data-theme="light"] .badge');
  assert.ok(badge.includes('background:#F6C453') && badge.includes('color:#1A1205'), 'badge must not pair with the --amber text color');
});

test('both theme selects offer Light and System', () => {
  for (const id of ['theme-quick', 'theme']) {
    const open = indexHtml.indexOf(`<select id="${id}"`);
    assert.ok(open >= 0, `#${id} select exists`);
    const sel = indexHtml.slice(open, indexHtml.indexOf('</select>', open));
    assert.ok(sel.includes('value="light">Light') && sel.includes('value="system">System'), `#${id} carries Light + System`);
  }
});

test('the theme is set pre-paint from the same store app.js uses', () => {
  const paint = indexHtml.indexOf('helmian.app.theme');
  assert.ok(paint >= 0 && paint < indexHtml.indexOf('/app/app.css'), 'pre-paint script reads helmian.app.theme before the stylesheets');
  assert.ok(indexHtml.includes("matchMedia('(prefers-color-scheme: light)')"), 'pre-paint resolves system');
});

test("applyTheme resolves 'system' and follows OS changes", () => {
  assert.ok(appJs.includes('function resolveTheme'), 'app.js has a theme resolver');
  assert.ok(appJs.includes("theme === 'system'"), "the resolver maps 'system' through prefers-color-scheme");
  assert.ok(appJs.includes('dataset.theme = resolved'), 'the attribute carries the resolved theme, not the preference');
  assert.ok(appJs.includes("themeMq.addEventListener('change'"), 'an OS theme change re-applies while system is chosen');
});
