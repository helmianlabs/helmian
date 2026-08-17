import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  parseCustomProviders,
  resolveChatCompletionsUrl,
  resolveProvider,
} from '../src/agent/env.mjs';
import { chatWithTools, redactOutboundBody } from '../src/agent/providers.mjs';
import { createStubServer } from '../test-support/openai-compatible-stub.mjs';
import { sharedProvenanceWorkspace } from '../test-support/provenance-workspace.mjs';

// Completions here are recorded like any other (src/agent/providers.mjs). They
// go to a throwaway workspace so a test run cannot append invented rows to the
// repo's own provenance ledger.
const LEDGER = sharedProvenanceWorkspace('helmion-custom-provider-');

const BUILTIN_ENV = {
  openai: 'openai-key',
  anthropic: 'anthropic-key',
  gemini: 'gemini-key',
  xai: 'xai-key',
  maestro: 'Gemini',
  customProviders: [],
};

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('resolveChatCompletionsUrl accepts every base-URL shape', () => {
  assert.equal(
    resolveChatCompletionsUrl('http://localhost:11434'),
    'http://localhost:11434/v1/chat/completions',
  );
  assert.equal(
    resolveChatCompletionsUrl('http://localhost:11434/v1'),
    'http://localhost:11434/v1/chat/completions',
  );
  assert.equal(
    resolveChatCompletionsUrl('http://localhost:11434/v1/'),
    'http://localhost:11434/v1/chat/completions',
  );
  assert.equal(
    resolveChatCompletionsUrl('http://localhost:11434/v1/chat/completions'),
    'http://localhost:11434/v1/chat/completions',
  );
  assert.equal(resolveChatCompletionsUrl(''), '');
});

test('parseCustomProviders drops malformed entries instead of throwing', () => {
  assert.deepEqual(parseCustomProviders(''), []);
  assert.deepEqual(parseCustomProviders('not json'), []);
  assert.deepEqual(parseCustomProviders('{"name":"x"}'), []);
  assert.deepEqual(parseCustomProviders('[{"name":"","baseUrl":"http://a"}]'), []);
  assert.deepEqual(
    parseCustomProviders('[{"name":"local","baseUrl":"http://a/v1"}]'),
    [{ name: 'local', baseUrl: 'http://a/v1', apiKey: '', model: 'local' }],
  );
  assert.deepEqual(
    parseCustomProviders('[{"name":"local","baseUrl":"http://a/v1","apiKey":"k","model":"m"}]'),
    [{ name: 'local', baseUrl: 'http://a/v1', apiKey: 'k', model: 'm' }],
  );
});

test('resolveProvider still routes the four built-ins unchanged', () => {
  assert.equal(resolveProvider('openai', BUILTIN_ENV).id, 'openai');
  assert.equal(resolveProvider('claude', BUILTIN_ENV).id, 'anthropic');
  assert.equal(resolveProvider('gemini', BUILTIN_ENV).id, 'gemini');
  assert.equal(resolveProvider('grok', BUILTIN_ENV).id, 'xai');
});

test('resolveProvider resolves a custom provider from env', () => {
  const env = {
    ...BUILTIN_ENV,
    customProviders: parseCustomProviders(
      '[{"name":"my-local","baseUrl":"http://127.0.0.1:9/v1","apiKey":"k","model":"qwen"}]',
    ),
  };
  const provider = resolveProvider('my-local', env);
  assert.equal(provider.id, 'custom');
  assert.equal(provider.label, 'my-local');
  assert.equal(provider.model, 'qwen');
  assert.equal(provider.key, 'k');
  assert.equal(provider.url, 'http://127.0.0.1:9/v1/chat/completions');
});

test('resolveProvider matches a custom provider case-insensitively', () => {
  const overrides = [{ name: 'My-Local', baseUrl: 'http://127.0.0.1:9', apiKey: '', model: 'm' }];
  assert.equal(resolveProvider('my-local', BUILTIN_ENV, overrides).id, 'custom');
});

test('a keyless local endpoint still resolves (Ollama runs without auth)', () => {
  const overrides = [{ name: 'ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: 'q' }];
  const provider = resolveProvider('ollama', BUILTIN_ENV, overrides);
  assert.equal(provider.apiKey, '');
  assert.ok(provider.key, 'placeholder key keeps the no-key guard from rejecting it');
});

test('a custom provider may not shadow a built-in coordinator', () => {
  const overrides = [{ name: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model: 'm' }];
  const provider = resolveProvider('openai', BUILTIN_ENV, overrides);
  assert.equal(provider.id, 'openai');
  assert.equal(provider.url, undefined);
});

test('an unknown provider throws and names the custom endpoints it does know', () => {
  const overrides = [{ name: 'my-local', baseUrl: 'http://a/v1', apiKey: '', model: 'm' }];
  assert.throws(
    () => resolveProvider('nope', BUILTIN_ENV, overrides),
    /Unknown provider "nope".*my-local/s,
  );
});

test('chatWithTools sends a custom provider to its own endpoint and returns the reply', async () => {
  const seen = [];
  const server = createStubServer({ onRequest: (info) => seen.push(info) });
  const port = await listen(server);
  try {
    const provider = resolveProvider('stub', BUILTIN_ENV, [
      { name: 'stub', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'stub-key', model: 'stub-7b' },
    ]);

    const reply = await chatWithTools({
      providerId: provider.id,
      apiKey: provider.key,
      url: provider.url,
      model: provider.model,
      messages: [{ role: 'user', content: 'ping' }],
      toolDefs: [],
      provenance: { workspace: LEDGER },
    });

    assert.equal(reply.role, 'assistant');
    assert.match(reply.content, /Hello from the Helmion custom endpoint stub/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].model, 'stub-7b');
    assert.equal(seen[0].authorization, 'Bearer stub-key');
    assert.equal(seen[0].lastUserMessage, 'ping');
  } finally {
    server.close();
  }
});

test('chatWithTools refuses a custom provider with no endpoint URL', async () => {
  await assert.rejects(
    () => chatWithTools({
      providerId: 'custom',
      apiKey: 'k',
      messages: [{ role: 'user', content: 'hi' }],
      toolDefs: [],
    }),
    /missing its endpoint URL/,
  );
});

test('the custom path redacts secrets in the outbound body like every other provider', async () => {
  const seen = [];
  const server = createStubServer({ onRequest: (info) => seen.push(info) });
  const port = await listen(server);
  try {
    await chatWithTools({
      providerId: 'custom',
      apiKey: 'stub-key',
      url: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: 'stub-7b',
      messages: [{
        role: 'user',
        content: 'my key is xai-abcdef0123456789 and my db is postgresql://u:secretpw@host/db',
      }],
      toolDefs: [],
      provenance: { workspace: LEDGER },
    });

    const sent = JSON.stringify(seen[0].body);
    assert.ok(!sent.includes('xai-abcdef0123456789'), 'xAI key must not leave the process');
    assert.ok(!sent.includes('secretpw'), 'database password must not leave the process');
    assert.match(sent, /\[REDACTED\]/);
  } finally {
    server.close();
  }
});

test('redactOutboundBody removes the live key itself from a body', () => {
  const body = JSON.stringify({ note: 'key sk-live-1234567890' });
  assert.match(redactOutboundBody(body, 'sk-live-1234567890'), /\[REDACTED\]/);
});

test('the NDJSON bridge routes a turn through a custom provider sent in the payload', async () => {
  const seen = [];
  const server = createStubServer({ onRequest: (info) => seen.push(info) });
  const port = await listen(server);
  const root = fileURLToPath(new URL('..', import.meta.url));

  // Deliberately no HELMION_CUSTOM_PROVIDERS: this proves the configure/turn payload
  // path the desktop AgentBridge uses, not the env-var seed.
  //
  // HELMION_LOCAL_ENABLED is forced OFF for this child. The turn below is short
  // and trivial, so with local routing on it is exactly the shape the router
  // sends to Ollama — the assertion then compares the stub's reply against a
  // real qwen answer and fails. That happened the moment the flag was switched
  // on in .env. A test must not depend on a user's machine-level setting, so it
  // pins the value rather than the .env being "correct".
  const child = spawn(process.execPath, ['bin/helmion.mjs', 'agent-bridge'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HELMION_CUSTOM_PROVIDERS: '',
      HELMION_MAESTRO_COORDINATOR: 'Gemini',
      HELMION_LOCAL_ENABLED: '0',
    },
  });

  const customProviders = [{
    name: 'bridge-stub',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'bridge-key',
    model: 'bridge-model',
  }];

  const events = [];
  let childStderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { childStderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`bridge timed out: ${childStderr}`)), 20000);
      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        events.push(ev);
        if (ev.event === 'ready') {
          child.stdin.write(`${JSON.stringify({
            cmd: 'turn',
            text: 'ping the bridge',
            // A throwaway workspace, not the repo: an agent turn run against
            // E:\Helmion appends its provenance rows to the real ledger.
            workspace: LEDGER,
            provider: 'bridge-stub',
            permission: 'read-only',
            customProviders,
          })}\n`);
        }
        if (ev.event === 'done') {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', (error) => reject(new Error(`bridge process failed: ${error.message}; ${childStderr}`)));
      child.stdin.write(`${JSON.stringify({
        cmd: 'configure',
        workspace: LEDGER,
        provider: 'bridge-stub',
        permission: 'read-only',
        customProviders,
      })}\n`);
    });
  } finally {
    child.kill();
    server.close();
  }

  const ready = events.find((e) => e.event === 'ready');
  assert.equal(ready.providerId, 'custom');
  assert.equal(ready.provider, 'bridge-stub');
  assert.equal(ready.endpoint, `http://127.0.0.1:${port}/v1/chat/completions`);

  const assistant = events.find((e) => e.event === 'assistant');
  assert.match(assistant.text, /Hello from the Helmion custom endpoint stub/);

  assert.equal(seen.at(-1).model, 'bridge-model');
  assert.equal(seen.at(-1).authorization, 'Bearer bridge-key');
  assert.equal(seen.at(-1).lastUserMessage, 'ping the bridge');
});
