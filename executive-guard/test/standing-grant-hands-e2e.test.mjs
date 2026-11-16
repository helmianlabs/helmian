// Bite Zero end-to-end: the REAL hands client (hands-mcp/src/guard-client.mjs)
// and the REAL PC spoke executor (src/hands/pc-spoke.mjs) against this Guard.
// A standing grant is minted through the normal human approval flow; after
// that, a covered PC-seat call runs with NO approval created and NO human
// tap — the spoke re-verifies the grant-backed decision itself before
// writing. An uncovered call still waits for the human, exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { canonicalJson } from '../src/canonical.mjs';
import { createGuardClient } from '../../hands-mcp/src/guard-client.mjs';
import { createExecutor } from '../../src/hands/pc-spoke.mjs';
import { startGuard, nonce, APPROVER_TOKEN } from '../test-support/helpers.mjs';

const HANDS_TOKEN = `hands-device-token-${randomBytes(8).toString('hex')}`;
const ACTIONS = [
  { tool: 'write_file', scope: 'jobs-prompt' },
  { tool: 'run_powershell', scope: 'seat-call' },
  { tool: 'run_powershell', scope: 'salvage-mkdir' },
  { tool: 'write_file', scope: 'salvage-file' },
];

async function setup() {
  const guard = await startGuard({ deviceTokens: { 'hands-mcp': HANDS_TOKEN } });
  const keyX = (await guard.call('GET', '/v1/keys')).body.publicKeyJwk.x;
  const client = createGuardClient({ url: guard.base, deviceToken: HANDS_TOKEN, publicKeyX: keyX, deviceId: 'hands-mcp', pollMs: 50, approvalWaitMs: 200 });
  const root = await mkdtemp(join(tmpdir(), 'pc-seat-'));
  const executor = createExecutor({ roots: [root], guardPublicKeyX: keyX, guardDeviceId: 'hands-mcp' });
  return { guard, client, executor, root, close: async () => { await guard.close(); await rm(root, { recursive: true, force: true }); } };
}

async function mintGrant(guard) {
  const hash = createHash('sha256').update(canonicalJson({ grant: { deviceId: 'hands-mcp', spokeDeviceId: 'pc-test', actions: ACTIONS } })).digest('hex');
  const action = {
    kind: 'agent.tool', site: 'hands.helmian', contentHash: hash,
    riskSignals: ['action-grant', 'destructive-intent', 'hands.act'],
    summary: `hands grant standing actions (${ACTIONS.map((a) => `${a.tool}:${a.scope}`).join(', ')}) for pc-test`,
  };
  const askRes = await guard.call('POST', '/v1/decisions', { token: HANDS_TOKEN, body: { action, nonce: nonce() } });
  assert.equal(askRes.status, 202, JSON.stringify(askRes.body));
  const decided = await guard.call('POST', `/v1/approvals/${askRes.body.approvalId}/decide`, { token: APPROVER_TOKEN, body: { approve: true } });
  assert.equal(decided.status, 200);
  assert.ok(decided.body.approval.grant, 'grant minted by the human approval');
  return askRes.body.approvalId;
}

test('e2e: a grant-covered jobs-prompt write executes through the spoke with no approval and no human tap', async () => {
  const s = await setup();
  try {
    await mintGrant(s.guard);
    await s.guard.call('GET', '/v1/approvals?status=pending', { token: APPROVER_TOKEN }).then((r) => assert.equal(r.body.approvals.length, 0));

    await mkdir(join(s.root, 'jobs'), { recursive: true }); // the seat transport creates jobs/ before the prompt write lands
    const args = { path: join(s.root, 'jobs', '3f2504e0-4f89-41d3-9a0c-0305e82c3301.prompt.txt'), content: 'build the thing' };
    const auth = await s.client.authorize({ tool: 'write_file', args, waitMs: 100 });
    assert.equal(auth.outcome, 'allow', auth.reason);
    assert.equal(auth.claims.ruleId, 'standing-grant');
    assert.ok(auth.claims.grantId);

    const pending = (await s.guard.call('GET', '/v1/approvals?status=pending', { token: APPROVER_TOKEN })).body.approvals;
    assert.equal(pending.length, 0, 'no approval was created for the covered call');

    const ran = await s.executor.execute({ tool: 'write_file', args, nonce: auth.nonce, guardDecision: auth.envelope });
    assert.equal(ran.ok, true, ran.error);
    assert.equal(await readFile(args.path, 'utf8'), 'build the thing');
    // Single-use still holds for grant-backed decisions.
    const replay = await s.executor.execute({ tool: 'write_file', args, nonce: auth.nonce, guardDecision: auth.envelope });
    assert.equal(replay.ok, false);
    assert.match(replay.error, /already used/);
  } finally { await s.close(); }
});

test('e2e: an uncovered write still parks for the human after the grant exists', async () => {
  const s = await setup();
  try {
    await mintGrant(s.guard);
    const args = { path: join(s.root, 'notes.txt'), content: 'uncovered' };
    const auth = await s.client.authorize({ tool: 'write_file', args, waitMs: 100 });
    assert.equal(auth.outcome, 'pending', auth.reason);
    const pending = (await s.guard.call('GET', '/v1/approvals?status=pending', { token: APPROVER_TOKEN })).body.approvals;
    assert.equal(pending.length, 1, 'the uncovered call created exactly one approval, as today');
  } finally { await s.close(); }
});

test('e2e: after revocation the same covered call parks again', async () => {
  const s = await setup();
  try {
    await mintGrant(s.guard);
    const grants = (await s.guard.call('GET', '/v1/grants', { token: HANDS_TOKEN })).body.grants;
    assert.equal(grants.length, 1);
    const claims = JSON.parse(Buffer.from(grants[0].payload, 'base64url').toString('utf8'));
    assert.equal((await s.guard.call('POST', `/v1/grants/${claims.grantId}/revoke`, { token: APPROVER_TOKEN, body: {} })).status, 200);
    const args = { path: join(s.root, 'jobs', '3f2504e0-4f89-41d3-9a0c-0305e82c3301.prompt.txt'), content: 'after revoke' };
    const auth = await s.client.authorize({ tool: 'write_file', args, waitMs: 100 });
    assert.equal(auth.outcome, 'pending', auth.reason);
  } finally { await s.close(); }
});
