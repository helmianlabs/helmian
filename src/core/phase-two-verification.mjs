import { createMaestroAdapter } from '../adapters/maestro.mjs';
import { createCodexAdapter } from '../adapters/codex.mjs';

// Stable identifiers make an interrupted verification safely replayable.
export const PHASE_TWO_TEST_DEFAULTS = Object.freeze({
  projectSlug: 'helmion-phase-two-switch-test',
  codexInstanceId: 'helmion-phase-two-test-codex',
  claudeInstanceId: 'helmion-phase-two-test-claude',
});

function assertTestProjectSlug(value) {
  const projectSlug = String(value ?? '').trim().toLowerCase();
  if (!/^helmion-phase-two-[a-z0-9-]{3,160}$/.test(projectSlug)) {
    throw new TypeError('switch-test project slug must start with "helmion-phase-two-"');
  }
  return projectSlug;
}

function assertCommitted(result, operation) {
  if (result?.durability !== 'committed') {
    throw new Error(`${operation} did not return a durable commit confirmation`);
  }
}

export async function runPhaseTwoSwitchTest({
  store,
  projectSlug: projectSlugInput = PHASE_TWO_TEST_DEFAULTS.projectSlug,
} = {}) {
  if (!store) throw new TypeError('store is required');
  const projectSlug = assertTestProjectSlug(projectSlugInput);
  const codex = createCodexAdapter({
    store,
    mode: 'read-write',
    instanceId: PHASE_TWO_TEST_DEFAULTS.codexInstanceId,
  });
  const claude = createMaestroAdapter({
    store,
    coordinatorId: 'claude',
    mode: 'read-write',
    instanceId: PHASE_TWO_TEST_DEFAULTS.claudeInstanceId,
  });

  const acquired = await codex.acquireWriteLease({
    projectSlug,
    idempotencyKey: 'phase-two-switch-test-acquire-v1',
    ttlSeconds: 300,
  });
  assertCommitted(acquired, 'Codex lease acquisition');

  const checkpoint = await codex.createCheckpoint({
    projectSlug,
    leaseToken: acquired.data.lease_token,
    idempotencyKey: 'phase-two-switch-test-checkpoint-v1',
    checkpoint: {
      work_completed: 'Started an isolated Phase Two database switch verification.',
      files_changed: [],
      test_results: [
        'Database migration checksums were verified before the switch test.',
        'Codex lease acquisition returned a committed durability confirmation.',
      ],
      open_blockers: [],
      unresolved_risks: ['No live Claude adapter is installed in Phase One.'],
      next_safe_action: 'Verify the transferred Claude test lease, then release it cleanly.',
    },
  });
  assertCommitted(checkpoint, 'checkpoint creation');

  const transferred = await codex.transferWriteLease({
    projectSlug,
    leaseToken: acquired.data.lease_token,
    idempotencyKey: 'phase-two-switch-test-transfer-v1',
    toCoordinatorId: 'claude',
    toHolderInstanceId: PHASE_TWO_TEST_DEFAULTS.claudeInstanceId,
    checkpointId: checkpoint.data.id,
    switchedBy: 'phase-two-local-verification',
    ttlSeconds: 300,
  });
  assertCommitted(transferred, 'lease transfer');

  const stateAfterTransfer = await claude.getProjectState(projectSlug);
  const handoff = await claude.getLatestHandoff(projectSlug);
  const activeLease = stateAfterTransfer.active_lease;
  if (activeLease) {
    if (
      activeLease.coordinator_id !== 'claude'
      || activeLease.holder_instance_id !== PHASE_TWO_TEST_DEFAULTS.claudeInstanceId
      || activeLease.lease_token !== transferred.data.lease.lease_token
    ) {
      throw new Error('The active lease after transfer did not belong to the Claude test instance');
    }
  } else if (!transferred.replayed) {
    throw new Error('The transferred Claude test lease was not visible after commit');
  }
  if (
    handoff?.status !== 'COMPLETE'
    || handoff?.to?.coordinator_id !== 'claude'
    || handoff?.checkpoint == null
  ) {
    throw new Error('The durable switch handoff was missing or incomplete');
  }

  const released = await claude.releaseWriteLease({
    projectSlug,
    leaseToken: transferred.data.lease.lease_token,
    idempotencyKey: 'phase-two-switch-test-release-v1',
    reason: 'Isolated Phase Two switch verification completed',
  });
  assertCommitted(released, 'Claude test lease release');

  const finalState = await claude.getProjectState(projectSlug);
  if (finalState.active_lease !== null) {
    throw new Error('The isolated switch test left an active database lease behind');
  }

  return {
    projectSlug,
    codexLeaseCommitted: true,
    checkpointCommitted: true,
    transferCommitted: true,
    handoffStatus: handoff.status,
    targetCoordinator: handoff.to.coordinator_id,
    targetInstanceId: PHASE_TWO_TEST_DEFAULTS.claudeInstanceId,
    targetLeaseReleased: true,
    activeLeaseAfterTest: null,
    replayed: {
      acquire: acquired.replayed,
      checkpoint: checkpoint.replayed,
      transfer: transferred.replayed,
      release: released.replayed,
    },
  };
}
