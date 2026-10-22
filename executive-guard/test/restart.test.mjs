// Pending approvals, issued approval decisions and used nonces survive a
// restart (audit file + state file on the same volume), honouring expiry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileAudit } from '../src/audit.mjs';
import { fileState } from '../src/state.mjs';
import { APPROVAL_TTL_SECONDS } from '../src/server.mjs';
import { generateSigningKey, loadSigningKey, verifyDecision } from '../src/signing.mjs';
import { startGuard, action, nonce, DEVICE_TOKEN, APPROVER_TOKEN } from '../test-support/helpers.mjs';

const DESTRUCTIVE = action({ kind: 'agent.tool', site: 'hands.helmian', riskSignals: ['destructive-intent'], summary: 'write_file' });

function volume() {
  const dir = mkdtempSync(join(tmpdir(), 'eg-restart-'));
  const pem = generateSigningKey();
  const paths = { audit: join(dir, 'audit', 'audit.jsonl'), state: join(dir, 'audit', 'state.jsonl') };
  const boot = (opts = {}) => startGuard({ key: loadSigningKey(pem), audit: fileAudit(paths.audit, opts), state: fileState(paths.state), ...opts });
  return { dir, paths, boot };
}

const askFor = async (guard, n = nonce()) => ({ n, res: await guard.call('POST', '/v1/decisions', { token: DEVICE_TOKEN, body: { action: DESTRUCTIVE, nonce: n } }) });
const decide = (guard, id, approve = true) => guard.call('POST', `/v1/approvals/${id}/decide`, { token: APPROVER_TOKEN, body: { approve } });
const poll = (guard, id) => guard.call('GET', `/v1/approvals/${id}`, { token: DEVICE_TOKEN });
const events = (guard) => guard.audit.all().map((e) => e.event);

test('a pending approval is still listed, pollable and approvable after a restart; the decision binds the ORIGINAL nonce', async () => {
  const v = volume();
  const a = await v.boot();
  const { n, res } = await askFor(a);
  assert.equal(res.status, 202);
  const id = res.body.approvalId;
  await a.close();

  const b = await v.boot();
  try {
    const list = await b.call('GET', '/v1/approvals?status=pending', { token: APPROVER_TOKEN });
    assert.deepEqual(list.body.approvals.map((x) => x.id), [id]);
    assert.equal(list.body.approvals[0].nonce, undefined, 'the nonce is never listed');
    assert.equal((await poll(b, id)).body.status, 'pending');
    assert.equal((await decide(b, id)).status, 200);
    const p = await poll(b, id);
    const { ok, claims } = verifyDecision(b.key.publicKey, p.body.decision);
    assert.equal(ok, true);
    assert.equal(claims.verdict, 'allow');
    assert.equal(claims.nonce, n);
    assert.equal(claims.approvalId, id);
    assert.equal(b.audit.verify().ok, true);
  } finally { await b.close(); }
});

test('used nonces stay used: a replay after restart is refused (409)', async () => {
  const v = volume();
  const a = await v.boot();
  const n = nonce();
  assert.equal((await a.call('POST', '/v1/decisions', { token: DEVICE_TOKEN, body: { action: action(), nonce: n } })).status, 200);
  await a.close();
  const b = await v.boot();
  try {
    const replay = await b.call('POST', '/v1/decisions', { token: DEVICE_TOKEN, body: { action: action(), nonce: n } });
    assert.deepEqual([replay.status, replay.body.error], [409, 'replayed-nonce']);
    assert.equal(readFileSync(v.paths.state, 'utf8').includes(n), false, 'a plain allow stores only the nonce hash');
    assert.ok(readFileSync(v.paths.state, 'utf8').includes(createHash('sha256').update(n).digest('hex')));
  } finally { await b.close(); }
});

test('an approval decision issued before the restart is returned unchanged after it, and its outcome stays single-use', async () => {
  const v = volume();
  const a = await v.boot();
  const { n, res } = await askFor(a);
  const id = res.body.approvalId;
  await decide(a, id);
  const before = (await poll(a, id)).body;
  const { claims } = verifyDecision(a.key.publicKey, before.decision);
  const t0 = new Date(Date.now() - 1000).toISOString();
  assert.equal((await a.call('POST', '/v1/audit/outcomes', { token: DEVICE_TOKEN, body: { decisionId: claims.decisionId, nonce: n, status: 'succeeded', startedAt: t0, finishedAt: new Date().toISOString() } })).status, 201);
  await a.close();

  const b = await v.boot();
  try {
    const after = (await poll(b, id)).body;
    assert.deepEqual(after.decision, before.decision, 're-poll after restart minted a different decision');
    assert.equal(events(b).filter((e) => e === 'decision.issued').length, 1);
    const dup = await b.call('POST', '/v1/audit/outcomes', { token: DEVICE_TOKEN, body: { decisionId: claims.decisionId, nonce: n, status: 'succeeded', startedAt: t0, finishedAt: new Date().toISOString() } });
    assert.equal(dup.status, 409);
    assert.equal((await decide(b, id)).status, 409, 'a settled approval cannot be decided again');
  } finally { await b.close(); }
});

test('expiry is honoured across a restart: an approval that timed out while down is expired, audited, and not approvable', async () => {
  const v = volume();
  let t = Date.now();
  const clock = () => t;
  const a = await v.boot({ now: clock });
  const { res } = await askFor(a);
  const id = res.body.approvalId;
  await a.close();
  t += (APPROVAL_TTL_SECONDS + 1) * 1000;
  const b = await v.boot({ now: clock });
  try {
    assert.ok(events(b).includes('approval.expired'), 'the expiry during downtime was not audited');
    assert.equal((await poll(b, id)).body.status, 'expired');
    assert.equal((await decide(b, id)).status, 409);
    assert.equal(b.audit.verify().ok, true);
  } finally { await b.close(); }
});

test('crash between state and audit: an approval the audit does not confirm is still pending (fail closed)', async () => {
  const v = volume();
  const a = await v.boot();
  const { res } = await askFor(a);
  const id = res.body.approvalId;
  await a.close();
  // Simulate: state says approved, then the process died before the audit line.
  const rec = readFileSync(v.paths.state, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.t === 'approval');
  appendFileSync(v.paths.state, `${JSON.stringify({ t: 'approval', approval: { ...rec.approval, status: 'approved', decidedBy: 'troy', decidedAt: Math.floor(Date.now() / 1000) } })}\n`);
  const b = await v.boot();
  try {
    const p = await poll(b, id);
    assert.equal(p.body.status, 'pending');
    assert.equal(p.body.decision, undefined);
  } finally { await b.close(); }
});

test('crash after signing but before the audit line: the decision is re-recorded (recovered) and stays the same', async () => {
  const v = volume();
  const a = await v.boot();
  const { res } = await askFor(a);
  const id = res.body.approvalId;
  await decide(a, id);
  const first = (await poll(a, id)).body.decision;
  await a.close();
  // Drop the decision.issued line from the audit (and keep the chain valid by
  // truncating to before it: it is the last line).
  const lines = readFileSync(v.paths.audit, 'utf8').trim().split('\n');
  assert.equal(JSON.parse(lines.at(-1)).event, 'decision.issued');
  writeFileSync(v.paths.audit, `${lines.slice(0, -1).join('\n')}\n`);
  const b = await v.boot();
  try {
    const recovered = b.audit.all().filter((e) => e.event === 'decision.issued');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].recovered, true);
    assert.deepEqual((await poll(b, id)).body.decision, first);
  } finally { await b.close(); }
});

test('state file lost: pending approvals are closed in the audit (state-unavailable), never silently approvable', async () => {
  const v = volume();
  const a = await v.boot();
  const { res } = await askFor(a);
  const id = res.body.approvalId;
  await a.close();
  rmSync(v.paths.state);
  const b = await v.boot();
  try {
    const closed = b.audit.all().find((e) => e.event === 'approval.expired' && e.approvalId === id);
    assert.equal(closed.reason, 'state-unavailable-after-restart');
    assert.equal((await poll(b, id)).status, 404);
  } finally { await b.close(); }
  const c = await v.boot();
  try {
    assert.equal(c.audit.all().filter((e) => e.event === 'approval.expired').length, 1, 'closed once, not on every restart');
  } finally { await c.close(); }
});

test('state file: compacted on start (expired nonces dropped), a torn last line is tolerated, mid-file corruption is not', async () => {
  const v = volume();
  let t = Date.now();
  const a = await v.boot({ now: () => t });
  for (let i = 0; i < 3; i += 1) await a.call('POST', '/v1/decisions', { token: DEVICE_TOKEN, body: { action: action(), nonce: nonce() } });
  await a.close();
  assert.equal(readFileSync(v.paths.state, 'utf8').trim().split('\n').length, 3);
  t += APPROVAL_TTL_SECONDS * 1000 + 60_000;
  appendFileSync(v.paths.state, '{"t":"nonce","h":"ab'); // torn write
  const b = await v.boot({ now: () => t });
  await b.close();
  assert.equal(readFileSync(v.paths.state, 'utf8'), '', 'expired nonces and the torn line were compacted away');
  writeFileSync(v.paths.state, 'not json\n{"t":"nonce","h":"x","exp":1}\n');
  assert.throws(() => fileState(v.paths.state).load(), /corrupt at line 1/);
});
