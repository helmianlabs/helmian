import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveOrganizationDatabase, normalizeOrganizationDatabaseRecord } from '../src/cloud/organization-database-routing.mjs';

const membership = { organizationId: 'customer-a', active: true, membershipVerified: true, role: 'member' };
const record = { tenant_id: 'customer-a', logical_database_locator: 'customer-a-primary', secret_reference_name: 'neon/customer-a-primary', region: 'us-east-2', lifecycle: 'active' };

test('Organization database routing resolves only server membership and exposes logical metadata', () => {
  const result = resolveOrganizationDatabase({ verifiedMembership: membership, registryRecord: record });
  assert.equal(result.status ?? 'active', 'active');
  assert.equal(result.organizationId, 'customer-a');
  assert.equal(result.logicalDatabaseLocator, 'customer-a-primary');
  assert.equal(result.secretReferenceName, 'neon/customer-a-primary');
  assert.equal(result.connectionString, null);
  assert.doesNotMatch(JSON.stringify(result), /postgres(?:ql)?:\/\//iu);
});

test('database routing fails closed for cross-Organization, Plant, raw secret, and non-active records', () => {
  assert.throws(() => normalizeOrganizationDatabaseRecord({ ...record, tenant_id: 'customer-b' }, 'customer-a'), /does not match/iu);
  assert.throws(() => resolveOrganizationDatabase({ verifiedMembership: { ...membership, plantId: 'warehouse-1' }, registryRecord: record }), /Plant/iu);
  assert.throws(() => normalizeOrganizationDatabaseRecord({ ...record, secret_reference_name: 'postgresql://raw-connection' }, 'customer-a'), /secret reference/iu);
  const planned = resolveOrganizationDatabase({ verifiedMembership: membership, registryRecord: { ...record, lifecycle: 'planned' } });
  assert.equal(planned.lifecycle, 'planned');
  assert.equal(planned.customerDatabase, 'not_available');
});
