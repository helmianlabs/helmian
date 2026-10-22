// POST /v1/audit/outcomes: a device reports what happened after a decision it
// was given. Contract: docs/OUTCOMES.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyDecision, generateSigningKey, loadSigningKey } from '../src/signing.mjs';
import { fileAudit } from '../src/audit.mjs';
import { OUTCOME_WINDOW_SECONDS } from '../src/server.mjs';
import { startGuard, action, nonce, sha256, DEVICE_TOKEN, OTHER_DEVICE_TOKEN, APPROVER_TOKEN } from '../test-support/helpers.mjs';

const DESTRUCTIVE = { kind: 'agent.tool', site: 'hands.helmian', riskSignals: ['destructive-intent'], summary: 'write_file' };

async function allowDecision(guard, overrides = {}) {
  const n = nonce();
  const res = await guard.call('POST', '/v1/decisions', { token: DEVICE_TOKEN, body: { action: action(overrides), nonce: n } });
  const { claims } = verifyDecision(guard.key.publicKey, res.body.decision);
  return { claims, nonce: n, res };
}

function times(startMs = Date.now() - 2000, ms = 1500) {
  return { startedAt: new Date(startMs).toISOString(), finishedAt: new Date(startMs + ms).toISOString() };
}

const report = (guard, body, token = DEVICE_TOKEN) => guard.call('POST', '/v1/audit/outcomes', { token, body });

test('succeeded outcome for an allow: 201, appended to the chain as decision.outcome, chain verifies', async () => {
  const guard = await startGuard();
  try {
    const { claims, nonce: n } = await allowDecision(guard);
    assert.equal(claims.verdict, 'allow');
    const resultHash = sha256('result');
    const res = await report(guard, { decisionId: claims.decisionId, nonce: n, status: 'succeeded', ...times(), resultHash });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const last = guard.audit.all().at(-1);
    assert.deepEqual(res.body, { recorded: true, decisionId: claims.decisionId, status: 'succeeded', auditSeq: last.seq, auditHash: last.hash });
    assert.equal(last.event, 'decision.outcome');
    assert.equal(last.deviceId, 'troy-laptop');
    assert.equal(last.verdict, 'allow');
    assert.equal(last.actionHash, claims.actionHash);
    assert.equal(last.resultHash, resultHash);
    assert.equal(last.durationMs, 1500);
    assert.equal(JSON.stringify(last).includes(n), false, 'the nonce itself is not written to the audit');
    assert.equal(guard.audit.verify().ok, true);
  } finally { await guard.close(); }
});

test('auth: device bearer only; approver token, no token and GET are refused', async () => {
  const guard = await startGuard();
  try {
    const { claims, nonce: n } = await allowDecision(guard);
    const body = { decisionId: claims.decisionId, nonce: n, status: 'succeeded', ...times() };
    assert.equal((await guard.call('POST', '/v1/audit/outcomes', { body })).status, 401);
    assert.equal((await report(guard, body, APPROVER_TOKEN)).status, 401);
    assert.equal((await guard.call('GET', '/v1/audit/outcomes', { token: DEVICE_TOKEN })).status, 405);
    const wrongType = await guard.call('POST', '/v1/audit/outcomes', { token: DEVICE_TOKEN, body: 'x', headers: { 'content-type': 'text/plain' } });
    assert.equal(wrongType.status, 415);
  } finally { await guard.close(); }
});

test('unknown and foreign decisionIds get the same 404; a wrong nonce is 403', async () => {
  const guard = await startGuard();
  try {
    const { claims, nonce: n } = await allowDecision(guard);
    const unknown = await report(guard, { decisionId: '00000000-0000-4000-8000-000000000000', nonce: n, status: 'succeeded', ...times() });
    assert.deepEqual([unknown.status, unknown.body.error], [404, 'unknown-decision']);
    const foreign = await report(guard, { decisionId: claims.decisionId, nonce: n, status: 'succeeded', ...times() }, OTHER_DEVICE_TOKEN);
    assert.deepEqual([foreign.status, foreign.body.error], [404, 'unknown-decision']);
    const wrongNonce = await report(guard, { decisionId: claims.decisionId, nonce: nonce(), status: 'succeeded', ...times() });
    assert.deepEqual([wrongNonce.status, wrongNonce.body.error], [403, 'nonce-mismatch']);
    // none of the refusals were recorded, so the real report still goes through
    assert.equal((await report(guard, { decisionId: claims.decisionId, nonce: n, status: 'succeeded', ...times() })).status, 201);
  } finally { await guard.close(); }
});

test('duplicates are refused with 409 and not appended', async () => {
  const guard = await startGuard();
  try {
    const { claims, nonce: n } = await allowDecision(guard);
    const body = { decisionId: claims.decisionId, nonce: n, status: 'failed', ...times(), error: 'EACCES' };
    assert.equal((await report(guard, body)).status, 201);
    const count = guard.audit.all().length;
    const again = await report(guard, { ...body, status: 'succeeded', error: undefined });
    assert.deepEqual([again.status, again.body.error], [409, 'duplicate-outcome']);
    assert.equal(guard.audit.all().length, count);
  } finally { await guard.close(); }
});

test('a deny can only be reported as refused; an ask decision is not executable', async () => {
  const guard = await startGuard();
  try {
    const deny = await allowDecision(guard, { kind: 'prompt.send', riskSignals: ['secret:api_key'] });
    assert.equal(deny.claims.verdict, 'deny');
    const ran = await report(guard, { decisionId: deny.claims.decisionId, nonce: deny.nonce, status: 'succeeded', ...times() });
    assert.deepEqual([ran.status, ran.body.error], [409, 'verdict-mismatch']);
    const refused = await report(guard, { decisionId: deny.claims.decisionId, nonce: deny.nonce, status: 'refused', finishedAt: new Date().toISOString(), error: 'denied by Guard' });
    assert.equal(refused.status, 201);
    assert.equal(guard.audit.all().at(-1).startedAt, undefined, 'refused without startedAt is fine');

    const ask = await allowDecision(guard, DESTRUCTIVE);
    assert.equal(ask.res.status, 202);
    const askReport = await report(guard, { decisionId: ask.claims.decisionId, nonce: ask.nonce, status: 'refused', finishedAt: new Date().toISOString() });
    assert.deepEqual([askReport.status, askReport.body.error], [404, 'unknown-decision']);
  } finally { await guard.close(); }
});

test('an approved decision (via poll) accepts one outcome, tied to the approval', async () => {
  const guard = await startGuard();
  try {
    const ask = await allowDecision(guard, DESTRUCTIVE);
    const approvalId = ask.res.body.approvalId;
    assert.equal((await guard.call('POST', `/v1/approvals/${approvalId}/decide`, { token: APPROVER_TOKEN, body: { approve: true } })).status, 200);
    const poll = await guard.call('GET', `/v1/approvals/${approvalId}`, { token: DEVICE_TOKEN });
    const { claims } = verifyDecision(guard.key.publicKey, poll.body.decision);
    const res = await report(guard, { decisionId: claims.decisionId, nonce: ask.nonce, status: 'succeeded', ...times() });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(guard.audit.all().at(-1).approvalId, approvalId);
  } finally { await guard.close(); }
});

test('validation: every bad field is a 400 with a specific code', async () => {
  const guard = await startGuard();
  try {
    const { claims, nonce: n } = await allowDecision(guard);
    const good = { decisionId: claims.decisionId, nonce: n, status: 'succeeded', ...times() };
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const cases = [
      [{ ...good, decisionId: 'abc' }, 'invalid-decision-id'],
      [{ ...good, nonce: 'short' }, 'invalid-nonce'],
      [{ ...good, status: 'done' }, 'invalid-status'],
      [{ ...good, startedAt: undefined }, 'invalid-time'],
      [{ ...good, finishedAt: undefined }, 'invalid-time'],
      [{ ...good, startedAt: '2026-10-22 10:00' }, 'invalid-time'],
      [{ ...good, finishedAt: future }, 'invalid-time'],
      [{ ...good, ...times(Date.now() - 1000, -500) }, 'invalid-time'],
      [{ ...good, resultHash: 'ABC' }, 'invalid-result-hash'],
      [{ ...good, error: 'not allowed on success' }, 'invalid-error'],
      [{ ...good, status: 'failed', error: 'x'.repeat(501) }, 'invalid-error'],
      [{ ...good, output: 'the whole stdout' }, 'unknown-field'],
      [[good], 'invalid-body'],
    ];
    for (const [body, code] of cases) {
      const res = await report(guard, body);
      assert.deepEqual([res.status, res.body.error], [400, code], `${JSON.stringify(body).slice(0, 120)} -> ${JSON.stringify(res.body)}`);
    }
    assert.equal(guard.audit.all().filter((e) => e.event === 'decision.outcome').length, 0);
    assert.equal((await report(guard, good)).status, 201);
  } finally { await guard.close(); }
});

test('the reporting window closes OUTCOME_WINDOW_SECONDS after the decision expires (410)', async () => {
  // Start at the real clock: verifyDecision checks exp against Date.now().
  let t = Date.now();
  const guard = await startGuard({ now: () => t });
  try {
    const { claims, nonce: n } = await allowDecision(guard);
    t = (claims.exp + OUTCOME_WINDOW_SECONDS + 1) * 1000;
    const res = await report(guard, { decisionId: claims.decisionId, nonce: n, status: 'succeeded', ...times(t - 2000) });
    assert.deepEqual([res.status, res.body.error], [410, 'outcome-window-closed']);
  } finally { await guard.close(); }
});

test('restart: decisions and recorded outcomes are rebuilt from the audit file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eg-outcomes-'));
  const path = join(dir, 'audit.jsonl');
  const pem = generateSigningKey();
  const first = await startGuard({ audit: fileAudit(path), key: loadSigningKey(pem) });
  let a; let b;
  try {
    a = await allowDecision(first);
    b = await allowDecision(first);
    assert.equal((await report(first, { decisionId: a.claims.decisionId, nonce: a.nonce, status: 'succeeded', ...times() })).status, 201);
  } finally { await first.close(); }
  const second = await startGuard({ audit: fileAudit(path), key: loadSigningKey(pem) });
  try {
    const dup = await report(second, { decisionId: a.claims.decisionId, nonce: a.nonce, status: 'succeeded', ...times() });
    assert.deepEqual([dup.status, dup.body.error], [409, 'duplicate-outcome'], 'a restart re-opened a recorded decision');
    assert.equal((await report(second, { decisionId: b.claims.decisionId, nonce: b.nonce, status: 'failed', ...times(), error: 'timeout' })).status, 201);
    assert.equal(second.audit.verify().ok, true);
  } finally { await second.close(); }
  // Tampering with a recorded outcome breaks the chain (and refuses to start).
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  const i = lines.findIndex((l) => l.includes('"decision.outcome"'));
  lines[i] = lines[i].replace('"succeeded"', '"failed"');
  writeFileSync(path, `${lines.join('\n')}\n`);
  assert.throws(() => fileAudit(path), /failed verification/);
});
