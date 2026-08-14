import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoraConfigClient } from '../web/cloud-admin/cora-config-client.mjs';

function fakeFetch() {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/config')) return new Response(JSON.stringify({ status: 'not_published', config: null }), { status: 200 });
    if (url.endsWith('/knowledge-sources')) return new Response(JSON.stringify({ sources: [] }), { status: 200 });
    return new Response(JSON.stringify({ config: { id: 'c1', lifecycle: 'draft' } }), { status: 200 });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('Cora config client uses same-origin auth and sends no tenant or Plant selector', async () => {
  const fetchImpl = fakeFetch();
  const client = createCoraConfigClient({ fetchImpl });
  await client.readConfig();
  await client.readKnowledgeSources();
  await client.createDraft({ reason: 'reviewed brief defaults' });
  await client.transition({ id: 'c1', lifecycle: 'testing', reason: 'begin test' });
  assert.equal(fetchImpl.calls.every(({ options }) => options.credentials === 'same-origin'), true);
  assert.equal(fetchImpl.calls.some(({ url, options }) => url.includes('tenant') || url.includes('plant') || String(options.body).includes('tenant') || String(options.body).includes('plant')), false);
  assert.deepEqual(JSON.parse(fetchImpl.calls[2].options.body).config, { style: 'professional_brief', maxSpokenChars: 900, interruptMode: 'barge_in', turnMode: 'concise' });
});

test('Cora config client preserves unauthorized status for UI error state', async () => {
  const client = createCoraConfigClient({ fetchImpl: async () => new Response(JSON.stringify({ code: 'CORA_MEMBERSHIP_REQUIRED' }), { status: 403 }) });
  await assert.rejects(() => client.readConfig(), (error) => error.status === 403 && /CORA_MEMBERSHIP_REQUIRED/.test(error.message));
});

