import assert from 'node:assert/strict';
import test from 'node:test';
import { EXACT_CANARY_SEQUENCE } from '../src/cloud/release-canary-contract.mjs';
import { RELEASE_CANARY_OBSERVATION_FORMAT, validateReleaseCanaryObservation } from '../src/cloud/release-canary-observation.mjs';

function validObservation() {
  return {
    format: RELEASE_CANARY_OBSERVATION_FORMAT,
    steps: EXACT_CANARY_SEQUENCE.map((name) => ({ name, status: 'pass' })),
    authority: { organizationSource: 'verified_active_membership', clientTenantSelectorUsed: false, clientPlantSelectorUsed: false, plantAuthority: 'business_data_only', crossOrganizationAccess: 'denied' },
    normalWork: { readPrepare: 'allowed_without_approval' },
    providerSessionReceipt: { durable: true, organizationConfigPinned: true, usageUnknownAllowed: true },
    providerClaimWithoutReceipt: false,
  };
}

test('physical canary observation requires every ordered step and truthful authority/receipt evidence', () => {
  const result = validateReleaseCanaryObservation(validObservation());
  assert.equal(result.valid, true);
});

test('observation rejects client tenant or Plant authority and missing receipt evidence', () => {
  const observation = validObservation();
  observation.authority.clientTenantSelectorUsed = true;
  observation.providerSessionReceipt.durable = false;
  const result = validateReleaseCanaryObservation(observation);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /client tenant|receipt evidence/u);
});

test('observation rejects provider claims without a durable source receipt and raw secrets', () => {
  const observation = validObservation();
  observation.providerClaimWithoutReceipt = true;
  const result = validateReleaseCanaryObservation(observation);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /provider claim/u);
  const secret = validObservation();
  secret.apiKey = 'never accepted';
  const secretResult = validateReleaseCanaryObservation(secret);
  assert.equal(secretResult.valid, false);
  assert.match(secretResult.errors.join(' '), /secret-bearing/u);
});
