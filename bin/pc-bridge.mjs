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
// Headless (runner): set HELMION_BRIDGE_PAIRING_CODE instead of answering
// the prompt; it is consumed once on exchange.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createInterface as createPromptInterface } from 'node:readline/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openVault, readDeviceToken, defaultVaultPath, PROVIDER_KEY_ENV } from '../src/runner/vault.mjs';
import { parseApprovalReply } from '../src/mcp/local-exec-server.mjs';
import { agentPrompt, normalizeProvider } from '../src/cloud/envoy-agents.mjs';

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
    channelSlugs: process.env.HELMION_BRIDGE_CHANNEL_SLUGS || '*', // '*' = all channels, or comma-separated slugs
    provider: process.env.HELMION_BRIDGE_PROVIDER || 'claude',
    // Agent members this PC answers for in Envoy (and linked Discord) channels.
    // Default: the bridge provider plus Maestro, plus every provider in the vault.
    agents: process.env.HELMION_BRIDGE_AGENTS || null,
    maestroProvider: process.env.HELMION_BRIDGE_MAESTRO_PROVIDER || null,
    workspace: process.env.HELMION_BRIDGE_WORKSPACE || join(homedir(), 'workspace'),
    toolsMode: process.env.HELMION_BRIDGE_TOOLS || 'read-only', // read-only | ask | full
    helmionBin: resolve(dirname(fileURLToPath(import.meta.url)), 'helmion.mjs'),
    fetchImpl: fetch,
    spawnImpl: spawn,
    execPath: process.execPath,
    ablyImpl: null, // tests inject a fake { Realtime }; default is dynamic import('ably')
    noAbly: process.env.HELMION_BRIDGE_NO_ABLY === '1',
    vaultPath: null, // null = defaultVaultPath(homedir()); tests inject a tmp path
    log: (...args) => console.log('[pc-bridge]', ...args),
    logError: (...args) => console.error('[pc-bridge]', ...args),
    promptCode: null, // tests inject an async () => code; default: HELMION_BRIDGE_PAIRING_CODE env, else prompt stdin
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
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch {}
  if (!res.ok || parsed?.valid === false) {
    // Log full response for debugging
    deps.log(`API DEBUG: status=${res.status}, body=${text.slice(0, 500)}`);
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
  } else if (process.env.HELMION_BRIDGE_PAIRING_CODE) {
    // Headless provisioning (runner): one-shot code via env, consumed on
    // exchange; the persisted device token takes over afterwards.
    code = String(process.env.HELMION_BRIDGE_PAIRING_CODE).trim().toUpperCase();
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

function startAgent(deps, extraEnv = {}) {
  const child = deps.spawnImpl(deps.execPath, [deps.helmionBin, 'agent-bridge'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...extraEnv },
  });
  child.on('error', (err) => {
    deps.logError('agent process failed to start:', err?.message ?? err);
    process.exit(1);
  });
  return child;
}

// Credential vault (runner v1): if the vault holds a key for the configured
// provider, it wins over the environment variable. The child inherits the
// bridge's env, so setting process.env here reaches the agent. Never throws:
// any vault problem falls back to plain env vars and is logged.
// Reports vault presence to the cloud (presence-only booleans, never secrets)
// so Settings can show which providers are connected. Best-effort: never
// throws, never blocks startup.
async function reportPresence(deps, token) {
  try {
    const vaultPath = deps.vaultPath || defaultVaultPath(homedir());
    const deviceToken = await readDeviceToken(deps.tokenPath);
    if (!deviceToken) return;
    const vault = await openVault({ vaultPath, deviceToken });
    const rows = await vault.status();
    const providers = new Set(rows.map((r) => String(r.provider).toLowerCase()));
    // The env-configured provider counts too when the vault does not have it.
    const envName = PROVIDER_KEY_ENV[String(deps.provider || '').toLowerCase()];
    if (envName && process.env[envName]) providers.add(String(deps.provider).toLowerCase());
    for (const provider of providers) {
      await api(deps, '/api/admin/envoy/runner/presence', {
        method: 'POST', token,
        body: { provider, connected: true },
      });
    }
    if (providers.size > 0) deps.log(`presence reported: ${[...providers].join(', ')}`);
  } catch (err) {
    deps.logError('presence report failed:', err?.message ?? err);
  }
}

async function vaultProviders(deps) {
  try {
    const token = await readDeviceToken(deps.tokenPath);
    if (!token) return [];
    const vault = await openVault({ vaultPath: deps.vaultPath || defaultVaultPath(homedir()), deviceToken: token });
    return (await vault.status()).map((r) => String(r.provider).toLowerCase());
  } catch { return []; }
}

// Keys for every provider this PC serves as an agent (vault wins over env).
async function loadVaultKeys(deps, providers) {
  const out = {};
  for (const provider of providers) Object.assign(out, await loadVaultKey({ ...deps, provider }));
  return out;
}

async function loadVaultKey(deps) {
  const envName = PROVIDER_KEY_ENV[String(deps.provider || '').toLowerCase()];
  if (!envName) return {};
  try {
    const token = await readDeviceToken(deps.tokenPath);
    if (!token) return {};
    const vaultPath = deps.vaultPath || defaultVaultPath(homedir());
    const vault = await openVault({ vaultPath, deviceToken: token });
    const secret = await vault.get(deps.provider);
    if (!secret) {
      deps.log(`provider key: environment (${envName})`);
      return {};
    }
    deps.log(`provider key: vault (${envName})`);
    return { [envName]: secret };
  } catch (err) {
    deps.logError('vault unavailable, using environment:', err?.message ?? err);
    return {};
  }
}

// NDJSON helpers for the agent child. Resolves with the concatenated
// assistant text once the turn's `done` event arrives.
// onPermissionRequest(event) is called for broker `permission_request` events
// so the host can surface approvals (envoy channel) while the turn is blocked.
function runTurn(child, text, { onPermissionRequest = null } = {}) {
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
        else if (event?.event === 'permission_request' && onPermissionRequest) {
          try { onPermissionRequest(event); } catch { /* never break the turn */ }
        }
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

// Send one command and wait for the child's matching event (or time out).
function sendAndWait(child, payload, eventName, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let buffer = '';
    const finish = (value) => { clearTimeout(timer); child.stdout.off('data', onData); resolve(value); };
    const onData = (data) => {
      buffer += String(data);
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const raw of lines) {
        try { const event = JSON.parse(raw.trim()); if (event?.event === eventName) return finish(event); } catch { /* not JSON */ }
      }
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout.on('data', onData);
    child.stdin.write(`${JSON.stringify(payload)}\n`);
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

// Post a tool approval request to the envoy team channel so the human can
// reply "approve <id>" / "deny <id>" from /app or phone. Best-effort.
async function postApprovalRequest(deps, token, channelId, req) {
  try {
    const summary = req.summary ?? req.tool ?? 'tool call';
    await api(deps, '/api/admin/envoy/messages', {
      method: 'POST', token,
      body: {
        channelId,
        body: `Approval needed (${req.id}): ${summary}\nReply "approve ${req.id}" or "deny ${req.id}".`,
        idempotencyKey: `bridge-approval:${req.id}`,
      },
    });
    deps.log(`approval requested: ${req.id} (${summary})`);
  } catch (err) {
    deps.logError('approval post failed:', err?.message ?? err);
  }
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

  // Agent members this PC serves (Envoy channel agents and linked Discord).
  const servedAgents = [...new Set(String(deps.agents ?? '').split(',').map(normalizeProvider).filter(Boolean))];
  if (!servedAgents.length) {
    for (const p of [deps.provider, 'maestro', ...await vaultProviders(deps)]) { const n = normalizeProvider(p); if (n && !servedAgents.includes(n)) servedAgents.push(n); }
  }
  const maestroProvider = normalizeProvider(deps.maestroProvider) && normalizeProvider(deps.maestroProvider) !== 'maestro' ? normalizeProvider(deps.maestroProvider) : (normalizeProvider(deps.provider) || 'claude');
  const keyProviders = [...new Set([deps.provider, maestroProvider, ...servedAgents.filter((p) => p !== 'maestro')])];
  const child = startAgent(deps, await loadVaultKeys(deps, keyProviders));
  void reportPresence(deps, creds.token);
  const hello = await waitForHello(child);
  if (hello?.ok === false) logError('agent bridge warning:', hello.message);
  else log('agent ready:', hello?.provider ?? 'unknown provider');

  const tenantSlug = process.env.HELMION_BRIDGE_TENANT_SLUG || null;
  if (tenantSlug) log(`tenant: ${tenantSlug}`);
  child.stdin.write(`${JSON.stringify({ cmd: 'configure', provider: deps.provider, workspace: deps.workspace, permission: deps.toolsMode })}\n`);
  log(`configured provider=${deps.provider} workspace=${deps.workspace} permission=${deps.toolsMode}`);

  const channels = await api(deps, '/api/admin/envoy/channels', { token: creds.token });
  const allChannels = (channels?.channels ?? []).filter((c) => c?.id);
  const slugFilter = String(deps.channelSlugs || '*').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const watched = slugFilter.includes('*') || slugFilter.length === 0
    ? allChannels
    : allChannels.filter((c) => slugFilter.includes(String(c.slug || '').toLowerCase()));
  if (watched.length === 0) {
    logError(`no channels matched "${deps.channelSlugs}". Set HELMION_BRIDGE_CHANNEL_SLUGS to '*' or a comma-separated slug list.`);
    return { ok: false, reason: 'channel not found' };
  }
  log(`watching ${watched.map((c) => `#${c.slug}`).join(', ')}`);
  log(`agent member for: ${servedAgents.join(', ')} (Maestro runs on ${maestroProvider})`);

  // Channels with an agent roster are answered by agent members only (below);
  // the legacy "reply to everything" path stays for channels never configured.
  const configuredChannels = new Set();
  const refreshConfigured = async () => {
    for (const ch of watched) {
      try {
        const c = await api(deps, `/api/admin/envoy/channel-config?channel_id=${encodeURIComponent(ch.id)}`, { token: creds.token });
        if (c?.configured) configuredChannels.add(ch.id); else configuredChannels.delete(ch.id);
      } catch { /* older cloud: no config route, keep legacy */ }
    }
  };
  await refreshConfigured();

  let seen = await loadSeen(deps);
  if (seen === null) {
    // First run: mark everything currently in the watched channels as seen,
    // so we never reply to ancient history.
    seen = new Set();
    for (const ch of watched) {
      const initial = await api(deps, `/api/admin/envoy/messages?channel_id=${encodeURIComponent(ch.id)}`, { token: creds.token });
      for (const m of initial?.messages ?? []) if (typeof m?.id === 'string') seen.add(m.id);
    }
    await saveSeen(deps, seen);
    log('initialized: will only answer new messages from here on.');
  } else {
    log(`resuming, ${seen.size} messages already seen`);
  }

  // Turns stay strictly serialized: one at a time, the rest queue.
  let turnInFlight = false;
  const turnQueue = [];
  let shuttingDown = false;

  const agentJobs = new Set();
  const runAgentJob = async ({ item, provider }) => {
    const runProvider = provider === 'maestro' ? maestroProvider : provider;
    const key = `${provider}|${item.message.id}`;
    try {
      log(`agent ${provider} (${runProvider}) answering ${item.message.id} in #${item.channel.slug}`);
      await sendAndWait(child, { cmd: 'configure', provider: runProvider, workspace: deps.workspace, permission: deps.toolsMode }, 'ready');
      await sendAndWait(child, { cmd: 'reset' }, 'ready');
      const text = agentPrompt({ provider, channelTitle: item.channel.title || item.channel.slug, members: item.members, context: item.context, message: item.message, source: item.message.source });
      const reply = await runTurn(child, text);
      if (!reply || !reply.trim()) { log(`agent ${provider}: no text for ${item.message.id}`); return; }
      const body = reply.length > 4000 ? `${reply.slice(0, 3997)}...` : reply;
      await api(deps, '/api/admin/envoy/agent-messages', { method: 'POST', token: creds.token, body: { channelId: item.channel.id, provider, replyTo: item.message.id, body } });
      log(`agent ${provider} replied in #${item.channel.slug} (${body.length} chars)`);
    } catch (err) {
      logError(`agent ${provider} failed on ${item.message.id}:`, err?.message ?? err);
    } finally {
      agentJobs.delete(key);
      // Back to the bridge's own provider for legacy turns.
      await sendAndWait(child, { cmd: 'configure', provider: deps.provider, workspace: deps.workspace, permission: deps.toolsMode }, 'ready', 5000);
    }
  };

  const enqueue = (job) => { if (turnInFlight) turnQueue.push(job); else void processOne(job); };

  const pollAgentWork = async () => {
    if (shuttingDown) return;
    try {
      const res = await api(deps, `/api/admin/envoy/agent-work?providers=${encodeURIComponent(servedAgents.join(','))}`, { token: creds.token });
      for (const item of res?.work ?? []) {
        configuredChannels.add(item.channel.id);
        for (const provider of item.agents ?? []) {
          const key = `${provider}|${item.message.id}`;
          if (agentJobs.has(key)) continue;
          agentJobs.add(key);
          enqueue({ kind: 'agent', item, provider });
        }
      }
    } catch (err) {
      if (!/ROUTE|404|405/.test(String(err?.message))) logError('agent work poll failed:', err?.message ?? err);
    }
  };

  const processOne = async (job) => {
    turnInFlight = true;
    if (job?.kind === 'agent') {
      try { await runAgentJob(job); }
      finally {
        turnInFlight = false;
        const next = turnQueue.shift();
        if (next && !shuttingDown) void processOne(next);
      }
      return;
    }
    const message = job;
    try {
      log(`turn for message ${message.id} from ${message.authorSubject}`);
      const reply = await runTurn(child, String(message.body ?? ''), {
        onPermissionRequest: (req) => {
          // Post to the channel the turn came from so the human sees it in context.
          void postApprovalRequest(deps, creds.token, message.channelId, req);
        },
      });
      if (!reply || !reply.trim()) {
        log(`message ${message.id}: agent produced no text, skipping reply`);
        return;
      }
      const truncated = reply.length > 4000 ? reply.slice(0, 3997) + "..." : reply;
      log(`message ${message.id}: sending reply, ${truncated.length} chars, preview: ${truncated.slice(0, 100)}`);
      const payload = { body: truncated, channelId: message.channelId, idempotencyKey: `pc-bridge:${message.id}` };
      log(`message ${message.id}: payload channelId=${message.channelId}, idempotencyKey=${payload.idempotencyKey}`);
      // Retry on failure: the cloud may have transient issues. IdempotencyKey makes retry safe.
      let posted = false;
      for (let attempt = 1; attempt <= 3 && !posted; attempt++) {
        try {
          await api(deps, '/api/admin/envoy/messages', { method: 'POST', token: creds.token, body: payload });
          posted = true;
        } catch (err) {
          if (attempt === 3) throw err;
          log(`message ${message.id}: attempt ${attempt} failed, retrying in 5s...`);
          await new Promise(r => setTimeout(r, 5000));
        }
      }
      log(`replied to message ${message.id} in #${(watched.find((c) => c.id === message.channelId) || {}).slug || message.channelId} (${reply.length} chars)`);
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
    const text = String(message.body ?? '').trim();
    if (!text) return;
    // Approval replies go straight to the agent child, never become chat turns.
    const approval = parseApprovalReply(text);
    if (approval && child) {
      log(`approval ${approval.decision}: ${approval.id}`);
      child.stdin.write(`${JSON.stringify({ cmd: 'permission_response', id: approval.id, decision: approval.decision === 'approve' ? 'allow-once' : 'deny' })}\n`);
      return;
    }
    if (configuredChannels.has(message.channelId)) { void pollAgentWork(); return; }
    enqueue(message);
  };

  let pollCount = 0;
  const poll = async () => {
    if (shuttingDown) return;
    pollCount += 1;
    if (pollCount % 12 === 0) await refreshConfigured();
    await pollAgentWork();
    try {
      for (const ch of watched) {
        const res = await api(deps,
          `/api/admin/envoy/messages?channel_id=${encodeURIComponent(ch.id)}`,
          { token: creds.token },
        );
        for (const message of res?.messages ?? []) await ingestMessage(message);
      }
    } catch (err) {
      logError('poll failed, retrying next interval:', err?.message ?? err);
    }
  };

  // Bridge v2 transport: Ably push. Subscribes to every watched channel on
  // one Realtime client (the token capability covers envoy:<tenant>:*).
  // Returns the realtime handle, or null to fall back to HTTPS polling.
  // The bridge subscribes only; replies still go over HTTPS POST as before.
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
    const channelNames = [];
    let firstToken = null;
    try {
      for (const ch of watched) {
        const t = await api(deps, '/api/admin/envoy/ably-token', { method: 'POST', token: creds.token, body: { channelId: ch.id } });
        if (!t?.tokenRequest?.keyName || !t?.channel) throw new Error('bad token response');
        if (!firstToken) firstToken = t;
        channelNames.push(t.channel);
      }
    } catch (err) {
      logError('Ably token failed, falling back to polling:', err?.message ?? err);
      return null;
    }
    const token = firstToken;
    return new Promise((resolve) => {
      void (async () => {
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      let realtime;
      try {
        realtime = new Realtime({
          authCallback: async (_tokenParams, callback) => {
            try {
              const t = await api(deps, '/api/admin/envoy/ably-token', { method: 'POST', token: creds.token, body: { channelId: watched[0].id } });
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
      try {
        await Promise.all(channelNames.map((name) =>
          realtime.channels.get(name).subscribe('message', (msg) => { void ingestMessage(msg?.data); })
        ));
      } catch (err) {
        clearTimeout(giveUp);
        logError('Ably subscribe failed, falling back to polling:', err?.message ?? err);
        try { realtime.close(); } catch {}
        done(null);
        return;
      }
      clearTimeout(giveUp);
      log(`transport: Ably push on ${channelNames.join(', ')}`);
      done({ realtime, channelNames });
      })();
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
    const agentTimer = setInterval(() => void pollAgentWork(), Math.max(deps.pollMs, 5000) * 3);
    if (typeof agentTimer.unref === 'function') agentTimer.unref();
  } else {
    startPolling();
    await poll();
  }
  return { ok: true, stop, get seenCount() { return seen.size; }, get transport() { return ablyHandle ? 'ably' : 'polling'; } };
}

// Helmian hands (src/hands/pc-spoke.mjs): if this PC was paired with
// `node bin/hands-spoke.mjs pair`, the bridge also runs the hands spoke, so the
// HelmianBridge Windows service keeps both alive. Not paired = not started.
async function startHandsSpokeIfPaired() {
  if (process.env.HELMIAN_HANDS_DISABLED === '1') return null;
  try {
    const { readSpokeConfig, startSpoke } = await import('../src/hands/pc-spoke.mjs');
    const config = await readSpokeConfig();
    if (!config) return null;
    return startSpoke({ config });
  } catch (err) {
    console.error('[pc-bridge] hands spoke not started:', err?.message ?? err);
    return null;
  }
}

async function main() {
  const handle = await runBridge();
  if (!handle?.ok) process.exit(1);
  const hands = await startHandsSpokeIfPaired();
  const shutdown = async () => { hands?.stop(); await handle.stop(); process.exit(0); };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[pc-bridge] fatal:', err?.message ?? err);
    process.exit(1);
  });
}
