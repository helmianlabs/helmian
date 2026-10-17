import assert from 'node:assert/strict';
import test from 'node:test';
import { guardMotionState, guardCardVisible, GUARD_MOTION_DEFAULTS } from '../web/shared/guard-motion.mjs';

const NOW = new Date('2026-10-17T00:00:00Z').getTime();
const minutesAgo = (m) => new Date(NOW - m * 60000).toISOString();

test('motion defaults: acknowledged hidden, pulse on', () => {
  assert.equal(GUARD_MOTION_DEFAULTS.showAcknowledged, false);
  assert.equal(GUARD_MOTION_DEFAULTS.pulseAnimations, true);
});

test('info is grey and never moves', () => {
  for (const finding of [
    { severity: 'info', sightingCount: 1, firstSeenAt: minutesAgo(1), acked: false },
    { severity: 'info', sightingCount: 99, firstSeenAt: minutesAgo(999), acked: false },
  ]) {
    const state = guardMotionState(finding, NOW);
    assert.equal(state.tone, 'grey');
    assert.equal(state.pulse, false);
  }
});

test('critical is red and always pulses from the first frame', () => {
  const state = guardMotionState({ severity: 'critical', sightingCount: 1, firstSeenAt: minutesAgo(0), acked: false }, NOW);
  assert.equal(state.tone, 'red');
  assert.equal(state.pulse, true);
});

test('warning is solid yellow below the pulse thresholds', () => {
  const state = guardMotionState({ severity: 'warning', sightingCount: 2, firstSeenAt: minutesAgo(1), acked: false }, NOW);
  assert.equal(state.tone, 'yellow');
  assert.equal(state.pulse, false);
});

test('warning pulses at 3 sightings', () => {
  const state = guardMotionState({ severity: 'warning', sightingCount: 3, firstSeenAt: minutesAgo(1), acked: false }, NOW);
  assert.equal(state.tone, 'yellow');
  assert.equal(state.pulse, true);
});

test('warning pulses after 2 minutes unanswered', () => {
  const state = guardMotionState({ severity: 'warning', sightingCount: 1, firstSeenAt: minutesAgo(2), acked: false }, NOW);
  assert.equal(state.tone, 'yellow');
  assert.equal(state.pulse, true);
});

test('warning escalates to red at 5 sightings', () => {
  const state = guardMotionState({ severity: 'warning', sightingCount: 5, firstSeenAt: minutesAgo(1), acked: false }, NOW);
  assert.equal(state.tone, 'red');
  assert.equal(state.pulse, true);
});

test('warning escalates to red after 5 minutes unanswered', () => {
  const state = guardMotionState({ severity: 'warning', sightingCount: 1, firstSeenAt: minutesAgo(5), acked: false }, NOW);
  assert.equal(state.tone, 'red');
  assert.equal(state.pulse, true);
});

test('acknowledge stops motion and keeps the base tone', () => {
  const acked = guardMotionState({ severity: 'warning', sightingCount: 9, firstSeenAt: minutesAgo(60), acked: true }, NOW);
  assert.equal(acked.tone, 'yellow');
  assert.equal(acked.pulse, false);
  assert.equal(acked.acked, true);
  const ackedCritical = guardMotionState({ severity: 'critical', sightingCount: 9, firstSeenAt: minutesAgo(60), acked: true }, NOW);
  assert.equal(ackedCritical.tone, 'red');
  assert.equal(ackedCritical.pulse, false);
});

test('missing timestamps degrade to solid tones, never pulse', () => {
  const state = guardMotionState({ severity: 'warning', sightingCount: 1, acked: false }, NOW);
  assert.equal(state.tone, 'yellow');
  assert.equal(state.pulse, false);
});

test('show-acknowledged hides acked info/warning but never acked criticals', () => {
  const ackedInfo = { severity: 'info', acked: true };
  const ackedWarning = { severity: 'warning', acked: true };
  const ackedCritical = { severity: 'critical', acked: true };
  const unacked = { severity: 'info', acked: false };
  assert.equal(guardCardVisible(ackedInfo, false), false);
  assert.equal(guardCardVisible(ackedWarning, false), false);
  assert.equal(guardCardVisible(ackedCritical, false), true);
  assert.equal(guardCardVisible(unacked, false), true);
  assert.equal(guardCardVisible(ackedInfo, true), true);
  assert.equal(guardCardVisible(ackedWarning, true), true);
});
