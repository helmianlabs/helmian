import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePersonalPreferences } from '../src/cora/personal-preferences.mjs';

test('personal preferences allow bounded ordinary controls only', () => {
  const prefs = normalizePersonalPreferences({ muted: false, volume: 70, verbosity: 'detailed', interruptMode: 'after_sentence', turnMode: 'standard', voiceProfile: 'emma' }, { verbosity: ['concise', 'standard', 'detailed'], interruptMode: ['after_sentence'], turnMode: ['standard'], voiceProfiles: ['emma'] });
  assert.equal(prefs.verbosity, 'detailed'); assert.equal(prefs.voiceProfile, 'emma');
});

test('personal preferences reject authority, provider, and out-of-bound controls', () => {
  assert.throws(() => normalizePersonalPreferences({ organizationId: 'other' }), /authority/u);
  assert.throws(() => normalizePersonalPreferences({ provider: 'openai' }), /unsupported/u);
  assert.throws(() => normalizePersonalPreferences({ volume: 101 }), /volume/u);
  assert.throws(() => normalizePersonalPreferences({ voiceProfile: 'unapproved' }, { voiceProfiles: ['emma'] }), /approved/u);
});
