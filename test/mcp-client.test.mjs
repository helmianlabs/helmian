// The MCP client — the seam src/agent/plugins.mjs:34 admitted was missing.
//
// A client for somebody else's process has to be tested on the days the server
// misbehaves, not the day it works. So most of this file is failure: a server
// that dies mid-call, one that never answers, one that writes noise to stdout,
// one that returns an error object. The happy path is two tests; the rest is
// what stops a bad server hanging a turn forever.
//
// A LIVE CONFORMANCE TEST RUNS TOO, against Helmion's own advisory server, which
// is the primary source for the wire format this client speaks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  INHERITED_ENV,
  McpClientError,
  buildEnv,
  createMcpClient,
} from '../src/agent/mcp-client.mjs';

/**
 * A fake server process. `respond` decides what comes back for each request, so
 * every failure mode is reachable without a real MCP server on disk.
 */
function fakeServer({ respond, autoInitialize = true } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => { child.emit('exit', 0, null); };

  let buffer = '';
  stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;

      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id === undefined) continue; // notification

      if (message.method === 'initialize' && autoInitialize) {
        stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2024-11-05', serverInfo: { name: 'fake', version: '9.9' } },
        })}\n`);
        continue;
      }

      const reply = respond?.(message, { stdout, child });
      if (reply !== undefined) {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply })}\n`);
      }
    }
  });

  return { child, spawnFn: () => child };
}

test('the environment is an ALLOW-LIST — secrets never reach a server by accident', () => {
  // spawn inherits process.env by default, which would hand every candidate
  // server ANTHROPIC_API_KEY and HELMION_DATABASE_URL. This is the whole reason
  // buildEnv exists.
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/troy',
    ANTHROPIC_API_KEY: 'sk-ant-SECRET',
    HELMION_DATABASE_URL: 'postgres://SECRET',
    GROK_API_KEY: 'xai-SECRET',
    SOME_RANDOM_VAR: 'nope',
  };

  const env = buildEnv({}, base);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/troy');
  for (const secret of ['ANTHROPIC_API_KEY', 'HELMION_DATABASE_URL', 'GROK_API_KEY', 'SOME_RANDOM_VAR']) {
    assert.equal(env[secret], undefined, `${secret} must not be inherited`);
  }
  assert.ok(!INHERITED_ENV.some((n) => /KEY|TOKEN|SECRET|PASSWORD|DATABASE/i.test(n)),
    'the allow-list itself contains nothing credential-shaped');
});

test('an explicitly granted variable IS passed — that is a decision, not an accident', () => {
  const env = buildEnv({ HELMION_DATABASE_URL: 'postgres://granted' }, { PATH: '/usr/bin' });
  assert.equal(env.HELMION_DATABASE_URL, 'postgres://granted');
});

test('a command is required', async () => {
  await assert.rejects(createMcpClient({}), /needs a command/);
});

test('the handshake reports what the server said about itself', async () => {
  const { spawnFn } = fakeServer();
  const client = await createMcpClient({ command: 'fake', spawnFn });
  assert.equal(client.serverInfo.name, 'fake');
  assert.equal(client.protocolVersion, '2024-11-05');
  await client.close();
});

test('tools are listed, and a tool call returns its content unchanged', async () => {
  const { spawnFn } = fakeServer({
    respond(message) {
      if (message.method === 'tools/list') {
        return { result: { tools: [{ name: 'do_thing', description: 'does a thing' }] } };
      }
      if (message.method === 'tools/call') {
        assert.equal(message.params.name, 'do_thing');
        assert.deepEqual(message.params.arguments, { x: 1 });
        return { result: { content: [{ type: 'text', text: 'the answer' }] } };
      }
      return undefined;
    },
  });

  const client = await createMcpClient({ command: 'fake', spawnFn });
  const tools = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['do_thing']);

  const result = await client.callTool('do_thing', { x: 1 });
  // NOT unwrapped: flattening here would discard anything but the first text
  // block, including a server's own error text.
  assert.deepEqual(result.content, [{ type: 'text', text: 'the answer' }]);
  assert.equal(client.textOf(result), 'the answer');
  await client.close();
});

test('a server ERROR reply becomes a rejection carrying the code', async () => {
  const { spawnFn } = fakeServer({
    respond(message) {
      if (message.method === 'tools/call') {
        return { error: { code: -32601, message: 'Unknown tool: nope' } };
      }
      return undefined;
    },
  });

  const client = await createMcpClient({ command: 'fake', spawnFn });
  await assert.rejects(client.callTool('nope'), (error) => {
    assert.ok(error instanceof McpClientError);
    assert.match(error.message, /Unknown tool/);
    assert.equal(error.code, -32601);
    return true;
  });
  await client.close();
});

test('A SERVER THAT NEVER ANSWERS TIMES OUT instead of hanging the turn', async () => {
  const { spawnFn } = fakeServer({ respond: () => undefined });
  const client = await createMcpClient({ command: 'fake', spawnFn, timeoutMs: 250 });
  await assert.rejects(client.listTools(), /did not answer within 250ms/);
  await client.close();
});

test('A SERVER THAT DIES MID-CALL rejects the pending call, it does not hang', async () => {
  const { child, spawnFn } = fakeServer({
    respond(message, { child: proc }) {
      if (message.method === 'tools/call') {
        setImmediate(() => proc.emit('exit', 1, null));
        return undefined;
      }
      return undefined;
    },
  });

  const client = await createMcpClient({ command: 'fake', spawnFn, timeoutMs: 5000 });
  await assert.rejects(client.callTool('anything'), /exited/);
  assert.equal(client.closed, true, 'and the client knows it is closed');
  void child;
});

test('a call made AFTER the server died fails immediately with the reason', async () => {
  const { child, spawnFn } = fakeServer();
  const client = await createMcpClient({ command: 'fake', spawnFn });
  child.emit('exit', 3, null);
  await assert.rejects(client.callTool('x'), /exited \(code 3/);
});

test('NOISE ON STDOUT IS IGNORED, not fatal', async () => {
  // Servers print startup banners, deprecation warnings and progress lines. A
  // client that dies on the first non-JSON line is useless in practice.
  const { spawnFn } = fakeServer({
    respond(message, { stdout }) {
      if (message.method === 'tools/list') {
        stdout.write('Listening on stdio...\n');
        stdout.write('{ this is not valid json\n');
        return { result: { tools: [{ name: 'survived' }] } };
      }
      return undefined;
    },
  });

  const client = await createMcpClient({ command: 'fake', spawnFn });
  const tools = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['survived']);
  await client.close();
});

test('a spawn failure is reported as a client error, not an unhandled throw', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  setImmediate(() => child.emit('error', new Error('ENOENT: no such file')));

  await assert.rejects(
    createMcpClient({ command: 'does-not-exist', spawnFn: () => child, timeoutMs: 1000 }),
    /could not be started|ENOENT/,
  );
});

test('closing twice is safe, and closing rejects anything in flight', async () => {
  const { spawnFn } = fakeServer({ respond: () => undefined });
  const client = await createMcpClient({ command: 'fake', spawnFn, timeoutMs: 5000 });
  const inFlight = client.callTool('slow');
  await client.close();
  await assert.rejects(inFlight, /closed/);
  await client.close();
  assert.equal(client.closed, true);
});

test('LIVE CONFORMANCE: it talks to Helmion\'s own MCP server', { skip: !process.env.HELMION_DATABASE_URL }, async () => {
  // The repo's own server is the primary source for the wire format this client
  // speaks — src/mcp/server.mjs reads lines and writes `${json}\n`. If this ever
  // fails, the client and the server have drifted.
  const client = await createMcpClient({
    command: process.execPath,
    args: ['bin/mcp-helmion-advisory.mjs'],
    env: { HELMION_DATABASE_URL: process.env.HELMION_DATABASE_URL ?? '' },
    timeoutMs: 20_000,
  });

  try {
    assert.equal(client.serverInfo?.name, 'mcp-helmion-advisory');
    const tools = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('helmion_register_action'), `got: ${names.join(', ')}`);
    assert.ok(names.includes('helmion_record_review'));
    assert.ok(names.includes('helmion_consensus_status'));
  } finally {
    await client.close();
  }
});
