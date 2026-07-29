import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));

/**
 * Troy fixes a bad API key in .env mid-session and resubmits. The Node child's
 * environment was fixed at spawn, and the bridge only re-read .env when the
 * provider, workspace, or permission changed — so a stale-but-non-empty key
 * survived every turn and kept returning 401.
 *
 * These tests watch the Authorization header the provider actually receives,
 * which is the only place the answer is unambiguous.
 */

/** Records every Authorization header and request body it is sent. */
function startRecordingProvider() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      seen.push({
        authorization: req.headers.authorization || null,
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-env-refresh',
        object: 'chat.completion',
        model: parsed.model || 'stub',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ack' },
          finish_reason: 'stop',
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

/**
 * Write the workspace .env that owns the custom endpoint profile. The key lives
 * here rather than in the configure payload on purpose: that is the case where
 * .env is the only source of truth, which is what the desktop hits for the four
 * built-in providers.
 */
function writeEnv(workspace, port, apiKey) {
  const profile = [{
    name: 'env-refresh-endpoint',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey,
    model: 'stub-model',
  }];
  writeFileSync(
    join(workspace, '.env'),
    `HELMION_CUSTOM_PROVIDERS=${JSON.stringify(profile)}\n`,
    'utf8',
  );
}

function startBridge(workspace) {
  const childEnv = { ...process.env };
  // Prove the value came from .env, not from something inherited.
  delete childEnv.HELMION_CUSTOM_PROVIDERS;

  const child = spawn(
    process.execPath,
    [join(REPO_ROOT, 'bin', 'helmion.mjs'), 'agent-bridge'],
    { cwd: workspace, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const events = [];
  const waiters = [];
  let buffer = '';

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        let ev = null;
        try { ev = JSON.parse(line); } catch { /* ignore noise */ }
        if (ev) {
          events.push(ev);
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
    events,
    send(obj) { child.stdin.write(`${JSON.stringify(obj)}\n`); },
    waitFor(match, ms = 25_000) {
      const hit = events.find(match);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out; saw: ${events.map((e) => e.event).join(', ')}`)),
          ms,
        );
        waiters.push({ match, resolve: (ev) => { clearTimeout(timer); resolvePromise(ev); } });
      });
    },
    async stop() {
      child.stdin.end();
      await new Promise((r) => { child.on('close', r); setTimeout(r, 3000); });
      if (!child.killed) child.kill();
    },
  };
}

describe('agent-bridge picks up an API key corrected in .env mid-session', () => {
  test('a key fixed on disk reaches the very next turn', { timeout: 60_000 }, async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'helmion-envrefresh-'));
    const { server, seen, port } = await startRecordingProvider();
    writeEnv(workspace, port, 'stale-key-001');
    const bridge = startBridge(workspace);

    try {
      // No customProviders in the payload: .env owns the profile, exactly like
      // the built-in providers whose keys only ever come from .env.
      bridge.send({
        cmd: 'configure',
        workspace,
        provider: 'env-refresh-endpoint',
        permission: 'read-only',
      });
      await bridge.waitFor((e) => e.event === 'ready');

      bridge.send({ cmd: 'turn', text: 'first message' });
      await bridge.waitFor((e) => e.event === 'done');

      assert.equal(seen.length, 1);
      assert.equal(seen[0].authorization, 'Bearer stale-key-001', 'turn 1 uses the bad key');

      // Troy fixes the key in .env and resubmits. Nothing else changes: same
      // provider, same workspace, same permission.
      writeEnv(workspace, port, 'fixed-key-002');

      bridge.send({ cmd: 'turn', text: 'second message' });
      await bridge.waitFor((e) => e.event === 'done' && bridge.events.filter(
        (x) => x.event === 'done').length >= 2);

      assert.equal(seen.length, 2, 'the second turn reached the provider');
      assert.equal(
        seen[1].authorization,
        'Bearer fixed-key-002',
        'turn 2 must carry the CORRECTED key, not the stale one',
      );

      const notice = bridge.events.find(
        (e) => e.event === 'status' && /updated .* API key from \.env/i.test(e.message || ''),
      );
      assert.ok(notice, 'the user is told the key was picked up');

      // The whole point of not calling reconfigure(): history must survive.
      const secondTurnText = JSON.stringify(seen[1].messages);
      assert.match(secondTurnText, /first message/, 'turn 1 is still in the conversation');
      assert.match(secondTurnText, /second message/);
      assert.ok(
        seen[1].messages.length > seen[0].messages.length,
        'the conversation grew rather than being reset',
      );
    } finally {
      await bridge.stop();
      server.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('an unchanged key neither swaps the provider nor resets the session', { timeout: 60_000 }, async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'helmion-envrefresh-'));
    const { server, seen, port } = await startRecordingProvider();
    writeEnv(workspace, port, 'steady-key-123');
    const bridge = startBridge(workspace);

    try {
      bridge.send({
        cmd: 'configure',
        workspace,
        provider: 'env-refresh-endpoint',
        permission: 'read-only',
      });
      await bridge.waitFor((e) => e.event === 'ready');

      bridge.send({ cmd: 'turn', text: 'alpha' });
      await bridge.waitFor((e) => e.event === 'done');
      bridge.send({ cmd: 'turn', text: 'beta' });
      await bridge.waitFor(
        () => bridge.events.filter((x) => x.event === 'done').length >= 2,
      );

      assert.equal(seen.length, 2);
      assert.equal(seen[0].authorization, 'Bearer steady-key-123');
      assert.equal(seen[1].authorization, 'Bearer steady-key-123');

      const spurious = bridge.events.find(
        (e) => e.event === 'status' && /updated .* API key/i.test(e.message || ''),
      );
      assert.equal(spurious, undefined, 'no key-change notice when nothing changed');

      // Re-reading .env every turn must not quietly reset the conversation.
      assert.match(JSON.stringify(seen[1].messages), /alpha/, 'history survived the re-read');
      assert.ok(seen[1].messages.length > seen[0].messages.length);
    } finally {
      await bridge.stop();
      server.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
