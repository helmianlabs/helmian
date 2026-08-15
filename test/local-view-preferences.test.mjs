import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCAL_VIEW_PREFERENCES_KEY, normalizeLocalViewPreferences, readLocalViewPreferences, saveLocalViewPreferences } from '../web/cloud-admin/local-view-preferences.mjs';

function storage(initial = null) {
  let value = initial;
  return {
    getItem(key) { assert.equal(key, LOCAL_VIEW_PREFERENCES_KEY); return value; },
    setItem(key, next) { assert.equal(key, LOCAL_VIEW_PREFERENCES_KEY); value = next; },
    value: () => value,
  };
}

test('local view preferences only allow presentation density and rails', () => {
  assert.deepEqual(normalizeLocalViewPreferences({ density: 'compact', navigationVisible: false, agentsVisible: true, guardVisible: false, organizationId: 'other', plantId: 'x' }), { density: 'compact', navigationVisible: false, agentsVisible: true, guardVisible: false });
  assert.deepEqual(normalizeLocalViewPreferences({ density: 'invalid' }), { density: 'comfortable', navigationVisible: true, agentsVisible: true, guardVisible: true });
});

test('local view preferences persist in this browser and tolerate unavailable storage', () => {
  const local = storage();
  assert.deepEqual(saveLocalViewPreferences(local, { density: 'compact', navigationVisible: false }), { density: 'compact', navigationVisible: false, agentsVisible: true, guardVisible: true });
  assert.equal(local.value(), '{"density":"compact","navigationVisible":false,"agentsVisible":true,"guardVisible":true}');
  assert.deepEqual(readLocalViewPreferences(local), { density: 'compact', navigationVisible: false, agentsVisible: true, guardVisible: true });
  assert.deepEqual(readLocalViewPreferences({ getItem() { throw new Error('blocked'); } }), { density: 'comfortable', navigationVisible: true, agentsVisible: true, guardVisible: true });
});
