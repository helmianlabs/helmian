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

test('Settings explains connecting Scribe with a copyable connector URL', () => {
  assert.match(html, /id="scribe-url" readonly value="https:\/\/connect\.helmian\.cloud\/mcp"/);
  assert.match(html, /id="scribe-copy"/);
  assert.match(html, /passphrase/);
});

test('no jargon left on the Devices page', () => {
  assert.doesNotMatch(html, /Clerk unify checklist/);
});
