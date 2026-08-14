import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveWorkspaceLayout, normalizeWorkspaceLayout, roleDefaultLayout } from '../src/cloud/workspace-layout-preferences.mjs';

const shelves = ['chat', 'cora', 'prepare', 'artifact', 'governance'];

test('workspace layout keeps role defaults separate from personal overrides', () => {
  const result = effectiveWorkspaceLayout({ role: 'member', roleDefault: roleDefaultLayout('member'), personal: { density: 'compact', defaultEnvoyChannelId: null } });
  assert.equal(result.source, 'role_default_plus_user_override');
  assert.equal(result.density, 'compact');
  assert.deepEqual(result.visibleShelves, shelves);
});

test('workspace layout rejects incomplete shelves, unsupported authority, and invalid channel ids', () => {
  assert.throws(() => normalizeWorkspaceLayout({ visibleShelves: ['chat'], panelOrder: shelves, density: 'comfortable', defaultEnvoyChannelId: null }), /complete allowed/iu);
  assert.throws(() => normalizeWorkspaceLayout({ visibleShelves: shelves, panelOrder: shelves, density: 'comfortable', defaultEnvoyChannelId: null, plantId: 'warehouse-1' }), /unsupported/iu);
  assert.throws(() => normalizeWorkspaceLayout({ visibleShelves: shelves, panelOrder: shelves, density: 'comfortable', defaultEnvoyChannelId: 'customer-b' }), /invalid/iu);
});
