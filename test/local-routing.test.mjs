import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolveTurnModel, TIERS } from '../src/agent/model-router.mjs';
import {
  LOCAL_BREVITY_INSTRUCTION,
  LOCAL_DEFAULT_MODEL,
  LOCAL_DEFAULT_TIMEOUT_MS,
  LOCAL_DEFAULT_URL,
  LOCAL_JOB_CONTRACT,
  LOCAL_MAX_PROMPT_CHARS,
  LOCAL_SAFETY_DENY,
  LOCAL_TIER,
  classifyLocalEligibility,
  resolveLocalProvider,
  withLocalBrevity,
} from '../src/agent/local-provider.mjs';
import { runAgentTurn } from '../src/agent/loop.mjs';
import { createStubServer } from '../test-support/openai-compatible-stub.mjs';
import { sharedProvenanceWorkspace } from '../test-support/provenance-workspace.mjs';

// Keys here are deliberately long, distinctive strings. providers.mjs redacts
// the outbound body by splitting on the RAW key with no minimum-length guard
// (redactOutboundBody), so a one-character key like 'k' rewrites every 'k' in
// the request to [REDACTED] — "deadlock" arrives as "deadloc[REDACTED]". That
// is a real robustness gap in that helper, but it is not what these tests are
// about, so they stay clear of it.
const TEST_KEY = 'zzz-test-provider-key-zzz';
const FRONTIER = { id: 'anthropic', label: 'Claude', key: TEST_KEY };
const ON = { HELMION_LOCAL_ENABLED: '1' };
const LOCAL = resolveLocalProvider(ON);

// --- resolveLocalProvider ---------------------------------------------------

test('local routing is OFF unless explicitly enabled', () => {
  // Regression guard. When this defaulted to ON, three unrelated bridge tests
  // began routing their turns to whatever model happened to be listening on
  // 127.0.0.1:11434 instead of the endpoint they were testing.
  assert.equal(resolveLocalProvider({}), null, 'empty env must not enable local routing');
  assert.equal(resolveLocalProvider({ HELMION_LOCAL_URL: 'http://127.0.0.1:11434/v1' }), null,
    'configuring a URL alone must not enable it either');
  assert.ok(resolveLocalProvider(ON), 'HELMION_LOCAL_ENABLED=1 turns it on');
});

test('resolveLocalProvider defaults to the loopback Ollama endpoint', () => {
  const p = resolveLocalProvider(ON);
  assert.equal(p.id, 'custom', 'must reuse the existing custom-endpoint path');
  assert.equal(p.baseUrl, LOCAL_DEFAULT_URL);
  assert.equal(p.model, LOCAL_DEFAULT_MODEL);
  assert.equal(p.isLocal, true);
  assert.equal(p.timeoutMs, LOCAL_DEFAULT_TIMEOUT_MS);
  // Local runtimes are keyless; the placeholder keeps chatWithTools' "no API
  // key configured" guard from rejecting them.
  assert.equal(p.key, 'no-key-required');
  assert.match(p.baseUrl, /^http:\/\/127\.0\.0\.1:/, 'must be loopback, never 0.0.0.0');
});

test('resolveLocalProvider appends /chat/completions exactly once', () => {
  assert.equal(
    resolveLocalProvider({ ...ON, HELMION_LOCAL_URL: 'http://127.0.0.1:11434/v1' }).url,
    'http://127.0.0.1:11434/v1/chat/completions',
  );
  assert.equal(
    resolveLocalProvider({ ...ON, HELMION_LOCAL_URL: 'http://127.0.0.1:11434/v1/chat/completions' }).url,
    'http://127.0.0.1:11434/v1/chat/completions',
  );
});

test('resolveLocalProvider honours the disable flag', () => {
  for (const off of ['0', 'false', 'no', 'off']) {
    assert.equal(resolveLocalProvider({ HELMION_LOCAL_ENABLED: off }), null, `flag ${off}`);
  }
  for (const on of ['1', 'true', 'yes', 'on']) {
    assert.ok(resolveLocalProvider({ HELMION_LOCAL_ENABLED: on }), `flag ${on}`);
  }
});

test('resolveLocalProvider rejects a nonsense timeout rather than hanging forever', () => {
  assert.equal(resolveLocalProvider({ ...ON, HELMION_LOCAL_TIMEOUT_MS: '-5' }).timeoutMs, LOCAL_DEFAULT_TIMEOUT_MS);
  assert.equal(resolveLocalProvider({ ...ON, HELMION_LOCAL_TIMEOUT_MS: 'abc' }).timeoutMs, LOCAL_DEFAULT_TIMEOUT_MS);
  assert.equal(resolveLocalProvider({ ...ON, HELMION_LOCAL_TIMEOUT_MS: '2500' }).timeoutMs, 2500);
});

// --- criteria: turns that SHOULD route local --------------------------------

test('trivial turns route local', () => {
  const trivial = [
    'What does the acronym API stand for?',
    'thanks',
    'Summarize this in one line: the server returned 200 and the job finished.',
    'Is JSON case sensitive?',
  ];
  for (const userText of trivial) {
    const v = classifyLocalEligibility({ tier: 'fast', userText, localProvider: LOCAL });
    assert.equal(v.local, true, `should be local: ${userText} (${v.reason})`);
  }
});

// --- criteria: turns that MUST NOT route local ------------------------------

test('local is round-0 only — never mid-chain', () => {
  for (const round of [1, 2, 7]) {
    const v = classifyLocalEligibility({
      tier: 'fast', userText: 'ok', roundsUsedThisTurn: round, localProvider: LOCAL,
    });
    assert.equal(v.local, false, `round ${round} must not be local`);
    assert.match(v.reason, /round-0 only/);
  }
});

test('only the fast tier is eligible — standard and deep stay frontier', () => {
  for (const tier of ['standard', 'deep']) {
    const v = classifyLocalEligibility({ tier, userText: 'ok', localProvider: LOCAL });
    assert.equal(v.local, false, `${tier} must not be local`);
    assert.match(v.reason, /above the local ceiling/);
  }
});

test('an explicit human choice always wins over local routing', () => {
  const pinnedTier = classifyLocalEligibility({
    tier: 'fast', userText: 'ok', localProvider: LOCAL, explicitTier: 'fast',
  });
  assert.equal(pinnedTier.local, false);
  const pinnedModel = classifyLocalEligibility({
    tier: 'fast', userText: 'ok', localProvider: LOCAL, modelOverride: 'claude-opus-5',
  });
  assert.equal(pinnedModel.local, false);
});

test('no local provider means no local routing', () => {
  const v = classifyLocalEligibility({ tier: 'fast', userText: 'ok', localProvider: null });
  assert.equal(v.local, false);
  assert.match(v.reason, /no local provider/);
});

test('a long prompt is itself evidence the turn is not trivial', () => {
  const long = 'a'.repeat(LOCAL_MAX_PROMPT_CHARS + 1);
  assert.equal(classifyLocalEligibility({ tier: 'fast', userText: long, localProvider: LOCAL }).local, false);
  // Boundary: exactly at the cap is still allowed.
  const atCap = 'a'.repeat(LOCAL_MAX_PROMPT_CHARS);
  assert.equal(classifyLocalEligibility({ tier: 'fast', userText: atCap, localProvider: LOCAL }).local, true);
});

test('"continue" resumes real work and must not drop to the local model', () => {
  for (const userText of ['continue', 'keep going', 'proceed', 'go ahead']) {
    const v = classifyLocalEligibility({ tier: 'fast', userText, localProvider: LOCAL });
    assert.equal(v.local, false, `"${userText}" must stay frontier`);
  }
});

test('HARD SAFETY CARVE-OUTS never route local', () => {
  const forbidden = {
    money: ['what is our stripe billing setup', 'issue a refund for that invoice'],
    // The `.env` variants are regression cases: the first version of the deny
    // list wrapped every alternative in \b(...)\b, which made `.env` unmatchable
    // and let "read the .env" route to the local model.
    credentials: [
      'what is the password', 'where is the api key stored',
      'read the .env', 'show me .env', 'cat .env.local', 'what is in .env?',
    ],
    deletion: ['delete that row', 'drop the old index', 'purge the cache'],
    deploys: ['deploy to production', 'is it live in prod', 'publish the release'],
    schema: ['write a migration', 'alter table loads'],
    governance: ['is this tier-b', 'record the consensus', 'needs approval'],
  };
  for (const [category, prompts] of Object.entries(forbidden)) {
    for (const userText of prompts) {
      const v = classifyLocalEligibility({ tier: 'fast', userText, localProvider: LOCAL });
      assert.equal(v.local, false, `${category}: "${userText}" must never be local (${v.reason})`);
    }
  }
});

test('the deny pattern is a real filter, not a regex that matches everything', () => {
  // Positive control: without this, a deny-list that matched every string would
  // pass the test above while silently disabling local routing entirely.
  for (const benign of ['what does API stand for', 'summarize this paragraph', 'thanks']) {
    assert.equal(LOCAL_SAFETY_DENY.test(benign), false, `deny must not match: ${benign}`);
  }
});

// --- resolveTurnModel integration ------------------------------------------

test('resolveTurnModel swaps the provider to local for a trivial turn', () => {
  const r = resolveTurnModel({
    provider: FRONTIER,
    userText: 'What does the acronym API stand for?',
    localProvider: LOCAL,
  });
  assert.equal(r.tier, LOCAL_TIER);
  assert.equal(r.isLocal, true);
  assert.equal(r.model, LOCAL.model);
  assert.equal(r.provider, LOCAL, 'the turn must be sent to the LOCAL endpoint');
  assert.match(r.source, /local endpoint/);
});

test('resolveTurnModel keeps hard turns on the frontier provider', () => {
  const r = resolveTurnModel({
    provider: FRONTIER,
    userText: 'Find the root cause of this deadlock and explain the race condition.',
    localProvider: LOCAL,
  });
  assert.equal(r.isLocal, false);
  assert.equal(r.tier, 'deep');
  assert.equal(r.provider, FRONTIER);
  assert.equal(r.model, 'claude-opus-5');
});

test('REGRESSION: omitting localProvider preserves the pre-existing behaviour', () => {
  // Local routing must be invisible to every caller that never opted in.
  for (const userText of ['hi', 'refactor the parser', 'why does this leak memory']) {
    const withoutLocal = resolveTurnModel({ provider: FRONTIER, userText });
    assert.equal(withoutLocal.isLocal, false, userText);
    assert.equal(withoutLocal.provider, FRONTIER, userText);
    assert.ok(TIERS.includes(withoutLocal.tier), `tier must stay on the ladder: ${withoutLocal.tier}`);
  }
});

test('local is not a member of the frontier tier ladder', () => {
  assert.equal(TIERS.includes(LOCAL_TIER), false);
});

// --- end-to-end: fallback must never fail the turn --------------------------

async function withStub(fn) {
  const seen = [];
  const server = createStubServer({ onRequest: (r) => seen.push(r) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    return await fn({ port, seen });
  } finally {
    server.close();
    await once(server, 'close');
  }
}

// `root` is not decoration. runAgentTurn passes runtime.root to the provenance
// ledger as the workspace a turn belongs to (src/agent/loop.mjs), and a runtime
// without one falls back to process.cwd() — which during `node --test` is the
// repo, so every turn below would append a row to Helmion's own ledger claiming
// a model answered Troy.
const fakeRuntime = {
  permissionMode: 'read-only',
  definitionsForOpenAi: () => [],
  root: sharedProvenanceWorkspace('helmion-local-routing-'),
};

test('PRODUCTION BOUNDARY: enabling local jobs cannot route an interactive reply to Qwen', async () => {
  await withStub(async ({ port, seen }) => {
    const localSeen = [];
    const localServer = createStubServer({ onRequest: (r) => localSeen.push(r) });
    localServer.listen(0, '127.0.0.1');
    await once(localServer, 'listening');
    const localPort = localServer.address().port;
    const beforeEnabled = process.env.HELMION_LOCAL_ENABLED;
    const beforeUrl = process.env.HELMION_LOCAL_URL;

    try {
      // This flag is allowed to enable the schema-validated, no-tools jobs in
      // src/jobs/local-job.mjs. It must have no effect on runAgentTurn.
      process.env.HELMION_LOCAL_ENABLED = '1';
      process.env.HELMION_LOCAL_URL = `http://127.0.0.1:${localPort}/v1`;

      const frontier = {
        id: 'custom',
        key: 'frontier-key',
        label: 'SelectedCloudStub',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        url: `http://127.0.0.1:${port}/v1/chat/completions`,
        model: 'selected-cloud-model',
      };
      const events = [];
      const result = await runAgentTurn({
        userText: 'What does the acronym API stand for?',
        messages: [],
        provider: frontier,
        runtime: fakeRuntime,
        onEvent: (event) => events.push(event),
        // Deliberately omit localProvider: this is the production call shape.
      });

      assert.ok(result.text.length > 0);
      assert.equal(localSeen.length, 0, 'the interactive turn must never reach Ollama');
      assert.equal(seen.length, 1, 'the selected provider must receive the turn');
      assert.equal(seen[0].model, 'selected-cloud-model');
      assert.equal(
        events.some((event) => event.type === 'model' && event.isLocal === true),
        false,
        'the interactive route must never announce or attempt a local model',
      );
    } finally {
      if (beforeEnabled === undefined) delete process.env.HELMION_LOCAL_ENABLED;
      else process.env.HELMION_LOCAL_ENABLED = beforeEnabled;
      if (beforeUrl === undefined) delete process.env.HELMION_LOCAL_URL;
      else process.env.HELMION_LOCAL_URL = beforeUrl;
      localServer.close();
      await once(localServer, 'close');
    }
  });
});

test('a DEAD local endpoint falls back to the frontier — the turn still succeeds', async () => {
  await withStub(async ({ port, seen }) => {
    // Port 9 is the discard port: nothing listens, so the connection is refused
    // immediately. This is a real failure, not a mocked one.
    const deadLocal = {
      ...resolveLocalProvider({ ...ON, HELMION_LOCAL_URL: 'http://127.0.0.1:9/v1' }),
      timeoutMs: 2000,
    };
    const frontier = {
      id: 'custom',
      key: 'frontier-key',
      label: 'StubFrontier',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      url: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: 'stub-frontier-model',
    };
    const events = [];
    const result = await runAgentTurn({
      userText: 'What does the acronym API stand for?',
      messages: [],
      provider: frontier,
      runtime: fakeRuntime,
      onEvent: (e) => events.push(e),
      localProvider: deadLocal,
    });

    assert.ok(result.text.length > 0, 'the turn must produce an answer, not an error');
    assert.equal(seen.length, 1, 'exactly one request should have reached the frontier stub');
    assert.equal(seen[0].model, 'stub-frontier-model');
    assert.ok(
      events.some((e) => e.type === 'status' && /local model unavailable/.test(e.message || '')),
      'the fallback must be announced, not silent',
    );
    // It genuinely tried local first.
    assert.ok(events.some((e) => e.type === 'model' && e.isLocal === true), 'local was attempted');
  });
});

test('a hard turn never reaches the local endpoint at all', async () => {
  await withStub(async ({ port, seen }) => {
    const localSeen = [];
    const localServer = createStubServer({ onRequest: (r) => localSeen.push(r) });
    localServer.listen(0, '127.0.0.1');
    await once(localServer, 'listening');
    const localPort = localServer.address().port;
    try {
      const local = {
        ...resolveLocalProvider({ ...ON, HELMION_LOCAL_URL: `http://127.0.0.1:${localPort}/v1` }),
        model: 'local-stub-model',
      };
      const frontier = {
        id: 'custom',
        key: 'frontier-key',
        label: 'StubFrontier',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        url: `http://127.0.0.1:${port}/v1/chat/completions`,
        model: 'stub-frontier-model',
      };
      await runAgentTurn({
        userText: 'Deploy this to production and drop the old table.',
        messages: [],
        provider: frontier,
        runtime: fakeRuntime,
        onEvent: () => {},
        localProvider: local,
      });
      assert.equal(localSeen.length, 0, 'a deploy/deletion turn must never touch the local model');
      assert.equal(seen.length, 1, 'it went to the frontier instead');
    } finally {
      localServer.close();
      await once(localServer, 'close');
    }
  });
});

test('a trivial turn really is sent to the local endpoint', async () => {
  const localSeen = [];
  const localServer = createStubServer({ onRequest: (r) => localSeen.push(r) });
  localServer.listen(0, '127.0.0.1');
  await once(localServer, 'listening');
  const localPort = localServer.address().port;
  try {
    const local = {
      ...resolveLocalProvider({ ...ON, HELMION_LOCAL_URL: `http://127.0.0.1:${localPort}/v1` }),
      model: 'local-stub-model',
    };
    const frontier = {
      id: 'custom', key: 'frontier-key', label: 'StubFrontier',
      baseUrl: 'http://127.0.0.1:9/v1', url: 'http://127.0.0.1:9/v1/chat/completions',
      model: 'stub-frontier-model',
    };
    const result = await runAgentTurn({
      userText: 'What does the acronym API stand for?',
      messages: [],
      provider: frontier,
      runtime: fakeRuntime,
      onEvent: () => {},
      localProvider: local,
    });
    assert.equal(localSeen.length, 1, 'the local endpoint served the turn');
    assert.equal(localSeen[0].model, 'local-stub-model');
    assert.ok(result.text.length > 0);
  } finally {
    localServer.close();
    await once(localServer, 'close');
  }
});

// --- reasoning_effort must reach the local endpoint and NOTHING else --------

test('the LOCAL endpoint receives reasoning_effort:none', async () => {
  const seen = [];
  const server = createStubServer({ onRequest: (r) => seen.push(r) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const local = {
      ...resolveLocalProvider({ ...ON, HELMION_LOCAL_URL: `http://127.0.0.1:${port}/v1` }),
      model: 'local-stub-model',
    };
    await runAgentTurn({
      userText: 'What does the acronym API stand for?',
      messages: [], provider: FRONTIER, runtime: fakeRuntime,
      onEvent: () => {}, localProvider: local,
    });
    assert.equal(seen.length, 1);
    // Without this the local model emits its full hidden reasoning trace:
    // ~2603 tokens / ~40 s for a one-sentence answer, vs 30 tokens / 0.9 s.
    assert.equal(seen[0].body.reasoning_effort, 'none');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('a NON-local custom endpoint never receives reasoning_effort', async () => {
  // The whole point of the opt-in flag. LM Studio, vLLM and DeepSeek are also
  // providerId 'custom' and were never tested against this field, so inferring
  // it from the provider id would risk 400ing somebody else's endpoint.
  const seen = [];
  const server = createStubServer({ onRequest: (r) => seen.push(r) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const customFrontier = {
      id: 'custom', key: TEST_KEY, label: 'SomeOtherCustomEndpoint',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      url: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: 'not-local-model',
    };
    await runAgentTurn({
      userText: 'What does the acronym API stand for?',
      messages: [], provider: customFrontier, runtime: fakeRuntime,
      onEvent: () => {}, localProvider: null,
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].body.model, 'not-local-model', 'sanity: the custom endpoint served it');
    assert.equal(
      Object.prototype.hasOwnProperty.call(seen[0].body, 'reasoning_effort'), false,
      'reasoning_effort must be ABSENT, not merely falsy',
    );
  } finally {
    server.close();
    await once(server, 'close');
  }
});

// --- brevity: local turns only, and never by truncation ---------------------

test('withLocalBrevity folds the instruction into the first system message', () => {
  const out = withLocalBrevity([
    { role: 'system', content: 'You are Helmion.' },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(out[0].role, 'system');
  assert.ok(out[0].content.startsWith('You are Helmion.'), 'original system text is kept');
  assert.ok(out[0].content.includes(LOCAL_BREVITY_INSTRUCTION));
  assert.deepEqual(out[1], { role: 'user', content: 'hi' }, 'other messages untouched');
});

test('withLocalBrevity prepends a system message when there is none', () => {
  const out = withLocalBrevity([{ role: 'user', content: 'hi' }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, LOCAL_BREVITY_INSTRUCTION);
});

test('withLocalBrevity NEVER mutates the conversation it was given', () => {
  // The live history is reused for every later frontier round. If this mutated,
  // "be brief" would leak into frontier turns permanently.
  const system = { role: 'system', content: 'You are Helmion.' };
  const original = [system, { role: 'user', content: 'hi' }];
  const snapshot = JSON.parse(JSON.stringify(original));
  const out = withLocalBrevity(original);
  assert.notEqual(out, original, 'must return a new array');
  assert.deepEqual(original, snapshot, 'input array unchanged');
  assert.equal(system.content, 'You are Helmion.', 'the system object itself is unchanged');
});

test('a LOCAL turn is sent the brevity instruction', async () => {
  const seen = [];
  const server = createStubServer({ onRequest: (r) => seen.push(r) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const local = {
      ...resolveLocalProvider({ ...ON, HELMION_LOCAL_URL: `http://127.0.0.1:${port}/v1` }),
      model: 'local-stub-model',
    };
    await runAgentTurn({
      userText: 'What does the acronym API stand for?',
      messages: [{ role: 'system', content: 'You are Helmion.' }],
      provider: FRONTIER, runtime: fakeRuntime, onEvent: () => {}, localProvider: local,
    });
    const sys = seen[0].body.messages.find((m) => m.role === 'system');
    assert.ok(sys.content.includes(LOCAL_BREVITY_INSTRUCTION));
    // Brevity must be an instruction, never a truncation.
    assert.equal(
      Object.prototype.hasOwnProperty.call(seen[0].body, 'max_tokens'), false,
      'no max_tokens may be set — a severed answer is worse than a slow one',
    );
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('a FRONTIER turn is byte-identical to what it was before brevity existed', async () => {
  const seen = [];
  const server = createStubServer({ onRequest: (r) => seen.push(r) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const frontier = {
      id: 'custom', key: TEST_KEY, label: 'StubFrontier',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      url: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: 'frontier-model',
    };
    // A hard turn, so the router never considers local at all.
    await runAgentTurn({
      userText: 'Find the root cause of the deadlock in the scheduler.',
      messages: [{ role: 'system', content: 'You are Helmion.' }],
      provider: frontier, runtime: fakeRuntime, onEvent: () => {},
      localProvider: resolveLocalProvider(ON),
    });
    assert.deepEqual(seen[0].body.messages, [
      { role: 'system', content: 'You are Helmion.' },
      { role: 'user', content: 'Find the root cause of the deadlock in the scheduler.' },
    ], 'the frontier must receive the conversation verbatim');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('LEAK GUARD: brevity does not survive into a later frontier round', async () => {
  // The case the no-mutation rule exists for. Local is attempted and fails, the
  // turn falls back to the frontier — which must NOT inherit "be brief".
  const seen = [];
  const server = createStubServer({ onRequest: (r) => seen.push(r) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const deadLocal = {
      ...resolveLocalProvider({ ...ON, HELMION_LOCAL_URL: 'http://127.0.0.1:9/v1' }),
      timeoutMs: 2000,
    };
    const frontier = {
      id: 'custom', key: TEST_KEY, label: 'StubFrontier',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      url: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: 'frontier-model',
    };
    const history = [{ role: 'system', content: 'You are Helmion.' }];
    await runAgentTurn({
      userText: 'What does the acronym API stand for?',
      messages: history, provider: frontier, runtime: fakeRuntime,
      onEvent: () => {}, localProvider: deadLocal,
    });
    assert.equal(seen.length, 1, 'the frontier served it after local failed');
    const sys = seen[0].body.messages.find((m) => m.role === 'system');
    assert.equal(sys.content, 'You are Helmion.', 'frontier system prompt is clean');
    assert.equal(history[0].content, 'You are Helmion.', 'live history was never polluted');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

// --- the seam the four always-on jobs will build against --------------------

test('LOCAL_JOB_CONTRACT names the four jobs and forbids tools', () => {
  assert.deepEqual(
    [...LOCAL_JOB_CONTRACT.jobs],
    ['triage', 'commit-message', 'log-monitor', 'dictation-summary'],
  );
  assert.equal(LOCAL_JOB_CONTRACT.toolsAllowed, false);
  assert.equal(LOCAL_JOB_CONTRACT.denyPattern, LOCAL_SAFETY_DENY);
  assert.throws(() => { LOCAL_JOB_CONTRACT.version = 2; }, 'contract must be frozen');
});
