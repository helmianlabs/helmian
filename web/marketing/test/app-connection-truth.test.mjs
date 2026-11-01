// Connection truth (2026-11-01): the surfaces agree, and "Connected"
// comes from one place only.
//
// The defect this locks down: pressing Sync Profile wrote
// connected = true for every stock provider into the runner presence
// store, and Settings + Integrations rendered that stamp as
// "Connected" — while the Agents page, reading the provider
// connections store (sql/031), truthfully said "Not connected". Sync
// now stamps presence rows without a connection claim (markSynced in
// src/cloud/runner-presence.mjs), and every surface below renders
// "Connected" only from the connections store, under the same rule
// the Agents page reads it with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { integrationsModel, agentsModel } from '../app/app-model.mjs';
import { integrationSections } from '../app/integrations-view.mjs';

const SYNCED_AT = '2026-11-01T19:03:00.000Z';
// The presence rows a profile sync leaves behind: one stamp per stock
// provider, no connection claim on any of them.
const syncPresence = ['claude', 'openai', 'grok', 'gemini', 'mistral', 'runway', 'ollama']
  .map((provider) => ({ provider, connected: false, updatedAt: SYNCED_AT }));

test('after a sync, every provider reads Synced · Not connected — model rows and cards alike', () => {
  const rows = integrationsModel({}, { connections: [] }, { presence: syncPresence });
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  for (const key of ['anthropic', 'openai', 'xai', 'google']) {
    assert.equal(by[key].connected, false, key);
    assert.equal(by[key].status, 'synced', key);
    assert.equal(by[key].statusText, 'Synced · Not connected', key);
    assert.equal(by[key].source, 'runner-presence', key);
    assert.equal(by[key].syncedAt, SYNCED_AT, key);
  }
  const cards = Object.fromEntries(integrationSections({ presence: syncPresence, providers: { connections: [] }, connectors: {} })
    .flatMap((s) => s.cards).map((c) => [c.key, c]));
  for (const key of ['claude', 'openai', 'gemini', 'grok', 'mistral', 'runway']) {
    assert.equal(cards[key].statusText, 'Synced · Not connected', key);
    assert.notEqual(cards[key].action?.label, 'Manage', `${key}: a stamp never earns the Manage action`);
  }
});

test('a presence report from a device still never reads Connected', () => {
  const rows = integrationsModel({}, { connections: [] }, { presence: [{ provider: 'claude', connected: true, updatedAt: SYNCED_AT }] });
  const claude = rows.find((r) => r.key === 'anthropic');
  assert.deepEqual([claude.connected, claude.statusText], [false, 'Synced · Not connected']);
});

test('a saved connection row reads Connected on every surface at once', () => {
  // The shape the real writers produce today: lifecycle 'pending'.
  const providers = { connections: [{ providerId: 'gemini', lifecycle: 'pending', authMode: 'oauth_subscription', updatedAt: SYNCED_AT }] };
  const row = integrationsModel({}, providers, { presence: [] }).find((r) => r.key === 'google');
  assert.deepEqual([row.connected, row.statusText, row.source], [true, 'Connected', 'provider-connection']);
  const cards = Object.fromEntries(integrationSections({ presence: [], providers, connectors: {} })
    .flatMap((s) => s.cards).map((c) => [c.key, c]));
  assert.equal(cards.gemini.statusText, 'Connected');
  assert.equal(cards.gemini.action.label, 'Manage');
  // The Agents page — the surface that was already telling the truth —
  // reads the same store the same way, so the surfaces cannot drift.
  const agents = agentsModel(providers, {});
  assert.equal(agents.agents.find((a) => a.name === 'Gemini').connected, true);
});

test('nothing saved and nothing stamped reads Not connected; unanswered reads Not checked', () => {
  const bare = integrationsModel({}, { connections: [] }, { presence: [] }).find((r) => r.key === 'google');
  assert.deepEqual([bare.connected, bare.statusText], [false, 'Not connected']);
  const blind = integrationsModel({}, {}, {}).find((r) => r.key === 'google');
  assert.deepEqual([blind.connected, blind.statusText], [false, 'Not checked']);
});
