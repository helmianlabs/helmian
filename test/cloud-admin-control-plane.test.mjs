import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCloudAdminControlSurface } from '../src/cloud/admin-control-plane.mjs';
import { listLoadBoardProviderReadiness, searchNormalizedSampleLoads } from '../src/cloud/load-board-provider-registry.mjs';

test('cloud admin control surface is tenant-admin scoped and working in sample mode', () => {
  const result = buildCloudAdminControlSurface({ tenant_id: 'Acme-Operations', actor_role: 'Admin' });
  assert.equal(result.valid, true); assert.equal(result.result.tenant_id, 'acme-operations');
  assert.equal(result.result.integrations.integrations.length, 3);
  assert.deepEqual(result.result.load_boards.providers.map((item) => item.provider_id), ['dat', 'truckstop', '123loadboard']);
  assert.equal(result.result.mutation, 'not_performed'); assert.equal(Object.isFrozen(result), true);
  assert.equal(buildCloudAdminControlSurface({ tenant_id: 'acme-operations', actor_role: 'member' }).valid, false);
});

test('normalized load-board registry returns sample results without activating providers', () => {
  const readiness = listLoadBoardProviderReadiness({ tenant_id: 'acme-operations', actor_role: 'auditor' }); assert.equal(readiness.valid, true);
  const result = searchNormalizedSampleLoads({ tenant_id: 'acme-operations', actor_role: 'auditor', provider_id: 'dat', criteria: { origin: 'Dallas, TX', equipment: 'dry_van' } });
  assert.equal(result.valid, true); assert.equal(result.result.source, 'deterministic_sample'); assert.equal(result.result.selected_provider, 'dat'); assert.equal(result.result.loads[0].load_id, 'load-301');
  assert.equal(searchNormalizedSampleLoads({ tenant_id: 'acme-operations', actor_role: 'auditor', provider_id: 'unknown' }).valid, false);
});
