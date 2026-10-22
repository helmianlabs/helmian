// THE VERIFICATION LOOP, end to end: the extension's background/executive.js
// against the REAL Executive Guard server, over real HTTP on loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startGuard, APPROVER_TOKEN, DEVICE_TOKEN } from '../../executive-guard/test-support/helpers.mjs';
import { memoryStorage } from '../test-support/mock-flags-api.mjs';
import {
  getExecutiveSettings, isAllowedServerUrl, pairExecutive, pollApproval, requestDecision, setExecutiveSettings, originPattern,
} from '../background/executive.js';
import { sha256Hex } from '../background/verify.js';

async function action(riskSignals = [], text = 'hello') {
  return { kind: 'prompt.send', site: 'chatgpt.com', contentHash: await sha256Hex(text), riskSignals, summary: 'redacted summary' };
}

function spyFetch() {
  const calls = [];
  const impl = (url, init) => { calls.push(url); return fetch(url, init); };
  return { calls, impl };
}

async function paired(guard) {
  const storage = memoryStorage();
  await setExecutiveSettings(storage, { enabled: true, serverUrl: guard.base, deviceToken: DEVICE_TOKEN });
  await pairExecutive(storage);
  return storage;
}

test('OFF BY DEFAULT: with nothing configured, no request is made and the local policy answers', async () => {
  const storage = memoryStorage();
  const spy = spyFetch();
  const decision = await requestDecision(storage, await action(['secret:api_key']), { fetchImpl: spy.impl });
  assert.equal(spy.calls.length, 0, 'the network was touched without configuration');
  assert.equal(decision.source, 'local');
  assert.equal(decision.verified, false);
  assert.equal(decision.verdict, 'deny');
});

test('configured but NOT paired: still local, still no request', async () => {
  const storage = memoryStorage();
  await setExecutiveSettings(storage, { enabled: true, serverUrl: 'https://guard.example', deviceToken: DEVICE_TOKEN });
  const spy = spyFetch();
  const decision = await requestDecision(storage, await action(), { fetchImpl: spy.impl });
  assert.equal(spy.calls.length, 0);
  assert.equal(decision.source, 'local');
});

test('server URLs: https anywhere, http only on loopback, no credentials or query', () => {
  assert.equal(isAllowedServerUrl('https://guard.example'), true);
  assert.equal(isAllowedServerUrl('http://localhost:8787'), true);
  assert.equal(isAllowedServerUrl('http://127.0.0.1:8787'), true);
  assert.equal(isAllowedServerUrl('http://guard.example'), false);
  assert.equal(isAllowedServerUrl('https://user:pw@guard.example'), false);
  assert.equal(isAllowedServerUrl('https://guard.example/?x=1'), false);
  assert.equal(isAllowedServerUrl('javascript:alert(1)'), false);
  assert.equal(originPattern('http://127.0.0.1:8787'), 'http://127.0.0.1/*');
});

test('pairing pins the server key; changing the server URL drops the pin', async () => {
  const guard = await startGuard();
  try {
    const storage = await paired(guard);
    const settings = await getExecutiveSettings(storage);
    assert.equal(settings.paired, true);
    assert.equal(settings.keyId, guard.key.keyId);
    assert.equal(settings.hasToken, true);
    assert.equal(JSON.stringify(settings).includes(DEVICE_TOKEN), false, 'the settings view leaks the token');
    await setExecutiveSettings(storage, { serverUrl: 'https://another.example' });
    assert.equal((await getExecutiveSettings(storage)).paired, false);
  } finally { await guard.close(); }
});

test('a clean prompt: server allow, signature verified against the pin', async () => {
  const guard = await startGuard();
  try {
    const storage = await paired(guard);
    const decision = await requestDecision(storage, await action());
    assert.equal(decision.verdict, 'allow');
    assert.equal(decision.source, 'executive-guard');
    assert.equal(decision.verified, true);
  } finally { await guard.close(); }
});

test('a secret: server deny, verified', async () => {
  const guard = await startGuard();
  try {
    const storage = await paired(guard);
    const decision = await requestDecision(storage, await action(['secret:api_key']));
    assert.equal(decision.verdict, 'deny');
    assert.equal(decision.verified, true);
    assert.equal(decision.ruleId, 'secrets-never-leave');
  } finally { await guard.close(); }
});

test('THE LOOP: ask -> pending -> approver approves on the server -> extension gets a VERIFIED allow', async () => {
  const guard = await startGuard();
  try {
    const storage = await paired(guard);
    const pendingApprovals = new Map();
    const decision = await requestDecision(storage, await action(['destructive-intent']), { pendingApprovals });
    assert.equal(decision.verdict, 'ask');
    assert.equal(decision.pending, true);
    assert.ok(pendingApprovals.has(decision.approvalId));

    assert.equal((await pollApproval(storage, decision.approvalId, { pendingApprovals })).status, 'pending');

    const approve = await guard.call('POST', `/v1/approvals/${decision.approvalId}/decide`, { token: APPROVER_TOKEN, body: { approve: true } });
    assert.equal(approve.status, 200);

    const done = await pollApproval(storage, decision.approvalId, { pendingApprovals });
    assert.deepEqual({ status: done.status, verdict: done.verdict, verified: done.verified, decidedBy: done.decidedBy },
      { status: 'approved', verdict: 'allow', verified: true, decidedBy: 'troy' });
    assert.equal(pendingApprovals.has(decision.approvalId), false, 'a used approval stays pollable');

    const audit = await guard.call('GET', '/v1/audit/verify', { token: APPROVER_TOKEN });
    assert.equal(audit.body.ok, true);
  } finally { await guard.close(); }
});

test('THE LOOP: approver denies -> verified deny', async () => {
  const guard = await startGuard();
  try {
    const storage = await paired(guard);
    const pendingApprovals = new Map();
    const decision = await requestDecision(storage, await action(['pii:ssn']), { pendingApprovals });
    await guard.call('POST', `/v1/approvals/${decision.approvalId}/decide`, { token: APPROVER_TOKEN, body: { approve: false } });
    const done = await pollApproval(storage, decision.approvalId, { pendingApprovals });
    assert.equal(done.status, 'denied');
    assert.equal(done.verdict, 'deny');
    assert.equal(done.verified, true);
  } finally { await guard.close(); }
});

test('an approval this session never asked for is not polled', async () => {
  const storage = memoryStorage();
  const spy = spyFetch();
  const result = await pollApproval(storage, 'not-mine', { pendingApprovals: new Map(), fetchImpl: spy.impl });
  assert.equal(result.status, 'unknown');
  assert.equal(spy.calls.length, 0);
});

test('FORGERY: a server that swaps its key after pairing gets a DENY, never an allow', async () => {
  const real = await startGuard();
  const impostor = await startGuard();
  try {
    const storage = await paired(real);
    // Point the paired settings at a different server, keeping the old pin.
    const raw = await storage.get('helmion.executive.settings');
    await storage.set('helmion.executive.settings', { ...raw, serverUrl: impostor.base });
    const decision = await requestDecision(storage, await action());
    assert.equal(decision.verdict, 'deny');
    assert.equal(decision.verified, false);
    assert.match(decision.reason, /did not verify/);
  } finally { await real.close(); await impostor.close(); }
});

test('FALLBACK: server down -> local policy, labelled unavailable', async () => {
  const guard = await startGuard();
  const storage = await paired(guard);
  await guard.close();
  const decision = await requestDecision(storage, await action(['pii:email']));
  assert.equal(decision.source, 'local');
  assert.equal(decision.serverUnavailable, true);
  assert.equal(decision.verdict, 'ask');
});

test('FALLBACK: a wrong device token -> local policy, labelled', async () => {
  const guard = await startGuard();
  try {
    const storage = await paired(guard);
    await setExecutiveSettings(storage, { deviceToken: 'wrong-token-xxxxxxxxxxxxxxxxxxxx' });
    const decision = await requestDecision(storage, await action());
    assert.equal(decision.source, 'local');
    assert.match(decision.error, /refused the device token/);
  } finally { await guard.close(); }
});

test('a raw secret in the summary is refused by the server and never stored', async () => {
  const guard = await startGuard();
  try {
    const storage = await paired(guard);
    const leaky = { ...(await action(['secret:api_key'])), summary: 'sk-proj-abcdefghijklmnop1234' };
    const decision = await requestDecision(storage, leaky);
    assert.equal(decision.source, 'local');
    assert.match(decision.error, /unredacted-content/);
    assert.doesNotMatch(JSON.stringify(guard.audit.all()), /abcdefghijklmnop1234/);
  } finally { await guard.close(); }
});
