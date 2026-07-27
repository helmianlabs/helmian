import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexAdapter } from '../src/adapters/codex.mjs';
import { createMaestroAdapter } from '../src/adapters/maestro.mjs';
import {
  IdempotencyConflictError,
  LeaseConflictError,
  ReadOnlyAdapterError,
  operationFingerprint,
} from '../src/core/maestro.mjs';
import { DurabilityConfirmationError } from '../src/core/operation-policy.mjs';
import { codexToolsForMode } from '../src/mcp/codex-server.mjs';
import { MemoryMaestroStore } from '../test-support/memory-maestro-store.mjs';

const checkpoint = {
  work_completed: 'Added the Phase One Maestro kernel',
  files_changed: ['src/core/maestro.mjs'],
  test_results: ['node --test: passed'],
  open_blockers: [],
  unresolved_risks: ['Live Neon migration has not been applied'],
  next_safe_action: 'Review and apply the migration on a Neon development branch',
};

test('operation fingerprints are deterministic across object key order', () => {
  assert.equal(
    operationFingerprint('ACQUIRE_LEASE', { projectSlug: 'p', ttlSeconds: 900 }),
    operationFingerprint('ACQUIRE_LEASE', { ttlSeconds: 900, projectSlug: 'p' }),
  );
});

test('normal switch creates a checkpoint, transfers the only lease, and generates a handoff', async () => {
  const store = new MemoryMaestroStore();
  const codex = createCodexAdapter({
    store,
    mode: 'read-write',
    instanceId: 'codex-session-1',
  });

  const acquired = await codex.acquireWriteLease({
    projectSlug: 'project-a',
    idempotencyKey: 'acquire-codex-001',
  });
  const saved = await codex.createCheckpoint({
    projectSlug: 'project-a',
    leaseToken: acquired.data.lease_token,
    idempotencyKey: 'checkpoint-codex-001',
    checkpoint,
  });
  const switched = await codex.transferWriteLease({
    projectSlug: 'project-a',
    leaseToken: acquired.data.lease_token,
    idempotencyKey: 'switch-codex-claude-001',
    toCoordinatorId: 'claude',
    toHolderInstanceId: 'claude-session-1',
    checkpointId: saved.data.id,
    switchedBy: 'local-user',
  });

  assert.equal(switched.durability, 'committed');
  assert.equal(switched.data.handoff.status, 'COMPLETE');
  assert.equal(switched.data.handoff.checkpoint.next_safe_action, checkpoint.next_safe_action);
  assert.equal(switched.data.lease.coordinator_id, 'claude');
  assert.equal(store.leaseHistory.filter((lease) => lease.status === 'ACTIVE').length, 1);

  const claude = createMaestroAdapter({
    store,
    coordinatorId: 'claude',
    mode: 'read-write',
    instanceId: 'claude-session-1',
  });
  const state = await claude.getProjectState('project-a');
  assert.equal(state.active_lease.lease_token, switched.data.lease.lease_token);
  assert.equal((await claude.getLatestHandoff('project-a')).to.coordinator_id, 'claude');
  assert.equal(
    claude.evaluateHandoffOperation({
      handoff: switched.data.handoff,
      operation: { migration: true },
    }).allowed,
    false,
  );
});

test('concurrent lease contenders cannot both become active', async () => {
  const store = new MemoryMaestroStore();
  const codex = createCodexAdapter({
    store,
    mode: 'read-write',
    instanceId: 'codex-session-1',
  });
  const claude = createMaestroAdapter({
    store,
    coordinatorId: 'claude',
    mode: 'read-write',
    instanceId: 'claude-session-1',
  });

  const outcomes = await Promise.allSettled([
    codex.acquireWriteLease({
      projectSlug: 'project-a',
      idempotencyKey: 'concurrent-codex-001',
    }),
    claude.acquireWriteLease({
      projectSlug: 'project-a',
      idempotencyKey: 'concurrent-claude-001',
    }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
  assert.ok(rejected.reason instanceof LeaseConflictError);
  assert.equal(store.leaseHistory.filter((lease) => lease.status === 'ACTIVE').length, 1);
});

test('missing checkpoint produces an explicit incomplete warning and gates high-risk work', async () => {
  const store = new MemoryMaestroStore();
  const codex = createCodexAdapter({
    store,
    mode: 'read-write',
    instanceId: 'codex-session-1',
  });
  const acquired = await codex.acquireWriteLease({
    projectSlug: 'project-a',
    idempotencyKey: 'acquire-incomplete-001',
  });
  const switched = await codex.transferWriteLease({
    projectSlug: 'project-a',
    leaseToken: acquired.data.lease_token,
    idempotencyKey: 'switch-incomplete-001',
    toCoordinatorId: 'claude',
    toHolderInstanceId: 'claude-session-2',
    incompleteReason: 'The prior coordinator stopped before it could commit a checkpoint.',
    switchedBy: 'local-user',
  });

  const handoff = switched.data.handoff;
  assert.equal(handoff.status, 'INCOMPLETE');
  assert.equal(handoff.requires_human_confirmation, true);
  assert.match(handoff.warning, /^INCOMPLETE HANDOFF:/);
  assert.equal(
    codex.evaluateHandoffOperation({ handoff, operation: { migration: true } }).allowed,
    false,
  );
  assert.equal(
    codex.evaluateHandoffOperation({ handoff, operation: { kind: 'scoped-read' } }).allowed,
    true,
  );
});

test('Codex adapter defaults to read-only and never calls a governance writer', async () => {
  const store = new MemoryMaestroStore();
  const codex = createCodexAdapter({ store });
  const state = await codex.getProjectState('project-a');
  assert.equal(state.project.slug, 'project-a');
  await assert.rejects(
    codex.acquireWriteLease({
      projectSlug: 'project-a',
      idempotencyKey: 'read-only-attempt-001',
    }),
    ReadOnlyAdapterError,
  );
  assert.equal(store.writeCalls, 0);
});

test('read-only Codex MCP surface does not advertise governance write tools', () => {
  const readOnlyNames = codexToolsForMode().map((tool) => tool.name);
  assert.deepEqual(readOnlyNames, [
    'helmion_maestro_project_state',
    'helmion_maestro_latest_handoff',
  ]);
  const readWriteNames = codexToolsForMode('read-write').map((tool) => tool.name);
  assert.ok(readWriteNames.includes('helmion_maestro_transfer_lease'));
  assert.ok(readWriteNames.includes('helmion_maestro_record_human_confirmation'));
  assert.ok(readWriteNames.includes('helmion_maestro_authorize_handoff_action'));
});

test('idempotent retries return the original lease and key reuse with new input is rejected', async () => {
  const store = new MemoryMaestroStore();
  const codex = createCodexAdapter({
    store,
    mode: 'read-write',
    instanceId: 'codex-session-1',
  });
  const request = {
    projectSlug: 'project-a',
    idempotencyKey: 'retry-acquire-001',
    ttlSeconds: 900,
  };
  const first = await codex.acquireWriteLease(request);
  const replay = await codex.acquireWriteLease(request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.data.lease_token, first.data.lease_token);
  assert.equal(store.leaseHistory.length, 1);
  await assert.rejects(
    codex.acquireWriteLease({ ...request, ttlSeconds: 1200 }),
    IdempotencyConflictError,
  );
});

test('lease release is durable and permits a later coordinator to acquire', async () => {
  const store = new MemoryMaestroStore();
  const codex = createCodexAdapter({
    store,
    mode: 'read-write',
    instanceId: 'codex-session-1',
  });
  const acquired = await codex.acquireWriteLease({
    projectSlug: 'project-a',
    idempotencyKey: 'release-acquire-001',
  });
  const released = await codex.releaseWriteLease({
    projectSlug: 'project-a',
    leaseToken: acquired.data.lease_token,
    idempotencyKey: 'release-lease-001',
    reason: 'Work paused after a clean checkpoint',
  });
  assert.equal(released.durability, 'committed');
  assert.equal(released.data.status, 'RELEASED');

  const claude = createMaestroAdapter({
    store,
    coordinatorId: 'claude',
    mode: 'read-write',
    instanceId: 'claude-session-1',
  });
  const next = await claude.acquireWriteLease({
    projectSlug: 'project-a',
    idempotencyKey: 'release-claude-acquire-001',
  });
  assert.equal(next.data.coordinator_id, 'claude');
});

test('telemetry fails open while an unconfirmed governance write fails closed', async () => {
  const telemetryStore = new MemoryMaestroStore({ telemetryError: new Error('telemetry offline') });
  const codex = createCodexAdapter({ store: telemetryStore });
  const telemetry = await codex.recordTelemetry({
    projectSlug: 'project-a',
    eventType: 'adapter-health',
  });
  assert.equal(telemetry.failed_open, true);

  const nonDurableStore = {
    async acquireMaestroLease() {
      return { data: { lease_token: 'not-committed' } };
    },
  };
  const writable = createCodexAdapter({
    store: nonDurableStore,
    mode: 'read-write',
    instanceId: 'codex-session-1',
  });
  await assert.rejects(
    writable.acquireWriteLease({
      projectSlug: 'project-a',
      idempotencyKey: 'missing-durability-001',
    }),
    DurabilityConfirmationError,
  );
});
