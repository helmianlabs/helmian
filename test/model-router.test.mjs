import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_TIER_MODELS,
  TIERS,
  classifyTier,
  maxTier,
  modelForTier,
  normalizeTier,
  readEnvTier,
  resolveTurnModel,
} from '../src/agent/model-router.mjs';
import { parseCustomProviders, resolveProvider } from '../src/agent/env.mjs';

const OPENAI = { id: 'openai', label: 'OpenAI' };
const ANTHROPIC = { id: 'anthropic', label: 'Claude' };
const GEMINI = { id: 'gemini', label: 'Gemini' };
const XAI = { id: 'xai', label: 'xAI Grok' };

// --- classifier ------------------------------------------------------------

test('short conversational turns route to the fast tier', () => {
  for (const text of ['hey', 'thanks!', 'ok', 'yep', 'status', 'nice']) {
    const { tier } = classifyTier({ userText: text });
    assert.equal(tier, 'fast', `expected "${text}" to be fast`);
  }
});

test('an empty or whitespace prompt is fast, not a crash', () => {
  assert.equal(classifyTier({ userText: '' }).tier, 'fast');
  assert.equal(classifyTier({ userText: '   ' }).tier, 'fast');
  assert.equal(classifyTier({}).tier, 'fast');
});

test('code and multi-file work routes to the standard tier', () => {
  const cases = [
    'refactor these three files',
    'add a test for the parser',
    'fix the npm build',
    'rename the endpoint in src/agent/loop.mjs',
    'what does providers.mjs do',
  ];
  for (const text of cases) {
    const { tier } = classifyTier({ userText: text });
    assert.equal(tier, 'standard', `expected "${text}" to be standard`);
  }
});

test('a fenced code block alone is enough to reach standard', () => {
  const { tier } = classifyTier({ userText: 'look at\n```\nconst a = 1;\n```' });
  assert.equal(tier, 'standard');
});

test('root-cause and architecture language routes to the deep tier', () => {
  const cases = [
    'find the root cause of this race condition',
    'why does the bridge drop the second event',
    'think hard about the architecture here',
    'diagnose the deadlock in the tool loop',
    'investigate the memory leak',
  ];
  for (const text of cases) {
    const { tier } = classifyTier({ userText: text });
    assert.equal(tier, 'deep', `expected "${text}" to be deep`);
  }
});

test('a long prompt is deep even with no reasoning keywords', () => {
  const long = 'a'.repeat(600);
  const { tier, reason } = classifyTier({ userText: long });
  assert.equal(tier, 'deep');
  assert.match(reason, /long prompt \(600 chars\)/);
});

test('a turn that has burned many tool rounds escalates to deep', () => {
  const shallow = classifyTier({ userText: 'hey', roundsUsedThisTurn: 7 });
  assert.equal(shallow.tier, 'fast');

  const deep = classifyTier({ userText: 'hey', roundsUsedThisTurn: 8 });
  assert.equal(deep.tier, 'deep');
  assert.match(deep.reason, /8 tool rounds spent this turn/);
});

test('read-only runtimes get a higher round cap — those rounds are cheap reads', () => {
  const base = { userText: 'hey', permissionMode: 'read-only' };
  assert.equal(classifyTier({ ...base, roundsUsedThisTurn: 8 }).tier, 'fast');
  assert.equal(classifyTier({ ...base, roundsUsedThisTurn: 12 }).tier, 'deep');
});

test('"continue" resumes work in flight and never falls to fast', () => {
  for (const text of ['continue', 'keep going', 'resume', 'go ahead']) {
    const { tier, reason } = classifyTier({ userText: text });
    assert.equal(tier, 'standard', `expected "${text}" to hold at standard`);
    assert.match(reason, /continuation of work already in flight/);
  }
});

test('a long conversation floors a short prompt at standard', () => {
  assert.equal(classifyTier({ userText: 'and now?', historyLength: 4 }).tier, 'fast');
  const { tier, reason } = classifyTier({ userText: 'and now?', historyLength: 12 });
  assert.equal(tier, 'standard');
  assert.match(reason, /conversation has 12 messages/);
});

// --- escalate-only ---------------------------------------------------------

test('mid-turn escalation never downgrades', () => {
  // A turn that started deep stays deep even when a later round would classify
  // as fast on its own.
  const { tier, reason } = classifyTier({ userText: 'ok', floorTier: 'deep' });
  assert.equal(tier, 'deep');
  assert.match(reason, /escalate-only/);
  assert.match(reason, /would have been fast/);

  // …and a floor never *raises* a turn that legitimately classifies higher.
  const rising = classifyTier({
    userText: 'find the root cause of this race condition',
    floorTier: 'fast',
  });
  assert.equal(rising.tier, 'deep');
});

test('maxTier picks the more capable of two tiers and tolerates nulls', () => {
  assert.equal(maxTier('fast', 'deep'), 'deep');
  assert.equal(maxTier('standard', 'fast'), 'standard');
  assert.equal(maxTier(null, 'fast'), 'fast');
  assert.equal(maxTier('deep', null), 'deep');
  assert.equal(maxTier(null, null), null);
});

// --- override chain --------------------------------------------------------

test('an explicit tier wins over the router and over the escalate-only floor', () => {
  const { tier, reason } = classifyTier({
    userText: 'find the root cause of this race condition',
    explicitTier: 'fast',
    floorTier: 'deep',
  });
  assert.equal(tier, 'fast');
  assert.match(reason, /explicit --tier fast/);
});

test('an explicit tier outranks the env tier', () => {
  const { tier } = classifyTier({ userText: 'hey', explicitTier: 'deep', envTier: 'fast' });
  assert.equal(tier, 'deep');
});

test('the env tier outranks the router', () => {
  const { tier, reason } = classifyTier({ userText: 'hey', envTier: 'deep' });
  assert.equal(tier, 'deep');
  assert.match(reason, /HELMION_MODEL_TIER=deep/);
});

test('readEnvTier treats auto, unset and garbage as "let the router decide"', () => {
  assert.equal(readEnvTier({}), null);
  assert.equal(readEnvTier({ HELMION_MODEL_TIER: 'auto' }), null);
  assert.equal(readEnvTier({ HELMION_MODEL_TIER: '  ' }), null);
  assert.equal(readEnvTier({ HELMION_MODEL_TIER: 'turbo' }), null);
  assert.equal(readEnvTier({ HELMION_MODEL_TIER: ' Deep ' }), 'deep');
});

test('normalizeTier accepts only the three known tiers', () => {
  assert.equal(normalizeTier('FAST'), 'fast');
  assert.equal(normalizeTier(' standard '), 'standard');
  assert.equal(normalizeTier('cheap'), null);
  assert.equal(normalizeTier(null), null);
  assert.equal(normalizeTier(42), null);
});

test('--model pins an exact model and bypasses the router', () => {
  const choice = resolveTurnModel({
    provider: ANTHROPIC,
    userText: 'find the root cause of this race condition',
    modelOverride: 'claude-fable-5',
  });
  assert.equal(choice.model, 'claude-fable-5');
  assert.equal(choice.source, 'explicit --model');
  assert.match(choice.reason, /explicit --model claude-fable-5/);
});

// --- tier tables -----------------------------------------------------------

test('every built-in provider declares all three tiers with non-empty ids', () => {
  for (const [providerId, table] of Object.entries(PROVIDER_TIER_MODELS)) {
    for (const tier of TIERS) {
      assert.equal(
        typeof table[tier],
        'string',
        `${providerId}.${tier} must be a string`,
      );
      assert.ok(table[tier].trim(), `${providerId}.${tier} must be non-empty`);
    }
  }
});

test('tier tables resolve to the doc-verified model ids', () => {
  assert.equal(modelForTier(OPENAI, 'fast').model, 'gpt-5.6-luna');
  assert.equal(modelForTier(OPENAI, 'standard').model, 'gpt-5.6-terra');
  assert.equal(modelForTier(OPENAI, 'deep').model, 'gpt-5.6-sol');

  assert.equal(modelForTier(ANTHROPIC, 'fast').model, 'claude-haiku-4-5');
  assert.equal(modelForTier(ANTHROPIC, 'standard').model, 'claude-sonnet-5');
  assert.equal(modelForTier(ANTHROPIC, 'deep').model, 'claude-opus-5');

  assert.equal(modelForTier(GEMINI, 'fast').model, 'gemini-2.5-flash-lite');
  assert.equal(modelForTier(GEMINI, 'standard').model, 'gemini-2.5-flash');
  assert.equal(modelForTier(GEMINI, 'deep').model, 'gemini-2.5-pro');

  // xAI publishes no mini/fast SKU, so fast and standard intentionally share a
  // model rather than pinning an invented or dated id.
  assert.equal(modelForTier(XAI, 'fast').model, 'grok-4.3');
  assert.equal(modelForTier(XAI, 'standard').model, 'grok-4.3');
  assert.equal(modelForTier(XAI, 'deep').model, 'grok-4.5');
});

test('claude-fable-5 is never auto-selected — it is opt-in via --model only', () => {
  const autoSelected = TIERS.map((t) => PROVIDER_TIER_MODELS.anthropic[t]);
  assert.ok(!autoSelected.includes('claude-fable-5'));
});

test('an unknown provider yields no model so the adapter default applies', () => {
  const { model, source } = modelForTier({ id: 'not-a-provider' }, 'deep');
  assert.equal(model, null);
  assert.match(source, /no tier table for provider not-a-provider/);
});

// --- custom OpenAI-compatible providers ------------------------------------

test('a custom provider with one model keeps that model on every tier', () => {
  const single = { id: 'custom', model: 'qwen2.5', models: null };
  for (const tier of TIERS) {
    const { model, source } = modelForTier(single, tier);
    assert.equal(model, 'qwen2.5', `tier ${tier} must not switch away from qwen2.5`);
    assert.match(source, /no tiers declared/);
  }
});

test('a custom provider that declares tiers switches between them', () => {
  const tiered = {
    id: 'custom',
    model: 'qwen2.5:14b',
    models: { fast: 'qwen2.5:3b', standard: 'qwen2.5:14b', deep: 'qwen2.5:32b' },
  };
  assert.equal(modelForTier(tiered, 'fast').model, 'qwen2.5:3b');
  assert.equal(modelForTier(tiered, 'standard').model, 'qwen2.5:14b');
  assert.equal(modelForTier(tiered, 'deep').model, 'qwen2.5:32b');
});

test('a partially-declared custom profile falls back to its single model', () => {
  const partial = {
    id: 'custom',
    model: 'qwen2.5:14b',
    models: { deep: 'qwen2.5:32b' },
  };
  assert.equal(modelForTier(partial, 'deep').model, 'qwen2.5:32b');
  assert.equal(modelForTier(partial, 'fast').model, 'qwen2.5:14b');
  assert.equal(modelForTier(partial, 'standard').model, 'qwen2.5:14b');
});

test('parseCustomProviders reads the optional models block and rejects junk', () => {
  const [tiered] = parseCustomProviders(JSON.stringify([{
    name: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: { fast: 'small', deep: 'big', bogus: 'ignored', standard: '   ' },
  }]));
  assert.deepEqual(tiered.models, { fast: 'small', deep: 'big' });

  // A profile without tiers keeps its original shape exactly — no `models` key
  // at all — so existing desktop/bridge round-trips are untouched.
  const [plain] = parseCustomProviders(JSON.stringify([{
    name: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen',
  }]));
  assert.ok(!('models' in plain));

  const [badBlock] = parseCustomProviders(JSON.stringify([{
    name: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: 'not-an-object',
  }]));
  assert.ok(!('models' in badBlock));
});

test('resolveProvider carries tier models through to the router', () => {
  const env = { maestro: 'local', customProviders: [] };
  const overrides = parseCustomProviders(JSON.stringify([{
    name: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'mid',
    models: { fast: 'small', deep: 'big' },
  }]));
  const provider = resolveProvider('local', env, overrides);
  assert.equal(provider.id, 'custom');
  assert.deepEqual(provider.models, { fast: 'small', deep: 'big' });

  const choice = resolveTurnModel({
    provider,
    userText: 'find the root cause of this race condition',
  });
  assert.equal(choice.tier, 'deep');
  assert.equal(choice.model, 'big');
});

// --- end-to-end resolution -------------------------------------------------

test('resolveTurnModel maps a trivial and a hard prompt to different models', () => {
  const trivial = resolveTurnModel({ provider: XAI, userText: 'hey' });
  const hard = resolveTurnModel({
    provider: XAI,
    userText: 'find the root cause of this race condition',
  });
  assert.equal(trivial.tier, 'fast');
  assert.equal(hard.tier, 'deep');
  assert.notEqual(trivial.model, hard.model);
});

test('resolveTurnModel reports the tier, the model and why it chose them', () => {
  const choice = resolveTurnModel({ provider: GEMINI, userText: 'refactor these three files' });
  assert.equal(choice.tier, 'standard');
  assert.equal(choice.model, 'gemini-2.5-flash');
  assert.match(choice.reason, /prompt describes code or tool work/);
  assert.match(choice.source, /gemini standard tier/);
});
