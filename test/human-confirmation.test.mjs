import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createMaestroAdapter } from '../src/adapters/maestro.mjs';
import { createCodexAdapter } from '../src/adapters/codex.mjs';
import {
  HUMAN_CONFIRMATION_AUDIENCE,
  HumanConfirmationError,
  HumanConfirmationRequiredError,
  createHumanConfirmationAssertion,
  handoffActionHash,
  verifyHumanConfirmationAssertion,
} from '../src/core/human-confirmation.mjs';
import { IdempotencyConflictError } from '../src/core/maestro.mjs';
import { MemoryMaestroStore } from '../test-support/memory-maestro-store.mjs';

const nowIso = '2026-07-27T04:10:00.000Z';
const identity = {
  provider: 'local-owner',
  subject: 'user:troy',
  key_id: 'owner-key-2026-01',
};

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

function assertionFor({
  privateKey,
  projectSlug = 'project-a',
  handoffId = 9,
  operation = { migration: true, migrationName: '003_human_confirmations.sql' },
  issuedAt = nowIso,
  expiresAt = '2026-07-27T04:15:00.000Z',
  nonce = 'confirm-migration-003',
} = {}) {
  const actionHash = handoffActionHash({ projectSlug, handoffId, operation });
  return createHumanConfirmationAssertion({
    privateKey,
    claims: {
      version: 1,
      audience: HUMAN_CONFIRMATION_AUDIENCE,
      ...identity,
      project_slug: projectSlug,
      handoff_id: handoffId,
      action_hash: actionHash,
      issued_at: issuedAt,
      expires_at: expiresAt,
      nonce,
    },
  });
}

test('Ed25519 confirmation verifies an exact handoff/action identity and expiry', () => {
  const { publicKey, privateKey } = keys();
  const operation = { authenticationChange: true, route: '/owner/enroll' };
  const assertion = assertionFor({ privateKey, handoffId: 42, operation });
  const actionHash = handoffActionHash({
    projectSlug: 'project-a',
    handoffId: 42,
    operation,
  });
  const verified = verifyHumanConfirmationAssertion({
    assertion,
    trustedIdentity: {
      id: 1,
      ...identity,
      algorithm: 'Ed25519',
      public_key_pem: publicKey,
    },
    expected: { projectSlug: 'project-a', handoffId: 42, actionHash },
    now: nowIso,
  });

  assert.equal(verified.identity.subject, identity.subject);
  assert.equal(verified.claims.action_hash, actionHash);
  assert.match(verified.assertionHash, /^[0-9a-f]{64}$/);
});

test('confirmation rejects tampering, wrong action binding, and expiration', () => {
  const { publicKey, privateKey } = keys();
  const assertion = assertionFor({ privateKey });
  const trustedIdentity = {
    id: 1,
    ...identity,
    algorithm: 'Ed25519',
    public_key_pem: publicKey,
  };
  const actionHash = assertion.claims.action_hash;

  assert.throws(
    () => verifyHumanConfirmationAssertion({
      assertion,
      trustedIdentity,
      expected: { projectSlug: 'project-a', handoffId: 10, actionHash },
      now: nowIso,
    }),
    /not bound to this project, handoff, and action/,
  );
  assert.throws(
    () => verifyHumanConfirmationAssertion({
      assertion: {
        ...assertion,
        claims: { ...assertion.claims, subject: 'user:attacker' },
      },
      trustedIdentity,
      expected: { projectSlug: 'project-a', handoffId: 9, actionHash },
      now: nowIso,
    }),
    HumanConfirmationError,
  );
  const tamperedSignature = `${
    assertion.signature.startsWith('A') ? 'B' : 'A'
  }${assertion.signature.slice(1)}`;
  assert.throws(
    () => verifyHumanConfirmationAssertion({
      assertion: { ...assertion, signature: tamperedSignature },
      trustedIdentity,
      expected: { projectSlug: 'project-a', handoffId: 9, actionHash },
      now: nowIso,
    }),
    /signature verification failed/,
  );
  assert.throws(
    () => verifyHumanConfirmationAssertion({
      assertion,
      trustedIdentity,
      expected: { projectSlug: 'project-a', handoffId: 9, actionHash },
      now: '2026-07-27T04:16:00.000Z',
    }),
    /expired/,
  );
  assert.throws(
    () => verifyHumanConfirmationAssertion({
      assertion: assertionFor({
        privateKey,
        expiresAt: '2026-07-27T04:30:00.000Z',
        nonce: 'confirmation-too-long',
      }),
      trustedIdentity,
      expected: { projectSlug: 'project-a', handoffId: 9, actionHash },
      now: nowIso,
    }),
    /lifetime must be at most 900 seconds/,
  );
});

async function incompleteHandoffFixture({ now = () => new Date(nowIso) } = {}) {
  const { publicKey, privateKey } = keys();
  const store = new MemoryMaestroStore({
    now,
    humanIdentityKeys: [{
      id: 71,
      ...identity,
      public_key_pem: publicKey,
    }],
  });
  const codex = createCodexAdapter({
    store,
    mode: 'read-write',
    instanceId: 'codex-session-confirmation',
  });
  const acquired = await codex.acquireWriteLease({
    projectSlug: 'project-a',
    idempotencyKey: 'confirm-test-acquire',
  });
  const transfer = await codex.transferWriteLease({
    projectSlug: 'project-a',
    leaseToken: acquired.data.lease_token,
    idempotencyKey: 'confirm-test-transfer',
    toCoordinatorId: 'claude',
    toHolderInstanceId: 'claude-session-confirmation',
    incompleteReason: 'Source coordinator stopped before checkpoint commit.',
    switchedBy: 'local-user',
  });
  const claude = createMaestroAdapter({
    store,
    coordinatorId: 'claude',
    mode: 'read-write',
    instanceId: 'claude-session-confirmation',
  });
  return { store, codex, claude, privateKey, transfer };
}

test('durable confirmation is consumed once by the exact handoff target lease', async () => {
  const fixture = await incompleteHandoffFixture();
  const handoff = fixture.transfer.data.handoff;
  const operation = { migration: true, migrationName: '003_human_confirmations.sql' };
  assert.equal(
    fixture.codex.evaluateHandoffOperation({ handoff, operation }).allowed,
    false,
  );

  const assertion = assertionFor({
    privateKey: fixture.privateKey,
    handoffId: handoff.id,
    operation,
  });
  const recorded = await fixture.claude.recordHumanConfirmation({
    projectSlug: 'project-a',
    handoffId: handoff.id,
    operation,
    assertion,
  });
  assert.equal(recorded.durability, 'committed');
  assert.equal(recorded.replayed, false);
  assert.equal(recorded.data.identity.subject, identity.subject);

  const request = {
    projectSlug: 'project-a',
    handoffId: handoff.id,
    leaseToken: fixture.transfer.data.lease.lease_token,
    idempotencyKey: 'confirm-test-consume',
    operation,
  };
  const authorized = await fixture.claude.authorizeHandoffOperation(request);
  assert.equal(authorized.durability, 'committed');
  assert.equal(authorized.data.allowed, true);
  assert.equal(authorized.data.tier, 'B');
  assert.equal(
    authorized.data.confirmation.consumed_by_instance,
    'claude-session-confirmation',
  );

  const replay = await fixture.claude.authorizeHandoffOperation(request);
  assert.equal(replay.replayed, true);
  await assert.rejects(
    fixture.claude.authorizeHandoffOperation({
      ...request,
      idempotencyKey: 'confirm-test-second-consume',
    }),
    HumanConfirmationRequiredError,
  );
});

test('confirmation cannot authorize another action and expires before consumption', async () => {
  let currentTime = new Date(nowIso);
  const fixture = await incompleteHandoffFixture({ now: () => currentTime });
  const handoffId = fixture.transfer.data.handoff.id;
  const confirmedOperation = { migration: true, migrationName: '003_human_confirmations.sql' };
  await fixture.claude.recordHumanConfirmation({
    projectSlug: 'project-a',
    handoffId,
    operation: confirmedOperation,
    assertion: assertionFor({
      privateKey: fixture.privateKey,
      handoffId,
      operation: confirmedOperation,
      expiresAt: '2026-07-27T04:11:00.000Z',
    }),
  });

  await assert.rejects(
    fixture.claude.authorizeHandoffOperation({
      projectSlug: 'project-a',
      handoffId,
      leaseToken: fixture.transfer.data.lease.lease_token,
      idempotencyKey: 'confirm-test-wrong-action',
      operation: { authenticationChange: true },
    }),
    HumanConfirmationRequiredError,
  );
  currentTime = new Date('2026-07-27T04:12:00.000Z');
  await assert.rejects(
    fixture.claude.authorizeHandoffOperation({
      projectSlug: 'project-a',
      handoffId,
      leaseToken: fixture.transfer.data.lease.lease_token,
      idempotencyKey: 'confirm-test-expired',
      operation: confirmedOperation,
    }),
    HumanConfirmationRequiredError,
  );
});

test('confirmation nonce is idempotent only for the identical signed assertion', async () => {
  const fixture = await incompleteHandoffFixture();
  const handoffId = fixture.transfer.data.handoff.id;
  const operation = { migration: true, migrationName: '003_human_confirmations.sql' };
  const assertion = assertionFor({
    privateKey: fixture.privateKey,
    handoffId,
    operation,
    nonce: 'confirmation-nonce-retry',
  });
  await fixture.claude.recordHumanConfirmation({
    projectSlug: 'project-a',
    handoffId,
    operation,
    assertion,
  });
  const replay = await fixture.claude.recordHumanConfirmation({
    projectSlug: 'project-a',
    handoffId,
    operation,
    assertion,
  });
  assert.equal(replay.replayed, true);

  const changedOperation = { authenticationChange: true };
  await assert.rejects(
    fixture.claude.recordHumanConfirmation({
      projectSlug: 'project-a',
      handoffId,
      operation: changedOperation,
      assertion: assertionFor({
        privateKey: fixture.privateKey,
        handoffId,
        operation: changedOperation,
        nonce: 'confirmation-nonce-retry',
      }),
    }),
    IdempotencyConflictError,
  );
});

test('revoking a trusted identity key invalidates an unused confirmation', async () => {
  const fixture = await incompleteHandoffFixture();
  const handoffId = fixture.transfer.data.handoff.id;
  const operation = { migration: true, migrationName: '003_human_confirmations.sql' };
  await fixture.claude.recordHumanConfirmation({
    projectSlug: 'project-a',
    handoffId,
    operation,
    assertion: assertionFor({
      privateKey: fixture.privateKey,
      handoffId,
      operation,
      nonce: 'confirmation-before-revocation',
    }),
  });
  fixture.store.humanIdentityKeys[0].active = false;
  fixture.store.humanIdentityKeys[0].revoked_at = nowIso;
  await assert.rejects(
    fixture.claude.authorizeHandoffOperation({
      projectSlug: 'project-a',
      handoffId,
      leaseToken: fixture.transfer.data.lease.lease_token,
      idempotencyKey: 'confirmation-after-revocation',
      operation,
    }),
    HumanConfirmationRequiredError,
  );
});

test('read-only adapters cannot record or consume human confirmations', async () => {
  const store = new MemoryMaestroStore();
  const codex = createCodexAdapter({ store });
  await assert.rejects(
    codex.recordHumanConfirmation({}),
    /read-only mode/,
  );
  await assert.rejects(
    codex.authorizeHandoffOperation({}),
    /read-only mode/,
  );
  assert.equal(store.writeCalls, 0);
});
