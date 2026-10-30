// Troy, 2026-10-30: "if it's read-only, the user doesn't need to click."
// Read-only allow-listed PowerShell commands skip the Executive Guard ask
// (audited as allowed.read-only); everything that changes something still asks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHands } from '../src/hands.mjs';
import { createAudit } from '../src/audit.mjs';
import { createExecutor } from '../../src/hands/pc-spoke.mjs';
import { isReadOnlyCall, POWERSHELL_COMMANDS, POWERSHELL_READ_CAPABILITY, POWERSHELL_READ_COMMANDS, validateArgs } from '../src/shared/protocol.mjs';

const READS = ['git-status', 'git-log', 'disk-free', 'list-processes', 'ollama-list', 'toolchain-versions', 'eas-build-status'];

test('read-only allow-list is exactly the look-only commands', () => {
  assert.deepEqual([...POWERSHELL_READ_COMMANDS].sort(), [...READS].sort());
  for (const id of ['restart-bridge', 'eas-build']) {
    assert.equal(POWERSHELL_COMMANDS[id].readOnly, undefined);
    assert.equal(isReadOnlyCall('run_powershell', { commandId: id, args: {} }), false);
  }
  assert.equal(isReadOnlyCall('write_file', { commandId: 'disk-free' }), false);
  assert.equal(isReadOnlyCall('run_phone', { commandId: 'disk-free' }), false);
  assert.equal(isReadOnlyCall('run_powershell', validateArgs('run_powershell', { commandId: 'disk-free' })), true);
});

function setup(caps) {
  const guardCalls = [];
  const dispatched = [];
  const guard = { live: true, authorize: async (x) => { guardCalls.push(x); return { outcome: 'deny', reason: 'test guard', nonce: 'n' }; }, awaitApproval: async () => ({ outcome: 'deny' }), reportOutcome: async () => ({ recorded: true }) };
  const hub = {
    presence: () => ({ pc: { online: true, lastSeenAt: new Date().toISOString(), capabilities: caps, deviceId: 'pc1' }, devices: { pc1: { lastSeenAt: new Date().toISOString(), capabilities: caps } } }),
    dispatch: async (job) => { dispatched.push(job); return { ok: true, output: 'ok', targetDeviceId: 'pc1' }; },
  };
  const audit = createAudit(null);
  const hands = createHands({ config: { handsEnabled: true, guard: { deviceId: 'hands-mcp' } }, guard, hub, audit }, { holdOpenWaitMs: 10 });
  return { hands, guardCalls, dispatched, audit };
}
const auth = { clientId: 'c', scopes: ['hands.read', 'hands.act'] };
const caps = ['local-files', 'powershell', POWERSHELL_READ_CAPABILITY, 'pc-browser', 'ollama'];

test('hub: read-only commands run with no Guard ask and an audit row', async () => {
  const { hands, guardCalls, dispatched, audit } = setup(caps);
  for (const id of ['disk-free', 'list-processes', 'ollama-list', 'toolchain-versions']) {
    const r = await hands.call('run_powershell', { commandId: id }, auth);
    assert.ok(!r.isError, id);
  }
  const r = await hands.call('run_powershell', { commandId: 'git-status', args: { repo: 'C:\\code\\x' } }, auth);
  assert.ok(!r.isError);
  assert.equal(guardCalls.length, 0);
  assert.equal(dispatched.length, 5);
  assert.ok(dispatched.every((j) => j.guardDecision === null));
  const rows = audit.rows().filter((x) => x.event === 'allowed.read-only');
  assert.equal(rows.length, 5);
  assert.equal(rows[0].commandId, 'disk-free');
});

test('hub: changing commands and tools still go to Guard', async () => {
  const { hands, guardCalls, dispatched } = setup(caps);
  for (const [tool, args] of [['run_powershell', { commandId: 'restart-bridge' }], ['run_powershell', { commandId: 'eas-build', args: { repo: 'C:\\code\\x' } }], ['write_file', { path: 'C:\\code\\a.txt', content: 'x' }], ['open_url', { url: 'https://example.com' }]]) {
    const r = await hands.call(tool, args, auth);
    assert.ok(r.isError, `${tool} must be denied by the test guard`);
  }
  assert.equal(guardCalls.length, 4);
  assert.equal(dispatched.length, 0);
});

test('hub: a spoke without powershell-read keeps the Guard ask for reads (old spokes refuse unsigned jobs)', async () => {
  const { hands, guardCalls, dispatched } = setup(['local-files', 'powershell']);
  const r = await hands.call('run_powershell', { commandId: 'disk-free' }, auth);
  assert.ok(r.isError);
  assert.equal(guardCalls.length, 1);
  assert.equal(dispatched.length, 0);
});

test('hub: a read-only token still cannot call run_powershell', async () => {
  const { hands, dispatched } = setup(caps);
  const r = await hands.call('run_powershell', { commandId: 'disk-free' }, { clientId: 'c', scopes: ['hands.read'] });
  assert.ok(r.isError);
  assert.equal(dispatched.length, 0);
});

function fakeSpawn(calls) {
  return (file, args) => {
    calls.push([file, ...args]);
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {};
    setImmediate(() => { c.stdout.emit('data', 'NAME llama3'); c.emit('close', 0); });
    return c;
  };
}

test('spoke: read-only command runs without a Guard decision; restart-bridge without one is refused', async () => {
  const calls = [];
  const exec = createExecutor({ roots: [process.cwd()], guardPublicKeyX: 'x'.repeat(43), spawnImpl: fakeSpawn(calls) });
  const ok = await exec.execute({ tool: 'run_powershell', args: { commandId: 'ollama-list' } });
  assert.equal(ok.ok, true);
  assert.equal(calls.length, 1);
  const bad = await exec.execute({ tool: 'run_powershell', args: { commandId: 'restart-bridge' } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /refused by the PC/);
  assert.equal(calls.length, 1);
});
