// Caller-selectable device targeting (agent-computer plan, bite 2b).
// PR #80 bound hub jobs to a device internally, but every MCP tool call was
// still bound to the legacy PC slot — a caller had no way to aim a call at
// the second spoke (the box). These tests go through the real MCP/HTTP tool
// path with two real spokes online: `device` aims a call, no `device` keeps
// the exact old PC behavior, and bad targets fail before Guard is ever asked.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
import { pairSpoke, readSpokeConfig, startSpoke } from '../../src/hands/pc-spoke.mjs';
import { listen, mockGuard, pkce } from './helpers.mjs';

const PASS = 'correct horse battery staple';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot({ guard = null, guardUrl = null, holdOpenWaitMs = 400 } = {}) {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await mkdtemp(join(tmpdir(), 'hands-state-'));
  const config = loadConfig({
    PUBLIC_URL: base, AUTH_PASSPHRASE: PASS, HANDS_ENABLED: 'true', STATE_DIR: state,
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
  const ok = await fetch(`${base}/consent`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ pending_id: pendingId, action: 'approve', passphrase: PASS }) });
  assert.equal(ok.status, 302);
  const code = new URL(ok.headers.get('location')).searchParams.get('code');
  const tok = await (await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: 'https://client.example/cb' }) })).json();
  assert.ok(tok.access_token, JSON.stringify(tok));
  return tok.access_token;
}

let rpcId = 0;
async function rpc(base, token, method, params) {
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const body = await res.json();
  assert.ok(body.result, JSON.stringify(body));
  return body.result;
}

async function callTool(base, token, name, args = {}) {
  const result = await rpc(base, token, 'tools/call', { name, arguments: args });
  return { text: result.content.map((c) => c.text).join('\n'), isError: result.isError === true };
}

async function pairAndRun(base, root, deviceId, extra = {}) {
  const configPath = join(await mkdtemp(join(tmpdir(), 'hands-cfg-')), 'hands-spoke.json');
  await pairSpoke({ url: base, passphrase: PASS, roots: [root], configPath, deviceId });
  const config = { ...(await readSpokeConfig(configPath)), usedDecisionsPath: join(dirname(configPath), 'used.json'), ...extra };
  const spoke = startSpoke({ config, log: () => {} });
  await sleep(200);
  return spoke;
}

async function twoRoots() {
  const rootPc = await mkdtemp(join(tmpdir(), 'hands-pc-'));
  const rootBox = await mkdtemp(join(tmpdir(), 'hands-box-'));
  await writeFile(join(rootPc, 'notes.txt'), 'hello from the PC');
  await writeFile(join(rootBox, 'notes.txt'), 'hello from the box');
  return { rootPc, rootBox };
}

async function untilApproval(guard) {
  for (let i = 0; i < 100 && guard.approvals.size === 0; i++) await sleep(50);
  assert.equal(guard.approvals.size, 1, 'expected exactly one approval to reach Guard');
  return [...guard.approvals.keys()][0];
}

const queuedJobs = (hub) => [...hub._queues.values()].reduce((n, q) => n + q.length, 0);

test('targeting: in one session, a read with device=<box> runs on the box and a read with no device runs on the PC', async () => {
  const app = await boot();
  const token = await connect(app.base, 'hands.read');
  const { rootPc, rootBox } = await twoRoots();
  const pc = await pairAndRun(app.base, rootPc, 'pc-test');
  const box = await pairAndRun(app.base, rootBox, 'box-test');
  await sleep(300);

  // Aimed at the box: the box spoke answers from ITS root.
  const onBox = await callTool(app.base, token, 'read_file', { path: join(rootBox, 'notes.txt'), device: 'box-test' });
  assert.equal(onBox.isError, false, onBox.text);
  assert.equal(onBox.text, 'hello from the box');

  // No device argument, same session: exactly the old behavior — the PC slot.
  const onPc = await callTool(app.base, token, 'read_file', { path: join(rootPc, 'notes.txt') });
  assert.equal(onPc.isError, false, onPc.text);
  assert.equal(onPc.text, 'hello from the PC');

  // Aimed at the PC by name works too, and list_files targets the same way.
  const namedPc = await callTool(app.base, token, 'read_file', { path: join(rootPc, 'notes.txt'), device: 'pc-test' });
  assert.equal(namedPc.text, 'hello from the PC');
  const listBox = await callTool(app.base, token, 'list_files', { path: rootBox, device: 'box-test' });
  assert.equal(listBox.isError, false, listBox.text);
  assert.match(listBox.text, /notes\.txt/);

  // The audit trail names the device behind each executed call.
  const executed = app.audit.rows().filter((row) => row.event === 'executed');
  assert.deepEqual(executed.map((row) => row.deviceId).sort(), ['box-test', 'box-test', 'pc-test', 'pc-test']);
  pc.stop(); box.stop();
  await app.close();
});

test('targeting: a mutating call with device=<box> asks Guard for the box and the audit rows name the box device', async () => {
  const guard = mockGuard({ mode: 'ask' });
  const g = await listen(guard.handler);
  const app = await boot({ guard, guardUrl: g.url, holdOpenWaitMs: 10000 });
  const token = await connect(app.base, 'hands.act');
  const { rootPc, rootBox } = await twoRoots();
  const pc = await pairAndRun(app.base, rootPc, 'pc-test', { guardPublicKeyX: guard.x });
  const box = await pairAndRun(app.base, rootBox, 'box-test', { guardPublicKeyX: guard.x });
  await sleep(300);

  const target = join(rootBox, 'made-on-box.txt');
  const callPromise = callTool(app.base, token, 'write_file', { path: target, content: 'written on the box', device: 'box-test' });
  const approvalId = await untilApproval(guard);
  await sleep(600); // land the decision inside the hold-open window
  // The Guard ask is audited against the box before anything runs.
  const pend = app.audit.rows().find((row) => row.event === 'pending.guard');
  assert.ok(pend, 'expected a pending.guard audit row');
  assert.equal(pend.deviceId, 'box-test');
  await assert.rejects(readFile(target));
  guard.decide(approvalId, true);
  const done = await callPromise;
  assert.equal(done.isError, false, done.text);
  // It ran on the box: the file exists in the box root, and the PC root has none.
  assert.equal(await readFile(target, 'utf8'), 'written on the box');
  await assert.rejects(readFile(join(rootPc, 'made-on-box.txt')));
  const rows = app.audit.rows().filter((row) => row.requestId === pend.requestId);
  assert.equal(rows.filter((row) => row.event === 'executed' && row.deviceId === 'box-test').length, 1);
  assert.equal(guard.outcomes.length, 1);
  assert.equal(guard.outcomes[0].status, 'succeeded');
  pc.stop(); box.stop();
  await app.close(); await g.close();
});

test('targeting: an unknown or offline device errors cleanly — no job created, no Guard ask', async () => {
  const guard = mockGuard({ mode: 'ask' });
  const g = await listen(guard.handler);
  const app = await boot({ guard, guardUrl: g.url });
  const token = await connect(app.base, 'hands.act');
  const { rootPc, rootBox } = await twoRoots();
  const pc = await pairAndRun(app.base, rootPc, 'pc-test', { guardPublicKeyX: guard.x });
  const box = await pairAndRun(app.base, rootBox, 'box-test', { guardPublicKeyX: guard.x });
  await sleep(300);
  const rowsBefore = app.audit.rows().length;

  const read = await callTool(app.base, token, 'read_file', { path: join(rootBox, 'notes.txt'), device: 'box-ghost' });
  assert.equal(read.isError, true);
  assert.match(read.text, /No device named "box-ghost" is connected/);
  assert.match(read.text, /box-test/); // the error names what IS connected
  const write = await callTool(app.base, token, 'write_file', { path: join(rootBox, 'ghost.txt'), content: 'x', device: 'box-ghost' });
  assert.equal(write.isError, true);
  assert.match(write.text, /No device named "box-ghost" is connected/);

  // Nothing was dispatched and Guard was never asked.
  assert.equal(queuedJobs(app.hub), 0);
  assert.equal(guard.approvals.size, 0);
  assert.equal(guard.calls.filter((c) => c.url === '/v1/decisions').length, 0);
  const newRows = app.audit.rows().slice(rowsBefore);
  assert.deepEqual(newRows.map((row) => row.event), ['refused.device', 'refused.device']);
  // The ghost did not leak into presence either.
  const status = JSON.parse((await callTool(app.base, token, 'hands_status')).text);
  assert.deepEqual(Object.keys(status.devices).sort(), ['box-test', 'pc-test']);
  pc.stop(); box.stop();
  await app.close(); await g.close();
});

test('targeting: a capability-mismatched target is refused at routing, never dispatched, Guard never asked', async () => {
  const guard = mockGuard({ mode: 'ask' });
  const g = await listen(guard.handler);
  const app = await boot({ guard, guardUrl: g.url });
  const token = await connect(app.base, 'hands.act');
  const { rootPc, rootBox } = await twoRoots();
  const pc = await pairAndRun(app.base, rootPc, 'pc-test', { guardPublicKeyX: guard.x });
  const box = await pairAndRun(app.base, rootBox, 'box-test', { guardPublicKeyX: guard.x });
  await sleep(300);
  // Both test spokes report only the local-files capability in this environment.
  const status = JSON.parse((await callTool(app.base, token, 'hands_status')).text);
  assert.deepEqual(status.devices['box-test'].capabilities, ['local-files']);

  // run_powershell needs powershell, which the box does not report.
  const ps = await callTool(app.base, token, 'run_powershell', { commandId: 'disk-free', device: 'box-test' });
  assert.equal(ps.isError, true);
  assert.match(ps.text, /Device "box-test" does not report powershell, which run_powershell needs/);
  assert.match(ps.text, /refused at routing/);
  // ollama_generate needs ollama, which the PC spoke here does not report.
  const ollama = await callTool(app.base, token, 'ollama_generate', { model: 'llama3', prompt: 'hi', device: 'pc-test' });
  assert.equal(ollama.isError, true);
  assert.match(ollama.text, /Device "pc-test" does not report ollama, which ollama_generate needs/);
  // open_url needs pc-browser, which the box does not report.
  const url = await callTool(app.base, token, 'open_url', { url: 'https://example.com', device: 'box-test' });
  assert.equal(url.isError, true);
  assert.match(url.text, /Device "box-test" does not report pc-browser, which open_url needs/);

  assert.equal(queuedJobs(app.hub), 0);
  assert.equal(guard.approvals.size, 0);
  assert.equal(guard.calls.filter((c) => c.url === '/v1/decisions').length, 0);
  assert.deepEqual(app.audit.rows().filter((row) => row.event.startsWith('refused.')).map((row) => row.event),
    ['refused.device-capability', 'refused.device-capability', 'refused.device-capability']);
  pc.stop(); box.stop();
  await app.close(); await g.close();
});

test('targeting: the tools/list catalog exposes the optional device argument on every spoke tool', async () => {
  const app = await boot();
  const token = await connect(app.base, 'hands.read');
  const { tools } = await rpc(app.base, token, 'tools/list', {});
  const byName = new Map(tools.map((t) => [t.name, t]));
  const spokeTools = ['list_files', 'read_file', 'search_files', 'ollama_generate', 'run_powershell', 'open_url',
    'write_file', 'move_file', 'copy_file', 'delete_file', 'make_dir', 'edit_file'];
  for (const name of spokeTools) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} missing from catalog`);
    assert.ok(tool.inputSchema.properties.device, `${name} must accept a device argument`);
    assert.equal(tool.inputSchema.properties.device.type, 'string');
    assert.ok(!tool.inputSchema.required?.includes('device'), `${name}: device must stay optional`);
    assert.match(tool.description, /"device"/, `${name}: description must mention the device argument`);
  }
  // Non-dispatching tools are unchanged.
  assert.equal(byName.get('hands_status').inputSchema.properties.device, undefined);
  assert.equal(byName.get('resume_action').inputSchema.properties.device, undefined);
  await app.close();
});
