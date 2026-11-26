// Bite Zero (no-approvals design): /v1/decisions consults standing action
// grants BEFORE creating an approval. Fixtures:
//   (a) covered scope   -> signed grant-backed allow citing grantId + the
//                          minting human approvalId; NO approval is created.
//   (b) uncovered scope -> an approval is created exactly as today (202 ask).
//   (c) REVOKED grant   -> ask again, never allow.
//   (d) expired grant   -> ask again, never allow (control: a live seeded
//                          grant with a future exp DOES cover).
// Fail-safe throughout: a grant never answers a deny, never covers another
// device, and never covers a (tool, scope) outside its minted actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, verify as edVerify } from 'node:crypto';
import { canonicalJson } from '../src/canonical.mjs';
import { memoryAudit } from '../src/audit.mjs';
import { generateSigningKey, loadSigningKey, signActionGrant } from '../src/signing.mjs';
import { startGuard, nonce, DEVICE_TOKEN, OTHER_DEVICE_TOKEN, APPROVER_TOKEN } from '../test-support/helpers.mjs';

const ALL_ACTIONS = [
  { tool: 'write_file', scope: 'jobs-prompt' },
  { tool: 'run_powershell', scope: 'seat-call' },
  { tool: 'run_powershell', scope: 'salvage-mkdir' },
  { tool: 'write_file', scope: 'salvage-file' },
];

// The grant action, built exactly like grants.test.mjs / the hands protocol.
function grantAction({ spokeDeviceId = 'pc-troy', actions = ALL_ACTIONS } = {}) {
  const hash = createHash('sha256').update(canonicalJson({ grant: { deviceId: 'troy-laptop', spokeDeviceId, actions } })).digest('hex');
  return {
    kind: 'agent.tool',
    site: 'hands.helmian',
    contentHash: hash,
    riskSignals: ['action-grant', 'destructive-intent', 'hands.act'],
    summary: `hands grant standing actions (${actions.map((a) => `${a.tool}:${a.scope}`).join(', ')}) for ${spokeDeviceId}`,
  };
}

// A mutating hands call, built exactly like buildGuardAction in the hands
// shared protocol (contentHash binds { tool, args }; the scope signal is
// stamped from the call shape).
const sha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function handsAction(tool, args, scope) {
  return {
    kind: 'agent.tool',
    site: 'hands.helmian',
    contentHash: sha256({ tool, args }),
    riskSignals: ['destructive-intent', 'hands.act', `tool:${tool}`, ...(scope ? [`scope:${scope}`] : [])].sort(),
    summary: `${tool} (test)`,
  };
}

const JOBS_PROMPT_ARGS = { path: 'C:\\Users\\sam\\pc-seat\\jobs\\3f2504e0-4f89-41d3-9a0c-0305e82c3301.prompt.txt', content: 'do the thing' };
const SEAT_CALL_ARGS = { commandId: 'run-command', args: { command: "Start-Process powershell -ArgumentList @('-File','C:\\Users\\sam\\pc-seat\\seat-call.ps1','-Provider','grok')" } };
const SALVAGE_MKDIR_ARGS = { commandId: 'run-command', args: { command: "New-Item -ItemType Directory -Force -Path 'C:\\Users\\sam\\pc-seat\\builds\\grok'" } };
const SALVAGE_FILE_ARGS = { path: 'C:\\Users\\sam\\pc-seat\\builds\\grok\\reply.txt', content: 'salvaged' };
const PLAIN_WRITE_ARGS = { path: 'E:\\Helmion\\notes.txt', content: 'not a seat call' };

async function mintGrant(guard, actions = ALL_ACTIONS) {
  const askRes = await guard.call('POST', '/v1/decisions', { token: DEVICE_TOKEN, body: { action: grantAction({ actions }), nonce: nonce() } });
  assert.equal(askRes.status, 202, JSON.stringify(askRes.body));
  const approvalId = askRes.body.approvalId;
  const decided = await guard.call('POST', `/v1/approvals/${approvalId}/decide`, { token: APPROVER_TOKEN, body: { approve: true } });
  assert.equal(decided.status, 200);
  const envelope = decided.body.approval.grant;
  assert.ok(envelope, 'grant minted');
  const claims = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'));
  return { approvalId, grantId: claims.grantId, envelope };
}

const decideCall = (guard, act, token = DEVICE_TOKEN) => guard.call('POST', '/v1/decisions', { token, body: { action: act, nonce: nonce() } });
const pendingCount = async (guard) => (await guard.call('GET', '/v1/approvals?status=pending', { token: APPROVER_TOKEN })).body.approvals.length;

function assertGrantBackedDecision(guard, body, { grantId, approvalId }) {
  assert.equal(body.verdict, 'allow');
  assert.equal(body.grantId, grantId);
  const envelope = body.decision;
  assert.equal(envelope.keyId, guard.key.keyId);
  assert.equal(edVerify(null, Buffer.from(envelope.payload, 'utf8'), guard.key.publicKey, Buffer.from(envelope.signature, 'base64url')), true, 'decision signature verifies');
  const claims = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'));
  assert.equal(claims.aud, 'helmian-executive-guard-decision-v1');
  assert.equal(claims.verdict, 'allow');
  assert.equal(claims.ruleId, 'standing-grant');
  assert.equal(claims.grantId, grantId, 'decision cites the grant');
  assert.equal(claims.approvalId, approvalId, 'decision cites the minting human approval');
  assert.equal(claims.decidedBy, 'troy', 'decision cites the human approver who minted the grant');
  assert.equal(claims.deviceId, 'troy-laptop');
  assert.equal(typeof claims.exp, 'number');
  return claims;
}

test('(a) covered scopes -> grant-backed allow with citations, and NO approval is created', async () => {
  const guard = await startGuard();
  try {
    const { approvalId, grantId } = await mintGrant(guard);
    const auditBefore = guard.audit.all().length;

    for (const [tool, args, scope] of [
      ['write_file', JOBS_PROMPT_ARGS, 'jobs-prompt'],
      ['run_powershell', SEAT_CALL_ARGS, 'seat-call'],
      ['run_powershell', SALVAGE_MKDIR_ARGS, 'salvage-mkdir'],
      ['write_file', SALVAGE_FILE_ARGS, 'salvage-file'],
    ]) {
      const res = await decideCall(guard, handsAction(tool, args, scope));
      assert.equal(res.status, 200, `${scope}: ${JSON.stringify(res.body)}`);
      assertGrantBackedDecision(guard, res.body, { grantId, approvalId });
    }

    assert.equal(await pendingCount(guard), 0, 'no approval was created for covered calls');
    const issued = guard.audit.all().filter((e) => e.event === 'decision.issued' && e.ruleId === 'standing-grant');
    assert.equal(issued.length, 4, 'each grant-backed allow is on the audit trail');
    assert.ok(issued.every((e) => e.grantId === grantId && e.approvalId === approvalId && e.verdict === 'allow'));
    assert.equal(guard.audit.all().filter((e) => e.event === 'approval.requested').length, 1, 'only the grant action itself ever requested an approval');
    assert.ok(guard.audit.all().length > auditBefore);
    assert.equal(guard.audit.verify().ok, true);
  } finally { await guard.close(); }
});

test('(b) uncovered scope -> approval created exactly as today', async () => {
  const guard = await startGuard();
  try {
    await mintGrant(guard);
    // A call with no scope bucket at all.
    const plain = await decideCall(guard, handsAction('write_file', PLAIN_WRITE_ARGS, null));
    assert.equal(plain.status, 202);
    assert.equal(plain.body.verdict, 'ask');
    assert.ok(plain.body.approvalId);
    // A classified call in a tool the grant covers but with the OTHER
    // tool's bucket shape cannot exist; instead: a run-command that is
    // neither seat-call nor salvage-mkdir carries no scope and asks.
    const otherCmd = await decideCall(guard, handsAction('run_powershell', { commandId: 'run-command', args: { command: 'Get-Date' } }, null));
    assert.equal(otherCmd.status, 202);
    assert.equal(otherCmd.body.verdict, 'ask');
    assert.equal(await pendingCount(guard), 2);
  } finally { await guard.close(); }
});

test('(b2) a grant covering only one bucket leaves the other buckets asking', async () => {
  const guard = await startGuard();
  try {
    await mintGrant(guard, [{ tool: 'write_file', scope: 'jobs-prompt' }]);
    const covered = await decideCall(guard, handsAction('write_file', JOBS_PROMPT_ARGS, 'jobs-prompt'));
    assert.equal(covered.status, 200);
    assert.equal(covered.body.verdict, 'allow');
    const uncovered = await decideCall(guard, handsAction('run_powershell', SEAT_CALL_ARGS, 'seat-call'));
    assert.equal(uncovered.status, 202);
    assert.equal(uncovered.body.verdict, 'ask');
  } finally { await guard.close(); }
});

test('(c) REVOKED grant -> ask again, never allow', async () => {
  const guard = await startGuard();
  try {
    const { grantId } = await mintGrant(guard);
    const before = await decideCall(guard, handsAction('write_file', JOBS_PROMPT_ARGS, 'jobs-prompt'));
    assert.equal(before.body.verdict, 'allow', 'covered while the grant lives');
    assert.equal((await guard.call('POST', `/v1/grants/${grantId}/revoke`, { token: APPROVER_TOKEN, body: {} })).status, 200);
    const after = await decideCall(guard, handsAction('write_file', JOBS_PROMPT_ARGS, 'jobs-prompt'));
    assert.equal(after.status, 202);
    assert.equal(after.body.verdict, 'ask', 'revoked grant must never allow');
    assert.ok(after.body.approvalId);
  } finally { await guard.close(); }
});

test('(d) an expired grant envelope never covers; a live one with a future exp does', async () => {
  const pem = generateSigningKey();
  const key = loadSigningKey(pem);
  const nowSec = Math.floor(Date.now() / 1000);
  const seed = (grantId, exp) => {
    const audit = memoryAudit();
    const envelope = signActionGrant(key, {
      grantType: 'action', grantId, verdict: 'allow', approvalId: `appr-${grantId}`, decidedBy: 'troy',
      deviceId: 'troy-laptop', spokeDeviceId: 'pc-troy', actions: ALL_ACTIONS, iat: nowSec - 1000, ...(exp ? { exp } : {}),
    });
    audit.append({ event: 'grant.issued', grantId, approvalId: `appr-${grantId}`, deviceId: 'troy-laptop', spokeDeviceId: 'pc-troy', actions: ALL_ACTIONS, decidedBy: 'troy', envelope });
    return audit;
  };

  const expired = await startGuard({ key, audit: seed('grant-expired', nowSec - 10) });
  try {
    const res = await decideCall(expired, handsAction('write_file', JOBS_PROMPT_ARGS, 'jobs-prompt'));
    assert.equal(res.status, 202);
    assert.equal(res.body.verdict, 'ask', 'an expired grant must never allow');
  } finally { await expired.close(); }

  const live = await startGuard({ key, audit: seed('grant-live', nowSec + 3600) });
  try {
    const res = await decideCall(live, handsAction('write_file', JOBS_PROMPT_ARGS, 'jobs-prompt'));
    assert.equal(res.status, 200);
    assertGrantBackedDecision(live, res.body, { grantId: 'grant-live', approvalId: 'appr-grant-live' });
  } finally { await live.close(); }
});

test('a grant held by another device never covers, and a grant never answers a deny (Q6 untouched)', async () => {
  const guard = await startGuard();
  try {
    await mintGrant(guard);
    const other = await decideCall(guard, handsAction('write_file', JOBS_PROMPT_ARGS, 'jobs-prompt'), OTHER_DEVICE_TOKEN);
    assert.equal(other.status, 202, 'another device asks as today');
    assert.equal(other.body.verdict, 'ask');
    // A prompt carrying a secret is a hard deny under secrets-never-leave;
    // no grant machinery may soften it.
    const secret = await guard.call('POST', '/v1/decisions', {
      token: DEVICE_TOKEN,
      body: { action: { kind: 'prompt.send', site: 'chatgpt.com', contentHash: createHash('sha256').update('x').digest('hex'), riskSignals: ['secret:api-key'], summary: 'send' }, nonce: nonce() },
    });
    assert.equal(secret.status, 200);
    assert.equal(secret.body.verdict, 'deny');
  } finally { await guard.close(); }
});

test('a forged scope signal (bucket outside the minted vocabulary) never matches', async () => {
  const guard = await startGuard();
  try {
    await mintGrant(guard);
    const forged = handsAction('write_file', JOBS_PROMPT_ARGS, 'any');
    const res = await decideCall(guard, forged);
    assert.equal(res.status, 202);
    assert.equal(res.body.verdict, 'ask');
  } finally { await guard.close(); }
});
