import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASE_TWO_TEST_DEFAULTS,
  runPhaseTwoSwitchTest,
} from '../src/core/phase-two-verification.mjs';
import { MemoryMaestroStore } from '../test-support/memory-maestro-store.mjs';

test('isolated Phase Two test commits a complete switch and releases its target lease', async () => {
  const store = new MemoryMaestroStore({
    projectSlug: PHASE_TWO_TEST_DEFAULTS.projectSlug,
  });
  const result = await runPhaseTwoSwitchTest({ store });

  assert.equal(result.transferCommitted, true);
  assert.equal(result.handoffStatus, 'COMPLETE');
  assert.equal(result.targetCoordinator, 'claude');
  assert.equal(result.targetLeaseReleased, true);
  assert.equal(result.activeLeaseAfterTest, null);
  assert.equal(store.activeLease, null);
  assert.equal(store.leaseHistory.length, 2);
  assert.equal(store.leaseHistory[0].status, 'TRANSFERRED');
  assert.equal(store.leaseHistory[1].status, 'RELEASED');
});

test('isolated Phase Two switch test is safely replayable after completion', async () => {
  const store = new MemoryMaestroStore({
    projectSlug: PHASE_TWO_TEST_DEFAULTS.projectSlug,
  });
  await runPhaseTwoSwitchTest({ store });
  const replay = await runPhaseTwoSwitchTest({ store });

  assert.deepEqual(replay.replayed, {
    acquire: true,
    checkpoint: true,
    transfer: true,
    release: true,
  });
  assert.equal(store.leaseHistory.length, 2);
  assert.equal(store.activeLease, null);
});

test('isolated Phase Two switch test rejects a non-test project slug', async () => {
  const store = new MemoryMaestroStore({ projectSlug: 'production' });
  await assert.rejects(
    runPhaseTwoSwitchTest({ store, projectSlug: 'production' }),
    /must start with "helmion-phase-two-"/,
  );
});
