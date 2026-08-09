import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProductIntegrationRegistry,
  defineProductIntegrationContract,
  productIntegrationRegistry,
} from '../src/core/product-integration-contract.mjs';

function fixture(overrides = {}) {
  return {
    id: 'fixture-product',
    displayName: 'Fixture Product',
    status: 'design_only',
    productBoundary: {
      codebase: 'separate', dataStore: 'separate', identity: 'separate',
      permissionModel: 'separate', crossProductAccess: false,
    },
    api: {
      contractStatus: 'required', authenticationStatus: 'required',
      endpointReference: null, authenticationReference: null,
    },
    data: { schemaStatus: 'required', retentionStatus: 'required', allowedFields: [] },
    tenantScope: { status: 'required', enforcedBy: 'source-product-and-helmian' },
    capabilities: {
      exceptionContextRead: 'unknown', advisoryEvidenceReturn: 'unknown',
      productionWrite: 'unsupported', remoteAction: 'unsupported',
    },
    ai: {
      mode: 'advisory_exception_analysis_only', providerNeutral: true,
      autonomousDecision: false, autonomousToolUse: false,
    },
    prohibitedUses: { employmentDecisionAutomation: true, opaqueDriverScoring: true },
    healthCheck: { method: 'read-only fixture check', mutates: false },
    ...overrides,
  };
}

test('DairyForge and AimForge are separate design-only product integrations', () => {
  const declarations = productIntegrationRegistry.list();
  assert.deepEqual(declarations.map((item) => item.id), ['dairyforge', 'aimforge']);
  assert.ok(declarations.every((item) => item.status === 'design_only'));
  assert.ok(declarations.every((item) => item.api.endpointReference === null));
  assert.ok(declarations.every((item) => item.api.authenticationReference === null));
  assert.ok(declarations.every((item) => item.data.allowedFields.length === 0));
  assert.ok(declarations.every((item) => !productIntegrationRegistry.isActivationEligible(item.id)));
  assert.notStrictEqual(declarations[0], declarations[1]);
});

test('product boundaries cannot merge code, data, identity, permissions, or access', () => {
  for (const [field, value] of [
    ['codebase', 'shared'], ['dataStore', 'shared'], ['identity', 'shared'],
    ['permissionModel', 'shared'], ['crossProductAccess', true],
  ]) {
    const candidate = fixture();
    candidate.productBoundary[field] = value;
    assert.throws(() => defineProductIntegrationContract(candidate), /separate|cross-product/);
  }
});

test('unverified contracts cannot smuggle endpoints, auth details, or credentials', () => {
  let candidate = fixture();
  candidate.api.endpointReference = 'https://unverified.invalid';
  assert.throws(() => defineProductIntegrationContract(candidate), /before its API contract is verified/);

  candidate = fixture();
  candidate.api.authenticationReference = 'unreviewed bearer scheme';
  assert.throws(() => defineProductIntegrationContract(candidate), /before review is verified/);

  candidate = fixture({ apiKey: 'must-never-enter-a-contract' });
  assert.throws(() => defineProductIntegrationContract(candidate), /secret-bearing integration field/);
});

test('the first integration slice cannot gain writes, actions, or autonomous AI authority', () => {
  for (const capability of ['productionWrite', 'remoteAction']) {
    const candidate = fixture();
    candidate.capabilities[capability] = 'supported';
    assert.throws(() => defineProductIntegrationContract(candidate), /cannot write|remote actions/);
  }

  for (const authority of ['autonomousDecision', 'autonomousToolUse']) {
    const candidate = fixture();
    candidate.ai[authority] = true;
    assert.throws(() => defineProductIntegrationContract(candidate), /autonomous/);
  }
});

test('activation requires verified API, auth, data, retention, tenant scope, and read support', () => {
  const candidate = fixture({ status: 'available' });
  candidate.api.contractStatus = 'verified';
  candidate.api.authenticationStatus = 'verified';
  candidate.api.endpointReference = 'versioned product API contract reference';
  candidate.api.authenticationReference = 'reviewed tenant-scoped authentication reference';
  candidate.data.schemaStatus = 'verified';
  candidate.data.retentionStatus = 'verified';
  candidate.data.allowedFields = ['fixtureExceptionId', 'observedAt'];
  candidate.tenantScope.status = 'verified';
  candidate.capabilities.exceptionContextRead = 'supported';

  const registry = createProductIntegrationRegistry([candidate]);
  assert.equal(registry.isActivationEligible('fixture-product'), true);
  assert.equal(registry.get('fixture-product').capabilities.productionWrite, 'unsupported');
});

test('duplicate product integration identities are rejected', () => {
  const candidate = fixture();
  assert.throws(
    () => createProductIntegrationRegistry([candidate, candidate]),
    /duplicate product integration ID/,
  );
});
