import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyDecision } from '../src/signing.mjs';
import { actionHash, normalizeAction } from '../src/action.mjs';
import { startGuard, action, nonce, DEVICE_TOKEN, OTHER_DEVICE_TOKEN, APPROVER_TOKEN } from '../test-support/helpers.mjs';

function claimsOf(guard, envelope) {
  const result = verifyDecision(guard.key.publicKey, envelope);
  assert.equal(result.ok, true, result.error);
  return result.claims;
}

test('health and keys need no auth; keys publish the Ed25519 public key only', async () => {
  const guard = await startGuard();
  try {
    assert.equal((await guard.call('GET', '/healthz')).status, 200);
    const keys = await guard.call('GET', '/v1/keys');
    assert.equal(keys.status, 200);
    assert.equal(keys.body.alg, 'Ed25519');
    assert.equal(keys.body.keyId, guard.key.keyId);
    assert.deepEqual(Object.keys(keys.body.publicKeyJwk).sort(), ['crv', 'kty', 'x']);
  } finally { await guard.close(); }
});

test('no CORS headers are sent, so a web page cannot read decisions', async () => {
  const guard = await startGuard();
  try {
    const res = await guard.call('GET', '/v1/keys', { headers: { origin: 'https://evil.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally { await guard.close(); }
});

test('decisions need a valid device token', async () => {
  const guard = await startGuard();
  try {
    assert.equal((await guard.call('POST', '/v1/decisions', { body: { action: action(), nonce: nonce() } })).status, 401);
    assert.equal((await guard.call('POST', '/v1/decisions', { token: 'wrong-token-xxxxxxxxxxxxxxxxxx', body: { action: action(), nonce: nonce() } })).status, 401);
    assert.equal((await guard.call('POST', '/v1/decisions', { token: APPROVER_TOKEN, body: { action: action(), nonce: nonce() } })).status, 401,
      'an approver token must not act as a device');
  } finally { await guard.close(); }
});

test('a clean prompt gets a signed allow bound to the action, nonce and device', async () => {
  const guard = await startGuard();
  try {
    const n = nonce();
    const res = await guard.call('POST', '/v1/decisions', { token: DEVICE_TOKEN, body: { action: action(), nonce: n } });
    assert.equal(res.status, 200);
    assert.equal(res.body.verdict, 'allow');
    const claims = claimsOf(guard, res.body.decision);
    assert.equal(claims.verdict, 'allow');
    assert.equal(claims.nonce, n);
    assert.equal(claims.deviceId, 'troy-laptop');
    assert.equal(claims.actionHash, actionHash(normalizeAction(action())));
    assert.ok(claims.exp > claims.iat);
  } finally { await guard.close(); }
});

test('a secret is denied with a signed deny, and the audit records it without the secret', async () => {
  const guard = await startGuard();
  try {
    const res = await guard.call('POST', '/v1/decisions', {
      token: DEVICE_TOKEN,
      body: { action: action({ riskSignals: ['secret:api_key'], summary: 'my key is [REDACTED:api_key]' }), nonce: nonce() },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.verdict, 'deny');
    assert.equal(claimsOf(guard, res.body.decision).verdict, 'deny');
    const last = guard.audit.all().at(-1);
    assert.equal(last.event, 'decision.issued');
    assert.equal(last.verdict, 'deny');
    assert.equal(last.ruleId, 'secrets-never-leave');
  } finally { await guard.close(); }
});

test('an unredacted secret in the summary is refused and audited as rejected', async () => {
  const guard = await startGuard();
  try {
    const res = await guard.call('POST', '/v1/decisions', {
      token: DEVICE_TOKEN,
      body: { action: action({ summary: 'token ghp_abcdefghijklmnopqrstuvwx1234' }), nonce: nonce() },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'unredacted-content');
    const last = guard.audit.all().at(-1);
    assert.equal(last.event, 'decision.rejected');
    assert.doesNotMatch(JSON.stringify(guard.audit.all()), /ghp_abcdefghij/);
  } finally { await guard.close(); }
});

test('a replayed nonce is refused', async () => {
  const guard = await startGuard();
  try {
    const n = nonce();
    assert.equal((await guard.call('POST', '/v1/decisions', { token: DEVICE_TOKEN, body: { action: action(), nonce: n } })).status, 200);
    const again = await guard.call('POST', '/v1/decisions', { token: DEVICE_TOKEN, body: { action: action(), nonce: n } });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'replayed-nonce');
  } finally { await guard.close(); }
});

test('bad input: wrong content type, bad JSON, oversize body, short nonce', async () => {
  const guard = await startGuard();
  try {
    assert.equal((await guard.call('POST', '/v1/decisions', { token: DEVICE_TOKEN, body: 'x', headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await guard.call('POST', '/v1/decisions', { token: DEVICE_TOKEN, body: '{nope' })).status, 400);
    assert.equal((await guard.call('POST', '/v1/decisions', { token: DEVICE_TOKEN, body: { pad: 'x'.repeat(40000) } })).status, 413);
    assert.equal((await guard.call('POST', '/v1/decisions', { token: DEVICE_TOKEN, body: { action: action(), nonce: 'short' } })).status, 400);
  } finally { await guard.close(); }
});

test('THE FULL LOOP: destructive prompt -> ask -> approver approves -> signed allow -> audit chain verifies', async () => {
  const guard = await startGuard();
  try {
    const n = nonce();
    const asked = await guard.call('POST', '/v1/decisions', {
      token: DEVICE_TOKEN,
      body: { action: action({ riskSignals: ['destructive-intent'], summary: 'Permanently erase all computer files.' }), nonce: n },
    });
    assert.equal(asked.status, 202);
    assert.equal(asked.body.verdict, 'ask');
    const { approvalId } = asked.body;
    assert.equal(claimsOf(guard, asked.body.decision).verdict, 'ask');

    const pending = await guard.call('GET', `/v1/approvals/${approvalId}`, { token: DEVICE_TOKEN });
    assert.equal(pending.body.status, 'pending');
    assert.equal(pending.body.decision, undefined, 'a pending approval must not carry a decision');

    const list = await guard.call('GET', '/v1/approvals?status=pending', { token: APPROVER_TOKEN });
    assert.equal(list.body.approvals.length, 1);
    assert.equal(list.body.approvals[0].nonce, undefined, 'the nonce is not shown to approvers');

    assert.equal((await guard.call('POST', `/v1/approvals/${approvalId}/decide`, { token: DEVICE_TOKEN, body: { approve: true } })).status, 401,
      'a device cannot approve its own request');

    const approved = await guard.call('POST', `/v1/approvals/${approvalId}/decide`, { token: APPROVER_TOKEN, body: { approve: true, reason: 'scratch VM' } });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.approval.status, 'approved');

    const done = await guard.call('GET', `/v1/approvals/${approvalId}`, { token: DEVICE_TOKEN });
    assert.equal(done.body.status, 'approved');
    const claims = claimsOf(guard, done.body.decision);
    assert.equal(claims.verdict, 'allow');
    assert.equal(claims.nonce, n, 'the approval is bound to the original nonce');
    assert.equal(claims.approvalId, approvalId);
    assert.equal(claims.decidedBy, 'troy');

    assert.equal((await guard.call('POST', `/v1/approvals/${approvalId}/decide`, { token: APPROVER_TOKEN, body: { approve: false } })).status, 409,
      'an approval cannot be decided twice');

    const audit = await guard.call('GET', '/v1/audit', { token: APPROVER_TOKEN });
    assert.deepEqual(audit.body.entries.map((e) => e.event), ['approval.requested', 'approval.approved']);
    const verify = await guard.call('GET', '/v1/audit/verify', { token: APPROVER_TOKEN });
    assert.equal(verify.body.ok, true);
  } finally { await guard.close(); }
});

test('a denied approval returns a signed deny', async () => {
  const guard = await startGuard();
  try {
    const asked = await guard.call('POST', '/v1/decisions', { token: DEVICE_TOKEN, body: { action: action({ riskSignals: ['pii:ssn'] }), nonce: nonce() } });
    await guard.call('POST', `/v1/approvals/${asked.body.approvalId}/decide`, { token: APPROVER_TOKEN, body: { approve: false } });
    const done = await guard.call('GET', `/v1/approvals/${asked.body.approvalId}`, { token: DEVICE_TOKEN });
    assert.equal(done.body.status, 'denied');
    assert.equal(claimsOf(guard, done.body.decision).verdict, 'deny');
  } finally { await guard.close(); }
});

test('another device cannot read someone else\'s approval', async () => {
  const guard = await startGuard();
  try {
    const asked = await guard.call('POST', '/v1/decisions', { token: DEVICE_TOKEN, body: { action: action({ riskSignals: ['pii:ssn'] }), nonce: nonce() } });
    assert.equal((await guard.call('GET', `/v1/approvals/${asked.body.approvalId}`, { token: OTHER_DEVICE_TOKEN })).status, 404);
  } finally { await guard.close(); }
});

test('approvals expire after 15 minutes and cannot then be approved', async () => {
  let clock = Date.parse('2026-10-22T09:00:00Z');
  const guard = await startGuard({ now: () => clock });
  try {
    const asked = await guard.call('POST', '/v1/decisions', { token: DEVICE_TOKEN, body: { action: action({ riskSignals: ['pii:ssn'] }), nonce: nonce() } });
    clock += 16 * 60 * 1000;
    const status = await guard.call('GET', `/v1/approvals/${asked.body.approvalId}`, { token: DEVICE_TOKEN });
    assert.equal(status.body.status, 'expired');
    assert.equal((await guard.call('POST', `/v1/approvals/${asked.body.approvalId}/decide`, { token: APPROVER_TOKEN, body: { approve: true } })).status, 409);
    assert.ok(guard.audit.all().some((e) => e.event === 'approval.expired'));
  } finally { await guard.close(); }
});

test('a decision signed by a different key does not verify', async () => {
  const a = await startGuard();
  const b = await startGuard();
  try {
    const res = await a.call('POST', '/v1/decisions', { token: DEVICE_TOKEN, body: { action: action(), nonce: nonce() } });
    assert.equal(verifyDecision(b.key.publicKey, res.body.decision).ok, false);
    const tampered = { ...res.body.decision, payload: res.body.decision.payload.slice(0, -2) + 'AA' };
    assert.equal(verifyDecision(a.key.publicKey, tampered).ok, false);
  } finally { await a.close(); await b.close(); }
});

test('audit and approval lists need an approver token', async () => {
  const guard = await startGuard();
  try {
    assert.equal((await guard.call('GET', '/v1/audit')).status, 401);
    assert.equal((await guard.call('GET', '/v1/audit', { token: DEVICE_TOKEN })).status, 401);
    assert.equal((await guard.call('GET', '/v1/approvals', { token: DEVICE_TOKEN })).status, 401);
  } finally { await guard.close(); }
});

test('short tokens in config are ignored rather than accepted', async () => {
  const guard = await startGuard({ deviceTokens: { weak: 'short' } });
  try {
    assert.equal((await guard.call('POST', '/v1/decisions', { token: 'short', body: { action: action(), nonce: nonce() } })).status, 401);
  } finally { await guard.close(); }
});
