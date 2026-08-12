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
