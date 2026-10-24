import test from 'node:test';
import assert from 'node:assert/strict';
import { assertEnvoyMembership, normalizeEnvoyChannel, normalizeEnvoyMessage } from '../src/cloud/envoy-chat.mjs';

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
