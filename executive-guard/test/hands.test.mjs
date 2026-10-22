// The /guard/v1 interface PR #52's hands MCP connector calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { argumentsDigest, verifyHands } from '../src/hands.mjs';
import { startGuard, action, nonce, APPROVER_TOKEN, DEVICE_TOKEN, SERVICE_TOKEN, OTHER_SERVICE_TOKEN } from '../test-support/helpers.mjs';

let seq = 0;
function request(tool, args, extra = {}) {
  seq += 1;
  return {
    requestId: `hreq_test${String(seq).padStart(6, '0')}`,
    actor: { kind: 'ai-client', clientId: 'claude', subject: 'user_troy', scopes: ['hands.read', 'hands.act'] },
    tool,
    target: { spoke: 'pc', deviceId: 'desktop_1' },
    arguments: args,
    argumentsDigest: argumentsDigest(args),
    context: { sessionId: 's1', routeReason: 'Needs powershell, which only the PC has.' },
    requestedAt: new Date().toISOString(),
    ...extra,
  };
}
const decide = (guard, body, token = SERVICE_TOKEN) => guard.call('POST', '/guard/v1/decide', { token, body });
const fields = (b) => ({ decisionId: b.decisionId, requestId: b.requestId, argumentsDigest: b.argumentsDigest, decision: b.decision, expiresAt: b.expiresAt });

async function withGuard(fn, options) {
  const guard = await startGuard(options);
  try { await fn(guard); } finally { await guard.close(); }
}

test('keys: /guard/v1/keys is the same Ed25519 key as /v1/keys and documents the signing string', () => withGuard(async (guard) => {
  const a = (await guard.call('GET', '/guard/v1/keys')).body;
  const b = (await guard.call('GET', '/v1/keys')).body;
  assert.equal(a.keyId, b.keyId);
  assert.deepEqual(a.publicKeyJwk, b.publicKeyJwk);
  assert.deepEqual(a.signedFields, ['decisionId', 'requestId', 'argumentsDigest', 'decision', 'expiresAt']);
}));

test('auth: only service tokens; device and approver tokens are refused', () => withGuard(async (guard) => {
  const body = request('hands.ollama_generate', { model: 'llama3', prompt: 'hi' });
  assert.equal((await decide(guard, body, null)).status, 401);
  assert.equal((await decide(guard, body, DEVICE_TOKEN)).status, 401);
  assert.equal((await decide(guard, body, APPROVER_TOKEN)).status, 401);
  assert.equal((await decide(guard, body)).status, 200);
}));

test('decide: allow carries every PR #52 field and a signature that verifies over the five fields', () => withGuard(async (guard) => {
  const r = await decide(guard, request('hands.read_file', { path: 'E:\\Helmion\\README.md', maxBytes: 4096 }));
  assert.equal(r.status, 200);
  const b = r.body;
  assert.equal(b.decision, 'allow');
  assert.match(b.decisionId, /^gdec_/);
  assert.equal(typeof b.reason, 'string');
  assert.deepEqual(b.constraints, { maxRuntimeMs: 30000, maxOutputBytes: 65536, readOnly: true });
  assert.match(b.signature, /^ed25519:[A-Za-z0-9_-]+$/);
  assert.equal(b.approval, undefined);
  const pub = createPublicKey({ key: (await guard.call('GET', '/guard/v1/keys')).body.publicKeyJwk, format: 'jwk' });
  assert.equal(verifyHands(pub, fields(b), b.signature), true);
  assert.equal(verifyHands(pub, { ...fields(b), decision: 'deny' }, b.signature), false, 'a changed decision must not verify');
  assert.equal(verifyHands(pub, { ...fields(b), argumentsDigest: argumentsDigest({ path: 'x' }) }, b.signature), false);
}));

test('decide: the default postures from PR #52 §4', () => withGuard(async (guard) => {
  const cases = [
    ['hands.list_files', { path: 'E:/Helmion/src', glob: '*.mjs' }, {}, 'allow'],
    ['hands.list_files', { path: 'C:\\Users\\troy', glob: '*' }, {}, 'deny'],
    ['hands.read_file', { path: 'E:\\Helmion\\..\\secrets.txt' }, {}, 'deny'],
    ['hands.read_file', { path: 'E:\\Helmion\\.env' }, {}, 'deny'],
    ['hands.read_file', { path: 'e:\\helmion\\keys\\server.pem' }, {}, 'deny'],
    ['hands.read_file', { path: '/srv/helmian/work/log.txt' }, { target: { spoke: 'runner', deviceId: 'hetzner' } }, 'allow'],
    ['hands.ollama_generate', { model: 'llama3', prompt: 'hi' }, {}, 'allow'],
    ['hands.ollama_generate', { model: 'llama3', prompt: 'hi' }, { target: { spoke: 'runner' } }, 'deny'],
    ['hands.run_powershell', { commandId: 'git-status', args: { repo: 'E:\\Helmion' } }, {}, 'pending_approval'],
    ['hands.run_powershell', { commandId: 'Remove-Item -Recurse C:\\' }, {}, 'deny'],
    ['hands.run_powershell', { commandId: 'format-disk' }, {}, 'deny'],
    ['hands.run_powershell', { commandId: 'git-status', args: { repo: 'x; rm -rf /' } }, {}, 'deny'],
    ['hands.open_url', { url: 'https://docs.helmian.cloud/a' }, {}, 'allow'],
    ['hands.open_url', { url: 'https://example.com/' }, {}, 'pending_approval'],
    ['hands.open_url', { url: 'http://example.com/' }, {}, 'deny'],
    ['hands.write_file', { path: 'E:\\Helmion\\notes.md', content: 'hello' }, {}, 'pending_approval'],
    ['hands.write_file', { path: 'C:\\Windows\\x.dll', content: 'x' }, {}, 'deny'],
    ['hands.delete_everything', {}, {}, 'deny'],
    ['hands.write_file', { path: 'E:\\Helmion\\n.md', content: 'x' }, { actor: { kind: 'ai-client', scopes: ['hands.read'] } }, 'deny'],
  ];
  for (const [tool, args, extra, want] of cases) {
    const r = await decide(guard, request(tool, args, extra));
    assert.equal(r.status, 200, `${tool} ${JSON.stringify(args)} -> ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.decision, want, `${tool} ${JSON.stringify(args)}: ${r.body.reason}`);
  }
}));

test('decide: argumentsDigest is recomputed; a mismatch, a stale request or a bad shape is a 400', () => withGuard(async (guard) => {
  const good = request('hands.ollama_generate', { model: 'llama3', prompt: 'hi' });
  assert.equal((await decide(guard, { ...good, argumentsDigest: argumentsDigest({ model: 'other' }) })).body.error, 'arguments-digest-mismatch');
  assert.equal((await decide(guard, { ...good, argumentsDigest: 'sha256:ABC' })).body.error, 'invalid-arguments-digest');
  assert.equal((await decide(guard, { ...good, requestId: `hreq_stale${seq}`, requestedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() })).body.error, 'stale-request');
  assert.equal((await decide(guard, { ...good, target: { spoke: 'phone' } })).status, 400);
  assert.equal((await decide(guard, { ...good, requestId: 'x' })).status, 400);
}));

test('idempotency: the same requestId returns the same decision; reuse with other arguments is 409', () => withGuard(async (guard) => {
  const body = request('hands.ollama_generate', { model: 'llama3', prompt: 'hi' });
  const a = await decide(guard, body);
  const b = await decide(guard, body);
  assert.deepEqual(b.body, a.body);
  const other = { ...body, arguments: { model: 'llama3', prompt: 'bye' }, argumentsDigest: argumentsDigest({ model: 'llama3', prompt: 'bye' }) };
  assert.equal((await decide(guard, other)).status, 409);
  assert.equal((await decide(guard, body, OTHER_SERVICE_TOKEN)).status, 409, 'another service cannot read a decision by guessing a requestId');
}));

test('approval: pending -> approver approves -> one signed allow bound to the same digest; re-polls return the same decisionId', () => withGuard(async (guard) => {
  const req = request('hands.run_powershell', { commandId: 'git-status', args: { repo: 'E:\\Helmion' } });
  const r = (await decide(guard, req)).body;
  assert.equal(r.decision, 'pending_approval');
  assert.match(r.approval.approvalId, /^gapr_/);
  assert.equal(r.approval.channel, 'app');
  assert.equal(r.approval.expiresAt, r.expiresAt);
  assert.equal(r.constraints.readOnly, false);
  const pending = (await guard.call('GET', `/guard/v1/approvals/${r.approval.approvalId}`, { token: SERVICE_TOKEN })).body;
  assert.equal(pending.state, 'pending');
  assert.equal(pending.signature, null);

  // The approver sees it in the existing list and decides it there.
  const list = (await guard.call('GET', '/v1/approvals?status=pending', { token: APPROVER_TOKEN })).body.approvals;
  const mine = list.find((a) => a.id === r.approval.approvalId);
  assert.equal(mine.tool, 'hands.run_powershell');
  assert.deepEqual(mine.arguments, req.arguments);
  // Long-poll: the answer arrives while the request is open.
  const waiting = guard.call('GET', `/guard/v1/approvals/${r.approval.approvalId}?waitMs=5000`, { token: SERVICE_TOKEN });
  await new Promise((res) => setTimeout(res, 300));
  await guard.call('POST', `/v1/approvals/${r.approval.approvalId}/decide`, { token: APPROVER_TOKEN, body: { approve: true } });
  const done = (await waiting).body;
  assert.equal(done.state, 'approved');
  assert.equal(done.decidedBy, 'troy');
  assert.equal(done.decision, 'allow');
  assert.equal(done.argumentsDigest, req.argumentsDigest);
  const pub = createPublicKey({ key: guard.key.publicJwk, format: 'jwk' });
  assert.equal(verifyHands(pub, fields(done), done.signature), true);
  const again = (await guard.call('GET', `/guard/v1/approvals/${r.approval.approvalId}`, { token: SERVICE_TOKEN })).body;
  assert.equal(again.decisionId, done.decisionId);
  // Another service cannot see it.
  assert.equal((await guard.call('GET', `/guard/v1/approvals/${r.approval.approvalId}`, { token: OTHER_SERVICE_TOKEN })).status, 404);
  // A device token cannot see it through the extension endpoint either.
  assert.equal((await guard.call('GET', `/v1/approvals/${r.approval.approvalId}`, { token: DEVICE_TOKEN })).status, 404);
}));

test('approval: denied gives a signed deny; an unanswered one expires', async () => {
  let clock = Date.now();
  await withGuard(async (guard) => {
    const r = (await decide(guard, request('hands.write_file', { path: 'E:\\Helmion\\a.md', content: 'secret plan' }))).body;
    const list = (await guard.call('GET', '/v1/approvals?status=pending', { token: APPROVER_TOKEN })).body.approvals;
    assert.deepEqual(list.find((a) => a.id === r.approval.approvalId).arguments.content.bytes, 11, 'file content is summarized, not copied');
    assert.doesNotMatch(JSON.stringify(guard.audit.all()), /secret plan/);
    await guard.call('POST', `/v1/approvals/${r.approval.approvalId}/decide`, { token: APPROVER_TOKEN, body: { approve: false } });
    const denied = (await guard.call('GET', `/guard/v1/approvals/${r.approval.approvalId}`, { token: SERVICE_TOKEN })).body;
    assert.equal(denied.state, 'denied');
    assert.equal(denied.decision, 'deny');
    assert.ok(denied.signature);

    const p = (await decide(guard, request('hands.open_url', { url: 'https://example.com/x' }))).body;
    clock += 16 * 60 * 1000;
    const expired = (await guard.call('GET', `/guard/v1/approvals/${p.approval.approvalId}`, { token: SERVICE_TOKEN })).body;
    assert.equal(expired.state, 'expired');
    assert.equal(expired.signature, null);
  }, { now: () => clock });
});

test('audit: outcomes append to the hash chain; executing a deny or executing twice is refused and recorded', () => withGuard(async (guard) => {
  const allow = (await decide(guard, request('hands.ollama_generate', { model: 'llama3', prompt: 'hi' }))).body;
  const entry = (outcome, extra = {}) => ({ decisionId: allow.decisionId, requestId: allow.requestId, outcome, spoke: 'pc', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), outputDigest: argumentsDigest({ out: 1 }), ...extra });
  const ok = await guard.call('POST', '/guard/v1/audit', { token: SERVICE_TOKEN, body: entry('executed') });
  assert.equal(ok.status, 201);
  assert.ok(ok.body.seq > 0);
  assert.equal((await guard.call('POST', '/guard/v1/audit', { token: SERVICE_TOKEN, body: entry('executed') })).body.error, 'already-executed');

  const deny = (await decide(guard, request('hands.read_file', { path: 'C:\\x' }))).body;
  assert.equal((await guard.call('POST', '/guard/v1/audit', { token: SERVICE_TOKEN, body: { ...entry('executed'), decisionId: deny.decisionId, requestId: deny.requestId } })).body.error, 'not-allowed');
  assert.equal((await guard.call('POST', '/guard/v1/audit', { token: SERVICE_TOKEN, body: { ...entry('refused_by_spoke'), decisionId: deny.decisionId, requestId: deny.requestId } })).status, 201);

  assert.equal((await guard.call('POST', '/guard/v1/audit', { token: SERVICE_TOKEN, body: entry('teleported') })).status, 400);
  assert.equal((await guard.call('POST', '/guard/v1/audit', { token: SERVICE_TOKEN, body: entry('executed', { requestId: 'hreq_other00' }) })).status, 400);
  assert.equal((await guard.call('POST', '/guard/v1/audit', { token: OTHER_SERVICE_TOKEN, body: entry('failed') })).status, 404);
  assert.equal((await guard.call('POST', '/guard/v1/audit', { token: SERVICE_TOKEN, body: { ...entry('executed'), decisionId: 'gdec_nope' } })).status, 404);

  const events = guard.audit.all().map((e) => e.event);
  assert.ok(events.includes('hands.executed'));
  assert.ok(events.includes('hands.refused_by_spoke'));
  assert.equal(events.filter((e) => e === 'hands.violation').length, 2);
  assert.equal((await guard.call('GET', '/v1/audit/verify', { token: APPROVER_TOKEN })).body.ok, true);
}));

test('the extension endpoints are unchanged alongside /guard/v1', () => withGuard(async (guard) => {
  const r = await guard.call('POST', '/v1/decisions', { token: DEVICE_TOKEN, body: { action: action(), nonce: nonce() } });
  assert.equal(r.status, 200);
  assert.equal(r.body.verdict, 'allow');
  assert.equal((await guard.call('POST', '/v1/decisions', { token: SERVICE_TOKEN, body: { action: action(), nonce: nonce() } })).status, 401, 'a service token is not a device');
}));
