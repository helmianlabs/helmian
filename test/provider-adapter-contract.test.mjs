import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProviderAdapterRegistry,
  defineProviderAdapterContract,
  providerAdapterRegistry,
} from '../src/core/provider-adapter-contract.mjs';

function validContract(overrides = {}) {
  return {
    id: 'fixture-provider',
    displayName: 'Fixture Provider',
    status: 'design_only',
    identity: {
      kind: 'fixture_identity',
      verification: 'redacted test identity',
    },
    auth: {
      type: 'fixture_flow',
      custody: 'test-only non-secret flow',
    },
    invocation: [{
      transport: 'local_endpoint',
      documentationStatus: 'documentation_required',
      documentationReference: 'fixture documentation review',
    }],
    capabilities: {
      readOnly: 'supported',
      workspaceWrite: 'unsupported',
      toolUse: 'unknown',
      streaming: 'unknown',
      voice: 'unsupported',
    },
    evidence: {
      format: 'helmion.adapter-evidence.v1',
      requiredFields: ['adapterId', 'result'],
    },
    safety: {
      authority: 'helmion-maestro',
      requiresLeaseForWorkspaceWrite: true,
      providerCanGrantApproval: false,
      consumerUiAutomation: false,
      restrictions: ['fixture restriction'],
    },
    healthCheck: {
      method: 'read-only fixture probe',
      mutates: false,
    },
    ...overrides,
  };
}

test('planned AI provider declarations are design-only and cannot activate', () => {
  const contracts = providerAdapterRegistry.list();
  assert.deepEqual(
    contracts.map((contract) => contract.id),
    [
      'codex-cli',
      'openai-api',
      'claude-code-cli',
      'gemini-cli',
      'gemini-api',
      'grok',
    ],
  );
  assert.ok(contracts.every((contract) => contract.status === 'design_only'));
  assert.ok(contracts.every((contract) =>
    !providerAdapterRegistry.isActivationEligible(contract.id)));
  const verified = new Set([
    'codex-cli',
    'openai-api',
    'gemini-cli',
    'gemini-api',
  ]);
  assert.ok(contracts.every((contract) =>
    contract.invocation.every((item) =>
      item.documentationStatus === (
        verified.has(contract.id)
          ? 'verified_documented'
          : 'documentation_required'
      ))));
});

test('registry rejects duplicate adapter identities', () => {
  const contract = validContract();
  assert.throws(
    () => createProviderAdapterRegistry([contract, contract]),
    /duplicate provider adapter ID/,
  );
});

test('consumer UI automation is not an invocation transport', () => {
  const contract = validContract({
    invocation: [{
      transport: 'consumer_ui',
      documentationStatus: 'verified_documented',
      documentationReference: 'not acceptable',
    }],
  });
  assert.throws(
    () => defineProviderAdapterContract(contract),
    /consumer UI automation is forbidden/,
  );
});

test('workspace write support requires the shared Maestro lease', () => {
  const contract = validContract();
  contract.capabilities.workspaceWrite = 'supported';
  contract.safety.requiresLeaseForWorkspaceWrite = false;
  assert.throws(
    () => defineProviderAdapterContract(contract),
    /requires a Maestro lease/,
  );
});

test('a provider cannot grant approvals', () => {
  const contract = validContract();
  contract.safety.providerCanGrantApproval = true;
  assert.throws(
    () => defineProviderAdapterContract(contract),
    /cannot grant Maestro approval/,
  );
});

test('health checks must remain non-mutating', () => {
  const contract = validContract();
  contract.healthCheck.mutates = true;
  assert.throws(
    () => defineProviderAdapterContract(contract),
    /health checks must be non-mutating/,
  );
});

test('contract declarations cannot carry secret-bearing fields', () => {
  const contract = validContract();
  contract.auth.secretValue = 'fixture';
  assert.throws(
    () => defineProviderAdapterContract(contract),
    /secret-bearing contract field is forbidden/,
  );
});

test('validated contracts are immutable', () => {
  const contract = defineProviderAdapterContract(validContract());
  assert.ok(Object.isFrozen(contract));
  assert.ok(Object.isFrozen(contract.capabilities));
  assert.throws(() => {
    contract.status = 'available';
  }, TypeError);
});
