import { planAppBuildFromNaturalLanguage } from './app-build-natural-language-planner.mjs';

export const OPENAI_APP_BUILD_PLANNER_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_OUTPUT_TOKENS = 1_024;

const APP_BUILD_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['intent', 'title', 'department', 'route', 'description', 'components', 'idempotencyKey'],
  properties: {
    intent: { type: 'string', enum: ['draft'] }, title: { type: 'string', minLength: 1, maxLength: 240 },
    department: { type: 'string', minLength: 1, maxLength: 160 }, route: { type: 'string', pattern: '^/[a-z0-9][a-z0-9-]{0,47}(?:/[a-z0-9][a-z0-9-]{0,47}){0,3}$' },
    description: { type: 'string', minLength: 1, maxLength: 1200 }, idempotencyKey: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' },
    components: { type: 'array', minItems: 1, maxItems: 32, items: { anyOf: [
      { type: 'object', additionalProperties: false, required: ['type', 'text'], properties: { type: { type: 'string', enum: ['heading', 'paragraph'] }, text: { type: 'string', minLength: 1, maxLength: 500 } } },
      { type: 'object', additionalProperties: false, required: ['type', 'label', 'fieldType', 'required'], properties: { type: { type: 'string', enum: ['field'] }, label: { type: 'string', minLength: 1, maxLength: 120 }, fieldType: { type: 'string', enum: ['text', 'email', 'date', 'select'] }, required: { type: 'boolean' } } },
      { type: 'object', additionalProperties: false, required: ['type', 'label', 'action'], properties: { type: { type: 'string', enum: ['button'] }, label: { type: 'string', minLength: 1, maxLength: 120 }, action: { type: 'string', enum: ['save_draft'] } } },
      { type: 'object', additionalProperties: false, required: ['type', 'label', 'columns'], properties: { type: { type: 'string', enum: ['table'] }, label: { type: 'string', minLength: 1, maxLength: 120 }, columns: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 80 } } } },
    ] } },
  },
});

function configuredText(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${name} is not configured`);
  return value.trim();
}
function boundedNumber(value, fallback, max, name) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > max) throw new Error(`${name} is invalid`);
  return resolved;
}
function error(message, code) { const result = new Error(message); result.code = code; return result; }
function safeUserPrompt(value) {
  const prompt = configuredText(value, 'app-build user request', 4000);
  if (/\b(?:tenantId|tenant_id|organizationId|organization_id|plantId|plant_id|facilityId|facility_id)\b/iu.test(prompt)
    || /\b(?:api[_ -]?key|authorization|bearer)\s*[:=]/iu.test(prompt)
    || /\bsk-[A-Za-z0-9_-]{8,}\b/u.test(prompt)) throw error('app-build user request contains an authority selector or secret', 'unsafe_user_request');
  return prompt;
}
function providerBody(userRequest, model, maxOutputTokens) {
  return {
    model, max_completion_tokens: maxOutputTokens,
    messages: [
      { role: 'system', content: 'Return exactly one JSON object matching the supplied schema. Design only a draft UI. Do not return HTML, JavaScript, CSS, shell commands, file paths, URLs, credentials, tenant/organization/plant/facility selectors, execution, publishing, deployment, or approval actions.' },
      { role: 'user', content: userRequest },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'cora_app_build_draft', strict: true, schema: APP_BUILD_SCHEMA } },
  };
}
function extractOneJsonObject(content) {
  if (typeof content !== 'string' || !content.trim()) throw error('provider returned no structured app-build output', 'provider_no_output');
  const text = content.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) throw error('provider returned non-JSON app-build output', 'provider_invalid_output');
  try { const parsed = JSON.parse(text); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object'); } catch { throw error('provider returned malformed app-build JSON', 'provider_invalid_output'); }
  return text;
}

/** Uses the documented Chat Completions structured-output contract, but only returns a bounded draft receipt. */
export function createOpenAIAppBuildPlannerAdapter({ apiKey, model, fetchImpl = globalThis.fetch, timeoutMs = 8_000, maxOutputTokens = 700, maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
  const credential = configuredText(apiKey, 'OpenAI app-build provider credential', 4096);
  const configuredModel = configuredText(model, 'OpenAI app-build provider model', 160);
  if (typeof fetchImpl !== 'function') throw new Error('OpenAI app-build provider fetch is not configured');
  const timeout = boundedNumber(timeoutMs, 8_000, MAX_TIMEOUT_MS, 'provider timeout');
  const outputBudget = boundedNumber(maxOutputTokens, 700, MAX_OUTPUT_TOKENS, 'provider output budget');
  const responseLimit = boundedNumber(maxResponseBytes, MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES, 'provider response limit');
  return async function planWithOpenAI(userRequest) {
    const safePrompt = safeUserPrompt(userRequest);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await fetchImpl(OPENAI_APP_BUILD_PLANNER_ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify(providerBody(safePrompt, configuredModel, outputBudget)), signal: controller.signal });
    } catch (cause) {
      if (controller.signal.aborted || cause?.name === 'AbortError') throw error('OpenAI app-build provider timed out', 'provider_timeout');
      throw error('OpenAI app-build provider is unavailable', 'provider_unavailable');
    } finally { clearTimeout(timer); }
    const raw = await response.text();
    if (raw.length > responseLimit) throw error('OpenAI app-build provider response exceeds limit', 'provider_response_too_large');
    if (!response.ok) throw error(`OpenAI app-build provider returned HTTP ${response.status}`, 'provider_http_error');
    let envelope;
    try { envelope = JSON.parse(raw); } catch { throw error('OpenAI app-build provider returned malformed response envelope', 'provider_invalid_response'); }
    const plannerResponse = extractOneJsonObject(envelope?.choices?.[0]?.message?.content);
    const receipt = planAppBuildFromNaturalLanguage({ userRequest: safePrompt, plannerResponse });
    return Object.freeze({ ...receipt, source: Object.freeze({ ...receipt.source, provider: 'openai-chat-completions', model: configuredModel }), providerInvocation: 'performed' });
  };
}
