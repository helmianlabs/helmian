import test from 'node:test';
import assert from 'node:assert/strict';
import { bindConnectorMessage, connectorCanRequestAgentTurn } from '../src/cloud/communication-identity.mjs';

const message = {
  provider: 'discord', eventId: 'evt-1', externalUserId: 'u-1', channelId: 'c-1', text: 'status?'
};

function resolvers(overrides = {}) {
  return {
    resolveUser: async () => [{ active: true, subject: 'user_1', tenantId: 'tenant_a', role: 'admin', ...overrides.user }],
    resolveChannel: async () => [{ active: true, tenantId: 'tenant_a', ...overrides.channel }],
  };
}

test('rejects unsupported role before any agent turn', async () => {
  await assert.rejects(() => bindConnectorMessage({ message, ...resolvers({ user: { role: 'driver' } }) }), /role is unsupported/);
});

test('rejects missing or duplicate user bindings', async () => {
  await assert.rejects(() => bindConnectorMessage({ message, resolveUser: async () => [], resolveChannel: async () => [] }), /exactly one/);
  await assert.rejects(() => bindConnectorMessage({ message, resolveUser: async () => [{ active: true }, { active: true }], resolveChannel: async () => [] }), /exactly one/);
});

test('rejects inactive and cross-tenant channel bindings', async () => {
  await assert.rejects(() => bindConnectorMessage({ message, ...resolvers({ user: { active: false } }) }), /inactive/);
  await assert.rejects(() => bindConnectorMessage({ message, ...resolvers({ channel: { tenantId: 'tenant_b' } }) }), /tenant mismatch/);
});

test('returns a bounded identity binding but does not mint a session', async () => {
  const binding = await bindConnectorMessage({ message, ...resolvers({ user: { role: 'admin' } }) });
  assert.equal(binding.subject, 'user_1');
  assert.equal(binding.tenantId, 'tenant_a');
  assert.equal(binding.surface, 'connector-discord');
  assert.equal(binding.sessionIssuer, 'signed-session-required');
  assert.equal(connectorCanRequestAgentTurn(binding), true);
  assert.equal('providerToken' in binding, false);
});
