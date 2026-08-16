import assert from 'node:assert/strict';
import test from 'node:test';
import { providerConnectionPanelModel } from '../web/cloud-admin/cora-config-client.mjs';

test('provider panel preserves explicit external-vault and no-execution states', () => {
  const model = providerConnectionPanelModel({ connections: [{ providerId: 'gemini', authMode: 'api_key', credentialReference: 'vault://tenant/acme/gemini', lifecycle: 'pending' }] });
  assert.equal(model.connections[0].credentialReference, 'vault://tenant/acme/gemini');
  assert.equal(model.vaultStatus, 'external_encrypted_vault_required');
  assert.equal(model.tools, 'not_granted');
  assert.equal(model.invocation, 'not_performed');
});

test('empty provider panel does not imply a configured provider', () => {
  const model = providerConnectionPanelModel({});
  assert.equal(model.empty, true);
  assert.match(model.statusLabel, /No tenant provider references/u);
});
