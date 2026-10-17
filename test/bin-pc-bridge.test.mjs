// PC bridge smoke test: fake cloud (fetch) + fake agent child process.
// Covers pairing, cursor init, human-message -> turn -> reply POST with the
// pc-bridge idempotency key, and agent-message skip. Headless, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBridge } from '../bin/pc-bridge.mjs';

function makeFakeChild() {
  const stdout = new EventEmitter();
  const written = [];
  const child = new EventEmitter();
  const stdin = {
    write(chunk, cb) {
      written.push(String(chunk));
      setImmediate(() => {
        let cmd;
        try { cmd = JSON.parse(String(chunk)); } catch { return; }
        if (cmd.cmd === 'turn') {
          stdout.emit('data', `${JSON.stringify({ event: 'assistant', text: `fake reply to: ${cmd.text}` })}\n`);
          stdout.emit('data', `${JSON.stringify({ event: 'done' })}\n`);
        }
      });
      if (typeof cb === 'function') cb();
    },
    end() { setImmediate(() => child.emit('exit', 0)); },
  };
  child.stdout = stdout;
  child.stdin = stdin;
  child.kill = () => {};
  setImmediate(() => {
    stdout.emit('data', `${JSON.stringify({ event: 'hello', ok: true, provider: 'Claude' })}\n`);
  });
  return { child, written };
}

function makeFakeCloud() {
  const calls = [];
  const messages = [
    { id: '4', channelId: 'ch-1', authorSubject: 'user-1', authorKind: 'human', body: 'old news', createdAt: 't' },
  ];
  const json = (obj, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => obj });
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ url, method, body: opts.body });
    const u = new URL(url);
    if (u.pathname === '/api/admin/desktop/link/exchange') {
      const body = JSON.parse(opts.body);
      assert.deepEqual(Object.keys(body), ['code']);
      return json({ valid: true, token: 'tok-1', tenantId: 'org-a' });
    }
    if (u.pathname === '/api/admin/envoy/channels') {
      return json({ valid: true, channels: [{ id: 'ch-1', slug: 'team', title: 'Team' }] });
    }
    if (u.pathname === '/api/admin/envoy/messages' && method === 'GET') {
      const afterId = u.searchParams.get('after_id');
      assert.ok(u.searchParams.get('channel_id'), 'channel_id required');
      if (u.headers && typeof u.headers === 'object') { /* headers pass through fetch init, asserted below */ }
      const fresh = afterId ? messages.filter((m) => Number(m.id) > Number(afterId)) : messages;
      return json({ valid: true, messages: fresh, nextCursor: fresh.at(-1)?.id ?? afterId ?? null });
    }
    if (u.pathname === '/api/admin/envoy/messages' && method === 'POST') {
      const body = JSON.parse(opts.body);
      assert.deepEqual(Object.keys(body).sort(), ['body', 'channelId', 'idempotencyKey']);
      return json({ valid: true, receipt: { message: { ...body, authorKind: 'agent' }, replayed: false } });
    }
    return json({ valid: false }, false);
  };
  return { fetchImpl, calls, messages };
}

test('bridge pairs on first run, inits cursor at latest, answers humans, skips agents', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'pc-bridge-test-'));
  const cloud = makeFakeCloud();
  const spawns = [];
  const spawnImpl = () => {
    const f = makeFakeChild();
    spawns.push(f);
    return f.child;
  };

  const handle = await runBridge({
    fetchImpl: cloud.fetchImpl,
    spawnImpl,
    execPath: 'node',
    helmionBin: 'fake-helmion.mjs',
    bridgeDir: tmp,
    tokenPath: join(tmp, 'token.json'),
    cursorPath: join(tmp, 'cursor.json'),
    pollMs: 50,
    promptCode: async () => 'testcode',
    log: () => {},
    logError: () => {},
  });
  t.after(() => handle.stop());
  assert.equal(handle.ok, true);

  // Pairing: token saved locally, exchange body was exactly {code}.
  const saved = JSON.parse(await readFile(join(tmp, 'token.json'), 'utf8'));
  assert.equal(saved.token, 'tok-1');
  assert.equal(saved.tenantId, 'org-a');

  // Cursor initialized at the latest existing message (id 4): no ancient replies.
  const cursorSaved = JSON.parse(await readFile(join(tmp, 'cursor.json'), 'utf8'));
  assert.equal(cursorSaved.cursor, '4');

  // Agent child got configure with read-only permission.
  const configure = spawns[0].written.find((w) => w.includes('"cmd":"configure"'));
  assert.match(configure, /"permission":"read-only"/);
  assert.match(configure, /"provider":"claude"/);

  // New traffic: one human message and one agent (own reply) message.
  cloud.messages.push(
    { id: '5', channelId: 'ch-1', authorSubject: 'user-1', authorKind: 'human', body: 'hello agent', createdAt: 't' },
    { id: '6', channelId: 'ch-1', authorSubject: 'user-1:bridge', authorKind: 'agent', body: 'older reply', createdAt: 't' },
  );
  await new Promise((r) => setTimeout(r, 600));

  // Exactly one reply POST, for the human message, with the bridge idempotency key.
  const posts = cloud.calls.filter((c) => c.url.endsWith('/api/admin/envoy/messages') && c.method === 'POST');
  assert.equal(posts.length, 1);
  const posted = JSON.parse(posts[0].body);
  assert.equal(posted.idempotencyKey, 'pc-bridge:5');
  assert.equal(posted.channelId, 'ch-1');
  assert.match(posted.body, /fake reply to: hello agent/);

  // Exactly one turn ran, for the human message only.
  const turns = spawns[0].written.filter((w) => w.includes('"cmd":"turn"'));
  assert.equal(turns.length, 1);
  assert.match(turns[0], /hello agent/);

  // Cursor advanced past both messages (including the skipped agent one).
  assert.equal(handle.cursor, '6');

  await handle.stop();
});

test('bridge resumes from a saved cursor and reuses a saved token', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'pc-bridge-test-'));
  const cloud = makeFakeCloud();
  const spawns = [];
  const spawnImpl = () => {
    const f = makeFakeChild();
    spawns.push(f);
    return f.child;
  };
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(tmp, 'token.json'), JSON.stringify({ token: 'tok-1', tenantId: 'org-a' }));
  await writeFile(join(tmp, 'cursor.json'), JSON.stringify({ cursor: '4' }));

  let prompted = false;
  const handle = await runBridge({
    fetchImpl: cloud.fetchImpl,
    spawnImpl,
    execPath: 'node',
    helmionBin: 'fake-helmion.mjs',
    bridgeDir: tmp,
    tokenPath: join(tmp, 'token.json'),
    cursorPath: join(tmp, 'cursor.json'),
    pollMs: 50,
    promptCode: async () => { prompted = true; return 'unused'; },
    log: () => {},
    logError: () => {},
  });
  t.after(() => handle.stop());
  assert.equal(handle.ok, true);
  assert.equal(prompted, false, 'saved token means no pairing prompt');
  const exchangeCalls = cloud.calls.filter((c) => c.url.endsWith('/api/admin/desktop/link/exchange'));
  assert.equal(exchangeCalls.length, 0);
  await handle.stop();
});
