// PROOF THAT EVERY COMPLETION RECORDS WHICH MODEL PRODUCED IT.
//
// WHAT WENT WRONG, 2026-07-30. Troy spoke to Helmion, saw "Qwen 3.5" flash on
// screen, said "hello Grok", and got a reply that called itself Helmion. He
// asked who he had been talking to and no log anywhere could answer it. The
// answer had to be reconstructed from live processes — `Get-Process ollama`,
// port 11434 — which stops being possible the moment that process exits.
//
// THE RULE EVERY TEST HERE FOLLOWS, inherited from test/audit-wiring.test.mjs:
// prove the wiring by the DURABLE SIDE EFFECT. A reply carrying
// `provenance: {logged:true}` has told us what it intends. Every assertion below
// reads the JSONL back off disk, because the file is the only thing that will
// still exist an hour after the app closes — which is exactly when Troy asked.
//
// AND THE ASSERTIONS THEMSELVES ARE TESTED. `assertAnsweredBy` is the check the
// positive tests rely on, so the negative control at the bottom of this file
// runs a completion the pre-fix way — a real request, a real parsed reply, and
// no ledger write — and requires that same check to FAIL. Three defects shipped
// today were tests that passed on broken and fixed code alike. This one cannot.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { chatWithTools } from '../src/agent/providers.mjs';
import { runAgentTurn } from '../src/agent/loop.mjs';
import { readCompletions, summarizeCompletions } from '../src/core/provenance-log.mjs';
import {
  cleanProvenanceWorkspace,
  makeProvenanceWorkspace,
} from '../test-support/provenance-workspace.mjs';

// ═══ THE CHECK UNDER TEST ════════════════════════════════════════════════════

/**
 * "Does the ledger say that <provider> answered, using <model>?"
 *
 * This is the assertion the whole feature has to satisfy, so it is written ONCE
 * and reused — including by the negative control, which requires it to throw.
 * A per-test hand-rolled assertion could quietly be weaker in the negative case
 * than in the positive one, which is how a test ends up proving nothing.
 */
function assertAnsweredBy(workspace, { provider, model, isLocal = null }) {
  const { entries } = readCompletions(workspace);
  const match = entries.find((e) => e.provider === provider && e.model === model);
  assert.ok(
    match,
    `the ledger has no row saying ${provider} answered with ${model}. `
    + `Rows present: ${JSON.stringify(entries.map((e) => `${e.provider}/${e.model}`))}`,
  );
  if (isLocal !== null) {
    assert.equal(match.isLocal, isLocal, `isLocal should be ${isLocal} for ${provider}/${model}`);
  }
  assert.ok(Date.parse(match.timestamp) > 0, 'the row has no parseable timestamp');
  assert.ok(match.sessionId, 'the row does not say which session it belonged to');
  assert.ok(match.endpointHost, 'the row does not say which host answered');
  return match;
}

// ═══ WIRE-FORMAT STUBS ═══════════════════════════════════════════════════════
//
// Real vendor URLs, stubbed transport. Pointing the built-in providers at a
// local HTTP stub would make every row's endpoint 127.0.0.1 and quietly destroy
// the one distinction these tests exist to prove.

const REPLIES = {
  openaiCompatible: { choices: [{ message: { content: 'answered', tool_calls: [] } }] },
  anthropic: { content: [{ type: 'text', text: 'answered' }] },
  gemini: { candidates: [{ content: { parts: [{ text: 'answered' }] } }] },
};

function stubFetch(bodyFor) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(bodyFor(String(url))),
    };
  };
  return {
    seen,
    restore() { globalThis.fetch = original; },
  };
}

function replyForUrl(url) {
  if (url.includes('api.anthropic.com')) return REPLIES.anthropic;
  if (url.includes('generativelanguage.googleapis.com')) return REPLIES.gemini;
  return REPLIES.openaiCompatible;
}

async function withStubbedProviders(fn) {
  const stub = stubFetch(replyForUrl);
  const workspace = makeProvenanceWorkspace('helmion-prov-wire-');
  try {
    await fn({ workspace, stub });
  } finally {
    stub.restore();
    cleanProvenanceWorkspace(workspace);
  }
}

const MESSAGES = [{ role: 'user', content: 'hello' }];

// ═══ 1. EVERY PROVIDER WRITES A ROW NAMING ITSELF ════════════════════════════

test('A COMPLETION FROM EACH PROVIDER WRITES A ROW NAMING THAT PROVIDER', async () => {
  await withStubbedProviders(async ({ workspace }) => {
    const cases = [
      { providerId: 'anthropic', model: 'claude-sonnet-5', provider: 'claude', host: 'api.anthropic.com' },
      { providerId: 'openai', model: 'gpt-5.6-terra', provider: 'openai', host: 'api.openai.com' },
      { providerId: 'gemini', model: 'gemini-2.5-flash', provider: 'gemini', host: 'generativelanguage.googleapis.com' },
      { providerId: 'xai', model: 'grok-4.5', provider: 'grok', host: 'api.x.ai' },
    ];

    for (const c of cases) {
      const reply = await chatWithTools({
        providerId: c.providerId,
        apiKey: 'test-key-for-provenance-wiring',
        model: c.model,
        messages: MESSAGES,
        toolDefs: [],
        provenance: { workspace },
      });
      // The reply is unchanged by the recording; it just carries the outcome.
      assert.equal(reply.content, 'answered');
      assert.equal(reply.provenance.logged, true, reply.provenance.reason);
    }

    // THE ASSERTION THAT MATTERS: on disk, one row per provider, each naming
    // itself, its exact model, and the host that actually answered.
    for (const c of cases) {
      const row = assertAnsweredBy(workspace, { provider: c.provider, model: c.model, isLocal: false });
      assert.equal(row.providerId, c.providerId);
      assert.equal(row.endpointHost, c.host);
    }

    const summary = summarizeCompletions(workspace);
    assert.equal(summary.total, 4);
    assert.equal(summary.local, 0);
    assert.equal(summary.remote, 4);
    assert.deepEqual(summary.byProvider, {
      claude: 1, openai: 1, gemini: 1, grok: 1,
    });
  });
});

test('the row records the model that was SENT, including a provider default', async () => {
  await withStubbedProviders(async ({ workspace, stub }) => {
    // No model passed: chatWithTools falls back to its own default. A ledger
    // that recorded the caller's `undefined` would be describing a request that
    // never happened.
    await chatWithTools({
      providerId: 'anthropic',
      apiKey: 'test-key-for-provenance-wiring',
      messages: MESSAGES,
      toolDefs: [],
      provenance: { workspace },
    });
    const sentModel = JSON.parse(stub.seen[0].init.body).model;
    assertAnsweredBy(workspace, { provider: 'claude', model: sentModel });
    assert.equal(sentModel, 'claude-sonnet-5', 'the default this test pins has moved');
  });
});

// ═══ 2. LOCAL IS UNMISTAKABLE ════════════════════════════════════════════════

test('A LOCAL COMPLETION IS UNMISTAKABLY MARKED LOCAL — the whole point of this ledger', async () => {
  await withStubbedProviders(async ({ workspace }) => {
    // Exactly the shape resolveLocalProvider produces (local-provider.mjs:161-174):
    // providerId 'custom', a loopback Ollama URL, and the qwen model that
    // answered Troy while calling itself Helmion.
    const reply = await chatWithTools({
      providerId: 'custom',
      apiKey: 'no-key-required',
      url: 'http://127.0.0.1:11434/v1/chat/completions',
      model: 'qwen3.5:4b',
      messages: MESSAGES,
      toolDefs: [],
      provenance: { workspace, routedLocal: true },
    });
    assert.equal(reply.provenance.logged, true, reply.provenance.reason);

    const row = assertAnsweredBy(workspace, { provider: 'local', model: 'qwen3.5:4b', isLocal: true });
    // Three independent ways a reader can see it, so no single field being
    // misread can hide it: the provider NAME is 'local', the boolean is true,
    // and the host is the loopback port Ollama listens on.
    assert.equal(row.provider, 'local');
    assert.equal(row.isLocal, true);
    assert.equal(row.endpointHost, '127.0.0.1:11434');
    assert.equal(row.routedLocal, true);

    // And it is countable without a reader having to derive it.
    assert.equal(summarizeCompletions(workspace).local, 1);
    assert.equal(readCompletions(workspace, { isLocal: true }).entries.length, 1);
    assert.equal(readCompletions(workspace, { isLocal: false }).entries.length, 0);
  });
});

test('LOCAL IS DERIVED FROM THE ENDPOINT, so a caller that claims nothing cannot hide it', async () => {
  await withStubbedProviders(async ({ workspace }) => {
    // No routedLocal at all — the caller says nothing about local routing. This
    // is the failure mode the incident actually had: the model answered and
    // nothing anywhere declared what it was.
    await chatWithTools({
      providerId: 'custom',
      apiKey: 'no-key-required',
      url: 'http://localhost:11434/v1/chat/completions',
      model: 'qwen3.5:4b',
      messages: MESSAGES,
      toolDefs: [],
      provenance: { workspace },
    });
    const row = assertAnsweredBy(workspace, { provider: 'local', model: 'qwen3.5:4b', isLocal: true });
    assert.equal(row.routedLocal, undefined, 'nobody claimed it; the row must not invent a claim');
    assert.equal(row.isLocal, true, 'the endpoint alone must be enough to mark it local');
  });
});

test('a REMOTE custom endpoint is not dressed up as local', async () => {
  await withStubbedProviders(async ({ workspace }) => {
    // A self-hosted vLLM on somebody else's machine. Calling this "local" would
    // overstate what the row proves about where Troy's words went.
    await chatWithTools({
      providerId: 'custom',
      apiKey: 'k',
      url: 'https://vllm.example.com/v1/chat/completions',
      model: 'mixtral-8x7b',
      messages: MESSAGES,
      toolDefs: [],
      provenance: { workspace },
    });
    const row = assertAnsweredBy(workspace, { provider: 'custom', model: 'mixtral-8x7b', isLocal: false });
    assert.equal(row.endpointHost, 'vllm.example.com');
  });
});

// ═══ 3. THE FALLBACK — where a decision-time log would have lied ═════════════

test('WHEN LOCAL DIES AND THE FRONTIER ANSWERS, THE ROW NAMES THE FRONTIER', async () => {
  const workspace = makeProvenanceWorkspace('helmion-prov-fallback-');
  const original = globalThis.fetch;
  try {
    // Local refuses the connection; Anthropic answers. This is the case the
    // whole design turns on: a record written where the model was CHOSEN would
    // name qwen here, because qwen is what the router picked.
    globalThis.fetch = async (url) => {
      if (String(url).includes('127.0.0.1')) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, text: async () => JSON.stringify(REPLIES.anthropic) };
    };

    const events = [];
    const result = await runAgentTurn({
      userText: 'hi',
      messages: [],
      provider: { id: 'anthropic', key: 'frontier-key-for-provenance', label: 'Claude' },
      runtime: { permissionMode: 'read-only', definitionsForOpenAi: () => [], root: workspace },
      onEvent: (e) => events.push(e),
      localProvider: {
        id: 'custom',
        key: 'no-key-required',
        label: 'local:qwen3.5:4b',
        baseUrl: 'http://127.0.0.1:11434/v1',
        url: 'http://127.0.0.1:11434/v1/chat/completions',
        model: 'qwen3.5:4b',
        isLocal: true,
        timeoutMs: 2000,
      },
    });
    assert.equal(result.text, 'answered', 'the turn must still succeed');

    const { entries } = readCompletions(workspace);
    // EXACTLY ONE ROW. The local attempt produced no completion, so it recorded
    // nothing — "nothing answered" is not "a model answered".
    assert.equal(entries.length, 1, `expected one row, got ${JSON.stringify(entries)}`);
    // claude-haiku-4-5, not sonnet: "hi" is a fast-tier turn, and the fallback
    // re-runs the SAME classification with local disallowed
    // (loop.mjs pickModel(round, {allowLocal:false})), so it lands on the
    // frontier's fast model. Pinned deliberately — the row has to name the model
    // that answered, and this is the one that did.
    assertAnsweredBy(workspace, { provider: 'claude', model: 'claude-haiku-4-5', isLocal: false });
    assert.equal(entries[0].endpointHost, 'api.anthropic.com');
    assert.equal(
      entries.some((e) => e.model === 'qwen3.5:4b'),
      false,
      'the ledger credited an answer to a model that never produced one',
    );
    // The router DID pick local first — proving the fallback really happened and
    // this test is not passing because local was never attempted.
    assert.ok(
      events.some((e) => e.type === 'model' && e.isLocal === true),
      'local was never attempted, so this proves nothing about fallbacks',
    );
  } finally {
    globalThis.fetch = original;
    cleanProvenanceWorkspace(workspace);
  }
});

test('a turn through the real loop records the router context alongside the model', async () => {
  const workspace = makeProvenanceWorkspace('helmion-prov-loop-');
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true, status: 200, text: async () => JSON.stringify(REPLIES.anthropic),
    });
    const events = [];
    await runAgentTurn({
      userText: 'Investigate the root cause of this deadlock and design a fix.',
      messages: [],
      provider: { id: 'anthropic', key: 'frontier-key-for-provenance', label: 'Claude' },
      runtime: { permissionMode: 'read-only', definitionsForOpenAi: () => [], root: workspace },
      onEvent: (e) => events.push(e),
      localProvider: null,
    });

    const [row] = readCompletions(workspace).entries;
    assert.equal(row.provider, 'claude');
    assert.equal(row.tier, 'deep', 'the tier that ran is part of the record');
    assert.equal(row.round, 0);
    assert.equal(row.providerLabel, 'Claude');
    assert.ok(row.reason, 'the router reason is recorded so a row explains itself');
    assert.ok(Number.isFinite(row.latencyMs), 'the measured latency is recorded');

    // The UI event is derived from the row that was WRITTEN, not from the
    // routing decision — the 'model' event fires before the request goes out and
    // can therefore only ever report an intention.
    const announced = events.find((e) => e.type === 'provenance');
    assert.ok(announced, 'nothing announced the recorded provenance');
    assert.equal(announced.model, row.model);
    assert.equal(announced.provider, 'claude');
    assert.equal(announced.isLocal, false);
    assert.equal(announced.endpointHost, 'api.anthropic.com');
  } finally {
    globalThis.fetch = original;
    cleanProvenanceWorkspace(workspace);
  }
});

// ═══ 3b. THE DESKTOP PROTOCOL ════════════════════════════════════════════════
//
// The Pilot's Console reads NDJSON from a real `helmion agent-bridge` child
// process. This spawns that child for real: nothing about the route from the
// completion to the desktop is simulated, because the header field this feeds
// is the one place Troy would have seen the truth on 2026-07-30.

test('THE BRIDGE EMITS A provenance EVENT AND THE ROW IS ON DISK IN THE WORKSPACE', async () => {
  const { spawn } = await import('node:child_process');
  const { createInterface } = await import('node:readline');
  const { fileURLToPath } = await import('node:url');
  const { createStubServer } = await import('../test-support/openai-compatible-stub.mjs');

  const workspace = makeProvenanceWorkspace('helmion-prov-bridge-');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const server = createStubServer({ onRequest: () => {} });
  const port = await new Promise((done) => {
    server.listen(0, '127.0.0.1', () => done(server.address().port));
  });

  // HELMION_LOCAL_ENABLED pinned OFF: this test must not depend on whether
  // Ollama happens to be listening on the machine running it.
  const child = spawn(process.execPath, ['bin/helmion.mjs', 'agent-bridge'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      ...process.env,
      HELMION_CUSTOM_PROVIDERS: '',
      HELMION_MAESTRO_COORDINATOR: 'Gemini',
      HELMION_LOCAL_ENABLED: '0',
    },
  });

  const customProviders = [{
    name: 'prov-stub',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'prov-key',
    model: 'prov-stub-model',
  }];
  const events = [];

  try {
    await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error('bridge timed out')), 20000);
      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        events.push(ev);
        if (ev.event === 'ready') {
          child.stdin.write(`${JSON.stringify({
            cmd: 'turn',
            text: 'ping',
            workspace,
            provider: 'prov-stub',
            permission: 'read-only',
            customProviders,
          })}\n`);
        }
        if (ev.event === 'done') { clearTimeout(timer); done(); }
      });
      child.on('error', fail);
      child.stdin.write(`${JSON.stringify({
        cmd: 'configure',
        workspace,
        provider: 'prov-stub',
        permission: 'read-only',
        customProviders,
      })}\n`);
    });

    const announced = events.find((e) => e.event === 'provenance');
    assert.ok(announced, `no provenance event: ${JSON.stringify(events.map((e) => e.event))}`);
    assert.equal(announced.model, 'prov-stub-model');
    assert.equal(announced.endpointHost, `127.0.0.1:${port}`);
    assert.equal(typeof announced.isLocal, 'boolean');
    assert.ok(announced.sessionId, 'the desktop cannot group rows without a session id');

    // AND THE DURABLE HALF: the row is in the workspace the turn ran against —
    // not in the repo the bridge process happens to be running from.
    const row = assertAnsweredBy(workspace, { provider: 'local', model: 'prov-stub-model' });
    assert.equal(row.endpointHost, `127.0.0.1:${port}`);
    assert.equal(
      row.model, announced.model,
      'the event and the file disagree about who answered',
    );
  } finally {
    child.kill();
    server.close();
    cleanProvenanceWorkspace(workspace);
  }
});

// ═══ 4. WHAT MUST *NOT* BE RECORDED ══════════════════════════════════════════

test('A FAILED CALL WRITES ONLY A SANITIZED ATTEMPT RECEIPT — no completion arrived', async () => {
  const workspace = makeProvenanceWorkspace('helmion-prov-fail-');
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: false, status: 500, text: async () => '{"error":"upstream exploded","api_key":"sk-live-provider-secret"}',
    });
    await assert.rejects(() => chatWithTools({
      providerId: 'openai',
      apiKey: 'k',
      model: 'gpt-5.6-terra',
      messages: MESSAGES,
      toolDefs: [],
      provenance: { workspace },
    }), /HTTP 500/);

    assert.deepEqual(readCompletions(workspace).entries, [],
      'a failed request was recorded as though something had answered');
    const failures = readCompletions(workspace, { outcome: 'failed' }).entries;
    assert.equal(failures.length, 1);
    assert.deepEqual({
      outcome: failures[0].outcome,
      provider: failures[0].provider,
      providerId: failures[0].providerId,
      model: failures[0].model,
      endpointHost: failures[0].endpointHost,
      failureCode: failures[0].failureCode,
      httpStatus: failures[0].httpStatus,
    }, {
      outcome: 'failed', provider: 'openai', providerId: 'openai', model: 'gpt-5.6-terra', endpointHost: 'api.openai.com', failureCode: 'provider_http_error', httpStatus: 500,
    });
    const onDisk = readFileSync(failures[0] && readCompletions(workspace, { outcome: 'failed' }).files[0], 'utf8');
    assert.equal(onDisk.includes('upstream exploded'), false, 'provider response body leaked into the receipt');
    assert.equal(onDisk.includes('sk-live-provider-secret'), false, 'provider credential leaked into the receipt');
  } finally {
    globalThis.fetch = original;
    cleanProvenanceWorkspace(workspace);
  }
});

test("GEMINI'S API KEY NEVER REACHES THE LEDGER — it authenticates in the URL", async () => {
  await withStubbedProviders(async ({ workspace, stub }) => {
    const key = 'AIzaSyTESTKEY0123456789abcdefghijklmno';
    await chatWithTools({
      providerId: 'gemini',
      apiKey: key,
      model: 'gemini-2.5-flash',
      messages: MESSAGES,
      toolDefs: [],
      provenance: { workspace },
    });

    // The key really was on the wire, in the URL — otherwise this proves nothing.
    assert.ok(stub.seen[0].url.includes(key), 'the request did not carry the key in its URL');

    const file = readCompletions(workspace).files[0];
    const onDisk = readFileSync(file, 'utf8');
    assert.equal(onDisk.includes(key), false, `the provenance ledger leaked: ${key}`);
    assert.equal(onDisk.includes('key='), false, 'a query string survived into the ledger');
    assert.match(onDisk, /generativelanguage\.googleapis\.com/);
  });
});

test('a ledger that cannot be written never fails the turn, and says so out loud', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200, text: async () => JSON.stringify(REPLIES.anthropic),
  });
  try {
    let reply;
    // An unwritable workspace: '' resolves to no usable audit directory.
    assert.doesNotThrow(() => {});
    reply = await chatWithTools({
      providerId: 'anthropic',
      apiKey: 'k',
      model: 'claude-sonnet-5',
      messages: MESSAGES,
      toolDefs: [],
      // A path that cannot be created: a NUL byte is rejected by every OS.
      provenance: { workspace: '\0invalid' },
    });
    // The ANSWER still arrives. That property matters more than the record.
    assert.equal(reply.content, 'answered');
    assert.equal(reply.provenance.logged, false);
    assert.ok(reply.provenance.reason, 'a logging failure must explain itself');
  } finally {
    globalThis.fetch = original;
  }
});

// ═══ 5. THE NEGATIVE CONTROL ═════════════════════════════════════════════════

test('NEGATIVE CONTROL: assertAnsweredBy FAILS when the completion is not recorded', async () => {
  const workspace = makeProvenanceWorkspace('helmion-prov-negative-');
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => ({
      ok: true, status: 200, text: async () => JSON.stringify(replyForUrl(String(url))),
    });

    // 1. A RECORDED completion, so the workspace is NOT simply empty. Without
    //    this the negative half would only prove that a reader finds nothing in
    //    an empty directory, which is true of a completely broken writer too.
    await chatWithTools({
      providerId: 'anthropic',
      apiKey: 'k',
      model: 'claude-sonnet-5',
      messages: MESSAGES,
      toolDefs: [],
      provenance: { workspace },
    });
    assertAnsweredBy(workspace, { provider: 'claude', model: 'claude-sonnet-5' });

    // 2. A completion produced THE PRE-FIX WAY: the same request, over the same
    //    transport, parsed the same way, with no ledger write. This is what the
    //    code did yesterday, and what any future refactor that drops the write
    //    site would go back to doing.
    const res = await globalThis.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.6-terra', messages: MESSAGES }),
    });
    const parsed = JSON.parse(await res.text());
    assert.equal(parsed.choices[0].message.content, 'answered',
      'the unrecorded completion must really have happened');

    // 3. THE CONTROL. The same check, on the same workspace, must FAIL for the
    //    completion nobody recorded. A check that passed here would pass on
    //    broken and fixed code alike and prove nothing.
    assert.throws(
      () => assertAnsweredBy(workspace, { provider: 'openai', model: 'gpt-5.6-terra' }),
      /the ledger has no row saying openai answered/,
      'THE CHECK HAS NO TEETH: it reported a completion that was never recorded',
    );

    // And the ledger is honest about its own contents rather than empty.
    assert.equal(summarizeCompletions(workspace).total, 1);
  } finally {
    globalThis.fetch = original;
    cleanProvenanceWorkspace(workspace);
  }
});

test('NEGATIVE CONTROL: the local check fails when a local answer is filed as remote', async () => {
  const workspace = makeProvenanceWorkspace('helmion-prov-negative-local-');
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true, status: 200, text: async () => JSON.stringify(REPLIES.openaiCompatible),
    });
    // A remote endpoint answering with the very model name that ran locally
    // during the incident. Only the endpoint distinguishes them, which is
    // precisely why isLocal is derived from the endpoint.
    await chatWithTools({
      providerId: 'custom',
      apiKey: 'k',
      url: 'https://someone-elses-box.example.com/v1/chat/completions',
      model: 'qwen3.5:4b',
      messages: MESSAGES,
      toolDefs: [],
      provenance: { workspace },
    });

    // The row exists…
    assertAnsweredBy(workspace, { provider: 'custom', model: 'qwen3.5:4b' });
    // …but claiming it was local must fail.
    assert.throws(
      () => assertAnsweredBy(workspace, { provider: 'local', model: 'qwen3.5:4b', isLocal: true }),
      /no row saying local answered/,
      'the local check accepts a remote row and therefore proves nothing',
    );
  } finally {
    globalThis.fetch = original;
    cleanProvenanceWorkspace(workspace);
  }
});
