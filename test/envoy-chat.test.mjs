import test from 'node:test';
import assert from 'node:assert/strict';
import { assertEnvoyMembership, attachChannelLinks, normalizeEnvoyChannel, normalizeEnvoyMessage } from '../src/cloud/envoy-chat.mjs';
import { parseConfig, serializeConfig } from '../src/cloud/envoy-agents.mjs';

test('normalizes bounded tenant channel definitions', () => {
  assert.deepEqual(normalizeEnvoyChannel({ slug: 'Ops-Room', title: 'Operations', kind: 'team' }), {
    slug: 'ops-room', title: 'Operations', kind: 'team'
  });
  assert.throws(() => normalizeEnvoyChannel({ slug: 'bad path', title: 'x' }), /slug/);
});

test('normalizes bounded messages and rejects unsupported authors', () => {
  assert.equal(normalizeEnvoyMessage({ channelId: 'c1', authorSubject: 'u1', authorKind: 'human', body: 'hello' }).body, 'hello');
  assert.throws(() => normalizeEnvoyMessage({ channelId: 'c1', authorSubject: 'u1', authorKind: 'tool', body: 'x' }), /author kind/);
});

test('requires live membership and explicit Envoy policy enablement', () => {
  assert.equal(assertEnvoyMembership({ tenantId: 't1', subject: 'u1', role: 'admin', canUseEnvoy: true }), true);
  assert.throws(() => assertEnvoyMembership({ tenantId: 't1', subject: 'u1', role: 'admin', canUseEnvoy: false }), /not enabled/);
  assert.throws(() => assertEnvoyMembership({ tenantId: 't1', subject: 'u1', role: 'driver', canUseEnvoy: true }), /unsupported/);
});

test('message metadata: attachments normalize, junk refuses, absence stays absent', () => {
  const withMeta = normalizeEnvoyMessage({ channelId: 'c1', authorSubject: 'u1', authorKind: 'human', body: 'hi', metadata: { attachments: [{ kind: 'connector', key: 'Slack' }], webSearch: false } });
  assert.equal(withMeta.metadata.attachments[0].key, 'slack');
  assert.equal(withMeta.metadata.webSearch, false);
  const bare = normalizeEnvoyMessage({ channelId: 'c1', authorSubject: 'u1', authorKind: 'human', body: 'hi' });
  assert.equal('metadata' in bare, false, 'the pre-picker shape is unchanged');
  const arrayShape = normalizeEnvoyMessage({ channelId: 'c1', authorSubject: 'u1', authorKind: 'human', body: 'hi', attachments: [{ kind: 'plugin', name: 'calcplug' }] });
  assert.equal(arrayShape.metadata.attachments[0].name, 'calcplug');
  assert.throws(() => normalizeEnvoyMessage({ channelId: 'c1', authorSubject: 'u1', authorKind: 'human', body: 'hi', metadata: { attachments: [{ kind: 'wormhole', name: 'x' }] } }), /unsupported/);
});

test('channels list carries each channel its own Discord/Slack link (bite 2)', () => {
  // Config rows as stored (serializeConfig) and re-read (parseConfig),
  // exactly the round trip listChannels performs against the database.
  const linked = parseConfig(serializeConfig({
    agents: [], joined: {},
    discord: { guildId: '1563445314692718645', channelId: '1563445315237974069', channelName: 'general', guildName: 'HELMIAN', linkedAt: null },
    slack: null, pendingLink: null,
  }));
  const channels = [
    { id: 'team-1', slug: 'team', title: 'Team', kind: 'team' },
    { id: 'room-1', slug: 'troy', title: 'troy', kind: 'agent' },
    { id: 'bare-1', slug: 'ops', title: 'Ops', kind: 'team' },
  ];
  const out = attachChannelLinks(channels, new Map([['room-1', linked]]));
  assert.equal(out[0].discord, null, 'an unlinked channel says null, not a guess');
  assert.equal(out[1].discord.channelName, 'general', 'the linked room carries its Discord link in the list payload');
  assert.equal(out[1].discord.channelId, '1563445315237974069');
  assert.equal(out[1].slack, null);
  assert.equal(out[2].discord, null, 'a channel with no config row at all reads unlinked');
});
