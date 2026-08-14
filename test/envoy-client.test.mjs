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
  await client.sendMessage({ channelId: 'c-1', body: 'hello', idempotencyKey: 'm-1' });
  assert.equal(fetchImpl.calls.every(({ options }) => options.credentials === 'same-origin'), true);
  assert.equal(fetchImpl.calls.some(({ url }) => url.includes('tenant')), false);
  assert.deepEqual(JSON.parse(fetchImpl.calls[2].options.body), { channelId: 'c-1', body: 'hello', idempotencyKey: 'm-1' });
});

test('empty channel selection does not make a network request', async () => {
  const fetchImpl = fakeFetch();
  assert.deepEqual(await createEnvoyClient({ fetchImpl }).listMessages(''), { messages: [] });
  assert.equal(fetchImpl.calls.length, 0);
});

