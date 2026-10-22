// Executive Guard against the hands connector's REAL client code (merged to
// main in #56): hands-mcp/src/guard-client.mjs on the hub and
// src/hands/pc-spoke.mjs createExecutor on the PC. Nothing is stubbed between
// them and this server; the hub talks HTTP to it on 127.0.0.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGuardClient } from '../../hands-mcp/src/guard-client.mjs';
import { createExecutor } from '../../src/hands/pc-spoke.mjs';
import { startGuard, APPROVER_TOKEN } from '../test-support/helpers.mjs';

const HANDS_TOKEN = 'hands-device-token-ffffffffffffffffffff';

async function setup() {
  const guard = await startGuard({ deviceTokens: { 'hands-mcp': HANDS_TOKEN } });
  const keyX = (await guard.call('GET', '/v1/keys')).body.publicKeyJwk.x;
  const client = createGuardClient({ url: guard.base, deviceToken: HANDS_TOKEN, publicKeyX: keyX, deviceId: 'hands-mcp', pollMs: 50, approvalWaitMs: 200 });
  const root = await mkdtemp(join(tmpdir(), 'hands-root-'));
  const executor = createExecutor({ roots: [root], guardPublicKeyX: keyX, guardDeviceId: 'hands-mcp' });
  const approvePending = async (approve = true) => {
    const list = (await guard.call('GET', '/v1/approvals?status=pending', { token: APPROVER_TOKEN })).body.approvals;
    assert.equal(list.length, 1);
    await guard.call('POST', `/v1/approvals/${list[0].id}/decide`, { token: APPROVER_TOKEN, body: { approve } });
    return list[0];
  };
  return { guard, client, executor, root, approvePending, close: async () => { await guard.close(); await rm(root, { recursive: true, force: true }); } };
}

test('hands: a mutating call waits for a human; approved -> the PC verifies and runs it exactly once', async () => {
  const s = await setup();
  try {
    const args = { path: join(s.root, 'note.md'), content: 'hello from hands' };
    const first = await s.client.authorize({ tool: 'write_file', args, waitMs: 100 });
    assert.equal(first.outcome, 'pending', first.reason);
    const pending = await s.approvePending(true);
    assert.equal(pending.action.kind, 'agent.tool');
    assert.equal(pending.action.site, 'hands.helmian');
    assert.equal(pending.ruleId, 'destructive-needs-approval');

    const approved = await s.client.awaitApproval({ approvalId: first.approvalId, tool: 'write_file', args, nonce: first.nonce, waitMs: 500 });
    assert.equal(approved.outcome, 'allow', approved.reason);
    const run = await s.executor.execute({ tool: 'write_file', args, guardDecision: approved.envelope, nonce: first.nonce });
    assert.equal(run.ok, true, run.error);
    assert.equal(await readFile(args.path, 'utf8'), 'hello from hands');

    // Re-polling Guard returns the SAME decision, so the PC refuses a second run.
    const again = await s.client.awaitApproval({ approvalId: first.approvalId, tool: 'write_file', args, nonce: first.nonce, waitMs: 500 });
    assert.equal(again.outcome, 'allow');
    assert.equal(again.claims.decisionId, approved.claims.decisionId, 'Guard minted a new decisionId on re-poll');
    const replay = await s.executor.execute({ tool: 'write_file', args, guardDecision: again.envelope, nonce: first.nonce });
    assert.equal(replay.ok, false);
    assert.match(replay.error, /already used/);

    // The approval is bound to the exact arguments.
    const changed = { ...args, content: 'something else' };
    const other = await s.executor.execute({ tool: 'write_file', args: changed, guardDecision: approved.envelope, nonce: first.nonce });
    assert.equal(other.ok, false);
    assert.match(other.error, /different arguments/);
    assert.equal((await s.guard.call('GET', '/v1/audit/verify', { token: APPROVER_TOKEN })).body.ok, true);
  } finally { await s.close(); }
});

test('hands: a human deny, an expired wait and an unreachable Guard all deny', async () => {
  const s = await setup();
  try {
    const args = { commandId: 'git-status', args: { repo: s.root } };
    const first = await s.client.authorize({ tool: 'run_powershell', args, waitMs: 100 });
    assert.equal(first.outcome, 'pending');
    await s.approvePending(false);
    const denied = await s.client.awaitApproval({ approvalId: first.approvalId, tool: 'run_powershell', args, nonce: first.nonce, waitMs: 500 });
    assert.equal(denied.outcome, 'deny');
    assert.match(denied.reason, /denied/);
  } finally { await s.close(); }
  const down = createGuardClient({ url: 'http://127.0.0.1:9', deviceToken: HANDS_TOKEN, publicKeyX: 'x', deviceId: 'hands-mcp', timeoutMs: 500 });
  const r = await down.authorize({ tool: 'open_url', args: { url: 'https://example.com/' } });
  assert.equal(r.outcome, 'deny');
});

test('hands: an agent.tool call without a risk signal is denied by default, not auto-allowed', async () => {
  const s = await setup();
  try {
    const { nonce } = await import('../test-support/helpers.mjs');
    const r = await s.guard.call('POST', '/v1/decisions', { token: HANDS_TOKEN, body: { nonce: nonce(), action: { kind: 'agent.tool', site: 'hands.helmian', contentHash: 'a'.repeat(64), riskSignals: [], summary: 'hands write_file' } } });
    assert.equal(r.body.verdict, 'deny');
  } finally { await s.close(); }
});
