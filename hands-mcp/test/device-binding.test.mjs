// Device-bound hub jobs (agent-computer plan, bite 2). Two spokes online at
// once — Troy's PC and a box spoke — must never see, claim, or complete each
// other's jobs; presence is per-device; pairing never silently evicts.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
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
import { pkce } from './helpers.mjs';

const PASS = 'correct horse battery staple';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── hub unit level: binding, visibility, completion ────────────────────────

test('hub: a job bound to device A is invisible to device B and completable only by A', async () => {
  const hub = createSpokeHub({ pollWaitMs: 60, resultWaitMs: 5000 });
  // Both devices are online (presence registered by their polls).
  assert.equal(await hub.nextJob({ deviceId: 'box-1', capabilities: ['agentbox'] }), null);
  assert.equal(await hub.nextJob({ deviceId: 'pc-test', capabilities: ['local-files'] }), null);

  const dispatched = hub.dispatch({ tool: 'read_file', args: { path: '/x' }, targetDeviceId: 'pc-test' });
  // Device B polls repeatedly: the job for A never surfaces.
  assert.equal(await hub.nextJob({ deviceId: 'box-1', capabilities: ['agentbox'] }), null);
  assert.equal(await hub.nextJob({ deviceId: 'box-1', capabilities: ['agentbox'] }), null);
  // Device A polls and gets exactly that job, stamped with its binding.
  const job = await hub.nextJob({ deviceId: 'pc-test', capabilities: ['local-files'] });
  assert.ok(job);
  assert.equal(job.targetDeviceId, 'pc-test');
  // B cannot complete A's job; A can.
  assert.equal(hub.complete(job.id, { ok: true, output: 'from B' }, { deviceId: 'box-1' }), false);
  assert.equal(hub.complete(job.id, { ok: true, output: 'from A' }, { deviceId: 'pc-test' }), true);
  const result = await dispatched;
  assert.equal(result.ok, true);
  assert.equal(result.output, 'from A');
  assert.equal(result.targetDeviceId, 'pc-test');
});

test('hub: presence is per-device and the legacy pc slot names the PC device', async () => {
  const hub = createSpokeHub({ pollWaitMs: 40 });
  await hub.nextJob({ deviceId: 'box-1', capabilities: ['agentbox'] });
  await hub.nextJob({ deviceId: 'pc-test', capabilities: ['local-files', 'powershell'] });
  const pres = hub.presence();
  assert.deepEqual(Object.keys(pres.devices).sort(), ['box-1', 'pc-test']);
  assert.deepEqual(pres.devices['box-1'].capabilities, ['agentbox']);
  assert.equal(pres.devices['pc-test'].online, true);
  assert.equal(pres.pc.deviceId, 'pc-test');
  assert.deepEqual(pres.pc.capabilities, ['local-files', 'powershell']);
});

test('hub: a job created with no target binds to the announced PC device when several are online', async () => {
  const hub = createSpokeHub({ pollWaitMs: 40, resultWaitMs: 5000 });
  await hub.nextJob({ deviceId: 'box-1', capabilities: ['local-files'] }); // box also reports files...
  await hub.nextJob({ deviceId: 'pc-test', capabilities: ['local-files'] }); // ...but the pc-* name wins the slot
  const dispatched = hub.dispatch({ tool: 'read_file', args: { path: '/x' } });
  assert.equal(await hub.nextJob({ deviceId: 'box-1', capabilities: ['local-files'] }), null);
  const job = await hub.nextJob({ deviceId: 'pc-test', capabilities: ['local-files'] });
  assert.ok(job);
  assert.equal(job.targetDeviceId, 'pc-test');
  assert.equal(hub.complete(job.id, { ok: true, output: 'pc did it' }, { deviceId: 'pc-test' }), true);
  assert.equal((await dispatched).output, 'pc did it');
});

test('hub: with a single device online, an untargeted job binds to that device (old one-spoke behavior)', async () => {
  const hub = createSpokeHub({ pollWaitMs: 40, resultWaitMs: 5000 });
  await hub.nextJob({ deviceId: 'box-1', capabilities: ['agentbox'] });
  const dispatched = hub.dispatch({ tool: 'read_file', args: { path: '/x' } });
  const job = await hub.nextJob({ deviceId: 'box-1', capabilities: ['agentbox'] });
  assert.ok(job);
  assert.equal(job.targetDeviceId, 'box-1');
  assert.equal(hub.complete(job.id, { ok: true, output: 'solo' }, { deviceId: 'box-1' }), true);
  assert.equal((await dispatched).output, 'solo');
});

test('hub: with nobody online, an untargeted job binds to the legacy default device and times out unclaimed', async () => {
  const hub = createSpokeHub({ pollWaitMs: 40, resultWaitMs: 60 });
  const result = await hub.dispatch({ tool: 'read_file', args: { path: '/x' } });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.pickedUp, false);
  assert.equal(result.targetDeviceId, 'pc');
});

test('hub: a late result is accepted only from the bound device', async () => {
  const hub = createSpokeHub({ pollWaitMs: 40, resultWaitMs: 60 });
  await hub.nextJob({ deviceId: 'pc-test', capabilities: ['local-files'] });
  let late = null;
  const dispatched = hub.dispatch({ tool: 'write_file', args: { path: '/x' }, targetDeviceId: 'pc-test' }, { onLate: (r) => { late = r; } });
  const job = await hub.nextJob({ deviceId: 'pc-test', capabilities: ['local-files'] });
  assert.ok(job); // picked up, but the answer misses the wait window
  const timedOut = await dispatched;
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.pickedUp, true);
  assert.equal(hub.complete(job.id, { ok: true, output: 'impostor' }, { deviceId: 'box-1' }), false);
  assert.equal(late, null);
  assert.equal(hub.complete(job.id, { ok: true, output: 'late but mine' }, { deviceId: 'pc-test' }), true);
  assert.equal(late.output, 'late but mine');
});

// ─── token store: no silent eviction ────────────────────────────────────────

test('tokens: pairing a 4th (and up to a 32nd) device evicts nobody; the 33rd new device is refused loudly', () => {
  const store = createSpokeTokens({ file: null, passphrase: PASS });
  const tokens = new Map();
  for (let i = 1; i <= 32; i++) {
    const r = store.pair({ passphrase: PASS, deviceId: `dev-${i}` });
    assert.equal(r.ok, true, `pair dev-${i}`);
    tokens.set(`dev-${i}`, r.token);
  }
  // The day-one scenario: pc-guard-e2e, pc-guard-e2e2 and pc-troy all survive
  // every later pairing — each token still verifies to its own device.
  for (const [id, tok] of tokens) assert.equal(store.verify(tok), id);
  assert.equal(store.devices().length, 32);
  // At capacity a NEW device is refused — loudly, not by dropping someone else.
  const refused = store.pair({ passphrase: PASS, deviceId: 'dev-33' });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 507);
  assert.match(refused.error, /full \(32 devices paired\)/);
  assert.equal(store.devices().length, 32);
  for (const [id, tok] of tokens) assert.equal(store.verify(tok), id);
  // Re-pairing an existing device still works at capacity (rotates its token).
  const again = store.pair({ passphrase: PASS, deviceId: 'dev-1' });
  assert.equal(again.ok, true);
  assert.equal(store.verify(again.token), 'dev-1');
  assert.equal(store.verify(tokens.get('dev-1')), null);
  assert.equal(store.devices().length, 32);
});

// ─── HTTP level: two real spokes, one app ───────────────────────────────────

async function boot() {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await mkdtemp(join(tmpdir(), 'hands-state-'));
  const config = loadConfig({ PUBLIC_URL: base, AUTH_PASSPHRASE: PASS, HANDS_ENABLED: 'true', STATE_DIR: state });
  const oauth = createOAuth({ resourceId: `${base}/mcp`, stateFile: join(state, 'oauth.json') });
  const guardClient = createGuardClient({ ...config.guard, pollMs: 50, timeoutMs: 1000 });
  const hub = createSpokeHub({ pollWaitMs: 300, resultWaitMs: 3000 });
  const audit = createAudit(null);
  const hands = createHands({ config, guard: guardClient, hub, audit });
  const spokeTokens = createSpokeTokens({ file: join(state, 'spoke.json'), passphrase: PASS });
  server.on('request', createApp({ config, oauth, hands, hub, spokeTokens }));
  return { base, hub, audit, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
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
async function callTool(base, token, name, args = {}) {
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  const body = await res.json();
  assert.ok(body.result, JSON.stringify(body));
  return { text: body.result.content.map((c) => c.text).join('\n'), isError: body.result.isError === true };
}

async function pairAndRun(base, root, deviceId) {
  const configPath = join(await mkdtemp(join(tmpdir(), 'hands-cfg-')), 'hands-spoke.json');
  await pairSpoke({ url: base, passphrase: PASS, roots: [root], configPath, deviceId });
  const config = { ...(await readSpokeConfig(configPath)), usedDecisionsPath: join(dirname(configPath), 'used.json') };
  const spoke = startSpoke({ config, log: () => {} });
  await sleep(200);
  return { spoke, token: config.token };
}

test('http: two spokes online — hands_status shows both, pc work runs on the PC, a result from the wrong device is refused', async () => {
  const app = await boot();
  const token = await connect(app.base, 'hands.read');
  const rootPc = await mkdtemp(join(tmpdir(), 'hands-pc-'));
  const rootBox = await mkdtemp(join(tmpdir(), 'hands-box-'));
  await writeFile(join(rootPc, 'notes.txt'), 'hello from the PC');
  await writeFile(join(rootBox, 'notes.txt'), 'hello from the box');
  const pc = await pairAndRun(app.base, rootPc, 'pc-test');
  const box = await pairAndRun(app.base, rootBox, 'box-1');
  await sleep(400);

  // (c) hands_status: the legacy pc view still works AND both devices show.
  const status = JSON.parse((await callTool(app.base, token, 'hands_status')).text);
  assert.equal(status.pc.online, true);
  assert.deepEqual(Object.keys(status.devices).sort(), ['box-1', 'pc-test']);
  assert.equal(status.devices['box-1'].online, true);
  assert.equal(status.devices['pc-test'].online, true);

  // (a) a job created the ordinary way (a tool call) is bound to the PC device:
  // it reads the PC's file even though the box spoke is also polling.
  const read = await callTool(app.base, token, 'read_file', { path: join(rootPc, 'notes.txt') });
  assert.equal(read.isError, false, read.text);
  assert.equal(read.text, 'hello from the PC');
  // The audit row names the device that ran it.
  assert.ok(app.audit.rows().some((row) => row.event === 'executed' && row.deviceId === 'pc-test'));

  // (b) HTTP result submission enforces the binding: stop both spokes so this
  // hand-dispatched job is claimed manually, then post results with each token.
  pc.spoke.stop(); box.spoke.stop();
  await sleep(100);
  const dispatched = app.hub.dispatch({ tool: 'read_file', args: { path: 'x' }, targetDeviceId: 'pc-test' });
  const job = await app.hub.nextJob({ deviceId: 'pc-test', capabilities: ['local-files'] });
  assert.ok(job);
  const postResult = (bearer, output) => fetch(`${app.base}/spoke/v1/result`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify({ jobId: job.id, ok: true, output }) });
  const wrong = await postResult(box.token, 'impostor');
  assert.equal(wrong.status, 404);
  const right = await postResult(pc.token, 'from the PC');
  assert.equal(right.status, 200);
  const result = await dispatched;
  assert.equal(result.ok, true);
  assert.equal(result.output, 'from the PC');
  await app.close();
});
