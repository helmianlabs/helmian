// End-to-end over real HTTP: OAuth (DCR + PKCE + passphrase consent) -> MCP
// tools/call -> routing -> Executive Guard (mock with the real envelope) ->
// PC spoke (real executor on a temp workspace). Proves the fail-closed rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createOAuth } from '../src/oauth.mjs';
import { createGuardClient } from '../src/guard-client.mjs';
import { createSpokeHub } from '../src/spoke-hub.mjs';
import { createAudit } from '../src/audit.mjs';
import { createHands } from '../src/hands.mjs';
import { createApp } from '../src/server.mjs';
import { createSpokeTokens } from '../src/spoke-tokens.mjs';
import { confinePath, createExecutor, pairSpoke, readSpokeConfig, startSpoke } from '../../src/hands/pc-spoke.mjs';
import { buildGuardAction, describeHandsAction, guardActionHash, PHONE_ACT_COMMANDS, PHONE_READ_COMMANDS, POWERSHELL_COMMANDS, TOOLS, validateArgs } from '../src/shared/protocol.mjs';
import { listen, mockGuard, pkce } from './helpers.mjs';

const PASS = 'correct horse battery staple';

async function boot({ handsEnabled = true, guard = null, guardUrl = null, holdOpenWaitMs = 400 } = {}) {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await mkdtemp(join(tmpdir(), 'hands-state-'));
  const config = loadConfig({
    PUBLIC_URL: base, AUTH_PASSPHRASE: PASS, HANDS_ENABLED: handsEnabled ? 'true' : 'false', STATE_DIR: state,
    HANDS_HOLD_OPEN_WAIT_MS: String(holdOpenWaitMs),
    ...(guardUrl ? { GUARD_URL: guardUrl, GUARD_DEVICE_TOKEN: guard.deviceToken, GUARD_PUBLIC_KEY_X: guard.x, GUARD_APPROVAL_WAIT_MS: '300' } : {}),
  });
  const oauth = createOAuth({ resourceId: `${base}/mcp`, stateFile: join(state, 'oauth.json') });
  const guardClient = createGuardClient({ ...config.guard, pollMs: 50, timeoutMs: 1000 });
  const hub = createSpokeHub({ pollWaitMs: 300, resultWaitMs: 3000 });
  const audit = createAudit(null);
  const hands = createHands({ config, guard: guardClient, hub, audit });
  const spokeTokens = createSpokeTokens({ file: join(state, 'spoke.json'), passphrase: PASS });
  server.on('request', createApp({ config, oauth, hands, hub, spokeTokens }));
  return { base, audit, hub, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

async function connect(base, scope) {
  const reg = await (await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'test-ai', redirect_uris: ['https://client.example/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })).json();
  const { verifier, challenge } = pkce();
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://client.example/cb', code_challenge: challenge, code_challenge_method: 'S256', scope, state: 's1' });
  const page = await (await fetch(`${base}/authorize?${q}`, { redirect: 'manual' })).text();
  const pendingId = /name="pending_id" value="([^"]+)"/.exec(page)[1];
  const wrong = await fetch(`${base}/consent`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ pending_id: pendingId, action: 'approve', passphrase: 'nope' }) });
  assert.equal(wrong.status, 401);
  const ok = await fetch(`${base}/consent`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ pending_id: pendingId, action: 'approve', passphrase: PASS }) });
  assert.equal(ok.status, 302);
  const code = new URL(ok.headers.get('location')).searchParams.get('code');
  const tok = await (await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: 'https://client.example/cb' }) })).json();
  assert.ok(tok.access_token, JSON.stringify(tok));
  return tok.access_token;
}

let rpcId = 0;
async function callTool(base, token, name, args = {}) {
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  const body = await res.json();
  assert.ok(body.result, JSON.stringify(body));
  return { text: body.result.content.map((c) => c.text).join('\n'), isError: body.result.isError === true };
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'hands-ws-'));
  await writeFile(join(root, 'notes.txt'), 'hello from the PC');
  await writeFile(join(root, '.env'), 'SECRET=1');
  return root;
}

async function pairAndRun(base, root, extra = {}) {
  const configPath = join(await mkdtemp(join(tmpdir(), 'hands-cfg-')), 'hands-spoke.json');
  await pairSpoke({ url: base, passphrase: PASS, roots: [root], configPath, deviceId: 'pc-test' });
  const config = { ...(await readSpokeConfig(configPath)), usedDecisionsPath: join(dirname(configPath), 'used.json'), ...extra };
  const spoke = startSpoke({ config, log: () => {} });
  await new Promise((r) => setTimeout(r, 150));
  return spoke;
}

test('unauthenticated MCP calls get a 401 pointing at the resource metadata', async () => {
  const app = await boot();
  const res = await fetch(`${app.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') || '', /resource_metadata/);
  const meta = await (await fetch(`${app.base}/.well-known/oauth-authorization-server`)).json();
  assert.ok(meta.registration_endpoint && meta.code_challenge_methods_supported.includes('S256'));
  await app.close();
});

test('read-only tools run on the PC through OAuth + routing without Guard; secrets and escapes refused', async () => {
  const app = await boot();
  const token = await connect(app.base, 'hands.read');
  const root = await workspace();
  // PC not connected yet: routing refuses, nothing queued.
  const off = await callTool(app.base, token, 'read_file', { path: join(root, 'notes.txt') });
  assert.ok(off.isError);
  assert.match(off.text, /PC is off/);
  const spoke = await pairAndRun(app.base, root);
  const read = await callTool(app.base, token, 'read_file', { path: join(root, 'notes.txt') });
  assert.equal(read.isError, false, read.text);
  assert.equal(read.text, 'hello from the PC');
  const list = await callTool(app.base, token, 'list_files', { path: root });
  assert.match(list.text, /notes\.txt/);
  assert.doesNotMatch(list.text, /\.env/);
  assert.match((await callTool(app.base, token, 'read_file', { path: join(root, '.env') })).text, /secrets path/);
  assert.match((await callTool(app.base, token, 'read_file', { path: '/etc/hostname' })).text, /Outside the workspace roots/);
  const status = JSON.parse((await callTool(app.base, token, 'hands_status')).text);
  assert.equal(status.pc.online, true);
  assert.equal(status.guardLive, false);
  spoke.stop();
  await app.close();
});

test('mutating tools are denied when Guard is not configured, and the PC never sees the job', async () => {
  const app = await boot();
  const token = await connect(app.base, 'hands.read hands.act');
  const root = await workspace();
  const spoke = await pairAndRun(app.base, root);
  const r = await callTool(app.base, token, 'write_file', { path: join(root, 'x.txt'), content: 'nope' });
  assert.ok(r.isError);
  assert.match(r.text, /Guard is not live/);
  await assert.rejects(readFile(join(root, 'x.txt')));
  assert.ok(app.audit.rows().some((row) => row.event === 'denied.guard'));
  spoke.stop();
  await app.close();
});

test('mutating tools are denied when Guard is unreachable', async () => {
  const guard = mockGuard();
  const app = await boot({ guard, guardUrl: 'http://127.0.0.1:9' });
  const token = await connect(app.base, 'hands.act');
  const root = await workspace();
  const spoke = await pairAndRun(app.base, root);
  const r = await callTool(app.base, token, 'write_file', { path: join(root, 'u.txt'), content: 'x' });
  spoke.stop();
  assert.ok(r.isError);
  assert.match(r.text, /unreachable/);
  spoke.stop();
  await app.close();
});

test('a Guard auto-allow without a human approval is not enough', async () => {
  const guard = mockGuard({ mode: 'allow' });
  const g = await listen(guard.handler);
  const app = await boot({ guard, guardUrl: g.url });
  const token = await connect(app.base, 'hands.act');
  const root = await workspace();
  const spoke = await pairAndRun(app.base, root);
  const r = await callTool(app.base, token, 'write_file', { path: join(root, 'x.txt'), content: 'nope' });
  assert.match(r.text, /without a human approval/);
  spoke.stop();
  await app.close(); await g.close();
});

test('a read-only token cannot request mutating tools', async () => {
  const app = await boot();
  const token = await connect(app.base, 'hands.read');
  const r = await callTool(app.base, token, 'open_url', { url: 'https://example.com' });
  assert.match(r.text, /not granted hands\.act/);
  await app.close();
});

test('kill switch: HANDS_ENABLED=false refuses everything', async () => {
  const app = await boot({ handsEnabled: false });
  const token = await connect(app.base, 'hands.read');
  assert.match((await callTool(app.base, token, 'list_files', { path: '/' })).text, /Hands are off/);
  await app.close();
});

test('human approval in Guard -> resume_action -> the PC verifies the signature itself and writes the file', async () => {
  const guard = mockGuard({ mode: 'ask' });
  const g = await listen(guard.handler);
  const app = await boot({ guard, guardUrl: g.url });
  const token = await connect(app.base, 'hands.act');
  const root = await workspace();
  const target = join(root, 'approved.txt');
  // The PC pins the Guard key locally.
  const spoke = await pairAndRun(app.base, root, { guardPublicKeyX: guard.x });
  const first = await callTool(app.base, token, 'write_file', { path: target, content: 'approved write' });
  assert.match(first.text, /Waiting for a human approval/);
  const requestId = /requestId "([^"]+)"/.exec(first.text)[1];
  await assert.rejects(readFile(target));
  const [approvalId] = guard.approvals.keys();
  guard.decide(approvalId, true);
  const done = await callTool(app.base, token, 'resume_action', { requestId });
  assert.equal(done.isError, false, done.text);
  assert.equal(await readFile(target, 'utf8'), 'approved write');
  // Single use.
  assert.match((await callTool(app.base, token, 'resume_action', { requestId })).text, /No pending action/);
  spoke.stop();
  await app.close(); await g.close();
});

test('a human denial in Guard means nothing runs', async () => {
  const guard = mockGuard({ mode: 'ask' });
  const g = await listen(guard.handler);
  const app = await boot({ guard, guardUrl: g.url });
  const token = await connect(app.base, 'hands.act');
  const root = await workspace();
  const spoke = await pairAndRun(app.base, root, { guardPublicKeyX: guard.x });
  const first = await callTool(app.base, token, 'write_file', { path: join(root, 'd.txt'), content: 'x' });
  const requestId = /requestId "([^"]+)"/.exec(first.text)[1];
  guard.decide([...guard.approvals.keys()][0], false);
  assert.match((await callTool(app.base, token, 'resume_action', { requestId })).text, /human denied/);
  await assert.rejects(readFile(join(root, 'd.txt')));
  spoke.stop();
  await app.close(); await g.close();
});

test('the PC refuses mutating jobs a compromised hub forwards', async () => {
  const guard = mockGuard();
  const root = await workspace();
  const args = { path: join(root, 'evil.txt'), content: 'pwned' };
  const hash = guardActionHash(buildGuardAction('write_file', args));
  const iat = Math.floor(Date.now() / 1000);
  const good = guard.forge({ decisionId: 'd1', verdict: 'allow', actionHash: hash, deviceId: 'hands-mcp', nonce: 'n'.repeat(20), iat, exp: iat + 300, approvalId: 'a1', decidedBy: 'troy' });
  const job = { tool: 'write_file', args, nonce: 'n'.repeat(20), guardDecision: good };

  // No pinned key on the PC.
  assert.match((await createExecutor({ roots: [root] }).execute(job)).error, /no Executive Guard key is pinned/);
  // Pinned key, but a different signer.
  const other = mockGuard();
  assert.match((await createExecutor({ roots: [root], guardPublicKeyX: other.x }).execute(job)).error, /bad signature/);
  const exec = createExecutor({ roots: [root], guardPublicKeyX: guard.x });
  // Approval for different arguments.
  assert.match((await exec.execute({ ...job, args: { ...args, content: 'other' } })).error, /different arguments/);
  // No decision at all.
  assert.match((await exec.execute({ ...job, guardDecision: null })).error, /malformed/);
  // Auto-allow without a human.
  const auto = guard.forge({ decisionId: 'd2', verdict: 'allow', actionHash: hash, deviceId: 'hands-mcp', nonce: 'n'.repeat(20), iat, exp: iat + 300 });
  assert.match((await exec.execute({ ...job, guardDecision: auto })).error, /not a human approval/);
  // Expired.
  const old = guard.forge({ decisionId: 'd3', verdict: 'allow', actionHash: hash, deviceId: 'hands-mcp', nonce: 'n'.repeat(20), iat: iat - 900, exp: iat - 600, approvalId: 'a', decidedBy: 'troy' });
  assert.match((await exec.execute({ ...job, guardDecision: old })).error, /expired/);
  // The genuine approval works exactly once.
  assert.equal((await exec.execute(job)).ok, true);
  assert.match((await exec.execute(job)).error, /already used/);
});

test('confinePath blocks symlink escapes', async () => {
  const root = await workspace();
  const outside = await mkdtemp(join(tmpdir(), 'hands-out-'));
  await writeFile(join(outside, 'x.txt'), 'outside');
  await mkdir(join(root, 'sub'));
  await symlink(outside, join(root, 'sub', 'link'));
  await assert.rejects(confinePath(join(root, 'sub', 'link', 'x.txt'), [root]), /Outside the workspace roots/);
  assert.ok(await confinePath(join(root, 'notes.txt'), [root]));
});

test('pairing needs the passphrase and locks after repeated misses', async () => {
  const app = await boot();
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${app.base}/spoke/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'guess', deviceId: 'x' }) });
    assert.equal(r.status, 401);
  }
  const locked = await fetch(`${app.base}/spoke/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: PASS, deviceId: 'x' }) });
  assert.equal(locked.status, 429);
  const poll = await fetch(`${app.base}/spoke/v1/poll`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer forged' }, body: '{}' });
  assert.equal(poll.status, 401);
  await app.close();
});

test('used Guard approvals survive a PC restart (file-backed, single use)', async () => {
  const guard = mockGuard();
  const root = await workspace();
  const usedPath = join(await mkdtemp(join(tmpdir(), 'hands-used-')), 'used.json');
  const args = { path: join(root, 'once.txt'), content: 'one' };
  const iat = Math.floor(Date.now() / 1000);
  const env = guard.forge({ decisionId: 'persist-1', verdict: 'allow', actionHash: guardActionHash(buildGuardAction('write_file', args)), deviceId: 'hands-mcp', nonce: 'p'.repeat(20), iat, exp: iat + 300, approvalId: 'a', decidedBy: 'troy' });
  const job = { tool: 'write_file', args, nonce: 'p'.repeat(20), guardDecision: env };
  assert.equal((await createExecutor({ roots: [root], guardPublicKeyX: guard.x, usedDecisionsPath: usedPath }).execute(job)).ok, true);
  // A fresh executor = the PC restarted.
  const restarted = createExecutor({ roots: [root], guardPublicKeyX: guard.x, usedDecisionsPath: usedPath });
  assert.match((await restarted.execute(job)).error, /already used/);
  // Expired entries are pruned, and an unwritable record refuses the action.
  const blocked = createExecutor({ roots: [root], guardPublicKeyX: guard.x, usedDecisionsPath: join(root, 'notes.txt', 'x.json') });
  const env2 = guard.forge({ decisionId: 'persist-2', verdict: 'allow', actionHash: guardActionHash(buildGuardAction('write_file', args)), deviceId: 'hands-mcp', nonce: 'p'.repeat(20), iat, exp: iat + 300, approvalId: 'a', decidedBy: 'troy' });
  assert.match((await blocked.execute({ ...job, guardDecision: env2 })).error, /could not record|unreadable/);
});

// ---- hold-open: the SAME call waits for the human decision (no resume relay) ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function untilApproval(guard, what = 'an approval') {
  for (let i = 0; i < 100 && guard.approvals.size === 0; i++) await sleep(50);
  assert.equal(guard.approvals.size, 1, `expected ${what} to reach Guard`);
  return [...guard.approvals.keys()][0];
}

test('hold-open: a human approval during the wait completes the SAME call, and resume afterwards is refused as already run', async () => {
  const guard = mockGuard({ mode: 'ask' });
  const g = await listen(guard.handler);
  const app = await boot({ guard, guardUrl: g.url, holdOpenWaitMs: 10000 });
  const token = await connect(app.base, 'hands.act');
  const root = await workspace();
  const spoke = await pairAndRun(app.base, root, { guardPublicKeyX: guard.x });
  const target = join(root, 'held.txt');
  const callPromise = callTool(app.base, token, 'write_file', { path: target, content: 'held open' });
  const approvalId = await untilApproval(guard);
  await sleep(600); // past authorize's own short wait: the decision must land in the hold-open window
  await assert.rejects(readFile(target), 'nothing may run before the human decides');
  guard.decide(approvalId, true);
  const r = await callPromise; // the original call itself returns the real result
  assert.equal(r.isError, false, r.text);
  assert.equal(await readFile(target, 'utf8'), 'held open');
  // Audited exactly like a resumed run: allowed.guard -> executed -> outcome.reported.
  const rows = app.audit.rows();
  const pend = rows.find((row) => row.event === 'pending.guard');
  assert.ok(pend?.requestId);
  assert.equal(rows.filter((row) => row.requestId === pend.requestId && row.event === 'executed').length, 1);
  assert.ok(rows.some((row) => row.requestId === pend.requestId && row.event === 'allowed.guard'));
  assert.equal(guard.outcomes.length, 1);
  assert.equal(guard.outcomes[0].status, 'succeeded');
  // The decision is consumed: resume_action can never run it a second time.
  const again = await callTool(app.base, token, 'resume_action', { requestId: pend.requestId });
  assert.ok(again.isError);
  assert.match(again.text, /already ran/);
  assert.equal(rows.filter((row) => row.requestId === pend.requestId && row.event === 'executed').length, 1);
  spoke.stop();
  await app.close(); await g.close();
});

test('hold-open: a human denial during the wait returns the denial in the same call', async () => {
  const guard = mockGuard({ mode: 'ask' });
  const g = await listen(guard.handler);
  const app = await boot({ guard, guardUrl: g.url, holdOpenWaitMs: 10000 });
  const token = await connect(app.base, 'hands.act');
  const root = await workspace();
  const spoke = await pairAndRun(app.base, root, { guardPublicKeyX: guard.x });
  const target = join(root, 'denied-held.txt');
  const callPromise = callTool(app.base, token, 'write_file', { path: target, content: 'no' });
  const approvalId = await untilApproval(guard);
  await sleep(600); // land the denial in the hold-open window, not authorize's own wait
  guard.decide(approvalId, false);
  const r = await callPromise;
  assert.ok(r.isError);
  assert.match(r.text, /Denied: A human denied/);
  await assert.rejects(readFile(target));
  assert.ok(app.audit.rows().some((row) => row.event === 'denied.guard'));
  assert.equal(guard.outcomes.length, 1);
  assert.equal(guard.outcomes[0].status, 'refused');
  spoke.stop();
  await app.close(); await g.close();
});

test('hold-open: when the hold window lapses undecided, the call returns pending + requestId and resume_action still completes it', async () => {
  const guard = mockGuard({ mode: 'ask' });
  const g = await listen(guard.handler);
  const app = await boot({ guard, guardUrl: g.url, holdOpenWaitMs: 500 });
  const token = await connect(app.base, 'hands.act');
  const root = await workspace();
  const spoke = await pairAndRun(app.base, root, { guardPublicKeyX: guard.x });
  const target = join(root, 'lapsed.txt');
  const first = await callTool(app.base, token, 'write_file', { path: target, content: 'after lapse' });
  assert.match(first.text, /Waiting for a human approval/);
  const requestId = /requestId "([^"]+)"/.exec(first.text)[1];
  await assert.rejects(readFile(target));
  guard.decide([...guard.approvals.keys()][0], true);
  const done = await callTool(app.base, token, 'resume_action', { requestId });
  assert.equal(done.isError, false, done.text);
  assert.equal(await readFile(target, 'utf8'), 'after lapse');
  spoke.stop();
  await app.close(); await g.close();
});

test('hold-open: a client that disconnects mid-wait leaves the action pending; resume_action completes it exactly once', async () => {
  const guard = mockGuard({ mode: 'ask' });
  const g = await listen(guard.handler);
  const app = await boot({ guard, guardUrl: g.url, holdOpenWaitMs: 10000 });
  const token = await connect(app.base, 'hands.act');
  const root = await workspace();
  const spoke = await pairAndRun(app.base, root, { guardPublicKeyX: guard.x });
  const target = join(root, 'disconnect.txt');
  const ctrl = new AbortController();
  const gone = fetch(`${app.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4242, method: 'tools/call', params: { name: 'write_file', arguments: { path: target, content: 'after disconnect' } } }),
    signal: ctrl.signal,
  });
  const approvalId = await untilApproval(guard);
  ctrl.abort();
  await assert.rejects(gone);
  await sleep(300); // let the hub notice the disconnect and stop waiting
  // The pending action survived the disconnect: nothing ran, nothing was consumed.
  await assert.rejects(readFile(target));
  const pend = app.audit.rows().find((row) => row.event === 'pending.guard');
  assert.ok(pend?.requestId);
  assert.equal(app.audit.rows().filter((row) => row.event === 'executed').length, 0);
  guard.decide(approvalId, true);
  const done = await callTool(app.base, token, 'resume_action', { requestId: pend.requestId });
  assert.equal(done.isError, false, done.text);
  assert.equal(await readFile(target, 'utf8'), 'after disconnect');
  assert.equal(app.audit.rows().filter((row) => row.requestId === pend.requestId && row.event === 'executed').length, 1);
  spoke.stop();
  await app.close(); await g.close();
});

// ---- execution outcomes -> Executive Guard POST /v1/audit/outcomes (executive-guard/docs/OUTCOMES.md) ----

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const FIELDS = ['decisionId', 'nonce', 'status', 'startedAt', 'finishedAt', 'resultHash', 'error', 'verdict'];

test('approved run: the hub reports "succeeded" once, with the PC timing and a hash of the output (never the output)', async () => {
  const guard = mockGuard({ mode: 'ask' });
  const g = await listen(guard.handler);
  const app = await boot({ guard, guardUrl: g.url });
  const token = await connect(app.base, 'hands.act');
  const root = await workspace();
  const spoke = await pairAndRun(app.base, root, { guardPublicKeyX: guard.x });
  const first = await callTool(app.base, token, 'write_file', { path: join(root, 'o.txt'), content: 'outcome' });
  const requestId = /requestId "([^"]+)"/.exec(first.text)[1];
  assert.equal(guard.outcomes.length, 0, 'an ask is not reportable');
  guard.decide([...guard.approvals.keys()][0], true);
  const done = await callTool(app.base, token, 'resume_action', { requestId });
  assert.equal(done.isError, false, done.text);
  assert.equal(guard.outcomes.length, 1);
  const o = guard.outcomes[0];
  assert.equal(o.status, 'succeeded');
  assert.equal(o.verdict, 'allow');
  assert.equal(o.resultHash, sha256(done.text));
  assert.ok(Date.parse(o.startedAt) <= Date.parse(o.finishedAt));
  assert.equal(o.error, undefined);
  for (const k of Object.keys(o)) assert.ok(FIELDS.includes(k), k);
  spoke.stop();
  await app.close(); await g.close();
});

test('every Guard decision the hub will not act on is reported "refused": policy deny, auto-allow, human denial', async () => {
  for (const [mode, deny] of [['deny', null], ['allow', null], ['ask', true]]) {
    const guard = mockGuard({ mode });
    const g = await listen(guard.handler);
    const app = await boot({ guard, guardUrl: g.url });
    const token = await connect(app.base, 'hands.act');
    const root = await workspace();
    const spoke = await pairAndRun(app.base, root, { guardPublicKeyX: guard.x });
    const r = await callTool(app.base, token, 'write_file', { path: join(root, 'r.txt'), content: 'x' });
    if (deny) {
      const requestId = /requestId "([^"]+)"/.exec(r.text)[1];
      guard.decide([...guard.approvals.keys()][0], false);
      assert.match((await callTool(app.base, token, 'resume_action', { requestId })).text, /human denied/);
    }
    await assert.rejects(readFile(join(root, 'r.txt')));
    assert.equal(guard.outcomes.length, 1, mode);
    assert.equal(guard.outcomes[0].status, 'refused', mode);
    assert.equal(guard.outcomes[0].startedAt, undefined, mode);
    spoke.stop();
    await app.close(); await g.close();
  }
});

test('approved but the PC refuses (key not pinned): reported "refused" with the PC reason', async () => {
  const guard = mockGuard({ mode: 'ask' });
  const g = await listen(guard.handler);
  const app = await boot({ guard, guardUrl: g.url });
  const token = await connect(app.base, 'hands.act');
  const root = await workspace();
  const spoke = await pairAndRun(app.base, root); // no pinned key
  const first = await callTool(app.base, token, 'write_file', { path: join(root, 'p.txt'), content: 'x' });
  const requestId = /requestId "([^"]+)"/.exec(first.text)[1];
  guard.decide([...guard.approvals.keys()][0], true);
  const r = await callTool(app.base, token, 'resume_action', { requestId });
  assert.match(r.text, /no Executive Guard key is pinned/);
  assert.equal(guard.outcomes.length, 1);
  assert.equal(guard.outcomes[0].status, 'refused');
  assert.match(guard.outcomes[0].error, /refused by the PC/);
  spoke.stop();
  await app.close(); await g.close();
});

test('PC executor execution records: refused before running, failed with timing, succeeded with output hash', async () => {
  const guard = mockGuard();
  const root = await workspace();
  const iat = Math.floor(Date.now() / 1000);
  const mk = (args, id) => ({ tool: 'write_file', args, nonce: 'n'.repeat(20), guardDecision: guard.forge({ decisionId: id, verdict: 'allow', actionHash: guardActionHash(buildGuardAction('write_file', args)), deviceId: 'hands-mcp', nonce: 'n'.repeat(20), iat, exp: iat + 300, approvalId: 'a', decidedBy: 'troy' }) });
  const ok = mk({ path: join(root, 'ok.txt'), content: 'hi' }, 'e1');
  const refused = (await createExecutor({ roots: [root] }).execute(ok)).execution;
  assert.equal(refused.status, 'refused'); assert.equal(refused.startedAt, undefined); assert.ok(refused.finishedAt);
  const exec = createExecutor({ roots: [root], guardPublicKeyX: guard.x });
  const good = await exec.execute(ok);
  assert.equal(good.execution.status, 'succeeded');
  assert.equal(good.execution.resultHash, sha256(good.output));
  const bad = await exec.execute(mk({ path: join(root, 'no-such-dir', 'f.txt'), content: 'x' }, 'e2'));
  assert.equal(bad.execution.status, 'failed'); assert.ok(bad.execution.startedAt); assert.ok(bad.execution.error);
  // Read-only tools carry no execution record (no Guard decision behind them).
  assert.equal((await exec.execute({ tool: 'list_files', args: { path: root } })).execution, undefined);
});

test('an outcome Guard cannot record never changes the tool answer', async () => {
  const down = createGuardClient({ url: 'http://127.0.0.1:9', deviceToken: 't'.repeat(32), publicKeyX: 'x', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.deepEqual(await down.reportOutcome({ decisionId: randomUUID(), nonce: 'n'.repeat(20), status: 'succeeded', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }), { recorded: false, error: 'unreachable' });
  const off = createGuardClient({});
  assert.equal((await off.reportOutcome({ decisionId: randomUUID(), nonce: 'n'.repeat(20), status: 'refused' })).recorded, false);
});

// ---- the widened hands set: search_files (read) + move/copy/delete/make_dir/edit (Guard-gated) ----

test('catalog: the six new tools carry the right gating flags and argument rules', () => {
  for (const t of ['move_file', 'copy_file', 'delete_file', 'make_dir', 'edit_file']) assert.equal(TOOLS[t].mutating, true, t);
  assert.equal(TOOLS.search_files.mutating, false);
  assert.deepEqual(validateArgs('move_file', { path: '/a', destination: '/b' }), { path: '/a', destination: '/b' });
  assert.throws(() => validateArgs('move_file', { path: '/a' }), /destination is required/);
  assert.throws(() => validateArgs('search_files', { path: '/a' }), /query or glob is required/);
  assert.throws(() => validateArgs('search_files', { path: '/a', query: 'x', maxResults: 0 }), /maxResults must be 1\.\.200/);
  assert.throws(() => validateArgs('delete_file', { path: '/a', recursive: 'yes' }), /recursive must be a boolean/);
  assert.throws(() => validateArgs('edit_file', { path: '/a', find: '', replace: 'x' }), /find is required/);
});

test('search_files runs with hands.read and no Guard; secrets stay hidden and escapes are refused', async () => {
  const app = await boot(); // no Guard configured at all: read tools must still work
  const token = await connect(app.base, 'hands.read');
  const root = await workspace();
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'guide.txt'), 'first line\nthe Secret Sauce recipe\nlast line');
  const spoke = await pairAndRun(app.base, root);
  const byText = await callTool(app.base, token, 'search_files', { path: root, query: 'secret sauce' });
  assert.equal(byText.isError, false, byText.text);
  assert.match(byText.text, /guide\.txt:2: the Secret Sauce recipe/);
  const byName = await callTool(app.base, token, 'search_files', { path: root, glob: '*.txt' });
  assert.match(byName.text, /notes\.txt/);
  assert.match(byName.text, /guide\.txt/);
  // The .env file's contents are never searched and its name never surfaces.
  const secret = await callTool(app.base, token, 'search_files', { path: root, query: 'SECRET=1' });
  assert.doesNotMatch(secret.text, /\.env/);
  assert.match((await callTool(app.base, token, 'search_files', { path: '/etc', query: 'x' })).text, /Outside the workspace roots/);
  // A read-only token cannot reach the mutating newcomers.
  assert.match((await callTool(app.base, token, 'delete_file', { path: join(root, 'notes.txt') })).text, /not granted hands\.act/);
  spoke.stop();
  await app.close();
});

async function approveAndResume(app, token, guard, name, args) {
  const first = await callTool(app.base, token, name, args);
  assert.match(first.text, /Waiting for a human approval/, `${name} should wait for a human`);
  const requestId = /requestId "([^"]+)"/.exec(first.text)[1];
  const pendingId = [...guard.approvals.entries()].find(([, a]) => a.status === 'pending')[0];
  guard.decide(pendingId, true);
  return callTool(app.base, token, 'resume_action', { requestId });
}

test('make_dir, copy_file, move_file, edit_file, delete_file run only after a human Guard approval', async () => {
  const guard = mockGuard({ mode: 'ask' });
  const g = await listen(guard.handler);
  const app = await boot({ guard, guardUrl: g.url });
  const token = await connect(app.base, 'hands.act');
  const root = await workspace();
  const spoke = await pairAndRun(app.base, root, { guardPublicKeyX: guard.x });

  // make_dir: nothing exists until the human approves.
  const held = await callTool(app.base, token, 'make_dir', { path: join(root, 'sorted') });
  assert.match(held.text, /Waiting for a human approval/);
  await assert.rejects(readdir(join(root, 'sorted')));
  const requestId = /requestId "([^"]+)"/.exec(held.text)[1];
  guard.decide([...guard.approvals.entries()].find(([, a]) => a.status === 'pending')[0], true);
  const made = await callTool(app.base, token, 'resume_action', { requestId });
  assert.equal(made.isError, false, made.text);
  assert.deepEqual(await readdir(join(root, 'sorted')), []);

  await writeFile(join(root, 'a.txt'), 'one two one');
  const copied = await approveAndResume(app, token, guard, 'copy_file', { path: join(root, 'a.txt'), destination: join(root, 'sorted', 'b.txt') });
  assert.equal(copied.isError, false, copied.text);
  assert.equal(await readFile(join(root, 'sorted', 'b.txt'), 'utf8'), 'one two one');
  // Overwriting an existing destination is refused even with an approval.
  const clobber = await approveAndResume(app, token, guard, 'copy_file', { path: join(root, 'a.txt'), destination: join(root, 'sorted', 'b.txt') });
  assert.match(clobber.text, /Destination already exists/);
  assert.equal(await readFile(join(root, 'sorted', 'b.txt'), 'utf8'), 'one two one');

  const moved = await approveAndResume(app, token, guard, 'move_file', { path: join(root, 'a.txt'), destination: join(root, 'c.txt') });
  assert.equal(moved.isError, false, moved.text);
  await assert.rejects(readFile(join(root, 'a.txt')));
  assert.equal(await readFile(join(root, 'c.txt'), 'utf8'), 'one two one');

  const edited = await approveAndResume(app, token, guard, 'edit_file', { path: join(root, 'c.txt'), find: 'two', replace: '2' });
  assert.equal(edited.isError, false, edited.text);
  assert.equal(await readFile(join(root, 'c.txt'), 'utf8'), 'one 2 one');
  const ambiguous = await approveAndResume(app, token, guard, 'edit_file', { path: join(root, 'c.txt'), find: 'one', replace: '1' });
  assert.match(ambiguous.text, /appears 2 times/);
  assert.equal(await readFile(join(root, 'c.txt'), 'utf8'), 'one 2 one');
  const editedAll = await approveAndResume(app, token, guard, 'edit_file', { path: join(root, 'c.txt'), find: 'one', replace: '1', all: true });
  assert.equal(editedAll.isError, false, editedAll.text);
  assert.equal(await readFile(join(root, 'c.txt'), 'utf8'), '1 2 1');

  // A folder delete without recursive is refused; with it, the folder goes.
  const dirHeld = await approveAndResume(app, token, guard, 'delete_file', { path: join(root, 'sorted') });
  assert.match(dirHeld.text, /recursive: true/);
  assert.deepEqual(await readdir(join(root, 'sorted')), ['b.txt']);
  const delFile = await approveAndResume(app, token, guard, 'delete_file', { path: join(root, 'c.txt') });
  assert.equal(delFile.isError, false, delFile.text);
  await assert.rejects(readFile(join(root, 'c.txt')));
  const delDir = await approveAndResume(app, token, guard, 'delete_file', { path: join(root, 'sorted'), recursive: true });
  assert.equal(delDir.isError, false, delDir.text);
  await assert.rejects(readdir(join(root, 'sorted')));
  spoke.stop();
  await app.close(); await g.close();
});

test('the PC refuses the new mutating tools without a verifiable human approval, exactly like write_file', async () => {
  const guard = mockGuard();
  const root = await workspace();
  const jobs = [
    ['move_file', { path: join(root, 'notes.txt'), destination: join(root, 'm.txt') }],
    ['copy_file', { path: join(root, 'notes.txt'), destination: join(root, 'c.txt') }],
    ['delete_file', { path: join(root, 'notes.txt') }],
    ['make_dir', { path: join(root, 'newdir') }],
    ['edit_file', { path: join(root, 'notes.txt'), find: 'hello', replace: 'bye' }],
  ];
  // No pinned Guard key on the PC: every one refused, nothing touched.
  const unpinned = createExecutor({ roots: [root] });
  for (const [tool, args] of jobs) {
    assert.match((await unpinned.execute({ tool, args, guardDecision: null })).error, /no Executive Guard key is pinned/, tool);
  }
  assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'hello from the PC');
  // Pinned key but no decision at all, then an approval forged for different arguments.
  const pinned = createExecutor({ roots: [root], guardPublicKeyX: guard.x });
  for (const [tool, args] of jobs) {
    assert.match((await pinned.execute({ tool, args, guardDecision: null })).error, /malformed/, tool);
  }
  const moveArgs = { path: join(root, 'notes.txt'), destination: join(root, 'm.txt') };
  const iat = Math.floor(Date.now() / 1000);
  const forged = guard.forge({ decisionId: 'mv1', verdict: 'allow', actionHash: guardActionHash(buildGuardAction('move_file', moveArgs)), deviceId: 'hands-mcp', nonce: 'm'.repeat(20), iat, exp: iat + 300, approvalId: 'a', decidedBy: 'troy' });
  assert.match((await pinned.execute({ tool: 'move_file', args: { ...moveArgs, destination: join(root, 'other.txt') }, nonce: 'm'.repeat(20), guardDecision: forged })).error, /different arguments/);
  // The genuine, exact-arguments approval runs exactly once.
  assert.equal((await pinned.execute({ tool: 'move_file', args: moveArgs, nonce: 'm'.repeat(20), guardDecision: forged })).ok, true);
  assert.equal(await readFile(join(root, 'm.txt'), 'utf8'), 'hello from the PC');
  assert.match((await pinned.execute({ tool: 'move_file', args: moveArgs, nonce: 'm'.repeat(20), guardDecision: forged })).error, /already used/);
});

test('the new tools refuse secret paths and escapes at the executor', async () => {
  const guard = mockGuard();
  const root = await workspace();
  const exec = createExecutor({ roots: [root], guardPublicKeyX: guard.x });
  const iat = Math.floor(Date.now() / 1000);
  let n = 0;
  const jobFor = (tool, args) => {
    n += 1;
    const nonce = `s${n}`.padEnd(20, 'x');
    return { tool, args, nonce, guardDecision: guard.forge({ decisionId: `sec-${n}`, verdict: 'allow', actionHash: guardActionHash(buildGuardAction(tool, args)), deviceId: 'hands-mcp', nonce, iat, exp: iat + 300, approvalId: 'a', decidedBy: 'troy' }) };
  };
  // Even a properly approved action cannot touch a secrets path or leave the roots.
  assert.match((await exec.execute(jobFor('delete_file', { path: join(root, '.env') }))).error, /secrets path/);
  assert.equal(await readFile(join(root, '.env'), 'utf8'), 'SECRET=1');
  assert.match((await exec.execute(jobFor('copy_file', { path: join(root, 'notes.txt'), destination: '/tmp/hands-escape.txt' }))).error, /Outside the workspace roots/);
  await mkdir(join(root, '.ssh'));
  assert.match((await exec.execute(jobFor('make_dir', { path: join(root, '.ssh', 'x') }))).error, /secrets path/);
  assert.match((await exec.execute(jobFor('edit_file', { path: join(root, 'missing.txt'), find: 'a', replace: 'b' }))).error, /Not found/);
});

// ---- run_powershell allow-list: restart-bridge ----
// The Bridge's in-process spoke reads its config once at pc-bridge start, so
// restarting the Bridge is the only way to make it pick up a config change.
// The allow-list gains exactly one fixed script for it: no arguments, no free
// text, and run_powershell stays a mutating, Guard-approved tool.

const RESTART_BRIDGE_SCRIPT = "$name = 'Helmian Bridge Service'; $exe = 'E:\\HelmianService\\Helmian Bridge Service.exe'; $roots = @(Get-Process -Name $name -ErrorAction SilentlyContinue); if ($roots.Count) { $ids = @($roots.Id); $frontier = @($roots.Id); while ($frontier.Count) { $kids = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $frontier -contains $_.ParentProcessId } | Select-Object -ExpandProperty ProcessId | Where-Object { $ids -notcontains $_ }); if (!$kids.Count) { break }; $ids += $kids; $frontier = $kids }; $ids | Where-Object { $_ -ne $PID } | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 2 }; if (!(Get-Process -Name $name -ErrorAction SilentlyContinue)) { Start-Process -FilePath $exe -WorkingDirectory 'E:\\HelmianService' -WindowStyle Hidden }; Start-Sleep -Seconds 3; $now = @(Get-Process -Name $name -ErrorAction SilentlyContinue); if ($now.Count) { $now | Select-Object Name,Id,StartTime | Format-Table -AutoSize | Out-String -Width 200 } else { 'Helmian Bridge Service is not running after the restart attempt.' }";

function fakeSpawnChild(output = '') {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => { if (output) child.stdout.emit('data', output); child.emit('close', 0); });
  return child;
}

test('the powershell allow-list carries restart-bridge with no arguments, and run_powershell stays Guard-gated', () => {
  assert.deepEqual(Object.keys(POWERSHELL_COMMANDS).sort(), ['disk-free', 'eas-build', 'eas-build-status', 'git-log', 'git-status', 'list-processes', 'ollama-list', 'restart-bridge', 'toolchain-versions']);
  assert.deepEqual(POWERSHELL_COMMANDS['restart-bridge'].args, {});
  assert.equal(TOOLS.run_powershell.mutating, true);
  assert.deepEqual(validateArgs('run_powershell', { commandId: 'restart-bridge' }), { commandId: 'restart-bridge', args: {} });
  assert.throws(() => validateArgs('run_powershell', { commandId: 'restart-bridge', args: { force: true } }), /unexpected argument args\.force/);
  assert.throws(() => validateArgs('run_powershell', { commandId: 'restart-everything' }), /commandId must be one of: .*restart-bridge/);
});

test('restart-bridge runs its one fixed script, and only behind a human Guard approval', async () => {
  const guard = mockGuard();
  const root = await workspace();
  const calls = [];
  const spawnImpl = (file, argv, opts) => { calls.push({ file, argv, opts }); return fakeSpawnChild('Helmian Bridge Service    1234'); };
  const exec = createExecutor({ roots: [root], guardPublicKeyX: guard.x, spawnImpl });
  const iat = Math.floor(Date.now() / 1000);
  const validated = { commandId: 'restart-bridge', args: {} };
  const job = { tool: 'run_powershell', args: { commandId: 'restart-bridge' }, nonce: 'r'.repeat(20), guardDecision: guard.forge({ decisionId: 'rb-1', verdict: 'allow', actionHash: guardActionHash(buildGuardAction('run_powershell', validated)), deviceId: 'hands-mcp', nonce: 'r'.repeat(20), iat, exp: iat + 300, approvalId: 'a', decidedBy: 'troy' }) };

  // No decision: refused, and powershell never spawns.
  const refused = await exec.execute({ ...job, guardDecision: null });
  assert.match(refused.error, /malformed/);
  assert.equal(calls.length, 0);

  const done = await exec.execute(job);
  assert.equal(done.ok, true);
  assert.equal(done.execution.status, 'succeeded');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'powershell.exe');
  assert.deepEqual(calls[0].argv.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(calls[0].argv[3], RESTART_BRIDGE_SCRIPT);
});

// ─── Approval-summary enrichment (folded in from the deployed hub) ──────────
// The summary is display-only: guardActionHash never reads it, so enriching
// it must leave every signed action hash byte-identical. The golden hashes
// below were computed from the pre-enrichment builder on main (6d3a4d0) for
// these exact inputs; if one changes, the enrichment leaked into signed
// material and approvals verified by older spokes would break.

const GOLDEN_ACTIONS = [
  ['write_file', { path: 'E:\\Helmion\\notes.txt', content: 'hello world\nsecond line' }, '351fc6aa57d474c7016133a1dc03255bf943b98a248e6f708d49ea262cf9e42d'],
  ['edit_file', { path: 'E:\\Helmion\\a.txt', find: 'old text', replace: 'new text' }, '60dd2abd153c4d76cf4c93cb1ed445b7cb189d323920d12193e2d3e146f10e34'],
  ['move_file', { path: 'E:\\Helmion\\a.txt', destination: 'E:\\Helmion\\b.txt' }, 'e686cf1816260cdc11265d27bfca4df1969130dc4168d3ea53f398ab105122d9'],
  ['copy_file', { path: 'E:\\Helmion\\a.txt', destination: 'E:\\Helmion\\b.txt' }, '396aeb907880297ef8a031829df7773de7ca655f0642df561227685f7adfd799'],
  ['delete_file', { path: 'E:\\Helmion\\a.txt', recursive: true }, '9419c1de342bdca35e5b10ad62d93ad899c0df46221d769d76203b1862808195'],
  ['make_dir', { path: 'E:\\Helmion\\newdir' }, '7468481d46b02b98c86f3dc72f0920fa9b9a28e32be56cb6387ef371e237aa4a'],
  ['run_powershell', { commandId: 'git-status', args: { repo: 'E:\\Helmion' } }, '7fcd4cdd2db5ec5d159d42a4e2173d39d225a0a520a85f81c670ed5ea1a08f51'],
  ['run_powershell', { commandId: 'restart-bridge', args: {} }, '23f9d44ba2f0702c0211d1619bca2bf75babb843d42710d18144920f2a6644ed'],
  ['open_url', { url: 'https://example.com/some/path?token=abc' }, '65dbbf6db2ed6e9475d1e8cc64ba8624942f051523046f8510830f43936a442d'],
  ['write_file', { path: 'C:\\Users\\troyh\\.claude.json', content: 'api_key = sk-1234567890abcdef\nrest' }, '6e71acd0e60323b5b5953382c7b04ecd4e96aa1034cf378f90beab70975634a1'],
];

test('golden hashes: the summary enrichment leaves every signed action hash unchanged', () => {
  for (const [tool, args, golden] of GOLDEN_ACTIONS) {
    assert.equal(guardActionHash(buildGuardAction(tool, args)), golden, `${tool} action hash drifted`);
  }
});

test('a mutating action carries the human-readable summary: tool, real target, content descriptor', () => {
  assert.equal(
    buildGuardAction('write_file', { path: 'E:\\Helmion\\notes.txt', content: 'hello world\nsecond line' }).summary,
    'hands write_file → E:\\Helmion\\notes.txt (23 bytes: "hello world")',
  );
  assert.equal(
    buildGuardAction('move_file', { path: 'E:\\Helmion\\a.txt', destination: 'E:\\Helmion\\b.txt' }).summary,
    'hands move_file → E:\\Helmion\\a.txt → E:\\Helmion\\b.txt',
  );
  assert.equal(
    buildGuardAction('delete_file', { path: 'E:\\Helmion\\a.txt', recursive: true }).summary,
    'hands delete_file → E:\\Helmion\\a.txt (recursive)',
  );
  assert.equal(
    buildGuardAction('run_powershell', { commandId: 'git-status', args: { repo: 'E:\\Helmion' } }).summary,
    'hands run_powershell git-status (repo: E:\\Helmion)',
  );
  // describeHandsAction is the same builder the action carries.
  assert.equal(
    describeHandsAction('make_dir', { path: 'E:\\Helmion\\newdir' }),
    buildGuardAction('make_dir', { path: 'E:\\Helmion\\newdir' }).summary,
  );
});

test('a secret-shaped value in the args never appears raw in the summary', () => {
  const secret = 'sk-1234567890abcdef';
  const a = buildGuardAction('write_file', { path: 'C:\\Users\\troyh\\.claude.json', content: `api_key = ${secret}\nrest` });
  assert.ok(!a.summary.includes(secret), 'summary leaked the key');
  assert.ok(a.summary.includes('first line withheld (looked sensitive)'), a.summary);

  const pem = buildGuardAction('write_file', { path: 'E:\\Helmion\\k.txt', content: '-----BEGIN RSA PRIVATE KEY-----\nMII…' });
  assert.ok(!pem.summary.includes('PRIVATE KEY-----'), pem.summary);

  // A JWT as an edit target: the FULL token — and its signature segment, the
  // part that makes it a credential — never appear. (Deployed nuance: the
  // 40-char edit snippet is truncated BEFORE the refusal scan, so a JWT's
  // first segment can show as a cut-off fragment; the scan, here and in
  // Guard, judges the truncated text, which no longer matches the JWT shape.)
  const jwtFull = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij1234567890';
  const jwt = buildGuardAction('edit_file', { path: 'E:\\Helmion\\a.txt', find: 'x', replace: jwtFull });
  assert.ok(!jwt.summary.includes(jwtFull), jwt.summary);
  assert.ok(!jwt.summary.includes('abcdefghij1234567890'), jwt.summary);

  // open_url shows host + path only: a secret riding the query string stays out.
  const url = buildGuardAction('open_url', { url: 'https://example.com/cb?access_token=supersecretvalue123' });
  assert.ok(!url.summary.includes('supersecretvalue123'), url.summary);
  assert.equal(url.summary, 'hands open_url → example.com/cb');
});

test('summaries stay inside the Guard length cap even for huge first lines', () => {
  const a = buildGuardAction('write_file', { path: 'E:\\Helmion\\big.txt', content: 'x'.repeat(5000) });
  assert.ok(a.summary.length <= 460, `summary was ${a.summary.length} chars`);
});

// ---- the phone family: phone_look (read) + run_phone (Guard-gated) ----

test('phone catalog: the six phone commands carry the right gating flags and argument rules', () => {
  assert.equal(TOOLS.phone_look.mutating, false);
  assert.equal(TOOLS.run_phone.mutating, true);
  assert.deepEqual(TOOLS.phone_look.needs, ['phone']);
  assert.deepEqual(TOOLS.run_phone.needs, ['phone']);
  assert.deepEqual(PHONE_READ_COMMANDS, ['phone-status', 'phone-screen', 'phone-layout']);
  assert.deepEqual(PHONE_ACT_COMMANDS, ['phone-tap', 'phone-swipe', 'phone-type']);
  assert.deepEqual(validateArgs('phone_look', { commandId: 'phone-status' }), { commandId: 'phone-status', args: {} });
  assert.deepEqual(validateArgs('run_phone', { commandId: 'phone-tap', args: { x: 540, y: 1200 } }), { commandId: 'phone-tap', args: { x: 540, y: 1200 } });
  // A command on the wrong tool is refused, fail closed, both ways.
  assert.throws(() => validateArgs('phone_look', { commandId: 'phone-tap', args: { x: 1, y: 2 } }), /commandId must be one of/);
  assert.throws(() => validateArgs('run_phone', { commandId: 'phone-status' }), /commandId must be one of/);
  assert.throws(() => validateArgs('run_phone', { commandId: 'phone-tap', args: { x: -1, y: 2 } }), /screen coordinate/);
  assert.throws(() => validateArgs('run_phone', { commandId: 'phone-tap', args: { x: 1, y: 2, z: 3 } }), /unexpected argument/);
  assert.throws(() => validateArgs('run_phone', { commandId: 'phone-nuke', args: {} }), /commandId must be one of/);
  // The Guard card names the action; the words phone-type types are never quoted.
  assert.equal(describeHandsAction('run_phone', { commandId: 'phone-tap', args: { x: 540, y: 1200 } }), 'hands run_phone phone-tap (x: 540, y: 1200)');
  const typeCard = describeHandsAction('run_phone', { commandId: 'phone-type', args: { text: 'a password' } });
  assert.match(typeCard, /10 characters/);
  assert.ok(!typeCard.includes('a password'));
});

function fakeAdbSpawn({ phoneThere = true } = {}) {
  return (file, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    let out = '';
    if (file === 'adb' && args[0] === 'devices') out = phoneThere ? 'List of devices attached\npixel-1\tdevice\n' : 'List of devices attached\n';
    else if (file === 'adb' && args.includes('getprop')) out = 'Pixel 8\n';
    else if (file === 'adb' && args.includes('battery')) out = '  level: 87\n  scale: 100\n';
    else if (file === 'adb' && args.includes('power')) out = 'mWakefulness=Awake\n';
    else if (file === 'adb' && args.includes('uiautomator')) out = '<?xml version="1.0"?><hierarchy><node text="Forge TMS" class="android.widget.TextView" bounds="[40,80][600,140]" /><node text="" content-desc="Sign in" class="android.widget.Button" clickable="true" bounds="[120,860][960,940]" /><node text="driver@example.com" class="android.widget.EditText" bounds="[120,300][960,380]" /></hierarchy>';
    else if (file === 'adb' && args.includes('input')) out = '';
    queueMicrotask(() => { if (out) child.stdout.emit('data', Buffer.from(out)); child.emit('close', 0); });
    return child;
  };
}

test('phone_look reads the phone through the bridge: status and layout in words, no Guard', async () => {
  const root = await workspace();
  const exec = createExecutor({ roots: [root], spawnImpl: fakeAdbSpawn() });
  const status = await exec.execute({ tool: 'phone_look', args: { commandId: 'phone-status', args: {} } });
  assert.equal(status.ok, true, status.error);
  assert.match(status.output, /phone: connected/);
  assert.match(status.output, /model: Pixel 8/);
  assert.match(status.output, /battery: 87%/);
  assert.match(status.output, /screen: on/);
  const layout = await exec.execute({ tool: 'phone_look', args: { commandId: 'phone-layout', args: {} } });
  assert.equal(layout.ok, true, layout.error);
  assert.match(layout.output, /text "Forge TMS" at \[40,80\]\[600,140\]/);
  assert.match(layout.output, /button "Sign in" at \[120,860\]\[960,940\]/);
  assert.match(layout.output, /field "driver@example\.com"/);
  // No phone there: an honest error, not a guess.
  const none = createExecutor({ roots: [root], spawnImpl: fakeAdbSpawn({ phoneThere: false }) });
  const missing = await none.execute({ tool: 'phone_look', args: { commandId: 'phone-status', args: {} } });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no phone found/);
});

test('run_phone changes the phone only after a human Guard approval the PC verifies itself', async () => {
  const guard = mockGuard();
  const root = await workspace();
  const iat = Math.floor(Date.now() / 1000);
  const tapArgs = { commandId: 'phone-tap', args: { x: 540, y: 1200 } };
  const mk = (tool, args, id) => ({ tool, args, nonce: 'n'.repeat(20), guardDecision: guard.forge({ decisionId: id, verdict: 'allow', actionHash: guardActionHash(buildGuardAction(tool, args)), deviceId: 'hands-mcp', nonce: 'n'.repeat(20), iat, exp: iat + 300, approvalId: 'a', decidedBy: 'troy' }) });
  // No pinned Guard key on the PC: refused before anything runs.
  const unpinned = await createExecutor({ roots: [root], spawnImpl: fakeAdbSpawn() }).execute(mk('run_phone', tapArgs, 'p1'));
  assert.equal(unpinned.ok, false);
  assert.match(unpinned.error, /no Executive Guard key is pinned/);
  // Pinned + a real human approval envelope: the tap runs.
  const exec = createExecutor({ roots: [root], guardPublicKeyX: guard.x, spawnImpl: fakeAdbSpawn() });
  const tapped = await exec.execute(mk('run_phone', tapArgs, 'p2'));
  assert.equal(tapped.ok, true, tapped.error);
  assert.match(tapped.output, /tapped at 540, 1200/);
  // Typing refuses characters the fixed command cannot safely type.
  const typeArgs = { commandId: 'phone-type', args: { text: 'pay $500 & go' } };
  const badType = await exec.execute(mk('run_phone', typeArgs, 'p3'));
  assert.equal(badType.ok, false);
  assert.match(badType.error, /can only type plain/);
});
