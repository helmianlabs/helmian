import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAblyAccountControl,
  createAccountRemoteControlApi,
} from '../herald/account-runtime.js';

const grant = Object.freeze({
  provider: 'ably', role: 'account-control', realtime: true,
  tokenRequest: {
    keyName: 'app.key', ttl: 60_000, capability: '{}',
    clientId: 'herald-control:control_12345678901234567890',
    timestamp: 1, nonce: 'n'.repeat(24), mac: 'signed',
  },
  channels: { requests: 'private:requests', results: 'private:results' },
  expiresAt: '2026-08-01T01:00:00.000Z',
});

test('account API uses Clerk session bearer plus fresh nonces without exposing a control credential', async () => {
  const calls = [];
  const api = createAccountRemoteControlApi({
    token: async () => 'clerk-session-fixture',
    nonce: () => 'nonce-1234567890123456',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ desktops: [] }) };
    },
  });
  await api.list();
  assert.equal(calls[0].url, '/api/remote/v1/desktops');
  assert.equal(calls[0].options.headers.authorization, 'Bearer clerk-session-fixture');
  assert.equal(calls[0].options.headers['x-helmian-nonce'], 'nonce-1234567890123456');
  assert.equal(JSON.stringify(calls[0]).includes('control_'), false);
});

test('scoped Ably adapter publishes only the fixed request envelope and accepts bounded results', async () => {
  const channels = new Map();
  const states = [];
  const results = [];
  class Channel {
    constructor(name) { this.name = name; this.handlers = new Map(); this.published = []; }
    subscribe(name, handler) { this.handlers.set(name, handler); }
    unsubscribe(name) { this.handlers.delete(name); }
    async publish(name, data) { this.published.push({ name, data }); }
    emit(name, data) { this.handlers.get(name)?.({ data }); }
  }
  class Realtime {
    constructor(options) {
      this.options = options;
      this.channels = { get: (name) => {
        if (!channels.has(name)) channels.set(name, new Channel(name));
        return channels.get(name);
      } };
      this.connection = { state: 'connected', on: (handler) => handler({ current: 'connected' }) };
    }
    close() { states.push('sdk-closed'); }
  }
  const control = await createAblyAccountControl({
    Ably: { Realtime }, tokenProvider: async () => grant,
    onResult: (value) => results.push(value), onState: ({ state }) => states.push(state),
  });
  const sent = await control.send('instruction.submit', {
    projectId: 'project-1', sessionId: 'session-1', text: 'hello', confirmed: true,
  });
  const published = channels.get('private:requests').published[0];
  assert.equal(published.name, 'remote-request');
  assert.equal(published.data.requestId, sent.requestId);
  assert.equal(published.data.deviceId, grant.tokenRequest.clientId);
  assert.equal(published.data.action, 'instruction.submit');

  channels.get('private:results').emit('remote-result', {
    v: 1, product: 'helmian-herald', kind: 'result', requestId: sent.requestId,
    action: 'instruction.submit', deviceId: grant.tokenRequest.clientId,
    state: 'ok', payload: { message: 'done' },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].state, 'ok');

  // Ably.NET historically published PascalCase C# records; must still settle.
  channels.get('private:results').emit('remote-result', {
    V: 1, Product: 'helmian-herald', Kind: 'result', RequestId: sent.requestId,
    Action: 'instruction.submit', DeviceId: grant.tokenRequest.clientId,
    State: 'ok', Payload: { Message: 'pascal-done' },
  });
  assert.equal(results.length, 2);
  assert.equal(results[1].state, 'ok');
  assert.equal(results[1].requestId, sent.requestId);
  assert.equal(results[1].payload?.message, 'pascal-done');

  control.close();
  assert.deepEqual(states, ['connected', 'sdk-closed', 'closed']);
});

test('scoped Ably adapter refuses prohibited actions before publish', async () => {
  class Realtime {
    constructor() {
      const channel = { subscribe() {}, unsubscribe() {}, async publish() { throw new Error('must not publish'); } };
      this.channels = { get: () => channel };
      this.connection = { on() {} };
    }
    close() {}
  }
  const control = await createAblyAccountControl({ Ably: { Realtime }, tokenProvider: async () => grant });
  await assert.rejects(() => control.send('shell.exec', {}), /not available/);
  control.close();
});
