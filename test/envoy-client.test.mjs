import assert from 'node:assert/strict';
import test from 'node:test';
import { createEnvoyClient } from '../web/cloud-admin/envoy-client.mjs';

function fakeFetch() {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/admin/envoy/channels') return new Response(JSON.stringify({ channels: [{ id: 'c-1' }] }), { status: 200 });
    if (url.includes('/api/admin/envoy/messages?channel_id=c-1')) return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    return new Response(JSON.stringify({ receipt: { durable: true, replayed: true } }), { status: 200 });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('Envoy client uses same-origin auth and never sends a tenant selector', async () => {
  const fetchImpl = fakeFetch();
  const client = createEnvoyClient({ fetchImpl });
  await client.listChannels();
  await client.listMessages('c-1');
  await client.listMessages('c-1', { afterId: '12' });
  await client.sendMessage({ channelId: 'c-1', body: 'hello', idempotencyKey: 'm-1' });
  assert.equal(fetchImpl.calls.every(({ options }) => options.credentials === 'same-origin'), true);
  assert.equal(fetchImpl.calls.some(({ url }) => url.includes('tenant')), false);
  assert.match(fetchImpl.calls[2].url, /after_id=12/);
  assert.deepEqual(JSON.parse(fetchImpl.calls[3].options.body), { channelId: 'c-1', body: 'hello', idempotencyKey: 'm-1' });
});

test('empty channel selection does not make a network request', async () => {
  const fetchImpl = fakeFetch();
  assert.deepEqual(await createEnvoyClient({ fetchImpl }).listMessages(''), { messages: [] });
  assert.equal(fetchImpl.calls.length, 0);
});

test('client preserves unauthorized status for the shell to stop polling', async () => {
  const client = createEnvoyClient({ fetchImpl: async () => new Response(JSON.stringify({ code: 'ENVOY_MEMBERSHIP_REQUIRED' }), { status: 403 }) });
  await assert.rejects(() => client.listChannels(), (error) => error.status === 403 && /ENVOY_MEMBERSHIP_REQUIRED/.test(error.message));
});

test('Envoy client opens same-origin SSE without tenant selectors and handles message/error events', () => {
  const calls = []; const listeners = {};
  class FakeEventSource {
    constructor(url) { this.url = url; calls.push(this); }
    addEventListener(name, handler) { listeners[name] = handler; }
    close() { this.closed = true; }
  }
  const messages = []; const errors = [];
  const stream = createEnvoyClient().openMessageStream('c-1', { afterId: '7', EventSourceImpl: FakeEventSource, onMessage: (message) => messages.push(message), onError: (error) => errors.push(error) });
  assert.match(calls[0].url, /channel_id=c-1&after_id=7/u); assert.doesNotMatch(calls[0].url, /tenant|organization|plant|facility/u);
  listeners.message({ data: JSON.stringify({ id: '8', body: 'hello' }) });
  listeners.envoy_error({ data: JSON.stringify({ code: 'ENVOY_MEMBERSHIP_REVOKED', retryable: false }) });
  assert.equal(messages[0].id, '8'); assert.equal(errors[0].status, 403);
  stream.close(); assert.equal(calls[0].closed, true);
});

test('Envoy client reconnects with the last durable cursor using bounded exponential retry', () => {
  const sources = []; const timers = []; const statuses = []; const messages = []; const errors = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = {}; this.closed = false; sources.push(this); }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    close() { this.closed = true; }
    emit(name, data) { this.listeners[name]?.({ data: JSON.stringify(data) }); }
  }
  const stream = createEnvoyClient().openMessageStream('c-1', {
    EventSourceImpl: FakeEventSource, retryBaseMs: 10, retryMaxMs: 20, maxRetries: 3,
    setTimeoutImpl: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeoutImpl: () => {}, onStatus: (status, detail) => statuses.push({ status, detail }),
    onMessage: (message) => messages.push(message), onError: (error) => errors.push(error),
  });
  sources[0].onopen();
  sources[0].emit('message', { id: '8', body: 'hello' });
  sources[0].emit('envoy_error', { code: 'ENVOY_STREAM_ROTATE', retryable: true });
  assert.equal(messages[0].id, '8'); assert.equal(timers[0].delay, 10); assert.equal(errors.length, 0);
  timers[0].callback();
  assert.match(sources[1].url, /channel_id=c-1&after_id=8/u);
  sources[1].onerror();
  assert.equal(timers[1].delay, 20); assert.match(statuses.map((entry) => entry.status).join(','), /stale,reconnecting/u);
  stream.close(); assert.equal(sources[1].closed, true);
});
