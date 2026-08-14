import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveServerHumeBinding } from '../src/cora/hume-server-binding.mjs';

test('server Hume binding accepts only injected non-secret readiness metadata', () => {
  assert.deepEqual(resolveServerHumeBinding({ source: 'injected_test', configured: true, configId: 'hume-config-test', credentialReady: true }), { state: 'ready', configId: 'hume-config-test', credentialReady: true, source: 'injected_test' });
});

test('absent or incomplete server binding is explicitly unavailable', () => {
  assert.deepEqual(resolveServerHumeBinding(), { state: 'unavailable', configId: null, credentialReady: false, source: 'server_binding_absent' });
  assert.deepEqual(resolveServerHumeBinding({ source: 'injected_test', configured: true, configId: 'hume-config-test', credentialReady: false }), { state: 'unavailable', configId: 'hume-config-test', credentialReady: false, source: 'injected_test' });
});

test('server Hume binding rejects secrets and arbitrary sources', () => {
  assert.throws(() => resolveServerHumeBinding({ source: 'injected_test', configured: true, configId: 'hume', credentialReady: true, apiKey: 'no' }), /secret-bearing/u);
  assert.throws(() => resolveServerHumeBinding({ source: 'client', configured: true, configId: 'hume', credentialReady: true }), /source is invalid/u);
});
