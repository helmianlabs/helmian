import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createToolRuntime, normalizePermissionMode } from '../src/agent/tools.mjs';
import { createSessionState, resetSessionState } from '../src/agent/loop.mjs';
import {
  ALLOW_ONCE,
  ALLOW_SESSION,
  DENY,
  createApprovalBroker,
  isAllowed,
  normalizeDecision,
  resolveAskTimeoutMs,
  summarizeToolCall,
} from '../src/agent/approval.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));

/** Fresh throwaway workspace; every filesystem assertion runs inside one. */
function makeWorkspace() {
  return mkdtempSync(join(tmpdir(), 'helmion-ask-'));
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Approver that always answers the same way, counting how often it was asked. */
function fixedApprover(decision) {
  const calls = [];
  const fn = async (request) => {
    calls.push(request);
    return decision;
  };
  fn.calls = calls;
  return fn;
}

describe('normalizeDecision — everything that is not an explicit allow is a denial', () => {
  test('allow words map to allow-once', () => {
    for (const word of ['allow-once', 'allow_once', 'allow', 'once', 'approve', 'yes', 'y', 'Y', ' YES ']) {
      assert.equal(normalizeDecision(word), ALLOW_ONCE, `${JSON.stringify(word)} should allow once`);
    }
    assert.equal(normalizeDecision(true), ALLOW_ONCE);
  });

  test('session words map to allow-session', () => {
    for (const word of ['allow-session', 'allow_session', 'session', 'always', 'all', 's', 'S']) {
      assert.equal(normalizeDecision(word), ALLOW_SESSION, `${JSON.stringify(word)} should allow for session`);
    }
  });

  test('malformed, missing, and hostile values all deny', () => {
    const hostile = [
      undefined, null, '', ' ', 'n', 'no', 'deny', 'nope', 'maybe', 'allow once',
      'ALLOW-ONCE-PLEASE', 0, 1, 42, false, [], {}, { allow: true }, { decision: 'weird' },
      () => ALLOW_ONCE, NaN, Infinity, 'yes\nallow-session',
    ];
    for (const value of hostile) {
      assert.equal(
        normalizeDecision(value),
        DENY,
        `${JSON.stringify(String(value))} must deny`,
      );
    }
  });

  test('an object carrying a decision field is accepted', () => {
    assert.equal(normalizeDecision({ decision: 'allow-once' }), ALLOW_ONCE);
    assert.equal(normalizeDecision({ decision: 'allow-session' }), ALLOW_SESSION);
    assert.equal(normalizeDecision({ decision: 'deny' }), DENY);
  });

  test('isAllowed only accepts the two allow decisions', () => {
    assert.equal(isAllowed(ALLOW_ONCE), true);
    assert.equal(isAllowed(ALLOW_SESSION), true);
    assert.equal(isAllowed(DENY), false);
    assert.equal(isAllowed('anything else'), false);
    assert.equal(isAllowed(undefined), false);
  });
});

describe('normalizePermissionMode — ask is a real fourth tier', () => {
  test('ask and its aliases resolve to ask', () => {
    for (const word of ['ask', 'Ask', 'ASK', 'always-ask', 'always_ask', 'ask-each', 'approve', 'prompt', 'confirm']) {
      assert.equal(normalizePermissionMode(word), 'ask', `${word} should be ask`);
    }
  });

  test('the other three tiers are unchanged', () => {
    assert.equal(normalizePermissionMode('full'), 'full');
    assert.equal(normalizePermissionMode('all'), 'full');
    assert.equal(normalizePermissionMode('read-tools'), 'read-tools');
    assert.equal(normalizePermissionMode('read-only'), 'read-only');
    assert.equal(normalizePermissionMode('nonsense'), 'read-only');
    assert.equal(normalizePermissionMode(undefined), 'read-only');
  });

  test('ask makes every tool eligible; read-tools still does not', () => {
    const ws = makeWorkspace();
    try {
      const ask = createToolRuntime(ws, { permissionMode: 'ask', approver: fixedApprover(ALLOW_ONCE) });
      assert.deepEqual(
        Object.keys(ask.tools).sort(),
        ['list_dir', 'read_file', 'run_command', 'search_text', 'write_file'],
      );
      const readTools = createToolRuntime(ws, { permissionMode: 'read-tools' });
      assert.deepEqual(Object.keys(readTools.tools).sort(), ['list_dir', 'read_file', 'search_text']);
    } finally {
      cleanup(ws);
    }
  });
});

describe('ask mode gate — proven by the side effect on disk, not by the return string', () => {
  test('an APPROVED write_file actually writes the file', async () => {
    const ws = makeWorkspace();
    try {
      const approver = fixedApprover(ALLOW_ONCE);
      const runtime = createToolRuntime(ws, { permissionMode: 'ask', approver });
      const target = join(ws, 'approved.txt');

      const result = await runtime.execute('write_file', { path: 'approved.txt', content: 'real bytes' });

      assert.equal(existsSync(target), true, 'approved write must land on disk');
      assert.equal(readFileSync(target, 'utf8'), 'real bytes');
      assert.match(result, /Wrote 10 bytes/);
      assert.equal(approver.calls.length, 1, 'the human was asked exactly once');
      assert.equal(approver.calls[0].tool, 'write_file');
      assert.equal(approver.calls[0].workspace, resolve(ws));
    } finally {
      cleanup(ws);
    }
  });

  test('a DENIED write_file leaves no file behind', async () => {
    const ws = makeWorkspace();
    try {
      const approver = fixedApprover(DENY);
      const runtime = createToolRuntime(ws, { permissionMode: 'ask', approver });
      const target = join(ws, 'denied.txt');

      const result = await runtime.execute('write_file', { path: 'denied.txt', content: 'must never exist' });

      assert.equal(existsSync(target), false, 'DENIED write must not touch the filesystem');
      assert.match(result, /DENIED/);
      assert.match(result, /did NOT run/);
      assert.equal(approver.calls.length, 1);
    } finally {
      cleanup(ws);
    }
  });

  test('a DENIED run_command does not run the command', async () => {
    const ws = makeWorkspace();
    try {
      const runtime = createToolRuntime(ws, { permissionMode: 'ask', approver: fixedApprover(DENY) });
      const marker = join(ws, 'shell-marker.txt');
      const command = process.platform === 'win32'
        ? `Set-Content -Path "${marker}" -Value "ran"`
        : `echo ran > "${marker}"`;

      const result = await runtime.execute('run_command', { command });

      assert.equal(existsSync(marker), false, 'a denied shell command must not execute');
      assert.match(result, /DENIED/);
    } finally {
      cleanup(ws);
    }
  });

  test('NO approver connected denies everything (fail closed by default)', async () => {
    const ws = makeWorkspace();
    try {
      const runtime = createToolRuntime(ws, { permissionMode: 'ask' });
      const result = await runtime.execute('write_file', { path: 'no-approver.txt', content: 'x' });

      assert.equal(existsSync(join(ws, 'no-approver.txt')), false);
      assert.match(result, /DENIED/);
      assert.match(result, /no approver is connected/);
    } finally {
      cleanup(ws);
    }
  });

  test('an approver that never answers TIMES OUT into a denial', async () => {
    const ws = makeWorkspace();
    try {
      const runtime = createToolRuntime(ws, {
        permissionMode: 'ask',
        approvalTimeoutMs: 60,
        approver: () => new Promise(() => { /* never resolves — a dead UI */ }),
      });

      const started = Date.now();
      const result = await runtime.execute('write_file', { path: 'timeout.txt', content: 'x' });
      const elapsed = Date.now() - started;

      assert.equal(existsSync(join(ws, 'timeout.txt')), false);
      assert.match(result, /DENIED/);
      assert.match(result, /no answer within 60ms/);
      assert.ok(elapsed < 5000, `timeout must not hang the turn (took ${elapsed}ms)`);
    } finally {
      cleanup(ws);
    }
  });

  test('an approver that throws denies', async () => {
    const ws = makeWorkspace();
    try {
      const runtime = createToolRuntime(ws, {
        permissionMode: 'ask',
        approver: async () => { throw new Error('channel exploded'); },
      });
      const result = await runtime.execute('write_file', { path: 'threw.txt', content: 'x' });

      assert.equal(existsSync(join(ws, 'threw.txt')), false);
      assert.match(result, /DENIED/);
      assert.match(result, /approval channel failed/);
    } finally {
      cleanup(ws);
    }
  });

  test('a garbled answer denies rather than guessing', async () => {
    const ws = makeWorkspace();
    try {
      const runtime = createToolRuntime(ws, {
        permissionMode: 'ask',
        approver: fixedApprover('sure go ahead'),
      });
      const result = await runtime.execute('write_file', { path: 'garbled.txt', content: 'x' });

      assert.equal(existsSync(join(ws, 'garbled.txt')), false);
      assert.match(result, /DENIED/);
    } finally {
      cleanup(ws);
    }
  });

  test('no environment variable can approve on the agent behalf', async () => {
    const ws = makeWorkspace();
    const saved = {
      HELMION_AUTO_APPROVE: process.env.HELMION_AUTO_APPROVE,
      HELMION_APPROVE_ALL: process.env.HELMION_APPROVE_ALL,
      HELMION_PERMISSION_MODE: process.env.HELMION_PERMISSION_MODE,
    };
    try {
      process.env.HELMION_AUTO_APPROVE = '1';
      process.env.HELMION_APPROVE_ALL = 'true';
      process.env.HELMION_PERMISSION_MODE = 'full';

      const runtime = createToolRuntime(ws, { permissionMode: 'ask' });
      const result = await runtime.execute('write_file', { path: 'env-bypass.txt', content: 'x' });

      assert.equal(existsSync(join(ws, 'env-bypass.txt')), false, 'env vars must not grant approval');
      assert.match(result, /DENIED/);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      cleanup(ws);
    }
  });

  test('the approved arguments are the executed arguments (no swap after approval)', async () => {
    const ws = makeWorkspace();
    try {
      const args = { path: 'snapshot.txt', content: 'APPROVED CONTENT' };
      const runtime = createToolRuntime(ws, {
        permissionMode: 'ask',
        // Approve slowly, giving the caller a window to mutate its own object.
        approver: async () => {
          await new Promise((r) => { setTimeout(r, 20); });
          return ALLOW_ONCE;
        },
      });

      const pending = runtime.execute('write_file', args);
      // Swap the payload out from under the approval that is already in flight.
      args.content = 'SMUGGLED CONTENT';
      args.path = 'smuggled.txt';
      await pending;

      assert.equal(existsSync(join(ws, 'snapshot.txt')), true, 'the approved path is what was written');
      assert.equal(readFileSync(join(ws, 'snapshot.txt'), 'utf8'), 'APPROVED CONTENT');
      assert.equal(existsSync(join(ws, 'smuggled.txt')), false, 'the swapped path must never be written');
    } finally {
      cleanup(ws);
    }
  });

  test('read-only and read-tools never even reach the approver', async () => {
    const ws = makeWorkspace();
    try {
      const approver = fixedApprover(ALLOW_ONCE);
      const readTools = createToolRuntime(ws, { permissionMode: 'read-tools', approver });
      const result = await readTools.execute('write_file', { path: 'blocked.txt', content: 'x' });

      assert.equal(existsSync(join(ws, 'blocked.txt')), false);
      assert.match(result, /blocked by permission mode 'read-tools'/);
      assert.equal(approver.calls.length, 0, 'an ineligible tool is refused before anyone is asked');
    } finally {
      cleanup(ws);
    }
  });
});

describe('allow-for-session — scoped to one tool, on one runtime', () => {
  test('a session grant covers later calls of the SAME tool but not a different tool', async () => {
    const ws = makeWorkspace();
    try {
      const approver = fixedApprover(ALLOW_SESSION);
      const runtime = createToolRuntime(ws, { permissionMode: 'ask', approver });

      await runtime.execute('write_file', { path: 'one.txt', content: 'first' });
      assert.equal(approver.calls.length, 1, 'first call asks');

      await runtime.execute('write_file', { path: 'two.txt', content: 'second' });
      assert.equal(approver.calls.length, 1, 'second call of the same tool does NOT ask again');
      assert.equal(existsSync(join(ws, 'one.txt')), true);
      assert.equal(existsSync(join(ws, 'two.txt')), true);
      assert.deepEqual(runtime.grantedTools, ['write_file']);

      // A different tool is a different grant — it must be asked about.
      await runtime.execute('list_dir', { path: '.' });
      assert.equal(approver.calls.length, 2, 'a different tool asks again');
      assert.equal(approver.calls[1].tool, 'list_dir');
    } finally {
      cleanup(ws);
    }
  });

  test('allow-once does NOT create a standing grant', async () => {
    const ws = makeWorkspace();
    try {
      const approver = fixedApprover(ALLOW_ONCE);
      const runtime = createToolRuntime(ws, { permissionMode: 'ask', approver });

      await runtime.execute('write_file', { path: 'a.txt', content: '1' });
      await runtime.execute('write_file', { path: 'b.txt', content: '2' });

      assert.equal(approver.calls.length, 2, 'allow-once asks every single time');
      assert.deepEqual(runtime.grantedTools, []);
    } finally {
      cleanup(ws);
    }
  });

  test('a permission change clears session grants (the bridge mode-swap path)', async () => {
    const ws = makeWorkspace();
    try {
      const approver = fixedApprover(ALLOW_SESSION);
      let runtime = createToolRuntime(ws, { permissionMode: 'ask', approver });
      await runtime.execute('write_file', { path: 'granted.txt', content: 'x' });
      assert.deepEqual(runtime.grantedTools, ['write_file']);

      // This is exactly what bridge.mjs does when the dropdown changes: a new
      // runtime, same conversation. Grants must not survive it.
      runtime = createToolRuntime(ws, { permissionMode: 'ask', approver });
      assert.deepEqual(runtime.grantedTools, [], 'grants must not survive a mode change');

      await runtime.execute('write_file', { path: 'after-change.txt', content: 'x' });
      assert.equal(approver.calls.length, 2, 'the user is asked again after a mode change');
    } finally {
      cleanup(ws);
    }
  });

  test('a session reset clears grants AND keeps the approver wired', async () => {
    const ws = makeWorkspace();
    try {
      const approver = fixedApprover(ALLOW_SESSION);
      const options = { permissionMode: 'ask', approver };
      const state = createSessionState(ws, options);

      await state.runtime.execute('write_file', { path: 'before-reset.txt', content: 'x' });
      assert.deepEqual(state.runtime.grantedTools, ['write_file']);

      resetSessionState(state, ws, options);
      assert.deepEqual(state.runtime.grantedTools, [], 'reset drops session grants');

      // Regression guard: resetSessionState used to drop every option except
      // permissionMode, which silently detached the approver and denied
      // everything afterwards. An approved write proves it is still connected.
      const result = await state.runtime.execute('write_file', { path: 'after-reset.txt', content: 'still works' });
      assert.equal(existsSync(join(ws, 'after-reset.txt')), true, 'the approver survives a reset');
      assert.match(result, /Wrote 11 bytes/);
      assert.equal(approver.calls.length, 2);
    } finally {
      cleanup(ws);
    }
  });
});

describe('approval broker — the request/response protocol', () => {
  test('emits a permission_request and resolves on the matching response', async () => {
    const events = [];
    const broker = createApprovalBroker({ emit: (e) => events.push(e), timeoutMs: 5000 });

    const pending = broker.approver({
      tool: 'run_command',
      args: { command: 'npm test' },
      workspace: 'E:\\Helmion',
      permissionMode: 'ask',
    });

    const request = events.find((e) => e.event === 'permission_request');
    assert.ok(request, 'a permission_request is emitted');
    assert.equal(request.tool, 'run_command');
    assert.equal(request.summary, 'run_command: npm test');
    assert.equal(request.workspace, 'E:\\Helmion');
    assert.equal(request.timeoutMs, 5000);
    assert.ok(request.id, 'the request carries an id');
    assert.equal(broker.pendingCount, 1);

    assert.equal(broker.handleResponse({ id: request.id, decision: 'allow-once' }), true);
    assert.equal(await pending, ALLOW_ONCE);
    assert.equal(broker.pendingCount, 0);

    const decision = events.find((e) => e.event === 'permission_decision');
    assert.equal(decision.decision, ALLOW_ONCE);
    assert.equal(decision.source, 'user');
    assert.equal(decision.id, request.id);
  });

  test('an unknown, forged, or duplicate id is refused', async () => {
    const events = [];
    const broker = createApprovalBroker({ emit: (e) => events.push(e), timeoutMs: 5000 });
    const pending = broker.approver({ tool: 'read_file', args: { path: 'a.txt' } });
    const { id } = events.find((e) => e.event === 'permission_request');

    assert.equal(broker.handleResponse({ id: 'perm-does-not-exist', decision: 'allow-session' }), false);
    assert.equal(broker.handleResponse({ decision: 'allow-once' }), false);
    assert.equal(broker.handleResponse(null), false);
    assert.equal(broker.pendingCount, 1, 'none of those touched the real request');

    assert.equal(broker.handleResponse({ id, decision: 'allow-once' }), true);
    assert.equal(await pending, ALLOW_ONCE);
    assert.equal(broker.handleResponse({ id, decision: 'allow-session' }), false, 'no second answer');
  });

  test('a malformed decision denies', async () => {
    const events = [];
    const broker = createApprovalBroker({ emit: (e) => events.push(e), timeoutMs: 5000 });
    const pending = broker.approver({ tool: 'write_file', args: { path: 'x', content: 'y' } });
    const { id } = events.find((e) => e.event === 'permission_request');

    broker.handleResponse({ id, decision: { nested: 'garbage' } });
    assert.equal(await pending, DENY);
  });

  test('no answer within the timeout denies', async () => {
    const events = [];
    const broker = createApprovalBroker({ emit: (e) => events.push(e), timeoutMs: 40 });
    const decision = await broker.approver({ tool: 'run_command', args: { command: 'rm -rf /' } });

    assert.equal(decision, DENY);
    assert.equal(events.find((e) => e.event === 'permission_decision').source, 'timeout');
    assert.equal(broker.pendingCount, 0);
  });

  test('denyAllPending fails every in-flight request closed', async () => {
    const events = [];
    const broker = createApprovalBroker({ emit: (e) => events.push(e), timeoutMs: 10_000 });
    const a = broker.approver({ tool: 'write_file', args: { path: 'a' } });
    const b = broker.approver({ tool: 'run_command', args: { command: 'x' } });
    assert.equal(broker.pendingCount, 2);

    broker.denyAllPending('shutdown');

    assert.equal(await a, DENY);
    assert.equal(await b, DENY);
    assert.equal(broker.pendingCount, 0);
    assert.equal(events.filter((e) => e.event === 'permission_decision' && e.source === 'shutdown').length, 2);
  });

  test('the timeout cannot be disabled by a bad environment value', () => {
    assert.equal(resolveAskTimeoutMs('0'), 300_000);
    assert.equal(resolveAskTimeoutMs('-1'), 300_000);
    assert.equal(resolveAskTimeoutMs('never'), 300_000);
    assert.equal(resolveAskTimeoutMs(undefined), 300_000);
    assert.equal(resolveAskTimeoutMs('1500'), 1500);
  });

  test('the summary shows the real command and path a human needs to judge', () => {
    assert.equal(
      summarizeToolCall('run_command', { command: 'Remove-Item -Recurse E:\\Helmion' }),
      'run_command: Remove-Item -Recurse E:\\Helmion',
    );
    assert.equal(
      summarizeToolCall('write_file', { path: 'src/agent/tools.mjs', content: '12345' }),
      'write_file: src/agent/tools.mjs (5 bytes)',
    );
    assert.equal(summarizeToolCall('read_file', { path: '.env' }), 'read_file: .env');
    assert.ok(summarizeToolCall('run_command', { command: 'x'.repeat(500) }).length <= 221);
  });
});

/**
 * End-to-end through the real `helmion agent-bridge` process, driven by a
 * scripted OpenAI-compatible endpoint that asks for write_file on its first
 * turn. This is the only test that proves the whole chain: model tool call →
 * permission_request on stdout → permission_response on stdin → the file
 * appearing (or not) on disk.
 */
describe('agent-bridge protocol end to end', () => {
  function startScriptedProvider() {
    const seen = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        seen.push(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });

        // First turn: demand a write. Later turns: plain text, so the loop ends.
        const wantsTool = seen.length === 1;
        res.end(JSON.stringify({
          id: 'chatcmpl-ask-test',
          object: 'chat.completion',
          model: parsed.model || 'stub',
          choices: [{
            index: 0,
            message: wantsTool
              ? {
                role: 'assistant',
                content: '',
                tool_calls: [{
                  id: 'call_write_1',
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({ path: 'agent-wrote-this.txt', content: 'tool output' }),
                  },
                }],
              }
              : { role: 'assistant', content: 'Finished.' },
            finish_reason: wantsTool ? 'tool_calls' : 'stop',
          }],
        }));
      });
    });
    return new Promise((resolvePromise) => {
      server.listen(0, '127.0.0.1', () => {
        resolvePromise({ server, seen, port: server.address().port });
      });
    });
  }

  /** Drive the bridge: send commands, collect events, answer approvals. */
  function startBridge(workspace, { decision, timeoutMs = '20000' }) {
    const child = spawn(
      process.execPath,
      [join(REPO_ROOT, 'bin', 'helmion.mjs'), 'agent-bridge'],
      {
        cwd: workspace,
        env: { ...process.env, HELMION_ASK_TIMEOUT_MS: timeoutMs },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    const events = [];
    let buffer = '';
    let answeredAt = 0;
    const waiters = [];

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          let ev = null;
          try { ev = JSON.parse(line); } catch { /* non-JSON noise */ }
          if (ev) {
            events.push(ev);
            if (ev.event === 'permission_request') {
              answeredAt = Date.now();
              child.stdin.write(`${JSON.stringify({
                cmd: 'permission_response', id: ev.id, decision,
              })}\n`);
            }
            for (const w of [...waiters]) {
              if (w.match(ev)) {
                waiters.splice(waiters.indexOf(w), 1);
                w.resolve(ev);
              }
            }
          }
        }
        index = buffer.indexOf('\n');
      }
    });

    return {
      child,
      events,
      get answeredAt() { return answeredAt; },
      send(obj) { child.stdin.write(`${JSON.stringify(obj)}\n`); },
      waitFor(match, ms = 25_000) {
        const hit = events.find(match);
        if (hit) return Promise.resolve(hit);
        return new Promise((resolvePromise, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`timed out waiting for event; saw: ${events.map((e) => e.event).join(', ')}`)),
            ms,
          );
          waiters.push({
            match,
            resolve: (ev) => { clearTimeout(timer); resolvePromise(ev); },
          });
        });
      },
      async stop() {
        child.stdin.end();
        await new Promise((r) => { child.on('close', r); setTimeout(r, 3000); });
        if (!child.killed) child.kill();
      },
    };
  }

  async function runBridgeScenario(decision) {
    const workspace = makeWorkspace();
    const { server, seen, port } = await startScriptedProvider();
    const bridge = startBridge(workspace, { decision });
    try {
      bridge.send({
        cmd: 'configure',
        workspace,
        provider: 'ask-test-endpoint',
        permission: 'ask',
        customProviders: [{
          name: 'ask-test-endpoint',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: 'test-key',
          model: 'stub-model',
        }],
      });
      const ready = await bridge.waitFor((e) => e.event === 'ready');
      assert.equal(ready.permission, 'ask', 'the bridge reports ask mode');

      const startedAt = Date.now();
      bridge.send({ cmd: 'turn', text: 'create the file' });
      const request = await bridge.waitFor((e) => e.event === 'permission_request');
      await bridge.waitFor((e) => e.event === 'done');

      return {
        workspace, seen, request, bridge, startedAt,
        target: join(workspace, 'agent-wrote-this.txt'),
        decisionEvent: bridge.events.find((e) => e.event === 'permission_decision'),
        elapsed: Date.now() - startedAt,
      };
    } finally {
      await bridge.stop();
      server.close();
      // workspace is cleaned by the caller after its assertions
    }
  }

  test('ALLOW ONCE over the wire: the file is created', { timeout: 60_000 }, async () => {
    const r = await runBridgeScenario('allow-once');
    try {
      assert.equal(r.request.tool, 'write_file');
      assert.equal(r.request.summary, 'write_file: agent-wrote-this.txt (11 bytes)');
      assert.equal(r.decisionEvent.decision, 'allow-once');
      assert.equal(r.decisionEvent.source, 'user', 'answered by the human, not by the timeout');
      assert.equal(existsSync(r.target), true, 'the approved tool call actually wrote the file');
      assert.equal(readFileSync(r.target, 'utf8'), 'tool output');

      // If permission_response were queued behind the in-flight turn, this could
      // only finish after the 20s ask timeout, and source would be "timeout".
      assert.ok(r.elapsed < 10_000, `approval answered out of band (turn took ${r.elapsed}ms)`);
    } finally {
      cleanup(r.workspace);
    }
  });

  test('DENY over the wire: no file, and the model is told', { timeout: 60_000 }, async () => {
    const r = await runBridgeScenario('deny');
    try {
      assert.equal(r.decisionEvent.decision, 'deny');
      assert.equal(r.decisionEvent.source, 'user');
      assert.equal(existsSync(r.target), false, 'a denied tool call must leave nothing on disk');

      // The provider's second request carries the tool result the model sees.
      assert.ok(r.seen.length >= 2, 'the loop continued after the denial');
      const toolMessage = r.seen[1].messages.find((m) => m.role === 'tool');
      assert.ok(toolMessage, 'the denial is fed back as a tool result');
      assert.match(toolMessage.content, /DENIED/);
      assert.match(toolMessage.content, /did NOT run/);
    } finally {
      cleanup(r.workspace);
    }
  });
});
