import assert from 'node:assert/strict';
import test from 'node:test';
import { connectorRegistrationView, normalizeConnectorRegistration } from '../src/cloud/connector-registration.mjs';

const base = { provider: 'slack', lifecycle: 'draft', publicEndpointReady: false, secretReferenceName: 'vault/helmian/slack-signing', allowedInboundChannels: [{ externalChannelId: 'C123', label: 'Operations', enabled: true }] };

test('connector registration is bounded metadata and never accepts secrets or authority selectors', () => {
  const registration = normalizeConnectorRegistration(base);
  assert.equal(registration.provider, 'slack'); assert.equal(registration.lifecycle, 'draft');
  assert.throws(() => normalizeConnectorRegistration({ ...base, signingSecret: 'raw-secret' }), /unsupported/u);
  assert.throws(() => normalizeConnectorRegistration({ ...base, plantId: 'warehouse-1' }), /authority/u);
  assert.throws(() => normalizeConnectorRegistration({ ...base, secretReferenceName: 'raw-secret-value' }), /non-sensitive/u);
});

test('GitHub is represented as a non-secret connector registration surface', () => {
  const registration = normalizeConnectorRegistration({
    ...base,
    provider: 'github',
    secretReferenceName: null,
  });
  assert.equal(registration.provider, 'github');
  assert.equal(registration.lifecycle, 'draft');
});

test('enabled connector requires declared readiness and an enabled channel', () => {
  assert.throws(() => normalizeConnectorRegistration({ ...base, lifecycle: 'enabled' }), /requires readiness/u);
  const enabled = normalizeConnectorRegistration({ ...base, lifecycle: 'enabled', publicEndpointReady: true });
  const member = connectorRegistrationView(enabled, { admin: false });
  assert.equal(member.secretReferenceName, null); assert.equal(member.providerCalls, 'not_performed');
});

test('connector lifecycle only advances through the reviewed sequence', () => {
  const readyDraft = { ...base, publicEndpointReady: true };
  assert.throws(() => normalizeConnectorRegistration({ ...readyDraft, lifecycle: 'enabled' }, readyDraft), /transition/u);
  assert.equal(normalizeConnectorRegistration({ ...base, lifecycle: 'testing' }, base).lifecycle, 'testing');
});
