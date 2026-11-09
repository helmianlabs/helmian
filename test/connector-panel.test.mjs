// Connector library — SPEC §1.1/§1.6/§3.4, build bite 3 gate pieces
// that staging can prove without the live room:
//
//   (1) the toggle store is per (seat, conversation): arming a
//       connector for one seat's message changes no other seat's
//       state and no other conversation's, and clearing the set when
//       the message lands leaves the next message's defaults exactly
//       as they were (nothing armed);
//   (2) the panel view models, run against the REAL Bite 2 read
//       (createSeatLibraryRead) over fake store data: connected
//       Helmian-brokered rows are toggleable, vendor-brokered rows
//       carry the mirror note + manage link and NO toggle, every
//       other row shows its §1.2 state label with no toggle;
//   (3) the ask path: buildMessageRequest carries the armed set as
//       metadata.connectors (and nothing when the panel is
//       untouched), and the server's canonical validator
//       (normalizeMessageMetadata) accepts that shape, freezes it,
//       and refuses malformed, duplicated, or oversized sets.
//
// The live half of the Bite 3 gate (toggling in the real room, the
// composer text untouched on close) runs after the push — see the
// bite report's UNVERIFIED list.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  armedConnectorPairs,
  armedStateFromConfig,
  clearConversationToggles,
  connectorsForTurn,
  isConnectorOn,
  level1Model,
  level2Model,
  providerForSeat,
  seatForProvider,
  seatName,
  toggleConnector,
} from '../web/marketing/app/connector-panel.mjs';
import { buildMessageRequest, normalizeConnectorToggles } from '../web/marketing/app/composer-picker.mjs';
import { normalizeMessageMetadata, MAX_MESSAGE_CONNECTORS } from '../src/cloud/envoy-agents.mjs';
import { createSeatLibraryRead } from '../src/cloud/connector-library-read.mjs';

const CONV = 'channel:chan-1';
const OTHER_CONV = 'channel:chan-2';

// ---------------------------------------------------------- toggle store

test('toggle store: arming is per seat and per conversation', () => {
  let state = {};
  state = toggleConnector(state, CONV, 'grok', 'github');
  assert.equal(isConnectorOn(state, CONV, 'grok', 'github'), true);
  // Another seat in the same conversation: untouched.
  assert.equal(isConnectorOn(state, CONV, 'claude', 'helmian-github'), false);
  // The same seat in another conversation: untouched.
  assert.equal(isConnectorOn(state, OTHER_CONV, 'grok', 'github'), false);
  assert.deepEqual(connectorsForTurn(state, OTHER_CONV), []);
  // A second seat arms independently; the turn set names each seat.
  state = toggleConnector(state, CONV, 'claude', 'helmian-github');
  assert.deepEqual(connectorsForTurn(state, CONV), [
    { seatId: 'claude', entryId: 'helmian-github' },
    { seatId: 'grok', entryId: 'github' },
  ]);
});

test('toggle store: clearing on send restores the next message\'s defaults', () => {
  let state = {};
  state = toggleConnector(state, CONV, 'grok', 'github');
  state = toggleConnector(state, OTHER_CONV, 'claude', 'helmian-github');
  const cleared = clearConversationToggles(state, CONV);
  // The sent conversation starts over: nothing armed, defaults intact.
  assert.deepEqual(connectorsForTurn(cleared, CONV), []);
  assert.equal(isConnectorOn(cleared, CONV, 'grok', 'github'), false);
  // The other conversation's armed set is not the send's business.
  assert.deepEqual(connectorsForTurn(cleared, OTHER_CONV), [{ seatId: 'claude', entryId: 'helmian-github' }]);
  // Toggling off again returns the branch to nothing.
  const off = toggleConnector(state, CONV, 'grok', 'github');
  assert.equal(isConnectorOn(off, CONV, 'grok', 'github'), false);
  // The input state was never mutated (immutable updates).
  assert.equal(isConnectorOn(state, CONV, 'grok', 'github'), true);
});

test('standing set bridges (bite A2): config pairs fold under the channel scope and back', () => {
  // Hydration from the channel config's flat pair list.
  const state = armedStateFromConfig({ armedConnectors: [
    { seatId: 'claude', entryId: 'helmian-github' },
    { seatId: 'grok', entryId: 'github' },
  ] }, CONV);
  assert.equal(isConnectorOn(state, CONV, 'claude', 'helmian-github'), true);
  assert.equal(isConnectorOn(state, OTHER_CONV, 'claude', 'helmian-github'), false, 'the folded set belongs to its own channel scope only');
  assert.deepEqual(connectorsForTurn(state, CONV), [
    { seatId: 'claude', entryId: 'helmian-github' },
    { seatId: 'grok', entryId: 'github' },
  ]);
  // Extraction is the inverse: sorted flat pairs, this scope only.
  assert.deepEqual(armedConnectorPairs(state, CONV), [
    { seatId: 'claude', entryId: 'helmian-github' },
    { seatId: 'grok', entryId: 'github' },
  ]);
  assert.deepEqual(armedConnectorPairs(state, OTHER_CONV), []);
  // A flip through the ordinary toggle API is what extraction sees.
  const flipped = toggleConnector(state, CONV, 'claude', 'helmian-github');
  assert.deepEqual(armedConnectorPairs(flipped, CONV), [{ seatId: 'grok', entryId: 'github' }]);
  // Fail-closed: junk pairs and junk configs hydrate to nothing.
  assert.deepEqual(armedStateFromConfig({ armedConnectors: [{ seatId: 'Bad Seat', entryId: 'x' }, 'junk', null] }, CONV), {});
  assert.deepEqual(armedStateFromConfig(null, CONV), {});
  assert.deepEqual(armedStateFromConfig('nope', CONV), {});
});

// ------------------------------------------------------------- seat names

test('seat directory: names and the room provider mapping', () => {
  assert.equal(seatName('claude'), 'Claude');
  assert.equal(seatName('chatgpt'), 'ChatGPT');
  // The one mismatch: library seat 'chatgpt', room provider 'openai'.
  assert.equal(providerForSeat('chatgpt'), 'openai');
  assert.equal(seatForProvider('openai'), 'chatgpt');
  assert.equal(providerForSeat('grok'), 'grok');
  // Library-only seats hold libraries but are not composer agents.
  assert.equal(providerForSeat('muse'), null);
  assert.equal(seatName('muse'), 'Muse');
});

test('level 1 model: seat rows carry name, provider and connected count', () => {
  const model = level1Model([
    { seatId: 'claude', connectedCount: 2, entryCount: 12 },
    { seatId: 'chatgpt', connectedCount: 0, entryCount: 10 },
  ]);
  assert.deepEqual(model.rows, [
    { seatId: 'claude', name: 'Claude', provider: 'claude', connectedCount: 2, entryCount: 12 },
    { seatId: 'chatgpt', name: 'ChatGPT', provider: 'openai', connectedCount: 0, entryCount: 10 },
  ]);
});

// -------------------------------------------- panel models over the read
// The Bite 2 read, run for real over stub stores whose records are in
// the Bite 1 store's own output shapes — the same rows the route will
// serve. Claude's library: a vendor-brokered Gmail (mirror-reported
// connected), the surfaced native GitHub (tool-connections verified),
// a vendor Linear nobody connected.

const NOW = Date.now();
const entry = (over) => ({
  seatId: 'claude', kind: 'catalog', iconRef: 'icon:x', category: null,
  mcpEndpointUrl: null, vendorConnectorRef: null, authMode: 'oauth',
  clientIdentity: null, scopesSummary: null, addedBy: 'system', addedAt: null,
  workspaceProvisioned: false, state: 'available', ...over,
});
const CLAUDE_ENTRIES = [
  entry({ id: 'gmail', name: 'Gmail', oneLiner: 'Draft replies, summarize threads, & search your inbox', iconRef: 'icon:gmail', vendorName: 'Google', trustLabel: 'verified', brokerMode: 'vendor', vendorConnectorRef: { ref: 'anthropic:gmail', manageUrl: 'https://claude.ai/settings/connectors' } }),
  entry({ id: 'helmian-github', kind: 'helmian-native', name: 'GitHub', oneLiner: 'Work with the repositories this workspace already reaches', iconRef: 'icon:helmian-github', vendorName: 'Helmian', trustLabel: 'verified', brokerMode: 'helmian', mcpEndpointUrl: 'https://api.githubcopilot.com/mcp/' }),
  entry({ id: 'linear', name: 'Linear', oneLiner: 'Look up issues, check project status, and file new work', iconRef: 'icon:linear', vendorName: 'Linear', trustLabel: 'verified', brokerMode: 'vendor', vendorConnectorRef: { ref: 'anthropic:linear', manageUrl: 'https://claude.ai/settings/connectors' } }),
];
const GROK_ENTRIES = [
  entry({ seatId: 'grok', id: 'github', name: 'GitHub', oneLiner: 'Review pull requests, issues, and repository activity', iconRef: 'icon:github', vendorName: 'GitHub', trustLabel: 'verified', brokerMode: 'helmian', mcpEndpointUrl: 'https://api.githubcopilot.com/mcp/' }),
];

function fakeRead() {
  const libraryStore = {
    async listEntries(tenantId, seatId) {
      return seatId === 'claude' ? CLAUDE_ENTRIES : seatId === 'grok' ? GROK_ENTRIES : [];
    },
    async listConnections(tenantId, { personId, seatId }) {
      if (seatId !== 'grok' || personId !== 'user:troy') return [];
      return [{ id: 'conn-1', personId, seatId, entryId: 'github', accountIdentity: 'troy', accessTokenRef: 'vault://x', refreshTokenRef: 'vault://y', grantedScopes: [], posture: 'ask', toolEnableMap: {}, toolSnapshotRef: 'snap-1', state: 'connected', lastDiscoveryAt: null, lastUsedAt: null, createdAt: null, updatedAt: null }];
    },
    async listMirrors(tenantId, { personId, seatId }) {
      if (seatId !== 'claude' || personId !== 'user:troy') return [];
      return [{ personId, seatId, entryId: 'gmail', reportedState: 'connected', reportedAccountIdentity: 'troy@example.com', reportedAt: new Date(NOW).toISOString(), createdAt: null, updatedAt: null }];
    },
  };
  const toolConnectionsStore = {
    async list() {
      return [{ serviceId: 'github', scopeKind: 'workspace', state: 'verified', lastVerifiedAt: new Date(NOW).toISOString(), accountLabel: 'helmianlabs', lastToolsCount: 26, lastError: null }];
    },
  };
  return createSeatLibraryRead({ libraryStore, toolConnectionsStore });
}

test('level 2 model over the read: mirror rows never toggle, Helmian connected rows do', async () => {
  const read = fakeRead();
  const library = await read.readSeatLibrary('tenant-a', { personId: 'user:troy', seatId: 'claude', now: NOW });
  const model = level2Model(library, {}, CONV);
  const byId = new Map([...model.connected, ...model.catalog].map((r) => [r.entryId, r]));

  // Gmail: connected as the mirror reported — and a mirror is never
  // a toggle. It carries the note and the manage link instead.
  const gmail = byId.get('gmail');
  assert.equal(gmail.state, 'connected');
  assert.equal(gmail.stateLabel, 'Connected as troy@example.com');
  assert.equal(gmail.toggleable, false);
  assert.equal(gmail.on, false);
  assert.equal(gmail.mirror.manageUrl, 'https://claude.ai/settings/connectors');
  assert.equal(gmail.mirror.managedIn, 'Claude');
  assert.ok(model.connected.includes(gmail));

  // The surfaced native GitHub: connected from the tool-connections
  // receipt, on a pipe Helmian holds — this one toggles.
  const github = byId.get('helmian-github');
  assert.equal(github.state, 'connected');
  assert.equal(github.stateLabel, 'Connected as helmianlabs');
  assert.equal(github.toggleable, true);
  assert.equal(github.mirror, null);

  // Linear: a vendor row nobody connected — state label, no toggle,
  // and the mirror note still names where it is managed.
  const linear = byId.get('linear');
  assert.equal(linear.state, 'not-connected');
  assert.equal(linear.stateLabel, 'Not connected');
  assert.equal(linear.toggleable, false);
  assert.ok(model.catalog.includes(linear));

  // The custom row is present but not actionable in this bite.
  assert.equal(model.customRow.enabled, false);
});

test('level 2 model: an armed toggle shows on, for that conversation only', async () => {
  const read = fakeRead();
  const library = await read.readSeatLibrary('tenant-a', { personId: 'user:troy', seatId: 'grok', now: NOW });
  const armed = toggleConnector({}, CONV, 'grok', 'github');
  const here = level2Model(library, armed, CONV);
  assert.equal(here.connected[0].entryId, 'github');
  assert.equal(here.connected[0].toggleable, true);
  assert.equal(here.connected[0].on, true);
  // Same library, another conversation: the toggle is not there.
  const elsewhere = level2Model(library, armed, OTHER_CONV);
  assert.equal(elsewhere.connected[0].on, false);
  // And a different person's read of the same seat has no connection
  // at all — the toggle store is not the only isolation (§3.4).
  const stranger = await read.readSeatLibrary('tenant-a', { personId: 'user:someone-else', seatId: 'grok', now: NOW });
  assert.equal(stranger.connectedCount, 0);
});

// -------------------------------------------------------------- ask path

test('ask path: the armed set rides metadata.connectors; untouched panel sends nothing', () => {
  const armed = [{ seatId: 'grok', entryId: 'github' }, { seatId: 'claude', entryId: 'helmian-github' }];
  const req = buildMessageRequest({ channelId: 'chan-1', body: 'hello', idempotencyKey: 'k1', connectors: armed });
  assert.deepEqual(req.payload.metadata, { connectors: armed });
  assert.deepEqual(req.metadata.connectors, armed);
  const plain = buildMessageRequest({ channelId: 'chan-1', body: 'hello', idempotencyKey: 'k2' });
  assert.equal(plain.metadata, null);
  assert.equal('metadata' in plain.payload, false);
  // Client-side cleaning: duplicates and malformed entries drop out.
  assert.deepEqual(normalizeConnectorToggles([armed[0], armed[0], { seatId: 'Bad Seat', entryId: 'x' }, { seatId: 'grok' }]), [armed[0]]);
});

test('server validator: connectors are accepted, frozen, and bounded', () => {
  const meta = normalizeMessageMetadata({ connectors: [{ seatId: 'grok', entryId: 'github' }] });
  assert.deepEqual(meta, { connectors: [{ seatId: 'grok', entryId: 'github' }] });
  assert.ok(Object.isFrozen(meta));
  assert.ok(Object.isFrozen(meta.connectors));
  // Duplicates refuse, as they do for attachments.
  assert.throws(() => normalizeMessageMetadata({ connectors: [{ seatId: 'grok', entryId: 'github' }, { seatId: 'grok', entryId: 'github' }] }), /duplicated/);
  // Malformed shapes refuse.
  assert.throws(() => normalizeMessageMetadata({ connectors: [{ seatId: 'Bad Seat', entryId: 'github' }] }), /invalid/);
  assert.throws(() => normalizeMessageMetadata({ connectors: 'github' }), /invalid/);
  assert.throws(() => normalizeMessageMetadata({ connectors: [{ seatId: 'grok' }] }), /invalid/);
  // The cap refuses.
  const many = Array.from({ length: MAX_MESSAGE_CONNECTORS + 1 }, (_, i) => ({ seatId: 'grok', entryId: `e${i}` }));
  assert.throws(() => normalizeMessageMetadata({ connectors: many }), /too many/);
  // Existing shapes are untouched: empty stays null, webSearch and
  // attachments behave exactly as before.
  assert.equal(normalizeMessageMetadata({}), null);
  assert.deepEqual(normalizeMessageMetadata({ webSearch: true }), { webSearch: true });
  const both = normalizeMessageMetadata({ webSearch: false, connectors: [{ seatId: 'claude', entryId: 'helmian-github' }] });
  assert.deepEqual(both, { webSearch: false, connectors: [{ seatId: 'claude', entryId: 'helmian-github' }] });
});
