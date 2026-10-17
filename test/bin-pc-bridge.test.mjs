// PC bridge smoke test: fake cloud (fetch) + fake agent child process.
// Covers pairing, seen-set init, human-message -> turn -> reply POST with the
// bridge idempotency key, agent-message skip, and resume from a saved seen set.
// The cloud's after_id cursor only accepts digits while message ids are UUIDs,
// so the bridge polls without after_id and tracks seen ids locally.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
      assert.ok(u.searchParams.get('channel_id'), 'channel_id required');
      assert.equal(u.searchParams.get('after_id'), null, 'bridge tracks seen ids locally, no after_id');
      return json({ valid: true, messages, nextCursor: messages.at(-1)?.id ?? null });
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

test('bridge pairs on first run, marks history seen, answers humans, skips agents', async (t) => {
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
    noAbly: true,
  });
  t.after(() => handle.stop());
  assert.equal(handle.ok, true);

  // Pairing: token saved locally, exchange body was exactly {code}.
  const saved = JSON.parse(await readFile(join(tmp, 'token.json'), 'utf8'));
  assert.equal(saved.token, 'tok-1');
  assert.equal(saved.tenantId, 'org-a');

  // Existing history (id 4) is marked seen on init: no ancient replies.
  const cursorSaved = JSON.parse(await readFile(join(tmp, 'cursor.json'), 'utf8'));
  assert.deepEqual(cursorSaved.seen, ['4']);

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

  // Seen set advanced past all three messages (including the skipped agent one).
  assert.equal(handle.seenCount, 3);

  await handle.stop();
});

test('bridge resumes from a saved seen set and reuses a saved token', async (t) => {
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
  await writeFile(join(tmp, 'cursor.json'), JSON.stringify({ seen: ['4'] }));

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
    noAbly: true,
  });
  t.after(() => handle.stop());
  assert.equal(handle.ok, true);
  assert.equal(prompted, false, 'saved token means no pairing prompt');
  const exchangeCalls = cloud.calls.filter((c) => c.url.endsWith('/api/admin/desktop/link/exchange'));
  assert.equal(exchangeCalls.length, 0);
  await handle.stop();
});

// ---- Bridge v2 transport selection: Ably push vs HTTPS polling ----

function makeFakeAbly() {
  const instances = [];
  class FakeChannel {
    constructor(name) { this.name = name; this.subs = []; }
    subscribe(eventName, cb) { this.subs.push({ eventName, cb }); return Promise.resolve(); }
    emitMessage(data) { for (const s of this.subs) if (s.eventName === 'message') s.cb({ data }); }
  }
  class FakeRealtime {
    constructor(opts) {
      this.opts = opts;
      this.channelsMap = new Map();
      this.connHandlers = {};
      this.connection = { on: (ev, fn) => { this.connHandlers[ev] = fn; } };
      this.closed = false;
      instances.push(this);
    }
    get channels() {
      return {
        get: (name) => {
          if (!this.channelsMap.has(name)) this.channelsMap.set(name, new FakeChannel(name));
          return this.channelsMap.get(name);
        },
      };
    }
    close() { this.closed = true; }
  }
  return { Realtime: FakeRealtime, instances };
}

function withAblyToken(cloud, { ok = true } = {}) {
  const orig = cloud.fetchImpl;
  const json = (obj, good = true) => ({ ok: good, status: good ? 200 : 503, json: async () => obj });
  cloud.fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.pathname === '/api/admin/envoy/ably-token') {
      cloud.calls.push({ url, method: opts.method ?? 'GET', body: opts.body });
      if (!ok) return json({ valid: false, code: 'ENVOY_ABLY_NOT_CONFIGURED' }, false);
      return json({
        valid: true,
        tokenRequest: { keyName: 'k', ttl: 300000, capability: '{}', clientId: 'c', timestamp: 1, nonce: 'n', mac: 'm' },
        channel: 'envoy:org-a:ch-1',
        expiresAt: 't',
      });
    }
    return orig(url, opts);
  };
}

function bridgeDeps(tmp, cloud, extra = {}) {
  return {
    fetchImpl: cloud.fetchImpl,
    spawnImpl: () => makeFakeChild().child,
    execPath: 'node',
    helmionBin: 'fake-helmion.mjs',
    bridgeDir: tmp,
    tokenPath: join(tmp, 'token.json'),
    cursorPath: join(tmp, 'cursor.json'),
    pollMs: 40,
    promptCode: async () => 'testcode',
    log: () => {},
    logError: () => {},
    ...extra,
  };
}

test('bridge uses Ably push when the token succeeds', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'pc-bridge-ably-'));
  const cloud = makeFakeCloud();
  withAblyToken(cloud, { ok: true });
  const ably = makeFakeAbly();
  const handle = await runBridge(bridgeDeps(tmp, cloud, { ablyImpl: ably }));
  t.after(() => handle.stop());
  assert.equal(handle.ok, true);
  assert.equal(handle.transport, 'ably');

  // Subscribed to the server-provided channel with the message handler.
  const rt = ably.instances[0];
  const chan = rt.channelsMap.get('envoy:org-a:ch-1');
  assert.ok(chan, 'subscribed to envoy:org-a:ch-1');
  assert.equal(chan.subs.length, 1);

  // A push message flows through the same turn pipeline as a poll.
  chan.emitMessage({ id: 'a1', channelId: 'ch-1', authorSubject: 'user-1', authorKind: 'human', body: 'via ably', createdAt: 't' });
  await new Promise((r) => setTimeout(r, 400));
  const posts = cloud.calls.filter((c) => c.url.endsWith('/api/admin/envoy/messages') && c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].body).idempotencyKey, 'pc-bridge:a1');

  // No polling timer in Ably mode: only the seen-init GET and the
  // post-subscribe catch-up GET happened.
  const gets = cloud.calls.filter((c) => c.url.includes('/api/admin/envoy/messages?') && c.method === 'GET');
  assert.ok(gets.length <= 2, `expected at most 2 message GETs, got ${gets.length}`);
  await handle.stop();
  assert.equal(rt.closed, true, 'realtime client closed on stop');
});

test('bridge falls back to polling when the Ably token fails', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'pc-bridge-ably-'));
  const cloud = makeFakeCloud();
  withAblyToken(cloud, { ok: false });
  const ably = makeFakeAbly();
  const handle = await runBridge(bridgeDeps(tmp, cloud, { ablyImpl: ably }));
  t.after(() => handle.stop());
  assert.equal(handle.ok, true);
  assert.equal(handle.transport, 'polling');
  assert.equal(ably.instances.length, 0, 'no realtime client when token fails');

  // Polling actually runs: new human message gets answered.
  cloud.messages.push({ id: 'p1', channelId: 'ch-1', authorSubject: 'user-1', authorKind: 'human', body: 'via poll', createdAt: 't' });
  await new Promise((r) => setTimeout(r, 400));
  const posts = cloud.calls.filter((c) => c.url.endsWith('/api/admin/envoy/messages') && c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].body).idempotencyKey, 'pc-bridge:p1');
  await handle.stop();
});

test('bridge stays on polling when Ably is disabled', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'pc-bridge-ably-'));
  const cloud = makeFakeCloud();
  withAblyToken(cloud, { ok: true });
  const ably = makeFakeAbly();
  const handle = await runBridge(bridgeDeps(tmp, cloud, { ablyImpl: ably, noAbly: true }));
  t.after(() => handle.stop());
  assert.equal(handle.transport, 'polling');
  assert.equal(ably.instances.length, 0);
  const tokenCalls = cloud.calls.filter((c) => c.url.endsWith('/api/admin/desktop/ably-token'));
  assert.equal(tokenCalls.length, 0, 'no token request when disabled');
  await handle.stop();
});

test('bridge drops to polling when the Ably connection fails late', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'pc-bridge-ably-'));
  const cloud = makeFakeCloud();
  withAblyToken(cloud, { ok: true });
  const ably = makeFakeAbly();
  const handle = await runBridge(bridgeDeps(tmp, cloud, { ablyImpl: ably }));
  t.after(() => handle.stop());
  assert.equal(handle.transport, 'ably');
  const rt = ably.instances[0];

  // Simulate a late connection failure: polling must start.
  rt.connHandlers.failed();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(handle.transport, 'polling');
  const gets = cloud.calls.filter((c) => c.url.includes('/api/admin/envoy/messages?') && c.method === 'GET');
  assert.ok(gets.length >= 3, 'poll timer started after late failure');
  await handle.stop();
});

test('bridge pairs from HELMION_BRIDGE_PAIRING_CODE when no promptCode is injected', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'pc-bridge-envcode-'));
  const cloud = makeFakeCloud();
  const prev = process.env.HELMION_BRIDGE_PAIRING_CODE;
  process.env.HELMION_BRIDGE_PAIRING_CODE = '  envcode9 ';
  t.after(() => {
    if (prev === undefined) delete process.env.HELMION_BRIDGE_PAIRING_CODE;
    else process.env.HELMION_BRIDGE_PAIRING_CODE = prev;
  });
  const handle = await runBridge(bridgeDeps(tmp, cloud, { promptCode: undefined }));
  t.after(() => handle.stop());
  assert.equal(handle.ok, true);
  const exchangeCalls = cloud.calls.filter((c) => c.url.endsWith('/api/admin/desktop/link/exchange'));
  assert.equal(exchangeCalls.length, 1);
  assert.deepEqual(JSON.parse(exchangeCalls[0].body), { code: 'ENVCODE9' }, 'env code is trimmed and uppercased');
  const saved = JSON.parse(await readFile(join(tmp, 'token.json'), 'utf8'));
  assert.equal(saved.token, 'tok-1');
  await handle.stop();
});

test('bridge injects the vault provider key into the agent child env', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'pc-bridge-vault-'));
  const cloud = makeFakeCloud();
  const spawns = [];
  const spawnImpl = (cmd, args, opts) => {
    const f = makeFakeChild();
    spawns.push({ cmd, args, env: opts?.env });
    return f.child;
  };
  // Pre-pair: token file exists so no pairing prompt runs.
  await writeFile(join(tmp, 'token.json'), JSON.stringify({ token: 'test-device-token-0123456789abcdef' }));
  // Vault holds the gemini key; env var is deliberately different.
  const vaultPath = join(tmp, 'vault.json');
  const { openVault } = await import('../src/runner/vault.mjs');
  const vault = await openVault({ vaultPath, deviceToken: 'test-device-token-0123456789abcdef' });
  await vault.set('gemini', 'api_key', 'vault-key-xyz');
  process.env.GEMINI_API_KEY = 'env-key-should-lose';

  const handle = await runBridge({
    fetchImpl: cloud.fetchImpl,
    spawnImpl,
    execPath: 'node',
    helmionBin: 'fake-helmion.mjs',
    bridgeDir: tmp,
    tokenPath: join(tmp, 'token.json'),
    cursorPath: join(tmp, 'cursor.json'),
    vaultPath,
    provider: 'gemini',
    pollMs: 50,
    log: () => {},
    logError: () => {},
    noAbly: true,
  });
  t.after(() => { handle.stop(); delete process.env.GEMINI_API_KEY; });
  assert.equal(handle.ok, true);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].env.GEMINI_API_KEY, 'vault-key-xyz', 'vault wins over env');
});

test('bridge falls back to env when the vault is empty', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'pc-bridge-vault-'));
  const cloud = makeFakeCloud();
  const spawns = [];
  const spawnImpl = (cmd, args, opts) => {
    const f = makeFakeChild();
    spawns.push({ env: opts?.env });
    return f.child;
  };
  await writeFile(join(tmp, 'token.json'), JSON.stringify({ token: 'test-device-token-0123456789abcdef' }));
  process.env.GEMINI_API_KEY = 'env-key-wins';

  const handle = await runBridge({
    fetchImpl: cloud.fetchImpl,
    spawnImpl,
    execPath: 'node',
    helmionBin: 'fake-helmion.mjs',
    bridgeDir: tmp,
    tokenPath: join(tmp, 'token.json'),
    cursorPath: join(tmp, 'cursor.json'),
    vaultPath: join(tmp, 'vault.json'), // no vault file yet
    provider: 'gemini',
    pollMs: 50,
    log: () => {},
    logError: () => {},
    noAbly: true,
  });
  t.after(() => { handle.stop(); delete process.env.GEMINI_API_KEY; });
  assert.equal(handle.ok, true);
  assert.equal(spawns[0].env.GEMINI_API_KEY, 'env-key-wins', 'env survives when vault is empty');
});

test('bridge watches all channels by default and replies in the message channel', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'pc-bridge-multi-'));
  const posts = [];
  const byChannel = {
    'ch-team': [{ id: 'm1', channelId: 'ch-team', authorSubject: 'user-1', authorKind: 'human', body: 'hello team', createdAt: 't' }],
    'ch-dm': [{ id: 'm2', channelId: 'ch-dm', authorSubject: 'user-1', authorKind: 'human', body: 'hello dm', createdAt: 't' }],
  };
  const json = (obj, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => obj });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.pathname === '/api/admin/envoy/channels') {
      return json({ valid: true, channels: [
        { id: 'ch-team', slug: 'team', title: 'Team', kind: 'team' },
        { id: 'ch-dm', slug: 'dm-troy', title: 'DM Troy', kind: 'direct' },
      ] });
    }
    if (u.pathname === '/api/admin/envoy/messages' && (opts.method ?? 'GET') === 'GET') {
      const msgs = byChannel[u.searchParams.get('channel_id')] ?? [];
      // First poll returns the backlog (marked seen on init); drain after.
      byChannel[u.searchParams.get('channel_id')] = [];
      return json({ valid: true, messages: msgs });
    }
    if (u.pathname === '/api/admin/envoy/messages' && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      posts.push(body);
      return json({ valid: true, receipt: { message: body, replayed: false } });
    }
    return json({ valid: false }, false);
  };
  const spawns = [];
  const spawnImpl = () => { const f = makeFakeChild(); spawns.push(f); return f.child; };
  await writeFile(join(tmp, 'token.json'), JSON.stringify({ token: 'tok-multi' }));

  const handle = await runBridge({
    fetchImpl, spawnImpl, execPath: 'node', helmionBin: 'fake.mjs',
    bridgeDir: tmp, tokenPath: join(tmp, 'token.json'), cursorPath: join(tmp, 'cursor.json'),
    vaultPath: join(tmp, 'vault.json'), pollMs: 30,
    log: () => {}, logError: () => {}, noAbly: true,
  });
  t.after(() => handle.stop());
  assert.equal(handle.ok, true);
  // Both backlogs were marked seen on init; now inject a fresh message in the DM channel.
  byChannel['ch-dm'] = [{ id: 'm3', channelId: 'ch-dm', authorSubject: 'user-1', authorKind: 'human', body: 'ping dm', createdAt: 't2' }];
  await new Promise((r) => setTimeout(r, 120));
  const dmPosts = posts.filter((p) => p.channelId === 'ch-dm');
  assert.ok(dmPosts.length >= 1, 'replied in the DM channel');
  assert.ok(dmPosts[0].idempotencyKey.includes('m3'));
  assert.equal(posts.filter((p) => p.channelId === 'ch-team').length, 0, 'no reply in team');
});

test('bridge honors HELMION_BRIDGE_CHANNEL_SLUGS filter', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'pc-bridge-filter-'));
  const seenChannels = [];
  const json = (obj, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => obj });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.pathname === '/api/admin/envoy/channels') {
      return json({ valid: true, channels: [
        { id: 'ch-team', slug: 'team', title: 'Team', kind: 'team' },
        { id: 'ch-dm', slug: 'dm-troy', title: 'DM Troy', kind: 'direct' },
      ] });
    }
    if (u.pathname === '/api/admin/envoy/messages') {
      seenChannels.push(u.searchParams.get('channel_id'));
      return json({ valid: true, messages: [] });
    }
    return json({ valid: false }, false);
  };
  const spawnImpl = () => makeFakeChild().child;
  await writeFile(join(tmp, 'token.json'), JSON.stringify({ token: 'tok-filter' }));
  const handle = await runBridge({
    fetchImpl, spawnImpl, execPath: 'node', helmionBin: 'fake.mjs',
    bridgeDir: tmp, tokenPath: join(tmp, 'token.json'), cursorPath: join(tmp, 'cursor.json'),
    vaultPath: join(tmp, 'vault.json'), channelSlugs: 'dm-troy', pollMs: 30,
    log: () => {}, logError: () => {}, noAbly: true,
  });
  t.after(() => handle.stop());
  assert.equal(handle.ok, true);
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(seenChannels.length > 0);
  assert.ok(seenChannels.every((id) => id === 'ch-dm'), 'only the filtered channel is polled');
});
