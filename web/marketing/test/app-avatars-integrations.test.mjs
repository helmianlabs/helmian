import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CHARACTERS, COLORS, avatarFor, defaultChoice, sanitizeChoice, initialOf } from '../app/avatars.mjs';
import { integrationSections, HELP, PHONE_URL } from '../app/integrations-view.mjs';

test('avatars: characters, simple icons, and safe fallbacks', () => {
  assert.equal(CHARACTERS.length, 12);
  assert.deepEqual(avatarFor({ k: 'char', id: 'fox' }, 'Research'), { kind: 'char', glyph: '🦊', label: 'Fox' });
  const plain = avatarFor({ k: 'plain', c: 2 }, 'research notes');
  assert.equal(plain.kind, 'plain'); assert.equal(plain.glyph, 'R'); assert.equal(plain.color, COLORS[2]);
  assert.equal(avatarFor(null, 'Team').kind, 'plain', 'no choice -> plain letter icon');
  assert.equal(avatarFor({ k: 'char', id: 'nope' }, 'Team').kind, 'plain');
  assert.equal(avatarFor(null, 'Team').color, avatarFor(null, 'Team').color, 'stable colour per name');
  assert.equal(initialOf('#éclair'), 'É'); assert.equal(initialOf(''), '#');
  assert.equal(defaultChoice('x', 'plain').k, 'plain');
  assert.equal(defaultChoice('x', 'playful').k, 'char');
  assert.equal(sanitizeChoice({ k: 'char', id: '<img>' }), null);
  assert.equal(sanitizeChoice({ k: 'plain', c: 99 }), null);
  assert.deepEqual(sanitizeChoice({ k: 'plain', c: 1, extra: 1 }), { k: 'plain', c: 1 });
});

const JARGON = /\b(env|token|endpoint|vault|runner|oauth|api|neon|postgres|database url|uuid|id|secret|webhook|HELMIAN_|[A-Z]{2,}_[A-Z_]+)\b/i;
test('integrations: plain cards, no internal jargon, honest states', () => {
  const sections = integrationSections({ presence: [{ provider: 'xai', connected: true }], connectors: { registrations: [{ provider: 'discord', lifecycle: 'enabled', enabled: true }] } });
  const cards = sections.flatMap((s) => s.cards);
  for (const c of cards) {
    for (const t of [c.name, c.blurb, c.statusText, c.action?.label ?? '']) assert.doesNotMatch(t, JARGON, `${c.key}: "${t}"`);
  }
  for (const [title, lines] of Object.values(HELP)) for (const t of [title, ...lines]) assert.doesNotMatch(t, JARGON, t);
  const by = Object.fromEntries(cards.map((c) => [c.key, c]));
  assert.equal(by.grok.statusText, 'Connected'); assert.equal(by.grok.action.label, 'Manage');
  assert.equal(by.openai.action.href, '/api/provider-oauth/openai/start');
  assert.equal(by.claude.action.act, 'claude-help');
  assert.equal(by.pc.statusText, 'Online');
  assert.equal(by.discord.statusText, 'Linked', 'Discord is a channel mirror: linked, not tool-connected');
  assert.equal(by.slack.statusText, 'Not linked');
  assert.equal(by.github.statusText, 'Coming soon'); assert.equal(by.github.action, null);
  assert.equal(by.phone.qr, PHONE_URL); assert.match(PHONE_URL, /^https:\/\/helmian\.cloud\/app$/);
  const off = Object.fromEntries(integrationSections({}).flatMap((s) => s.cards).map((c) => [c.key, c]));
  assert.equal(off.pc.statusText, 'Offline'); assert.equal(off.pc.action.act, 'pc-help');
  assert.equal(off.data.statusText, 'Managed by Helmian');
});

test('integrations: tool-connection cards render probe truth; unchecked providers say so (bite 1b)', () => {
  const now = Date.parse('2026-10-25T18:00:00.000Z');
  const failed = Object.fromEntries(integrationSections({ connectors: { registrations: [] }, providers: { connections: [] }, presence: [],
    toolConnections: [{ serviceId: 'github', state: 'failed', lastVerifiedAt: null, lastError: 'connection refused' }], now }).flatMap((s) => s.cards).map((c) => [c.key, c]));
  assert.equal(failed.github.statusText, 'Check failed', 'a failed probe replaces Coming soon with the truth');
  assert.equal(failed.github.status, 'off');
  assert.equal(failed.discord.statusText, 'Not linked');
  assert.equal(failed.gemini.statusText, 'Not connected', 'both provider sources answered empty → Not connected');
  const fresh = Object.fromEntries(integrationSections({ connectors: { registrations: [] }, providers: { connections: [] }, presence: [],
    toolConnections: [{ serviceId: 'github', state: 'verified', lastVerifiedAt: '2026-10-25T17:45:00.000Z' }], now }).flatMap((s) => s.cards).map((c) => [c.key, c]));
  assert.equal(fresh.github.statusText, 'Connected'); assert.equal(fresh.github.status, 'on');
  const blind = Object.fromEntries(integrationSections({}).flatMap((s) => s.cards).map((c) => [c.key, c]));
  assert.equal(blind.gemini.statusText, 'Not checked', 'no source answered → Not checked, never a guessed Not connected');
  assert.equal(blind.discord.statusText, 'Not checked');
});

test('QR encoder is vendored same-origin (no outside script source)', async () => {
  const src = await readFile(new URL('../app/vendor/qrcode.mjs', import.meta.url), 'utf8');
  assert.match(src, /export default qrcode;/); assert.match(src, /MIT/);
  const { default: qrcode } = await import('../app/vendor/qrcode.mjs');
  const q = qrcode(0, 'M'); q.addData(PHONE_URL); q.make(); assert.ok(q.getModuleCount() >= 21);
  const app = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');
  assert.match(app, /import\('\.\/vendor\/qrcode\.mjs'\)/);
});

import { collapseRepeats, friendlyWorkspace } from '../app/app-model.mjs';
test('guard feed folds back-to-back repeats', () => {
  const a = { severity: 'info', title: 'Navigation requested', body: 'x' };
  const b = { severity: 'warning', title: 'Other', body: 'y' };
  const f = { severity: 'info', title: 'Navigation requested', body: 'x', finding: { fingerprint: 'k' } };
  const out = collapseRepeats([a, { ...a }, { ...a }, b, a, f, f]);
  assert.deepEqual(out.map((g) => g.repeat), [3, 1, 1, 1, 1]);
});
test('raw workspace ids are not shown', () => {
  assert.equal(friendlyWorkspace('2f6e22b9-a71e-40b6-8505-da29b79aaaaa'), 'your workspace');
  assert.equal(friendlyWorkspace('acme'), 'acme');
  assert.equal(friendlyWorkspace(''), 'your workspace');
});
