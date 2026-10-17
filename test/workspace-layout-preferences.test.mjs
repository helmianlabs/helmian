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

test('workspace layout emojiMode defaults to playful and accepts plain', () => {
  const base = { visibleShelves: shelves, panelOrder: shelves, density: 'comfortable', defaultEnvoyChannelId: null };
  assert.equal(normalizeWorkspaceLayout({ ...base, emojiMode: 'playful' }).emojiMode, 'playful');
  assert.equal(normalizeWorkspaceLayout({ ...base, emojiMode: 'plain' }).emojiMode, 'plain');
  assert.equal(normalizeWorkspaceLayout({ ...base, emojiMode: 'PLAIN' }).emojiMode, 'plain');
  assert.equal(normalizeWorkspaceLayout({ ...base, emojiMode: null }).emojiMode, null);
  assert.equal(normalizeWorkspaceLayout({ ...base, emojiMode: '' }).emojiMode, null);
  assert.throws(() => normalizeWorkspaceLayout({ ...base, emojiMode: 'wild' }), /emojiMode is invalid/iu);
});

test('workspace layout effective emojiMode resolves null to playful', () => {
  const base = { visibleShelves: shelves, panelOrder: shelves, density: 'comfortable', defaultEnvoyChannelId: null };
  const withNull = effectiveWorkspaceLayout({ role: 'member', roleDefault: { ...base, emojiMode: null }, personal: null });
  assert.equal(withNull.emojiMode, 'playful');
  const personal = effectiveWorkspaceLayout({ role: 'member', roleDefault: roleDefaultLayout('member'), personal: { emojiMode: 'plain' } });
  assert.equal(personal.emojiMode, 'plain');
  assert.equal(personal.source, 'role_default_plus_user_override');
  const rolePlain = effectiveWorkspaceLayout({ role: 'member', roleDefault: { ...base, emojiMode: 'plain' }, personal: null });
  assert.equal(rolePlain.emojiMode, 'plain');
});
