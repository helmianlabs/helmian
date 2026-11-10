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
  assert.equal(by.grok.statusText, 'Synced', 'a presence row alone reads Synced, never Connected (connection-truth correction, 2026-11-01)');
  // One connect road (2026-11-01, Bite 4): a not-connected AI card
  // carries the email + password fields, not a link out or a help act.
  assert.deepEqual(by.grok.connect, { provider: 'grok' }, 'not connected → the connect fields, not Manage');
  assert.equal(by.grok.action, null);
  assert.deepEqual(by.openai.connect, { provider: 'openai' });
  assert.equal(by.openai.action, null);
  assert.deepEqual(by.claude.connect, { provider: 'claude' });
  assert.equal(by.claude.action, null);
  assert.equal(by.pc.statusText, 'Online');
  assert.equal(by.discord.statusText, 'Linked', 'Discord is a channel mirror: linked, not tool-connected');
  assert.equal(by.slack.statusText, 'Not linked');
  assert.equal(by.github.statusText, 'Ready to link'); assert.deepEqual(by.github.action, { label: 'Link a channel', href: '#desktop' });
  assert.equal(by.phone.qr, PHONE_URL); assert.match(PHONE_URL, /^https:\/\/helmian\.cloud\/app$/);
  const off = Object.fromEntries(integrationSections({}).flatMap((s) => s.cards).map((c) => [c.key, c]));
  assert.equal(off.pc.statusText, 'Offline'); assert.equal(off.pc.action.act, 'pc-help');
  assert.equal(off.data.statusText, 'Managed by Helmian');
});

test('integrations: AI card icons are settled letter tiles — asset images or the plain letter tile, never emoji glyphs (polish pass)', () => {
  const ai = integrationSections({}).find((s) => s.id === 'ai').cards;
  const by = Object.fromEntries(ai.map((c) => [c.key, c]));
  for (const [key, file] of [['claude', 'claude'], ['openai', 'chatgpt'], ['gemini', 'gemini'], ['grok', 'grok']]) {
    assert.deepEqual(by[key].icon, { img: `/assets/agents/${file}.png` }, `${key} renders its settled asset tile`);
  }
  // Mistral and Runway have no asset file under /assets/agents/; their
  // cards carry the app's plain letter tile (avatars.mjs) in the same
  // construction — an initial on a name-stable colour from COLORS.
  assert.equal(by.mistral.icon.tile.kind, 'plain');
  assert.equal(by.mistral.icon.tile.glyph, 'M');
  assert.ok(COLORS.includes(by.mistral.icon.tile.color), 'mistral tile colour comes from the plain-avatar palette');
  assert.equal(by.runway.icon.tile.kind, 'plain');
  assert.equal(by.runway.icon.tile.glyph, 'R');
  assert.ok(COLORS.includes(by.runway.icon.tile.color), 'runway tile colour comes from the plain-avatar palette');
  for (const c of ai) assert.equal(c.icon.glyph, undefined, `${c.key} carries no emoji glyph icon`);
});

test('integrations: the five catalog seats carry key fields, not sign-in fields, until connected', () => {
  const ai = integrationSections({}).find((s) => s.id === 'ai').cards;
  const by = Object.fromEntries(ai.map((c) => [c.key, c]));
  // One key each for four seats; Cloudflare's two named pieces.
  assert.deepEqual(by.groq.apiKeyConnect, { provider: 'groq', fields: ['api_key'] });
  assert.deepEqual(by.nvidia.apiKeyConnect, { provider: 'nvidia', fields: ['api_key'] });
  assert.deepEqual(by.openrouter.apiKeyConnect, { provider: 'openrouter', fields: ['api_key'] });
  assert.deepEqual(by.muse.apiKeyConnect, { provider: 'muse', fields: ['api_key'] });
  assert.deepEqual(by.cloudflare.apiKeyConnect, { provider: 'cloudflare', fields: ['account_id', 'api_token'] });
  for (const key of ['groq', 'nvidia', 'cloudflare', 'openrouter', 'muse']) {
    assert.equal(by[key].connect, null, `${key} never gets the email + password fields`);
    assert.equal(by[key].action, null, `${key} not connected → no Manage`);
    assert.equal(by[key].icon.tile.kind, 'plain', `${key} renders the plain letter tile like Mistral and Runway`);
  }
  assert.deepEqual(ai.map((c) => c.key), ['claude', 'openai', 'gemini', 'grok', 'mistral', 'runway', 'groq', 'nvidia', 'cloudflare', 'openrouter', 'muse'], 'the catalog seats join the AI section after the sign-in seats');
  // A saved connection flips the card: fields go, Manage arrives.
  const on = Object.fromEntries(integrationSections({ providers: { connections: [{ providerId: 'groq', authMode: 'api_key' }] }, presence: [] })
    .find((s) => s.id === 'ai').cards.map((c) => [c.key, c]));
  assert.equal(on.groq.apiKeyConnect, null);
  assert.equal(on.groq.status, 'on');
  assert.deepEqual(on.groq.action, { label: 'Manage', href: '#agents' });
  // …and the change button arrives (owner's order, 2026-11-06): a
  // connected card must let the person put in new values.
  assert.deepEqual(on.groq.changeApiKey, { provider: 'groq', fields: ['api_key'], label: 'New API key' });
  assert.equal(on.groq.changeConnect, null, 'a key seat never offers the sign-in change');
});

test('integrations: connected cards carry the plain change button; not-connected cards do not (owner order, 2026-11-06)', () => {
  const on = Object.fromEntries(integrationSections({ providers: { connections: [
    { providerId: 'mistral', authMode: 'password_session' },
    { providerId: 'cloudflare', authMode: 'api_key' },
  ] }, presence: [] }).find((s) => s.id === 'ai').cards.map((c) => [c.key, c]));
  // Mistral's saved connection now reads through her truth row, so
  // her card closes the connect fields, reads Connected, and offers
  // the change button like every other sign-in seat.
  assert.equal(on.mistral.statusText, 'Connected');
  assert.equal(on.mistral.connect, null, 'a connected card shows no first-connect fields');
  assert.deepEqual(on.mistral.changeConnect, { provider: 'mistral', label: 'New username and password' });
  assert.equal(on.mistral.changeApiKey, null);
  // Cloudflare's button names both of its pieces.
  assert.deepEqual(on.cloudflare.changeApiKey, { provider: 'cloudflare', fields: ['account_id', 'api_token'], label: 'New account number and API key' });
  assert.equal(on.cloudflare.changeConnect, null);
  // Runway keeps its existing card exactly — no change road.
  assert.equal(on.runway.changeConnect, null);
  assert.equal(on.runway.changeApiKey, null);
  const off = Object.fromEntries(integrationSections({}).find((s) => s.id === 'ai').cards.map((c) => [c.key, c]));
  for (const c of Object.values(off)) {
    assert.equal(c.changeConnect, null, `${c.key} not connected → no change button`);
    assert.equal(c.changeApiKey, null, `${c.key} not connected → no change button`);
  }
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
  assert.match(app, /import\('\.\/vendor\/qrcode\.mjs(\?v=[0-9a-f]{16})?'\)/);
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
