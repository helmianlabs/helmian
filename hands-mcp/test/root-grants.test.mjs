// Root grants: signed, read-only, per-folder access beyond the PC's built-in
// workspace roots. Proves the fail-closed rules at the spoke: no grant (or a
// tampered / unsigned / expired / wrong-device one) means no access; a valid
// grant opens list/read/search only; mutating tools refuse under a granted
// root without consuming the Guard decision; revocation closes access on the
// same running executor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutor, startSpoke } from '../../src/hands/pc-spoke.mjs';
import { activateRootGrant, createRootRequest, loadRootGrants, revokeRootGrant } from '../../src/hands/root-grants.mjs';
import { ROOT_GRANT_AUDIENCE, buildGuardAction, guardActionHash, rootGrantActionHash, verifyRootGrant } from '../src/shared/protocol.mjs';
import { mockGuard } from './helpers.mjs';

const DEVICE = 'pc-test';
const iat = () => Math.floor(Date.now() / 1000);

function makeGrant(guard, rootPath, overrides = {}) {
  return guard.forge({
    aud: ROOT_GRANT_AUDIENCE,
    grantType: 'root',
    grantId: 'grant-1',
    verdict: 'allow',
    approvalId: 'appr-1',
    decidedBy: 'troy',
    rootPath,
    scope: 'read-only',
    spokeDeviceId: DEVICE,
    iat: iat(),
    exp: iat() + 3600,
    ...overrides,
  });
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'root-grants-'));
  const defaultRoot = join(base, 'default');
  const grantedRoot = join(base, 'f-drive-folder');
  await mkdir(defaultRoot);
  await mkdir(grantedRoot);
  await writeFile(join(defaultRoot, 'home.txt'), 'inside the default root');
  await writeFile(join(grantedRoot, 'scale-build.txt'), 'the autovector scale build');
  return { base, defaultRoot, grantedRoot, grantsPath: join(base, 'roots.grants.json') };
}

function writeDecision(guard, args, id = 'w1') {
  const nonce = 'n'.repeat(20);
  return {
    tool: 'write_file', args, nonce,
    guardDecision: guard.forge({ decisionId: id, verdict: 'allow', actionHash: guardActionHash(buildGuardAction('write_file', args)), deviceId: 'hands-mcp', nonce, iat: iat(), exp: iat() + 300, approvalId: 'a', decidedBy: 'troy' }),
  };
}

test('verifyRootGrant: a valid signed grant verifies; tampered, unsigned, wrong-device, expired, and write-scope grants do not', async () => {
  const guard = mockGuard();
  const { grantedRoot } = await fixture();
  const good = makeGrant(guard, grantedRoot);
  const v = verifyRootGrant({ publicKeyX: guard.x, envelope: good, spokeDeviceId: DEVICE });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.claims.rootPath, grantedRoot);

  // Tampered: rewrite the folder inside the payload, keep the old signature.
  const claims = JSON.parse(Buffer.from(good.payload, 'base64url').toString('utf8'));
  claims.rootPath = '/somewhere/else';
  const tampered = { ...good, payload: Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url') };
  assert.match(verifyRootGrant({ publicKeyX: guard.x, envelope: tampered, spokeDeviceId: DEVICE }).error, /bad signature/);

  // Unsigned / malformed.
  assert.match(verifyRootGrant({ publicKeyX: guard.x, envelope: { payload: good.payload, signature: 'AAAA' }, spokeDeviceId: DEVICE }).error, /bad signature/);
  assert.match(verifyRootGrant({ publicKeyX: guard.x, envelope: null, spokeDeviceId: DEVICE }).error, /malformed/);
  assert.match(verifyRootGrant({ publicKeyX: guard.x, envelope: { payload: good.payload }, spokeDeviceId: DEVICE }).error, /malformed/);

  // No pinned key, wrong key, wrong device, expired, no human, write scope, and
  // a plain Guard action decision (wrong audience) are all refused.
  assert.match(verifyRootGrant({ publicKeyX: null, envelope: good, spokeDeviceId: DEVICE }).error, /no pinned Guard key/);
  assert.match(verifyRootGrant({ publicKeyX: mockGuard().x, envelope: good, spokeDeviceId: DEVICE }).error, /bad signature/);
  assert.match(verifyRootGrant({ publicKeyX: guard.x, envelope: good, spokeDeviceId: 'pc-other' }).error, /device mismatch/);
  assert.match(verifyRootGrant({ publicKeyX: guard.x, envelope: makeGrant(guard, grantedRoot, { grantId: 'g-exp', exp: iat() - 10 }), spokeDeviceId: DEVICE }).error, /expired/);
  assert.match(verifyRootGrant({ publicKeyX: guard.x, envelope: makeGrant(guard, grantedRoot, { grantId: 'g-auto', approvalId: undefined, decidedBy: undefined }), spokeDeviceId: DEVICE }).error, /not a human approval/);
  assert.match(verifyRootGrant({ publicKeyX: guard.x, envelope: makeGrant(guard, grantedRoot, { grantId: 'g-rw', scope: 'read-write' }), spokeDeviceId: DEVICE }).error, /read-only/);
  const decision = guard.forge({ decisionId: 'd1', verdict: 'allow', actionHash: 'x'.repeat(64), deviceId: 'hands-mcp', nonce: 'n'.repeat(20), iat: iat(), exp: iat() + 300, approvalId: 'a', decidedBy: 'troy' });
  assert.match(verifyRootGrant({ publicKeyX: guard.x, envelope: decision, spokeDeviceId: DEVICE }).error, /wrong audience/);

  // No exp = until revoked, and that verifies too.
  const open = makeGrant(guard, grantedRoot, { grantId: 'g-open', exp: undefined });
  assert.equal(verifyRootGrant({ publicKeyX: guard.x, envelope: open, spokeDeviceId: DEVICE }).ok, true);
});

test('loadRootGrants: missing file grants nothing; a tampered entry in the file grants nothing but does not poison a valid one', async () => {
  const guard = mockGuard();
  const { grantedRoot, grantsPath } = await fixture();
  assert.deepEqual((await loadRootGrants({ path: grantsPath, publicKeyX: guard.x, spokeDeviceId: DEVICE })).roots, []);

  const good = makeGrant(guard, grantedRoot);
  const claims = JSON.parse(Buffer.from(good.payload, 'base64url').toString('utf8'));
  claims.rootPath = '/tampered';
  const tampered = { ...good, payload: Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url') };
  await writeFile(grantsPath, JSON.stringify({ version: 1, grants: [{ envelope: tampered }, { envelope: makeGrant(guard, grantedRoot, { grantId: 'grant-2' }) }] }));
  const loaded = await loadRootGrants({ path: grantsPath, publicKeyX: guard.x, spokeDeviceId: DEVICE });
  assert.deepEqual(loaded.roots, [grantedRoot]);
  assert.equal(loaded.rejected.length, 1);
  assert.match(loaded.rejected[0].error, /bad signature/);

  // A malformed grants file grants nothing.
  await writeFile(grantsPath, 'not json {');
  const broken = await loadRootGrants({ path: grantsPath, publicKeyX: guard.x, spokeDeviceId: DEVICE });
  assert.deepEqual(broken.roots, []);
  assert.equal(broken.rejected.length, 1);
});

test('activateRootGrant: refuses anything unverifiable and writes nothing; a valid grant lands in the file', async () => {
  const guard = mockGuard();
  const { grantedRoot, grantsPath } = await fixture();
  await assert.rejects(
    activateRootGrant({ path: grantsPath, envelope: { payload: 'e30', signature: 'AAAA' }, publicKeyX: guard.x, spokeDeviceId: DEVICE }),
    /root grant refused/,
  );
  await assert.rejects(stat(grantsPath), /ENOENT/);

  const claims = await activateRootGrant({ path: grantsPath, envelope: makeGrant(guard, grantedRoot), publicKeyX: guard.x, spokeDeviceId: DEVICE });
  assert.equal(claims.grantId, 'grant-1');
  const onDisk = JSON.parse(await readFile(grantsPath, 'utf8'));
  assert.equal(onDisk.grants.length, 1);
  assert.equal(onDisk.grants[0].rootPath, grantedRoot);
  // Re-activating the same grantId replaces, never duplicates.
  await activateRootGrant({ path: grantsPath, envelope: makeGrant(guard, grantedRoot), publicKeyX: guard.x, spokeDeviceId: DEVICE });
  assert.equal(JSON.parse(await readFile(grantsPath, 'utf8')).grants.length, 1);
});

test('executor: an ungranted folder is refused for reads; after a valid grant, list/read/search work there', async () => {
  const guard = mockGuard();
  const { defaultRoot, grantedRoot, grantsPath } = await fixture();
  const exec = createExecutor({ roots: [defaultRoot], rootGrantsPath: grantsPath, rootGrantDeviceId: DEVICE, guardPublicKeyX: guard.x });

  // Before the grant: outside the workspace roots, exactly like any stranger path.
  assert.match((await exec.execute({ tool: 'read_file', args: { path: join(grantedRoot, 'scale-build.txt') } })).error, /Outside the workspace roots/);
  assert.match((await exec.execute({ tool: 'list_files', args: { path: grantedRoot } })).error, /Outside the workspace roots/);
  assert.match((await exec.execute({ tool: 'search_files', args: { path: grantedRoot, query: 'autovector' } })).error, /Outside the workspace roots/);

  await activateRootGrant({ path: grantsPath, envelope: makeGrant(guard, grantedRoot), publicKeyX: guard.x, spokeDeviceId: DEVICE });

  // After the grant: the SAME executor (grants reload per operation) reads it.
  const read = await exec.execute({ tool: 'read_file', args: { path: join(grantedRoot, 'scale-build.txt') } });
  assert.equal(read.ok, true, read.error);
  assert.match(read.output, /autovector scale build/);
  const list = await exec.execute({ tool: 'list_files', args: { path: grantedRoot } });
  assert.equal(list.ok, true, list.error);
  assert.match(list.output, /scale-build\.txt/);
  const search = await exec.execute({ tool: 'search_files', args: { path: grantedRoot, query: 'autovector' } });
  assert.equal(search.ok, true, search.error);
  assert.match(search.output, /scale-build\.txt:1/);
  // The default root still reads as before.
  assert.equal((await exec.execute({ tool: 'read_file', args: { path: join(defaultRoot, 'home.txt') } })).ok, true);
});

test('executor: mutating tools refuse under a granted root — before the Guard decision is spent — while the default root still accepts approved writes', async () => {
  const guard = mockGuard();
  const { defaultRoot, grantedRoot, grantsPath } = await fixture();
  await activateRootGrant({ path: grantsPath, envelope: makeGrant(guard, grantedRoot), publicKeyX: guard.x, spokeDeviceId: DEVICE });
  const exec = createExecutor({ roots: [defaultRoot], rootGrantsPath: grantsPath, rootGrantDeviceId: DEVICE, guardPublicKeyX: guard.x });

  // A fully valid, human-approved Guard decision to write under the grant:
  const target = join(grantedRoot, 'evil.txt');
  const job = writeDecision(guard, { path: target, content: 'pwned' });
  const first = await exec.execute(job);
  assert.equal(first.ok, false);
  assert.match(first.error, /read-only root grant/);
  assert.equal(first.execution.status, 'refused');
  await assert.rejects(readFile(target), /ENOENT/);
  // The decision was NOT consumed by the refusal: the same job is refused the
  // same way again (a claimed decision would answer "already used" instead).
  const second = await exec.execute(job);
  assert.match(second.error, /read-only root grant/);

  // A move whose DESTINATION is under the grant is refused the same way.
  const moveArgs = { path: join(defaultRoot, 'home.txt'), destination: join(grantedRoot, 'home.txt') };
  const moveNonce = 'm'.repeat(20);
  const moveJob = { tool: 'move_file', args: moveArgs, nonce: moveNonce, guardDecision: guard.forge({ decisionId: 'mv1', verdict: 'allow', actionHash: guardActionHash(buildGuardAction('move_file', moveArgs)), deviceId: 'hands-mcp', nonce: moveNonce, iat: iat(), exp: iat() + 300, approvalId: 'a', decidedBy: 'troy' }) };
  assert.match((await exec.execute(moveJob)).error, /read-only root grant/);
  assert.equal(await readFile(join(defaultRoot, 'home.txt'), 'utf8'), 'inside the default root');

  // And an approved write inside the DEFAULT root still runs.
  const okJob = writeDecision(guard, { path: join(defaultRoot, 'ok.txt'), content: 'fine' }, 'w2');
  assert.equal((await exec.execute(okJob)).ok, true);
  assert.equal(await readFile(join(defaultRoot, 'ok.txt'), 'utf8'), 'fine');
});

test('revocation closes access on the same running executor (by grantId and by path)', async () => {
  const guard = mockGuard();
  const { defaultRoot, grantedRoot, grantsPath } = await fixture();
  await activateRootGrant({ path: grantsPath, envelope: makeGrant(guard, grantedRoot), publicKeyX: guard.x, spokeDeviceId: DEVICE });
  const exec = createExecutor({ roots: [defaultRoot], rootGrantsPath: grantsPath, rootGrantDeviceId: DEVICE, guardPublicKeyX: guard.x });
  assert.equal((await exec.execute({ tool: 'read_file', args: { path: join(grantedRoot, 'scale-build.txt') } })).ok, true);

  const byId = await revokeRootGrant({ path: grantsPath, selector: 'grant-1' });
  assert.equal(byId.removed, 1);
  assert.match((await exec.execute({ tool: 'read_file', args: { path: join(grantedRoot, 'scale-build.txt') } })).error, /Outside the workspace roots/);

  // Re-grant, then revoke by folder path.
  await activateRootGrant({ path: grantsPath, envelope: makeGrant(guard, grantedRoot, { grantId: 'grant-2' }), publicKeyX: guard.x, spokeDeviceId: DEVICE });
  assert.equal((await exec.execute({ tool: 'list_files', args: { path: grantedRoot } })).ok, true);
  const byPath = await revokeRootGrant({ path: grantsPath, selector: grantedRoot });
  assert.equal(byPath.removed, 1);
  assert.match((await exec.execute({ tool: 'list_files', args: { path: grantedRoot } })).error, /Outside the workspace roots/);

  // Revoking something that is not there removes nothing.
  assert.equal((await revokeRootGrant({ path: grantsPath, selector: 'grant-nope' })).removed, 0);
});

test('an expired grant in the file opens nothing', async () => {
  const guard = mockGuard();
  const { defaultRoot, grantedRoot, grantsPath } = await fixture();
  await writeFile(grantsPath, JSON.stringify({ version: 1, grants: [{ envelope: makeGrant(guard, grantedRoot, { exp: iat() - 5 }) }] }));
  const exec = createExecutor({ roots: [defaultRoot], rootGrantsPath: grantsPath, rootGrantDeviceId: DEVICE, guardPublicKeyX: guard.x });
  assert.match((await exec.execute({ tool: 'read_file', args: { path: join(grantedRoot, 'scale-build.txt') } })).error, /Outside the workspace roots/);
});

test('startSpoke: grants bound to the spoke device id load at startup and are reported in the startup line', async () => {
  const guard = mockGuard();
  const { defaultRoot, grantedRoot, grantsPath } = await fixture();
  await activateRootGrant({ path: grantsPath, envelope: makeGrant(guard, grantedRoot), publicKeyX: guard.x, spokeDeviceId: DEVICE });
  const logs = [];
  let polls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('11434')) return { ok: false, json: async () => ({}) };
    if (String(url).includes('/spoke/v1/poll')) {
      polls += 1;
      if (polls > 1) return new Promise(() => {}); // park the loop
      return { ok: true, status: 200, json: async () => ({ job: null }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const spoke = startSpoke({ config: { url: 'http://hub.test', token: 't', roots: [defaultRoot], rootGrantsPath: grantsPath, guardPublicKeyX: guard.x, deviceId: DEVICE }, fetchImpl, log: (...a) => logs.push(a.join(' ')) });
  for (let i = 0; i < 40 && !logs.join('\n').includes('granted read-only roots'); i++) await new Promise((r) => setTimeout(r, 50));
  spoke.stop();
  assert.match(logs.join('\n'), /granted read-only roots/);
  assert.ok(logs.join('\n').includes(grantedRoot), logs.join('\n'));
});

test('createRootRequest: one absolute folder, read-only, bound to the Guard action a hub should approve', async () => {
  const { grantedRoot } = await fixture();
  const req = createRootRequest({ rootPath: grantedRoot, reason: 'read the new autovector build', spokeDeviceId: DEVICE, requestId: 'req-1', now: 0 });
  assert.equal(req.kind, 'root-request');
  assert.equal(req.scope, 'read-only');
  assert.equal(req.requester, DEVICE);
  assert.equal(req.actionHash, rootGrantActionHash({ rootPath: grantedRoot, scope: 'read-only', spokeDeviceId: DEVICE, expiresAt: null }));
  assert.throws(() => createRootRequest({ rootPath: 'relative/folder', reason: 'x', spokeDeviceId: DEVICE }), /absolute/);
  assert.throws(() => createRootRequest({ rootPath: grantedRoot, reason: '  ', spokeDeviceId: DEVICE }), /reason is required/);
});
