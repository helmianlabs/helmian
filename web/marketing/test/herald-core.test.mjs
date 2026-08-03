import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hashPairingCode, hashSecret, parseDeviceCookie, randomChannel, randomPairingCode,
  validateDesktopResult, validatePhoneAction,
} from '../api/_herald-core.js';

test('pairing material is random, bounded, and hashed outside the client', () => {
  const channel = randomChannel();
  const code = randomPairingCode();
  assert.match(channel, /^herald_[A-Za-z0-9_-]{20,80}$/);
  assert.match(code, /^\d{8}$/);
  assert.notEqual(hashPairingCode(channel, code, 'a'.repeat(32)), code);
  assert.notEqual(hashSecret('b'.repeat(32)), 'b'.repeat(32));
});

test('device cookie parsing accepts only the fixed channel/device/token shape', () => {
  const request = { headers: { cookie: `helmian_herald_device=herald_${'a'.repeat(24)}.phone_${'b'.repeat(16)}.${'c'.repeat(43)}` } };
  assert.equal(parseDeviceCookie(request).deviceId, `phone_${'b'.repeat(16)}`);
  assert.equal(parseDeviceCookie({ headers: { cookie: 'helmian_herald_device=../../secret' } }), null);
});

test('phone action contract is closed and confirmation survives to desktop', () => {
  const deviceId = `phone_${'d'.repeat(16)}`;
  const instruction = validatePhoneAction({
    requestId: 'request-1', action: 'instruction.submit',
    payload: { projectId: 'project-1', sessionId: 'session-1', text: 'Summarize.', confirmed: true },
  }, deviceId);
  assert.equal(instruction.deviceId, deviceId);
  assert.equal(instruction.payload.confirmed, true);
  assert.throws(() => validatePhoneAction({ action: 'shell.exec', payload: {} }, deviceId), /not available/);
  assert.throws(() => validatePhoneAction({ action: 'instruction.submit', payload: { text: 'run' } }, deviceId), /explicitly confirm/);
});

test('desktop can return only a bounded result envelope', () => {
  const result = validateDesktopResult({
    v: 1, product: 'helmian-herald', kind: 'result', requestId: 'request-1', state: 'ok',
    payload: { project: { id: 'project-1', name: 'Demo' } }, ignored: 'removed',
  });
  assert.equal(result.state, 'ok');
  assert.equal('ignored' in result, false);
  assert.throws(() => validateDesktopResult({ kind: 'command', action: 'shell.exec' }), /invalid/);
});
