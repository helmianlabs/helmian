import {
  HumanConfirmationRequiredError,
  handoffActionHash,
  normalizeHumanConfirmationClaims,
  verifyHumanConfirmationAssertion,
} from '../src/core/human-confirmation.mjs';
import { classifyOperation } from '../src/core/governance.mjs';
import {
  IdempotencyConflictError,
  LeaseAuthorizationError,
  LeaseConflictError,
  buildMaestroHandoff,
  canonicalJson,
  normalizeCheckpoint,
  operationFingerprint,
} from '../src/core/maestro.mjs';

function clone(value) {
  return JSON.parse(canonicalJson(value));
}

function publicConfirmation(row) {
  return {
    id: row.id,
    project_slug: row.project_slug,
    handoff_id: row.handoff_id,
    identity: {
      provider: row.identity_provider,
      subject: row.identity_subject,
      key_id: row.identity_key_id_snapshot,
    },
    action_hash: row.action_hash,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    recorded_at: row.recorded_at,
    consumed_at: row.consumed_at,
    consumed_by_coordinator: row.consumed_by_coordinator,
    consumed_by_instance: row.consumed_by_instance,
  };
}

export class MemoryMaestroStore {
  constructor({
    projectSlug = 'project-a',
    telemetryError = null,
    humanIdentityKeys = [],
    now = () => new Date('2026-07-27T04:10:00.000Z'),
  } = {}) {
    this.projectSlug = projectSlug;
    this.telemetryError = telemetryError;
    this.activeLease = null;
    this.leaseHistory = [];
    this.checkpoints = [];
    this.handoffs = [];
    this.operations = new Map();
    this.humanIdentityKeys = humanIdentityKeys.map((identity, index) => ({
      id: identity.id ?? index + 1,
      algorithm: 'Ed25519',
      active: true,
      revoked_at: null,
      valid_from: '2026-07-27T00:00:00.000Z',
      valid_until: null,
      ...identity,
    }));
    this.humanConfirmations = [];
    this.now = now;
    this.sequence = 0;
    this.tail = Promise.resolve();
    this.writeCalls = 0;
    this.sharedState = {
      blockers: [{ id: 7, severity: 'high', description: 'Verify the migration' }],
      context: [{ key: 'next_release', value: 'phase-one' }],
      rules: [{ id: 3, severity: 'flag', pattern: 'unsafe' }],
    };
  }

  async exclusive(work) {
    let unlock;
    const previous = this.tail;
    this.tail = new Promise((resolve) => { unlock = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      unlock();
    }
  }

  committed(data, replayed = false) {
    return { durability: 'committed', replayed, data: clone(data) };
  }

  async idempotent(operationType, input, work) {
    return this.exclusive(async () => {
      this.writeCalls += 1;
      const key = `${input.projectSlug}:${input.idempotencyKey}`;
      const request = { ...input };
      delete request.idempotencyKey;
      const requestHash = operationFingerprint(operationType, request);
      const prior = this.operations.get(key);
      if (prior) {
        if (prior.operationType !== operationType || prior.requestHash !== requestHash) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        return this.committed(prior.data, true);
      }
      const data = await work();
      this.operations.set(key, { operationType, requestHash, data: clone(data) });
      return this.committed(data);
    });
  }

  requireProject(projectSlug) {
    if (projectSlug !== this.projectSlug) throw new Error(`Project ${projectSlug} was not found`);
  }

  requireLease(input) {
    const lease = this.activeLease;
    if (
      !lease
      || lease.lease_token !== input.leaseToken
      || lease.coordinator_id !== input.coordinatorId
      || lease.holder_instance_id !== input.holderInstanceId
    ) {
      throw new LeaseAuthorizationError('Caller does not hold the active lease');
    }
    return lease;
  }

  async getMaestroProjectState(projectSlug) {
    this.requireProject(projectSlug);
    return {
      project: { slug: this.projectSlug },
      active_lease: clone(this.activeLease),
      latest_checkpoint: clone(this.checkpoints.at(-1) ?? null),
      latest_handoff: clone(this.handoffs.at(-1) ?? null),
    };
  }

  async getLatestMaestroHandoff(projectSlug) {
    this.requireProject(projectSlug);
    return clone(this.handoffs.at(-1) ?? null);
  }

  async acquireMaestroLease(input) {
    this.requireProject(input.projectSlug);
    return this.idempotent('ACQUIRE_LEASE', input, async () => {
      if (this.activeLease) {
        throw new LeaseConflictError(
          `Project ${input.projectSlug} already has an active lease`,
          { coordinatorId: this.activeLease.coordinator_id },
        );
      }
      const lease = {
        id: ++this.sequence,
        lease_token: `00000000-0000-4000-8000-${String(this.sequence).padStart(12, '0')}`,
        project_slug: input.projectSlug,
        coordinator_id: input.coordinatorId,
        holder_instance_id: input.holderInstanceId,
        status: 'ACTIVE',
        acquired_at: '2026-07-27T04:00:00.000Z',
        expires_at: '2026-07-27T04:15:00.000Z',
      };
      this.activeLease = lease;
      this.leaseHistory.push(lease);
      return lease;
    });
  }

  async createProjectCheckpoint(input) {
    this.requireProject(input.projectSlug);
    const checkpoint = normalizeCheckpoint(input.checkpoint);
    return this.idempotent('CREATE_CHECKPOINT', { ...input, checkpoint }, async () => {
      const lease = this.requireLease(input);
      const record = {
        id: ++this.sequence,
        project_slug: input.projectSlug,
        lease_id: lease.id,
        coordinator_id: input.coordinatorId,
        ...checkpoint,
        created_at: '2026-07-27T04:05:00.000Z',
      };
      this.checkpoints.push(record);
      return record;
    });
  }

  async releaseMaestroLease(input) {
    this.requireProject(input.projectSlug);
    return this.idempotent('RELEASE_LEASE', input, async () => {
      const lease = this.requireLease(input);
      lease.status = 'RELEASED';
      lease.closed_at = '2026-07-27T04:06:00.000Z';
      lease.close_reason = input.reason;
      this.activeLease = null;
      return lease;
    });
  }

  async transferMaestroLease(input) {
    this.requireProject(input.projectSlug);
    return this.idempotent('TRANSFER_LEASE', input, async () => {
      const fromLease = this.requireLease(input);
      const checkpoint = input.checkpointId == null
        ? null
        : this.checkpoints.find(
          (candidate) => (
            String(candidate.id) === String(input.checkpointId)
            && candidate.lease_id === fromLease.id
          ),
        );
      if (input.checkpointId != null && !checkpoint) {
        throw new Error(`Checkpoint ${input.checkpointId} does not belong to the active lease`);
      }
      if (!checkpoint && !input.incompleteReason) {
        throw new TypeError('checkpointId or incompleteReason is required');
      }

      fromLease.status = 'TRANSFERRED';
      fromLease.closed_at = '2026-07-27T04:07:00.000Z';
      const toLease = {
        id: ++this.sequence,
        lease_token: `00000000-0000-4000-8000-${String(this.sequence).padStart(12, '0')}`,
        project_slug: input.projectSlug,
        coordinator_id: input.toCoordinatorId,
        holder_instance_id: input.toHolderInstanceId,
        status: 'ACTIVE',
        acquired_at: '2026-07-27T04:07:00.000Z',
        expires_at: '2026-07-27T04:22:00.000Z',
      };
      this.activeLease = toLease;
      this.leaseHistory.push(toLease);
      const payload = buildMaestroHandoff({
        projectSlug: input.projectSlug,
        fromLease,
        toLease,
        checkpoint,
        sharedState: this.sharedState,
        switchedBy: input.switchedBy,
        switchedAt: '2026-07-27T04:07:00.000Z',
        incompleteReason: input.incompleteReason,
      });
      const handoff = { id: ++this.sequence, ...payload };
      this.handoffs.push(handoff);
      return { lease: toLease, handoff };
    });
  }

  async recordHumanConfirmation(input) {
    this.requireProject(input.projectSlug);
    this.writeCalls += 1;
    const operation = clone(input.operation);
    if (classifyOperation(operation).tier !== 'B') {
      throw new TypeError('Human confirmations are accepted only for Tier B actions');
    }
    const handoff = this.handoffs.find(
      (candidate) => String(candidate.id) === String(input.handoffId),
    );
    if (!handoff) throw new Error(`Handoff ${input.handoffId} was not found`);
    const actionHash = handoffActionHash({
      projectSlug: input.projectSlug,
      handoffId: input.handoffId,
      operation,
    });
    const claims = normalizeHumanConfirmationClaims(input.assertion?.claims);
    const identity = this.humanIdentityKeys.find((candidate) => (
      candidate.provider === claims.provider
      && candidate.subject === claims.subject
      && candidate.key_id === claims.key_id
      && candidate.active
      && !candidate.revoked_at
    ));
    if (!identity) {
      throw new HumanConfirmationRequiredError(
        'The signed confirmer does not have an active trusted identity key',
      );
    }
    const verified = verifyHumanConfirmationAssertion({
      assertion: input.assertion,
      trustedIdentity: identity,
      expected: {
        projectSlug: input.projectSlug,
        handoffId: input.handoffId,
        actionHash,
      },
      now: this.now(),
    });
    const prior = this.humanConfirmations.find(
      (candidate) => (
        candidate.identity_key_id === identity.id
        && candidate.nonce === verified.claims.nonce
      ),
    );
    if (prior) {
      if (prior.assertion_hash !== verified.assertionHash) {
        throw new IdempotencyConflictError(verified.claims.nonce);
      }
      return this.committed(publicConfirmation(prior), true);
    }
    const confirmation = {
      id: ++this.sequence,
      project_slug: input.projectSlug,
      handoff_id: String(input.handoffId),
      identity_key_id: identity.id,
      identity_provider: verified.identity.provider,
      identity_subject: verified.identity.subject,
      identity_key_id_snapshot: verified.identity.key_id,
      nonce: verified.claims.nonce,
      action_hash: actionHash,
      action: operation,
      claims: verified.claims,
      assertion_hash: verified.assertionHash,
      issued_at: verified.claims.issued_at,
      expires_at: verified.claims.expires_at,
      recorded_at: this.now().toISOString(),
      consumed_at: null,
      consumed_by_coordinator: null,
      consumed_by_instance: null,
    };
    this.humanConfirmations.push(confirmation);
    return this.committed(publicConfirmation(confirmation));
  }

  async consumeHumanConfirmation(input) {
    this.requireProject(input.projectSlug);
    const operation = clone(input.operation);
    if (classifyOperation(operation).tier !== 'B') {
      throw new TypeError('One-time human confirmation is required only for Tier B actions');
    }
    const actionHash = handoffActionHash({
      projectSlug: input.projectSlug,
      handoffId: input.handoffId,
      operation,
    });
    return this.idempotent('CONSUME_CONFIRMATION', input, async () => {
      const lease = this.requireLease(input);
      const handoff = this.handoffs.find(
        (candidate) => String(candidate.id) === String(input.handoffId),
      );
      if (!handoff || handoff.to.lease_token !== lease.lease_token) {
        throw new HumanConfirmationRequiredError(
          'The handoff does not target the active lease held by this coordinator',
        );
      }
      const nowMs = this.now().getTime();
      const confirmation = this.humanConfirmations
        .filter((candidate) => {
          const key = this.humanIdentityKeys.find(
            (identity) => identity.id === candidate.identity_key_id,
          );
          return (
            candidate.project_slug === input.projectSlug
            && String(candidate.handoff_id) === String(input.handoffId)
            && candidate.action_hash === actionHash
            && canonicalJson(candidate.action) === canonicalJson(operation)
            && candidate.consumed_at == null
            && new Date(candidate.expires_at).getTime() > nowMs
            && key?.active
            && !key?.revoked_at
          );
        })
        .sort((left, right) => (
          new Date(left.expires_at).getTime() - new Date(right.expires_at).getTime()
          || left.id - right.id
        ))[0];
      if (!confirmation) {
        throw new HumanConfirmationRequiredError(
          'No matching unexpired unused human confirmation is available',
        );
      }
      confirmation.consumed_at = this.now().toISOString();
      confirmation.consumed_by_coordinator = input.coordinatorId;
      confirmation.consumed_by_instance = input.holderInstanceId;
      return {
        allowed: true,
        tier: 'B',
        reasons: classifyOperation(operation).reasons,
        action_hash: actionHash,
        confirmation: publicConfirmation(confirmation),
      };
    });
  }

  async recordTelemetry() {
    if (this.telemetryError) throw this.telemetryError;
    return { ok: true, recorded: true };
  }
}
