import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createNeonStore } from '../src/adapters/neon.mjs';
import {
  HUMAN_CONFIRMATION_AUDIENCE,
  HumanConfirmationRequiredError,
  createHumanConfirmationAssertion,
  handoffActionHash,
} from '../src/core/human-confirmation.mjs';

const now = new Date('2026-07-27T04:10:00.000Z');

class ConfirmationPool {
  constructor(publicKey) {
    this.identity = {
      id: 51,
      provider: 'local-owner',
      subject: 'user:troy',
      key_id: 'owner-key-2026-01',
      algorithm: 'Ed25519',
      public_key_pem: publicKey,
    };
    this.lease = {
      id: 12,
      lease_token: '00000000-0000-4000-8000-000000000012',
      project_slug: 'project-a',
      coordinator_id: 'claude',
      holder_instance_id: 'claude-confirmation-test',
      status: 'ACTIVE',
    };
    this.confirmation = null;
    this.operations = new Map();
    this.transactions = [];
  }

  async connect() {
    const pool = this;
    return {
      async query(sql, parameters = []) {
        const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
        if (['begin', 'commit', 'rollback'].includes(normalized)) {
          pool.transactions.push(normalized);
          return { rowCount: 0, rows: [] };
        }
        if (
          normalized.startsWith('select * from helmion.projects')
          && normalized.includes('for update')
        ) {
          return { rowCount: 1, rows: [{ slug: parameters[0] }] };
        }
        if (normalized.startsWith('select operation_type, request_hash, response')) {
          const prior = pool.operations.get(`${parameters[0]}:${parameters[1]}`);
          return prior
            ? { rowCount: 1, rows: [prior] }
            : { rowCount: 0, rows: [] };
        }
        if (normalized.startsWith('insert into helmion.maestro_operations')) {
          pool.operations.set(`${parameters[0]}:${parameters[1]}`, {
            operation_type: parameters[2],
            request_hash: parameters[3],
            response: JSON.parse(parameters[4]),
          });
          return { rowCount: 1, rows: [] };
        }
        if (
          normalized.startsWith('select id from helmion.maestro_handoffs')
          && normalized.includes('to_lease_id')
        ) {
          return parameters[2] === pool.lease.id
            ? { rowCount: 1, rows: [{ id: parameters[0] }] }
            : { rowCount: 0, rows: [] };
        }
        if (normalized.startsWith('select id from helmion.maestro_handoffs')) {
          return { rowCount: 1, rows: [{ id: parameters[0] }] };
        }
        if (normalized.startsWith('select * from helmion.human_identity_keys')) {
          return (
            parameters[0] === pool.identity.provider
            && parameters[1] === pool.identity.subject
            && parameters[2] === pool.identity.key_id
          )
            ? { rowCount: 1, rows: [pool.identity] }
            : { rowCount: 0, rows: [] };
        }
        if (normalized === 'select clock_timestamp() as now') {
          return { rowCount: 1, rows: [{ now }] };
        }
        if (normalized.startsWith('select * from helmion.human_handoff_confirmations')) {
          return (
            pool.confirmation
            && parameters[0] === pool.confirmation.identity_key_id
            && parameters[1] === pool.confirmation.nonce
          )
            ? { rowCount: 1, rows: [pool.confirmation] }
            : { rowCount: 0, rows: [] };
        }
        if (normalized.startsWith('insert into helmion.human_handoff_confirmations')) {
          pool.confirmation = {
            id: 91,
            project_slug: parameters[0],
            handoff_id: String(parameters[1]),
            identity_key_id: parameters[2],
            identity_provider: parameters[3],
            identity_subject: parameters[4],
            identity_key_id_snapshot: parameters[5],
            nonce: parameters[6],
            action_hash: parameters[7],
            action: JSON.parse(parameters[8]),
            claims: JSON.parse(parameters[9]),
            signature: parameters[10],
            assertion_hash: parameters[11],
            issued_at: parameters[12],
            expires_at: parameters[13],
            recorded_at: now,
            consumed_at: null,
            consumed_by_coordinator: null,
            consumed_by_instance: null,
          };
          return { rowCount: 1, rows: [pool.confirmation] };
        }
        if (normalized.startsWith('select * from helmion.maestro_leases')) {
          return (
            parameters[0] === pool.lease.project_slug
            && parameters[1] === pool.lease.lease_token
            && parameters[2] === pool.lease.coordinator_id
            && parameters[3] === pool.lease.holder_instance_id
          )
            ? { rowCount: 1, rows: [pool.lease] }
            : { rowCount: 0, rows: [] };
        }
        if (normalized.startsWith('select c.id from helmion.human_handoff_confirmations')) {
          return pool.confirmation?.consumed_at == null
            ? { rowCount: 1, rows: [{ id: pool.confirmation.id }] }
            : { rowCount: 0, rows: [] };
        }
        if (normalized.startsWith('update helmion.human_handoff_confirmations')) {
          if (!pool.confirmation || pool.confirmation.consumed_at != null) {
            return { rowCount: 0, rows: [] };
          }
          pool.confirmation.consumed_at = now;
          pool.confirmation.consumed_by_coordinator = parameters[1];
          pool.confirmation.consumed_by_instance = parameters[2];
          return { rowCount: 1, rows: [pool.confirmation] };
        }
        throw new Error(`Unexpected confirmation query: ${normalized}`);
      },
      release() {},
    };
  }
}

test('Neon store durably records and atomically consumes one signed confirmation', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pool = new ConfirmationPool(publicKeyPem);
  const store = await createNeonStore(null, { pool });
  const operation = { migration: true, migrationName: '003_human_confirmations.sql' };
  const actionHash = handoffActionHash({
    projectSlug: 'project-a',
    handoffId: 33,
    operation,
  });
  const assertion = createHumanConfirmationAssertion({
    privateKey: privateKeyPem,
    claims: {
      version: 1,
      audience: HUMAN_CONFIRMATION_AUDIENCE,
      provider: pool.identity.provider,
      subject: pool.identity.subject,
      key_id: pool.identity.key_id,
      project_slug: 'project-a',
      handoff_id: 33,
      action_hash: actionHash,
      issued_at: now.toISOString(),
      expires_at: '2026-07-27T04:15:00.000Z',
      nonce: 'neon-confirmation-test',
    },
  });

  const recorded = await store.recordHumanConfirmation({
    projectSlug: 'project-a',
    handoffId: 33,
    operation,
    assertion,
  });
  assert.equal(recorded.durability, 'committed');
  assert.equal(recorded.data.identity.subject, 'user:troy');
  assert.equal(pool.confirmation.consumed_at, null);

  const request = {
    projectSlug: 'project-a',
    handoffId: 33,
    leaseToken: pool.lease.lease_token,
    coordinatorId: pool.lease.coordinator_id,
    holderInstanceId: pool.lease.holder_instance_id,
    idempotencyKey: 'neon-confirm-consume',
    operation,
  };
  const consumed = await store.consumeHumanConfirmation(request);
  assert.equal(consumed.durability, 'committed');
  assert.equal(consumed.data.allowed, true);
  assert.equal(consumed.data.confirmation.consumed_by_instance, pool.lease.holder_instance_id);

  const replay = await store.consumeHumanConfirmation(request);
  assert.equal(replay.replayed, true);
  await assert.rejects(
    store.consumeHumanConfirmation({
      ...request,
      idempotencyKey: 'neon-confirm-second-consume',
    }),
    HumanConfirmationRequiredError,
  );
  assert.equal(pool.transactions.at(-1), 'rollback');
});
