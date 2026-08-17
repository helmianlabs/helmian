import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAIAppBuildPlannerAdapter, OPENAI_APP_BUILD_PLANNER_ENDPOINT } from '../src/cora/openai-app-build-planner-adapter.mjs';

const draft = { intent: 'draft', title: 'Driver self onboarding', department: 'hr', route: '/hr/self-onboarding', description: 'Collect a driver onboarding draft.', idempotencyKey: 'provider-plan-0001', components: [{ type: 'heading', text: 'Driver self onboarding' }, { type: 'field', label: 'Driver email', fieldType: 'email', required: true }, { type: 'button', label: 'Save draft', action: 'save_draft' }] };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => body });

test('mocked OpenAI structured output produces only a bounded HR draft receipt', async () => {
  const calls = [];
  const plan = createOpenAIAppBuildPlannerAdapter({ apiKey: 'test-key-not-a-real-secret', model: 'gpt-5.6-mini', fetchImpl: async (...args) => { calls.push(args); return response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(draft) } }] })); } });
  const receipt = await plan('Build HR a driver self-onboarding page.');
  assert.equal(calls.length, 1); assert.equal(calls[0][0], OPENAI_APP_BUILD_PLANNER_ENDPOINT); assert.equal(receipt.normalized.route, '/hr/self-onboarding'); assert.equal(receipt.providerInvocation, 'performed');
  const body = JSON.parse(calls[0][1].body); assert.equal(body.response_format.json_schema.strict, true); assert.equal(body.max_completion_tokens, 700); assert.equal(body.messages.some((message) => /tenantId|apiKey|test-key-not-a-real-secret/u.test(message.content)), false);
});

test('mocked provider rejects malformed JSON, raw code, HTTP errors, timeout, and no output without network', async () => {
  const base = { apiKey: 'test-key-not-a-real-secret', model: 'gpt-5.6-mini' };
  await assert.rejects(createOpenAIAppBuildPlannerAdapter({ ...base, fetchImpl: async () => response(JSON.stringify({ choices: [{ message: { content: '{bad' } }] })) })('HR draft'), /non-JSON|malformed app-build JSON/);
  await assert.rejects(createOpenAIAppBuildPlannerAdapter({ ...base, fetchImpl: async () => response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...draft, components: [{ type: 'heading', text: '<script>run()</script>' }] }) } }] })) })('HR draft'), /raw HTML/);
  await assert.rejects(createOpenAIAppBuildPlannerAdapter({ ...base, fetchImpl: async () => response('bad gateway', 502) })('HR draft'), /HTTP 502/);
  await assert.rejects(createOpenAIAppBuildPlannerAdapter({ ...base, fetchImpl: async () => { const aborted = new Error('aborted'); aborted.name = 'AbortError'; throw aborted; } })('HR draft'), /timed out/);
  await assert.rejects(createOpenAIAppBuildPlannerAdapter({ ...base, fetchImpl: async () => response(JSON.stringify({ choices: [{ message: { content: '' } }] })) })('HR draft'), /no structured app-build output/);
  let called = false;
  assert.throws(() => createOpenAIAppBuildPlannerAdapter({ model: 'gpt-5.6-mini', fetchImpl: async () => { called = true; return response(''); } }), /credential.*not configured/);
  const rejectUnsafePrompt = createOpenAIAppBuildPlannerAdapter({ ...base, fetchImpl: async () => { called = true; return response(''); } });
  await assert.rejects(rejectUnsafePrompt('Build it for tenantId=other with api_key: sk-not-for-provider'), /authority selector or secret/);
  assert.equal(called, false);
});
