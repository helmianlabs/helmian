import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const csp = vercel.headers.flatMap((h) => h.headers).find((h) => h.key === 'Content-Security-Policy').value;

test('/app has no inline scripts (CSP script-src has no unsafe-inline)', () => {
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(m[1], /\bsrc=/, 'every script must be external');
    assert.equal(m[2].trim(), '');
  }
  assert.doesNotMatch(csp, /unsafe-inline'[^;]*;\s*style-src/);
});

test('CSP admits the voice module, Cloudflare beacon and Turnstile data: connect', () => {
  const dir = (name) => csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name} `)) ?? '';
  assert.match(dir('script-src'), /https:\/\/esm\.sh/);
  assert.match(dir('script-src'), /static\.cloudflareinsights\.com/);
  assert.match(dir('connect-src'), /cloudflareinsights\.com/);
  assert.match(dir('connect-src'), /\bdata:/);
});

test('title-only pages carry an empty state that points at a next step', () => {
  for (const id of ['metrics', 'timeline', 'evidence', 'approvals', 'integrations', 'home-running']) {
    assert.match(html, new RegExp(`class="empty empty-hint" data-empty-for="${id}"`), id);
    assert.match(html, new RegExp(`id="${id}"`), `target ${id} exists`);
  }
  assert.match(html, /id="getting-started"/);
});

test('the app carries no Scribe section or reference (Scribe is a separate product)', () => {
  assert.doesNotMatch(html, /\bScribe\b/);
  assert.doesNotMatch(html, /id="scribe-panel"/);
  assert.doesNotMatch(html, /id="scribe-url"/);
});

test('no jargon left on the Devices page', () => {
  assert.doesNotMatch(html, /Clerk unify checklist/);
});

// ---- P2 polish (2026-11-09): card names and ambient states ----
// The fresh-signup walk found agent cards clipping seat names to a
// single letter ("C…") and two ambient lines that read as stuck:
// the channels footer opening on "checking…" and the sidebar's
// "Cloud service · Connecting…", which no code path ever replaced
// for a signed-in person without a workspace yet.

const envoyCss = readFileSync(new URL('../app/envoy.css', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../app/app.js', import.meta.url), 'utf8');

test('P2: the integration card name line wraps, so a seat name is never squeezed to one letter', () => {
  const line1 = envoyCss.match(/\.int-line1 \{[^}]*\}/)?.[0] ?? '';
  assert.match(line1, /flex-wrap:\s*wrap/, 'when name and state cannot share the line, the state wraps below the name');
});

test('P2: ambient lines open on a state that was read, never on a progress claim', () => {
  for (const id of ['ew-discord-status-text', 'ew-slack-status-text', 'ew-github-status-text']) {
    assert.match(html, new RegExp(`id="${id}">not checked<`), `${id} opens on the honest pre-read word`);
  }
  assert.doesNotMatch(html, />checking…</, 'no footer line opens claiming a check is running');
  assert.match(html, /id="svc-text">Cloud service · Not checked</, 'the sidebar service line opens unclaimed');
  assert.doesNotMatch(html, /Cloud service · Connecting…/, 'and never opens on the stuck wording');
  assert.match(appJs, /\$\('#svc-text'\)\.textContent = model\.signedIn \? 'No workspace yet' : 'Signed out';/, 'boot names the read state on the no-workspace and signed-out paths too');
  assert.match(appJs, /\$\('#svc-text'\)\.textContent = 'Connected';/, 'the member path still earns Connected');
});
