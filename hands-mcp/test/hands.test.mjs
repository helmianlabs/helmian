// End-to-end over real HTTP: OAuth (DCR + PKCE + passphrase consent) -> MCP
// tools/call -> routing -> Executive Guard (mock with the real envelope) ->
// PC spoke (real executor on a temp workspace). Proves the fail-closed rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
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
import { buildGuardAction, guardActionHash } from '../src/shared/protocol.mjs';
import { listen, mockGuard, pkce } from './helpers.mjs';

const PASS = 'correct horse battery staple';

async function boot({ handsEnabled = true, guard = null, guardUrl = null } = {}) {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await mkdtemp(join(tmpdir(), 'hands-state-'));
  const config = loadConfig({
    PUBLIC_URL: base, AUTH_PASSPHRASE: PASS, HANDS_ENABLED: handsEnabled ? 'true' : 'false', STATE_DIR: state,
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
