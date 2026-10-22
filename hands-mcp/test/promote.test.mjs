// The promote lever: manifest validation, hash binding, role gate, and the
// executor's fail-closed order. Guard decisions here are signed with a test
// Ed25519 key in the exact envelope Executive Guard issues (PR #53), and the
// real verifyApproval from the shared protocol checks them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import {
  ArgError, buildGuardAction, canonicalJson, DECISION_AUDIENCE, guardActionHash,
  promoteManifestHash, sha256Hex, validateArgs, verifyApproval,
} from '../src/shared/protocol.mjs';
import { approverCoversTarget, targetForSite } from '../src/promote/targets.mjs';
import { createPromoteExecutor, gitBlobSha, PromoteRefusal } from '../src/promote/executor.mjs';

const NONCE = 'nonce-0123456789abcdef';
const fileA = { path: 'docs/promote-lever-test.md', content: '# Promote lever test\n' };
const fileB = { path: 'docs/aaa-note.md', content: 'second file\n' };

function rawManifest(overrides = {}) {
  return {
    repo: 'troy83352/forge-tms', baseBranch: 'main', mode: 'branch-pr', branch: 'promote/test',
    commitMessage: 'test promotion', files: [fileA], ...overrides,
  };
}
const manifest = (overrides) => validateArgs('promote_build', rawManifest(overrides));

// ── Manifest validation ──────────────────────────────────────────────────────

test('validateArgs: a manifest normalizes and every file hash is computed', () => {
  const args = manifest();
  assert.equal(args.files[0].sha256, sha256Hex(fileA.content));
  assert.equal(args.mode, 'branch-pr');
  assert.equal(args.branch, 'promote/test');
});

test('validateArgs: a declared hash that does not match the content is refused', () => {
  assert.throws(
    () => manifest({ files: [{ path: 'x.md', content: 'real', sha256: '0'.repeat(64) }] }),
    (e) => e instanceof ArgError && /does not match/.test(e.message),
  );
});

test('validateArgs: traversal, absolute and duplicate paths are refused', () => {
  assert.throws(() => manifest({ files: [{ path: '../escape.md', content: 'x' }] }), ArgError);
  assert.throws(() => manifest({ files: [{ path: '/abs.md', content: 'x' }] }), ArgError);
  assert.throws(() => manifest({ files: [{ path: 'a\\win.md', content: 'x' }] }), ArgError);
  assert.throws(() => manifest({ files: [fileA, fileA] }), ArgError);
});

test('validateArgs: mode and branch must agree', () => {
  assert.throws(() => manifest({ mode: 'direct-main' }), ArgError); // branch present
  assert.throws(() => manifest({ branch: undefined }), ArgError); // branch-pr needs one
  assert.throws(() => manifest({ branch: 'main' }), ArgError); // same as base
  assert.throws(() => manifest({ mode: 'sideways' }), ArgError);
  const direct = manifest({ mode: 'direct-main', branch: undefined });
  assert.equal(direct.branch, undefined);
});

test('validateArgs: file order does not change the manifest hash', () => {
  const a = manifest({ files: [fileA, fileB] });
  const b = manifest({ files: [fileB, fileA] });
  assert.deepEqual(a.files.map((f) => f.path), ['docs/aaa-note.md', 'docs/promote-lever-test.md']);
  assert.equal(promoteManifestHash(a), promoteManifestHash(b));
});

// ── Guard action binding ─────────────────────────────────────────────────────

test('buildGuardAction: promote_build is sited at forge.promote, others unchanged', () => {
  const action = buildGuardAction('promote_build', manifest());
  assert.equal(action.site, 'forge.promote');
  assert.equal(action.contentHash, promoteManifestHash(manifest()));
  assert.equal(buildGuardAction('write_file', { path: 'a.txt', content: 'x' }).site, 'hands.helmian');
  const changed = manifest({ files: [{ path: fileA.path, content: `${fileA.content} ` }] });
  assert.notEqual(guardActionHash(action), guardActionHash(buildGuardAction('promote_build', changed)));
});

// ── Signed decisions (real verifyApproval, test key) ────────────────────────

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyX = publicKey.export({ format: 'jwk' }).x;

function signClaims(claims) {
  const payload = Buffer.from(canonicalJson({ aud: DECISION_AUDIENCE, ...claims }), 'utf8').toString('base64url');
  return { payload, signature: sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64url'), keyId: 'test' };
}

function allowEnvelope(args, { decidedBy = 'troy' } = {}) {
  const iat = Math.floor(Date.now() / 1000);
  return signClaims({
    decisionId: randomUUID(), verdict: 'allow', ruleId: 'destructive-needs-approval',
    actionHash: guardActionHash(buildGuardAction('promote_build', args)),
    deviceId: 'hands-mcp', nonce: NONCE, iat, exp: iat + 300, approvalId: randomUUID(), decidedBy,
  });
}

test('verifyApproval: an approval for manifest A does not cover manifest B', () => {
  const a = manifest();
  const envelope = allowEnvelope(a);
  assert.equal(verifyApproval({ publicKeyX, envelope, tool: 'promote_build', args: a, nonce: NONCE, deviceId: 'hands-mcp' }).ok, true);
  const b = manifest({ commitMessage: 'a different message' });
  const v = verifyApproval({ publicKeyX, envelope, tool: 'promote_build', args: b, nonce: NONCE, deviceId: 'hands-mcp' });
  assert.equal(v.ok, false);
  assert.match(v.error, /different arguments/);
});

test('verifyApproval: an automatic allow without a human approver is not an approval', () => {
  const a = manifest();
  const iat = Math.floor(Date.now() / 1000);
  const envelope = signClaims({
    decisionId: randomUUID(), verdict: 'allow', ruleId: 'r', actionHash: guardActionHash(buildGuardAction('promote_build', a)),
    deviceId: 'hands-mcp', nonce: NONCE, iat, exp: iat + 300,
  });
  const v = verifyApproval({ publicKeyX, envelope, tool: 'promote_build', args: a, nonce: NONCE, deviceId: 'hands-mcp' });
  assert.equal(v.ok, false);
  assert.match(v.error, /not a human approval/);
});

// ── Roles ────────────────────────────────────────────────────────────────────

test('roles: only the registered admin/owner covers the forge target', () => {
  assert.equal(targetForSite('forge.promote').repo, 'troy83352/forge-tms');
  assert.equal(approverCoversTarget('forge.promote', 'troy'), true);
  assert.equal(approverCoversTarget('forge.promote', 'mallory'), false);
  assert.equal(approverCoversTarget('forge.promote', ''), false);
  assert.equal(approverCoversTarget('unknown.site', 'troy'), false);
});

// ── Executor ─────────────────────────────────────────────────────────────────

function fakeGithub() {
  const calls = [];
  return {
    calls,
    async createBranch(repo, branch, from) { calls.push(['createBranch', repo, branch, from]); },
    async pushFiles(repo, branch, message, files) { calls.push(['pushFiles', repo, branch, message, files.map((f) => f.path)]); return { sha: 'c0ffee123' }; },
    async getFileBlobSha(repo, path, ref) {
      calls.push(['getFileBlobSha', repo, path, ref]);
      const content = { [fileA.path]: fileA.content, [fileB.path]: fileB.content }[path];
      return gitBlobSha(content);
    },
    async createPullRequest(repo, head, base, title) { calls.push(['createPullRequest', repo, head, base, title]); return { url: 'https://github.com/troy83352/forge-tms/pull/999', number: 999 }; },
  };
}

function fakeGuard() {
  const outcomes = [];
  return {
    outcomes,
    async authorize() { throw new Error('not used in execute tests'); },
    async awaitApproval() { throw new Error('not used in execute tests'); },
    async reportOutcome(o) { outcomes.push(o); return { recorded: true }; },
  };
}

function makeExecutor(guard, github) {
  return createPromoteExecutor({ guard, github, audit: { append() {} }, publicKeyX, deviceId: 'hands-mcp', site: 'forge.promote' });
}

test('gitBlobSha matches git\'s known blob id for "hello\\n"', () => {
  assert.equal(gitBlobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('execute: approved branch+PR promotion pushes, verifies and reports', async () => {
  const guard = fakeGuard();
  const github = fakeGithub();
  const executor = makeExecutor(guard, github);
  const args = manifest();
  const r = await executor.execute({ args, envelope: allowEnvelope(args), nonce: NONCE });
  assert.equal(r.commit.sha, 'c0ffee123');
  assert.equal(r.pr.url, 'https://github.com/troy83352/forge-tms/pull/999');
  assert.deepEqual(github.calls.map((c) => c[0]), ['createBranch', 'pushFiles', 'getFileBlobSha', 'createPullRequest']);
  assert.equal(guard.outcomes.length, 1);
  assert.equal(guard.outcomes[0].status, 'succeeded');
  assert.equal(guard.outcomes[0].resultHash, sha256Hex('c0ffee123'));
});

test('execute: an approver without the target role is refused before any push', async () => {
  const guard = fakeGuard();
  const github = fakeGithub();
  const executor = makeExecutor(guard, github);
  const args = manifest();
  await assert.rejects(
    executor.execute({ args, envelope: allowEnvelope(args, { decidedBy: 'mallory' }), nonce: NONCE }),
    (e) => e instanceof PromoteRefusal && /does not hold admin\/owner/.test(e.message),
  );
  assert.equal(github.calls.length, 0);
  assert.equal(guard.outcomes[0].status, 'refused');
});

test('execute: a manifest changed after approval is refused before any push', async () => {
  const guard = fakeGuard();
  const github = fakeGithub();
  const executor = makeExecutor(guard, github);
  const approved = manifest();
  const tampered = manifest({ files: [{ path: fileA.path, content: `${fileA.content}tampered\n` }] });
  await assert.rejects(
    executor.execute({ args: tampered, envelope: allowEnvelope(approved), nonce: NONCE }),
    (e) => e instanceof PromoteRefusal && /does not cover this manifest/.test(e.message),
  );
  assert.equal(github.calls.length, 0);
});

test('execute: direct-main ships to main with no branch and no PR', async () => {
  const guard = fakeGuard();
  const github = fakeGithub();
  const executor = makeExecutor(guard, github);
  const args = manifest({ mode: 'direct-main', branch: undefined });
  const r = await executor.execute({ args, envelope: allowEnvelope(args), nonce: NONCE });
  assert.equal(r.ref, 'main');
  assert.equal(r.pr, null);
  assert.deepEqual(github.calls.map((c) => c[0]), ['pushFiles', 'getFileBlobSha']);
  assert.equal(github.calls[0][2], 'main');
});

test('request: an unregistered repo is refused before Guard is asked', async () => {
  let asked = false;
  const guard = { async authorize() { asked = true; return { outcome: 'deny', reason: 'x' }; }, async reportOutcome() { return { recorded: false }; } };
  const executor = makeExecutor(guard, fakeGithub());
  await assert.rejects(executor.request(rawManifest({ repo: 'mallory/elsewhere' })), PromoteRefusal);
  assert.equal(asked, false);
});
