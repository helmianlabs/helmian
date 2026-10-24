// Root-grant signer: the issuance half of docs/hands/ROOT_GRANTS.md.
// Proves the signer mints envelopes the spoke's verifyRootGrant accepts
// (byte-compatible canonical JSON + Ed25519 over the payload string), and
// that issuance itself fails closed: no recorded human approval, a request
// record edited after it was written, a widened scope, a past expiry, or a
// non-Ed25519 key all refuse before anything is signed. Keys here are
// throwaway test keys; the real Guard key never appears in this repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateRootGrant, createRootRequest, loadRootGrants } from '../../src/hands/root-grants.mjs';
import { guardPublicKeyX, issueRootGrant, loadGuardPrivateKey } from '../../src/hands/root-grant-signer.mjs';
import { verifyRootGrant } from '../src/shared/protocol.mjs';

const DEVICE = 'pc-test';
const APPROVAL = { approvalId: 'appr-1', decidedBy: 'troy' };

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, x: publicKey.export({ format: 'jwk' }).x };
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'root-grant-signer-'));
  const rootPath = join(base, 'f-drive-folder');
  const request = createRootRequest({ rootPath, reason: 'read the new autovector build', spokeDeviceId: DEVICE, requestId: 'req-1' });
  return { base, rootPath, request, grantsPath: join(base, 'roots.grants.json') };
}

test('signer round trip: an issued grant verifies with verifyRootGrant and activates on the spoke side', async () => {
  const { privateKey, x } = keys();
  const { rootPath, request, grantsPath } = await fixture();
  const { envelope, claims } = issueRootGrant({ request, approval: APPROVAL, privateKey, keyId: 'test-key' });
  assert.equal(claims.rootPath, rootPath);
  assert.equal(claims.spokeDeviceId, DEVICE);
  assert.equal(claims.approvalId, 'appr-1');
  assert.equal(claims.decidedBy, 'troy');
  assert.equal(claims.requestId, 'req-1');
  assert.equal(claims.actionHash, request.actionHash);
  assert.equal(claims.exp, undefined);

  const v = verifyRootGrant({ publicKeyX: x, envelope, spokeDeviceId: DEVICE });
  assert.equal(v.ok, true, JSON.stringify(v));

  // The full spoke path: activation + load hand back the granted root.
  await activateRootGrant({ path: grantsPath, envelope, publicKeyX: x, spokeDeviceId: DEVICE });
  const loaded = await loadRootGrants({ path: grantsPath, publicKeyX: x, spokeDeviceId: DEVICE });
  assert.deepEqual(loaded.roots, [rootPath]);
  assert.equal(loaded.grants[0].approvalId, 'appr-1');
});

test('signer: a tampered envelope is rejected by the spoke verifier', async () => {
  const { privateKey, x } = keys();
  const { request } = await fixture();
  const { envelope } = issueRootGrant({ request, approval: APPROVAL, privateKey, keyId: 'test-key' });
  const claims = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'));
  claims.rootPath = '/somewhere/else';
  const tampered = { ...envelope, payload: Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url') };
  assert.match(verifyRootGrant({ publicKeyX: x, envelope: tampered, spokeDeviceId: DEVICE }).error, /bad signature/);
});

test('signer: a grant issued for one device opens nothing on another', async () => {
  const { privateKey, x } = keys();
  const { request } = await fixture();
  const { envelope } = issueRootGrant({ request, approval: APPROVAL, privateKey, keyId: 'test-key' });
  assert.match(verifyRootGrant({ publicKeyX: x, envelope, spokeDeviceId: 'pc-other' }).error, /device mismatch/);
  // A different signing key is likewise a bad signature, not a grant.
  assert.match(verifyRootGrant({ publicKeyX: keys().x, envelope, spokeDeviceId: DEVICE }).error, /bad signature/);
});

test('signer: no recorded human approval, no issuance', async () => {
  const { privateKey } = keys();
  const { request } = await fixture();
  assert.throws(() => issueRootGrant({ request, privateKey, keyId: 'k' }), /approvalId/);
  assert.throws(() => issueRootGrant({ request, approval: {}, privateKey, keyId: 'k' }), /approvalId/);
  assert.throws(() => issueRootGrant({ request, approval: { approvalId: 'a' }, privateKey, keyId: 'k' }), /decidedBy/);
  assert.throws(() => issueRootGrant({ request, approval: { approvalId: '  ', decidedBy: 'troy' }, privateKey, keyId: 'k' }), /approvalId/);
  assert.throws(() => issueRootGrant({ request, approval: { approvalId: 'a', decidedBy: '' }, privateKey, keyId: 'k' }), /decidedBy/);
});

test('signer: a request record edited after it was written is refused', async () => {
  const { privateKey } = keys();
  const { rootPath, request } = await fixture();
  // Re-aimed at another folder: the record no longer hashes to its actionHash.
  assert.throws(
    () => issueRootGrant({ request: { ...request, rootPath: `${rootPath}-elsewhere` }, approval: APPROVAL, privateKey, keyId: 'k' }),
    /actionHash/,
  );
  // Scope widening and device swapping are refused outright.
  assert.throws(
    () => issueRootGrant({ request: { ...request, scope: 'read-write' }, approval: APPROVAL, privateKey, keyId: 'k' }),
    /read-only/,
  );
  assert.throws(
    () => issueRootGrant({ request: { ...request, spokeDeviceId: 'pc-other' }, approval: APPROVAL, privateKey, keyId: 'k' }),
    /actionHash/,
  );
  assert.throws(
    () => issueRootGrant({ request: { ...request, kind: 'something-else' }, approval: APPROVAL, privateKey, keyId: 'k' }),
    /root-request/,
  );
});

test('signer: expiry must be in the future at issuance, and the spoke rejects the grant once it passes', async () => {
  const { privateKey, x } = keys();
  const { request } = await fixture();
  const now = Date.now();
  const soon = Math.floor(now / 1000) + 60;
  const { envelope, claims } = issueRootGrant({ request, approval: APPROVAL, privateKey, keyId: 'k', expiresAt: soon, now });
  assert.equal(claims.exp, soon);
  assert.equal(verifyRootGrant({ publicKeyX: x, envelope, spokeDeviceId: DEVICE, now }).ok, true);
  assert.match(verifyRootGrant({ publicKeyX: x, envelope, spokeDeviceId: DEVICE, now: (soon + 1) * 1000 }).error, /expired/);
  // Issuing an already-dead grant is refused, not signed.
  assert.throws(
    () => issueRootGrant({ request, approval: APPROVAL, privateKey, keyId: 'k', expiresAt: Math.floor(now / 1000) - 5, now }),
    /in the future/,
  );
});

test('loadGuardPrivateKey: PEM and JWK files load and sign; a non-Ed25519 key is refused', async () => {
  const { base, request } = await fixture();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x;

  const pemPath = join(base, 'guard.pem');
  await writeFile(pemPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const fromPem = await loadGuardPrivateKey(pemPath);
  assert.equal(guardPublicKeyX(fromPem), x);
  const { envelope } = issueRootGrant({ request, approval: APPROVAL, privateKey: fromPem, keyId: 'k' });
  assert.equal(verifyRootGrant({ publicKeyX: x, envelope, spokeDeviceId: DEVICE }).ok, true);

  const jwkPath = join(base, 'guard.jwk.json');
  await writeFile(jwkPath, JSON.stringify(privateKey.export({ format: 'jwk' })), { mode: 0o600 });
  const fromJwk = await loadGuardPrivateKey(jwkPath);
  assert.equal(guardPublicKeyX(fromJwk), x);

  const rsaPath = join(base, 'rsa.pem');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(rsaPath, rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  await assert.rejects(loadGuardPrivateKey(rsaPath), /not Ed25519/);
  await assert.rejects(loadGuardPrivateKey(join(base, 'missing.pem')), /ENOENT/);
});
