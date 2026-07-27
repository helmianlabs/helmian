import test from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertConfirmedPassphrase,
  initializeOwnerKey,
  inspectOwnerKey,
  restoreOwnerKey,
  reviewAndSignOwnerConfirmation,
} from '../src/windows/owner-key-store.mjs';
import { verifyHumanConfirmationAssertion } from '../src/core/human-confirmation.mjs';

const testPassphrase = 'correct horse battery staple';
const approvalPassphrase = 'local owner signing phrase';
const fixedNow = new Date('2026-07-27T12:00:00.000Z');

async function pilotKeyFixture() {
  const root = await mkdtemp(join(tmpdir(), 'helmion-owner-key-test-'));
  const keyDirectory = join(root, 'owner-keys');
  const publicOutput = join(root, 'owner-public.json');
  const recoveryOutput = join(root, 'recovery', 'owner-recovery.json');
  const created = await initializeOwnerKey({
    provider: 'windows-pilot',
    subject: 'user:test-owner',
    keyDirectory,
    publicOutput,
    recoveryOutput,
    approvalPassphrase: Buffer.from(approvalPassphrase),
    recoveryPassphrase: Buffer.from(testPassphrase),
    workspaceRoot: process.cwd(),
    now: fixedNow,
    scryptN: 4096,
  });
  return { root, keyDirectory, publicOutput, recoveryOutput, created };
}

test('owner-key init writes only DPAPI ciphertext, public enrollment, and encrypted recovery', async () => {
  const fixture = await pilotKeyFixture();
  try {
    const localText = await readFile(fixture.created.local_key_path, 'utf8');
    const publicRecord = JSON.parse(await readFile(fixture.publicOutput, 'utf8'));
    const recoveryText = await readFile(fixture.recoveryOutput, 'utf8');
    const localRecord = JSON.parse(localText);

    assert.equal(
      localRecord.protection,
      'windows-dpapi-current-user+approval-passphrase-aes-256-gcm',
    );
    assert.match(localRecord.protected_private_key_base64, /^[A-Za-z0-9+/=]+$/);
    assert.doesNotMatch(localText, /BEGIN PRIVATE KEY/);
    assert.doesNotMatch(localText, new RegExp(testPassphrase, 'i'));
    assert.doesNotMatch(localText, new RegExp(approvalPassphrase, 'i'));
    assert.equal(publicRecord.algorithm, 'Ed25519');
    assert.match(publicRecord.public_key_pem, /BEGIN PUBLIC KEY/);
    assert.equal('protected_private_key_base64' in publicRecord, false);
    assert.doesNotMatch(recoveryText, /BEGIN PRIVATE KEY/);
    assert.doesNotMatch(recoveryText, new RegExp(testPassphrase, 'i'));
    assert.equal(fixture.created.private_key_exported, false);
    assert.equal(fixture.created.enrollment_performed, false);

    const inspection = await inspectOwnerKey({ keyPath: fixture.created.local_key_path });
    assert.equal(inspection.fingerprint_sha256, publicRecord.fingerprint_sha256);
    assert.equal(inspection.private_key_exported, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('interactive approval helper signs exact Tier B action without exporting private key', async () => {
  const fixture = await pilotKeyFixture();
  try {
    const requestPath = join(fixture.root, 'request.json');
    const confirmationDirectory = join(fixture.root, 'confirmations');
    const assertionPath = join(confirmationDirectory, 'approval.json');
    const request = {
      projectSlug: 'project-a',
      handoffId: '42',
      operation: {
        description: 'Apply the reviewed human-confirmation schema migration',
        migration: true,
        pilotScope: 'shared-development',
      },
      guardState: {},
    };
    await writeFile(requestPath, JSON.stringify(request), 'utf8');
    let displayedReview;
    const result = await reviewAndSignOwnerConfirmation({
      keyPath: fixture.created.local_key_path,
      requestPath,
      output: assertionPath,
      now: fixedNow,
      decisionProvider: async (review) => {
        displayedReview = review;
        return 'APPROVE';
      },
      approvalPassphraseProvider: async () => Buffer.from(approvalPassphrase),
    });

    assert.equal(displayedReview.plain_english_action, request.operation.description);
    assert.equal(displayedReview.risk_tier, 'B');
    assert.equal(result.decision, 'APPROVED');
    assert.equal(result.private_key_exported, false);
    const approved = JSON.parse(await readFile(assertionPath, 'utf8'));
    const publicEnrollment = JSON.parse(await readFile(fixture.publicOutput, 'utf8'));
    const verified = verifyHumanConfirmationAssertion({
      assertion: approved.assertion,
      trustedIdentity: {
        id: 1,
        ...publicEnrollment,
      },
      expected: {
        projectSlug: request.projectSlug,
        handoffId: request.handoffId,
        actionHash: approved.action.action_hash,
      },
      now: fixedNow,
    });
    assert.equal(verified.identity.subject, 'user:test-owner');
    assert.equal(approved.assertion.claims.expires_at, '2026-07-27T12:05:00.000Z');
    assert.doesNotMatch(await readFile(assertionPath, 'utf8'), /BEGIN PRIVATE KEY/);

    const wrongPassphrasePath = join(confirmationDirectory, 'wrong-passphrase.json');
    await assert.rejects(
      reviewAndSignOwnerConfirmation({
        keyPath: fixture.created.local_key_path,
        requestPath,
        output: wrongPassphrasePath,
        now: fixedNow,
        decisionProvider: async () => 'APPROVE',
        approvalPassphraseProvider: async () => Buffer.from('incorrect signing phrase'),
      }),
    );
    await assert.rejects(access(wrongPassphrasePath));

    const declinedPath = join(confirmationDirectory, 'declined.json');
    const declined = await reviewAndSignOwnerConfirmation({
      keyPath: fixture.created.local_key_path,
      requestPath,
      output: declinedPath,
      now: fixedNow,
      decisionProvider: async () => 'DECLINE',
      approvalPassphraseProvider: async () => {
        throw new Error('Decline must not request the signing passphrase');
      },
    });
    assert.equal(declined.signed, false);
    await assert.rejects(access(declinedPath));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('recovery passphrase restores the same key under current-user DPAPI', async () => {
  const fixture = await pilotKeyFixture();
  try {
    const restored = await restoreOwnerKey({
      recoveryPath: fixture.recoveryOutput,
      keyDirectory: join(fixture.root, 'restored', 'owner-keys'),
      recoveryPassphrase: Buffer.from(testPassphrase),
      approvalPassphrase: Buffer.from('new owner signing passphrase'),
      workspaceRoot: process.cwd(),
      scryptN: 4096,
    });
    assert.equal(restored.fingerprint_sha256, fixture.created.fingerprint_sha256);
    assert.equal(restored.private_key_exported, false);
    const inspection = await inspectOwnerKey({ keyPath: restored.local_key_path });
    assert.equal(
      inspection.protection,
      'windows-dpapi-current-user+approval-passphrase-aes-256-gcm',
    );

    await assert.rejects(
      restoreOwnerKey({
        recoveryPath: fixture.recoveryOutput,
        keyDirectory: join(fixture.root, 'failed', 'owner-keys'),
        recoveryPassphrase: Buffer.from('wrong recovery phrase'),
        approvalPassphrase: Buffer.from('another owner signing phrase'),
        workspaceRoot: process.cwd(),
        scryptN: 4096,
      }),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('sensitive owner-key files are refused inside the repository workspace', async () => {
  await assert.rejects(
    initializeOwnerKey({
      provider: 'windows-pilot',
      subject: 'user:test-owner',
      keyDirectory: join(process.cwd(), 'owner-keys'),
      publicOutput: join(tmpdir(), 'unused-public.json'),
      recoveryOutput: join(tmpdir(), 'unused-recovery.json'),
      approvalPassphrase: Buffer.from(approvalPassphrase),
      recoveryPassphrase: Buffer.from(testPassphrase),
      workspaceRoot: process.cwd(),
      scryptN: 4096,
    }),
    /must be outside the workspace/,
  );
});

test('daily signing and recovery passphrases must be different', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helmion-owner-key-distinct-'));
  try {
    await assert.rejects(
      initializeOwnerKey({
        provider: 'windows-pilot',
        subject: 'user:test-owner',
        keyDirectory: join(root, 'owner-keys'),
        publicOutput: join(root, 'public.json'),
        recoveryOutput: join(root, 'recovery.json'),
        approvalPassphrase: Buffer.from(testPassphrase),
        recoveryPassphrase: Buffer.from(testPassphrase),
        workspaceRoot: process.cwd(),
        scryptN: 4096,
      }),
      /must be different/,
    );
    await assert.rejects(access(join(root, 'public.json')));
    await assert.rejects(access(join(root, 'recovery.json')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('same-length distinct signing and recovery passphrases initialize successfully', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helmion-owner-key-same-length-'));
  try {
    const result = await initializeOwnerKey({
      provider: 'windows-pilot',
      subject: 'user:test-owner',
      keyDirectory: join(root, 'owner-keys'),
      publicOutput: join(root, 'public.json'),
      recoveryOutput: join(root, 'recovery.json'),
      approvalPassphrase: Buffer.from('owner phrase 0001'),
      recoveryPassphrase: Buffer.from('owner phrase 0002'),
      workspaceRoot: process.cwd(),
      scryptN: 4096,
    });
    assert.equal(result.created, true);
    assert.equal(result.private_key_exported, false);
    assert.equal(result.enrollment_performed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('passphrase confirmation errors identify the prompt that failed', () => {
  assert.throws(
    () => assertConfirmedPassphrase(
      Buffer.from('owner signing phrase one'),
      Buffer.from('owner signing phrase two'),
      'Owner signing',
    ),
    /Owner signing passphrases did not match/,
  );
  assert.throws(
    () => assertConfirmedPassphrase(
      Buffer.from('too short'),
      Buffer.from('too short'),
      'Owner signing',
    ),
    /Owner signing passphrase must be at least 16 characters/,
  );
});
