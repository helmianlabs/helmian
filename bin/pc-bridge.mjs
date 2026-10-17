#!/usr/bin/env node
// PC bridge (v1): puts a real agent behind the cloud /app chat.
//
// Run on Troy's Windows PC:  node bin/pc-bridge.mjs
//
// It polls the cloud envoy team channel for new human messages, feeds each
// one to the local agent loop (bin/helmion.mjs agent-bridge, read-only), and
// posts the reply back as an agent-authored message. The cloud never sees a
// provider key: all LLM calls happen on this PC under the local .env.
//
// Pairing (first run only): the bridge asks for the pairing code shown by
// the /app "link desktop" button, exchanges it for a device token, and
// stores the token in %APPDATA%/Helmian/pc-bridge-token.json (this PC only).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createInterface as createPromptInterface } from 'node:readline/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLOUD = 'https://helmian.cloud';
const POLL_MS = 5000;
const BRIDGE_DIR = join(homedir(), 'AppData', 'Roaming', 'Helmian');

function defaultDeps() {
  return {
    cloud: CLOUD,
    pollMs: POLL_MS,
    bridgeDir: BRIDGE_DIR,
    tokenPath: join(BRIDGE_DIR, 'pc-bridge-token.json'),
    cursorPath: join(BRIDGE_DIR, 'pc-bridge-cursor.json'),
    channelSlug: process.env.HELMION_BRIDGE_CHANNEL_SLUG || 'team',
    provider: process.env.HELMION_BRIDGE_PROVIDER || 'claude',
    workspace: process.env.HELMION_BRIDGE_WORKSPACE || 'E:\\Helmion',
    helmionBin: resolve(dirname(fileURLToPath(import.meta.url)), 'helmion.mjs'),
    fetchImpl: fetch,
    spawnImpl: spawn,
    execPath: process.execPath,
    ablyImpl: null, // tests inject a fake { Realtime }; default is dynamic import('ably')
    noAbly: process.env.HELMION_BRIDGE_NO_ABLY === '1',
    log: (...args) => console.log('[pc-bridge]', ...args),
    logError: (...args) => console.error('[pc-bridge]', ...args),
    promptCode: null, // tests inject an async () => code; default prompts stdin
  };
}

async function api(deps, path, { method = 'GET', body = null, token = null } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== null) headers['content-type'] = 'application/json';
  const res = await deps.fetchImpl(`${deps.cloud}${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok || parsed?.valid === false) {
    throw new Error(`cloud ${method} ${path} failed: ${parsed?.code ?? parsed?.message ?? res.status}`);
  }
  return parsed;
}

async function loadToken(deps) {
  try {
    const data = JSON.parse(await readFile(deps.tokenPath, 'utf8'));
    if (data?.token) return data;
  } catch { /* first run */ }
  return null;
}

async function pairWithCode(deps) {
  await mkdir(deps.bridgeDir, { recursive: true });
  let code;
  if (deps.promptCode) {
    code = String(await deps.promptCode() ?? '').trim().toUpperCase();
  } else {
    const rl = createPromptInterface({ input: process.stdin, output: process.stdout });
    code = (await rl.question('Pairing code (tap the link button in /app Settings): ')).trim().toUpperCase();
    rl.close();
  }
  if (!code) {
    deps.logError('no pairing code provided. Get one from /app Settings, then run again.');
    return null;
  }
  const exchanged = await api(deps, '/api/admin/desktop/link/exchange', { method: 'POST', body: { code } });
  if (!exchanged?.token) {
    deps.logError('pairing failed: code expired or already used. Generate a fresh one and try again.');
    return null;
  }
  const saved = { token: exchanged.token, tenantId: exchanged.tenantId };
  await writeFile(deps.tokenPath, JSON.stringify(saved, null, 2));
  deps.log('paired. Token saved to this PC only:', deps.tokenPath);
  return saved;
}

// Seen-message tracking. The cloud's after_id cursor only accepts digits,
// but message ids are UUIDs, so the bridge tracks what it has answered
// locally instead: a persisted set of message ids.
async function loadSeen(deps) {
  try {
    const data = JSON.parse(await readFile(deps.cursorPath, 'utf8'));
    if (Array.isArray(data?.seen)) return new Set(data.seen.filter((id) => typeof id === 'string'));
    // Back-compat: the first v1 build stored a single cursor id.
    if (typeof data?.cursor === 'string') return new Set([data.cursor]);
  } catch { /* first run */ }
  return null;
}

async function saveSeen(deps, seen) {
  try {
    await mkdir(deps.bridgeDir, { recursive: true });
    await writeFile(deps.cursorPath, JSON.stringify({ seen: [...seen].slice(-200) }));
  } catch (err) {
    deps.logError('could not persist cursor:', err?.message ?? err);
  }
}

function startAgent(deps) {
  const child = deps.spawnImpl(deps.execPath, [deps.helmionBin, 'agent-bridge'], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.on('error', (err) => {
    deps.logError('agent process failed to start:', err?.message ?? err);
    process.exit(1);
  });
  return child;
}

// NDJSON helpers for the agent child. Resolves with the concatenated
// assistant text once the turn's `done` event arrives.
function runTurn(child, text) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let buffer = '';
    const onData = (data) => {
      buffer += String(data);
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event?.event === 'assistant' && typeof event.text === 'string') chunks.push(event.text);
        else if (event?.event === 'done') {
          child.stdout.off('data', onData);
          resolve(chunks.join('').trim());
        }
      }
    };
    child.stdout.on('data', onData);
    child.stdin.write(`${JSON.stringify({ cmd: 'turn', text })}\n`, (err) => {
      if (err) { child.stdout.off('data', onData); reject(err); }
    });
  });
}

// Wait for the agent child's first `hello` event (provider resolved).
function waitForHello(child) {
  return new Promise((resolve) => {
    let buffer = '';
    const onData = (data) => {
      buffer += String(data);
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const raw of lines) {
        try {
          const event = JSON.parse(raw.trim());
          if (event?.event === 'hello') { child.stdout.off('data', onData); resolve(event); }
        } catch { /* not JSON yet */ }
      }
    };
    child.stdout.on('data', onData);
  });
}

export async function runBridge(overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const { log, logError } = deps;

  let creds = await loadToken(deps);
  if (!creds) {
    log('first run: pairing this PC with helmian.cloud');
    creds = await pairWithCode(deps);
    if (!creds) return { ok: false, reason: 'pairing failed' };
  }

  const child = startAgent(deps);
  const hello = await waitForHello(child);
  if (hello?.ok === false) logError('agent bridge warning:', hello.message);
  else log('agent ready:', hello?.provider ?? 'unknown provider');

  child.stdin.write(`${JSON.stringify({ cmd: 'configure', provider: deps.provider, workspace: deps.workspace, permission: 'read-only' })}\n`);
  log(`configured provider=${deps.provider} workspace=${deps.workspace} permission=read-only`);

  const channels = await api(deps, '/api/admin/envoy/channels', { token: creds.token });
  const channel = (channels?.channels ?? []).find((c) => c.slug === deps.channelSlug);
  if (!channel?.id) {
    logError(`channel "${deps.channelSlug}" not found. Set HELMION_BRIDGE_CHANNEL_SLUG to an existing channel slug.`);
    return { ok: false, reason: 'channel not found' };
  }
  log(`watching #${channel.slug} (${channel.id})`);

  let seen = await loadSeen(deps);
  if (seen === null) {
    // First run: mark everything currently in the channel as seen, so we never reply to ancient history.
    const initial = await api(deps, `/api/admin/envoy/messages?channel_id=${encodeURIComponent(channel.id)}`, { token: creds.token });
    seen = new Set((initial?.messages ?? []).map((m) => m.id).filter((id) => typeof id === 'string'));
    await saveSeen(deps, seen);
    log('initialized: will only answer new messages from here on.');
  } else {
    log(`resuming, ${seen.size} messages already seen`);
  }

  // Turns stay strictly serialized: one at a time, the rest queue.
  let turnInFlight = false;
  const turnQueue = [];
  let shuttingDown = false;

  const processOne = async (message) => {
    turnInFlight = true;
    try {
      log(`turn for message ${message.id} from ${message.authorSubject}`);
      const reply = await runTurn(child, String(message.body ?? ''));
      if (!reply) {
        log(`message ${message.id}: agent produced no text, skipping reply`);
        return;
      }
      await api(deps, '/api/admin/envoy/messages', {
        method: 'POST',
        token: creds.token,
        body: { body: reply, channelId: channel.id, idempotencyKey: `pc-bridge:${message.id}` },
      });
      log(`replied to message ${message.id} (${reply.length} chars)`);
    } catch (err) {
      logError(`failed on message ${message.id}:`, err?.message ?? err);
    } finally {
      turnInFlight = false;
      const next = turnQueue.shift();
      if (next && !shuttingDown) void processOne(next);
    }
  };

  // One entry point for every new message, however it arrived (Ably push
  // or HTTPS poll). Seen-set dedupes; only human messages become turns.
  const ingestMessage = async (message) => {
    if (typeof message?.id !== 'string' || seen.has(message.id)) return;
    seen.add(message.id);
    await saveSeen(deps, seen);
    if (message.authorKind !== 'human') return; // skip own replies + system lines
    if (!String(message.body ?? '').trim()) return;
    if (turnInFlight) turnQueue.push(message);
    else void processOne(message);
  };

  const poll = async () => {
    if (shuttingDown) return;
    try {
      const res = await api(deps,
        `/api/admin/envoy/messages?channel_id=${encodeURIComponent(channel.id)}`,
        { token: creds.token },
      );
      for (const message of res?.messages ?? []) await ingestMessage(message);
    } catch (err) {
      logError('poll failed, retrying next interval:', err?.message ?? err);
    }
  };

  // Bridge v2 transport: Ably push. Returns the realtime handle, or null to
  // fall back to HTTPS polling. The bridge subscribes only; replies still go
  // over HTTPS POST as before.
  const startAbly = async () => {
    if (deps.noAbly) { log('Ably disabled (HELMION_BRIDGE_NO_ABLY=1)'); return null; }
    let Realtime;
    if (deps.ablyImpl) {
      ({ Realtime } = deps.ablyImpl);
    } else {
      try {
        ({ Realtime } = await import('ably'));
      } catch {
        logError('Ably unavailable: the "ably" package is not installed. Run: npm install');
        return null;
      }
    }
    let token;
    try {
      token = await api(deps, '/api/admin/desktop/ably-token', { method: 'POST', token: creds.token, body: { channelId: channel.id } });
      if (!token?.tokenRequest?.keyName || !token?.channel) throw new Error('bad token response');
    } catch (err) {
      logError('Ably token failed, falling back to polling:', err?.message ?? err);
      return null;
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      let realtime;
      try {
        realtime = new Realtime({
          authCallback: async (_tokenParams, callback) => {
            try {
              const t = await api(deps, '/api/admin/desktop/ably-token', { method: 'POST', token: creds.token, body: { channelId: channel.id } });
              callback(null, t.tokenRequest);
            } catch (err) { callback(err); }
          },
        });
      } catch (err) {
        logError('Ably client failed, falling back to polling:', err?.message ?? err);
        return done(null);
      }
      const giveUp = setTimeout(() => {
        logError('Ably subscribe timed out, falling back to polling');
        try { realtime.close(); } catch {}
        done(null);
      }, 15000);
      realtime.connection.on('failed', () => {
        logError('Ably connection failed, falling back to polling');
        clearTimeout(giveUp);
        try { realtime.close(); } catch {}
        done(null);
      });
      const ablyChannel = realtime.channels.get(token.channel);
      ablyChannel.subscribe('message', (msg) => { void ingestMessage(msg?.data); })
        .then(() => {
          clearTimeout(giveUp);
          log(`transport: Ably push on ${token.channel}`);
          done({ realtime, channelName: token.channel });
        })
        .catch((err) => {
          clearTimeout(giveUp);
          logError('Ably subscribe failed, falling back to polling:', err?.message ?? err);
          try { realtime.close(); } catch {}
          done(null);
        });
    });
  };

  let pollTimer = null;
  const startPolling = () => {
    if (pollTimer || shuttingDown) return;
    log(`transport: HTTPS polling every ${deps.pollMs / 1000}s`);
    pollTimer = setInterval(() => void poll(), deps.pollMs);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  };

  let ablyHandle = null;
  const stop = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('shutting down…');
    if (pollTimer) clearInterval(pollTimer);
    if (ablyHandle) { try { ablyHandle.realtime.close(); } catch {} ablyHandle = null; }
    await saveSeen(deps, seen);
    try { child.stdin.end(); } catch {}
    await new Promise((resolve) => {
      const timeout = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 5000);
      child.on('exit', () => { clearTimeout(timeout); resolve(); });
    });
    log('bye.');
  };

  child.on('exit', (code) => {
    if (!shuttingDown) {
      logError(`agent process exited unexpectedly (code ${code}). Restart the bridge.`);
      void stop();
    }
  });

  log('Press Ctrl+C to stop.');
  ablyHandle = await startAbly();
  if (ablyHandle) {
    // A late Ably failure (after a good subscribe) drops back to polling.
    ablyHandle.realtime.connection.on('failed', () => {
      logError('Ably connection lost, falling back to polling');
      try { ablyHandle.realtime.close(); } catch {}
      ablyHandle = null;
      startPolling();
    });
    // Catch anything posted between the seen-init fetch and the subscribe.
    await poll();
  } else {
    startPolling();
    await poll();
  }
  return { ok: true, stop, get seenCount() { return seen.size; }, get transport() { return ablyHandle ? 'ably' : 'polling'; } };
}

async function main() {
  const handle = await runBridge();
  if (!handle?.ok) process.exit(1);
  const shutdown = async () => { await handle.stop(); process.exit(0); };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[pc-bridge] fatal:', err?.message ?? err);
    process.exit(1);
  });
}
