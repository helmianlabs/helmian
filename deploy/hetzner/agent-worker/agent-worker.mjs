#!/usr/bin/env node
// Helmian cloud agent worker (Hetzner box): the always-on consumer for
// Envoy channel agent-work, providers gemini + grok.
//
// Mirrors the agent-member loop of bin/pc-bridge.mjs (pollAgentWork /
// runAgentJob) so a channel message that names @Gemini or @Grok gets
// answered even when Troy's PC is off:
//   1. heartbeat  POST /api/admin/envoy/runner/presence {provider, connected}
//                 (once per served provider)
//   2. poll       GET  /api/admin/envoy/agent-work?providers=gemini,grok
//   3. run        the job prompt (assembled exactly like the bridge's
//                 agentPrompt): gemini jobs go through
//                 run-gemini-visible.sh (bite 9: a terminal on the
//                 workspace screen, so the work is watchable live),
//                 falling back to run-gemini.sh (hidden docker exec) if
//                 the visible path fails; grok jobs go through
//                 run-grok.mjs (SuperGrok subscription session resolved
//                 from the cloud bridge's vault -> api.x.ai)
//   4. reply      POST /api/admin/envoy/agent-messages {channelId, provider,
//                 replyTo} — the route derives the reply:<messageId>
//                 idempotency key, so a message is never answered twice.
//   5. attachments  the job payload already carries message.metadata
//                 (composer "+" attachments, sql/060 via PR #97's
//                 messageOut). Before the prompt is assembled,
//                 worker-attachments.mjs expands a leading /skill lead
//                 through the real command registry and prepends the
//                 attachment context block — the context half of the PC
//                 bridge's resolveTurnAttachments. This runner has no
//                 tool runtime, so plugin tools are NOT connected here;
//                 the context says so plainly instead of faking it.
//                 The registry is tenant-aware (tenant-onboarding
//                 splice): worker-tenant.mjs stocks the served tenant's
//                 starter commands under JOB_WORKSPACE/tenants/<id>/
//                 on first use and merges them under the workspace's own
//                 commands, which win every clash — Troy's hand-seeded
//                 workspace expands exactly as it did before.
//
// Auth: a Helmian device token (the same pairing mechanism as the PC
// bridge: /app link-desktop code -> POST /api/admin/desktop/link/exchange),
// stored only in ./device-token.json (mode 600) next to this script.
// The token value is never logged.
import { execFile } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { prepareJobMessage } from './worker-attachments.mjs';
import { isQuotaError, isParked, parkedUntil, parkProvider, claimOnce, releaseClaim } from './worker-park.mjs';

const CLOUD = 'https://helmian.cloud';
const PROVIDERS = ['gemini', 'grok'];
const SERVED = new Set(PROVIDERS);
const TOKEN_PATH = '/opt/helmian-agentbox/worker/device-token.json';
const RUN_GEMINI = '/opt/helmian-agentbox/run-gemini.sh';
const RUN_GEMINI_VISIBLE = '/opt/helmian-agentbox/run-gemini-visible.sh';
const RUN_GROK = '/opt/helmian-agentbox/run-grok.mjs';
// Host path of the workspace both gemini runners mount as /workspace in
// agentbox-test — the command-discovery root for slash expansion.
const JOB_WORKSPACE = '/opt/helmian-agentbox/workspaces/test-project';
const LOG_PATH = '/opt/helmian-agentbox/worker/worker.log';
const POLL_MS = 12_000;
const PRESENCE_MS = 60_000;
const JOB_TIMEOUT_MS = 660_000; // run-gemini.sh caps the CLI at 600s
const MAX_ATTEMPTS = 3;

function log(...args) {
  const line = `${new Date().toISOString()} [agent-worker] ${args.map((a) => String(a)).join(' ')}`;
  console.log(line);
  try { appendFileSync(LOG_PATH, `${line}\n`); } catch { /* journald still has it */ }
}

// ---- prompt assembly: replicated from src/cloud/envoy-agents.mjs ----
// (agentPrompt + AGENT_NAMES; providers arrive normalized from the cloud,
// the alias map is kept so members/message fields normalize identically.)
const AGENT_NAMES = Object.freeze({ maestro: 'Maestro', claude: 'Claude', openai: 'ChatGPT', grok: 'Grok', gemini: 'Gemini' });
const ALIASES = Object.freeze({
  maestro: 'maestro', manager: 'maestro',
  claude: 'claude', anthropic: 'claude',
  chatgpt: 'openai', openai: 'openai', gpt: 'openai', codex: 'openai',
  grok: 'grok', xai: 'grok',
  gemini: 'gemini', google: 'gemini',
});
function normalizeProvider(value) {
  const key = String(value ?? '').trim().toLowerCase().replace(/^@/, '');
  return ALIASES[key] ?? null;
}
function agentPrompt({ provider, channelTitle, members, context = [], message, source = 'helmian' }) {
  const p = normalizeProvider(provider);
  const me = AGENT_NAMES[p] ?? 'Agent';
  const others = (members ?? []).map(normalizeProvider).filter((x) => x && x !== p).map((x) => AGENT_NAMES[x]);
  const where = source === 'discord' ? `the #${channelTitle} channel (mirrored with Discord)` : `the #${channelTitle} channel in Helmian Envoy`;
  const role = p === 'maestro'
    ? `You are Maestro, the manager agent in ${where}. Other agents here: ${others.join(', ') || 'none'}. When the request needs work, split it into distinct slices and assign each with an @mention (for example "@Claude: ..."). Keep it short. If no other agents are here, answer yourself.`
    : `You are ${me}, an agent member of ${where}. Other agents here: ${others.join(', ') || 'none'}. If you were given a slice of work, start your reply with "Claim:" and the slice you are taking, so you do not overlap the others. Be concise.`;
  const history = context.slice(-12).map((m) => `${m.authorName || m.authorKind}: ${String(m.body ?? '').slice(0, 600)}`).join('\n');
  const from = message?.authorName || (message?.authorKind === 'agent' ? 'Agent' : 'Member');
  return `${role}\n\nRecent conversation:\n${history || '(none)'}\n\nReply to this message from ${from}:\n${String(message?.body ?? '')}`;
}
// ---- end replication ----

let token = null;
// The tenant this worker serves — the pairing record carries it next to
// the token. Command discovery resolves that tenant's own workspace
// commands under the job workspace's (worker-tenant.mjs). Absent or
// malformed → null, and discovery stays the single-workspace path.
let tenantId = null;
try {
  const data = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
  if (!data?.token) throw new Error('no token field');
  token = String(data.token);
  if (typeof data?.tenantId === 'string' && data.tenantId.trim()) tenantId = data.tenantId.trim();
} catch (err) {
  log('fatal: cannot load device token:', err?.message ?? err);
  process.exit(1);
}

async function api(path, { method = 'GET', body = null } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== null) headers['content-type'] = 'application/json';
  const res = await fetch(`${CLOUD}${path}`, { method, headers, body: body === null ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
  if (!res.ok || parsed?.valid === false) throw new Error(`cloud ${method} ${path} failed: ${parsed?.code ?? res.status}`);
  return parsed;
}

async function heartbeat() {
  for (const provider of PROVIDERS) {
    try {
      await api('/api/admin/envoy/runner/presence', { method: 'POST', body: { provider, connected: true } });
      log(`presence heartbeat ok: ${provider} connected`);
    } catch (err) {
      log(`presence heartbeat failed (${provider}):`, err?.message ?? err);
    }
  }
}

function runGeminiVisible(prompt, jobId) {
  return new Promise((resolve, reject) => {
    execFile(RUN_GEMINI_VISIBLE, [prompt, jobId], { timeout: JOB_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr ?? '').split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300);
        reject(new Error(`run-gemini-visible failed: ${err.message}${tail ? ` (${tail})` : ''}`));
        return;
      }
      resolve(String(stdout ?? '').trim());
    });
  });
}

function runGemini(prompt) {
  return new Promise((resolve, reject) => {
    execFile(RUN_GEMINI, [prompt], { timeout: JOB_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr ?? '').split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300);
        reject(new Error(`run-gemini failed: ${err.message}${tail ? ` (${tail})` : ''}`));
        return;
      }
      resolve(String(stdout ?? '').trim());
    });
  });
}

function runGrok(prompt) {
  return new Promise((resolve, reject) => {
    execFile(RUN_GROK, [prompt], { timeout: JOB_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr ?? '').split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 400);
        reject(new Error(`run-grok failed: ${err.message}${tail ? ` (${tail})` : ''}`));
        return;
      }
      resolve(String(stdout ?? '').trim());
    });
  });
}

// ---- reply extraction ---------------------------------------------------
// The Gemini CLI's headless stdout sometimes ends a turn with NO human
// text: either truly empty, or a bare protocol marker such as
// {"end_of_turn": true} — the CLI's turn-complete event leaking into the
// text stream when the model's final part carried no text. The runners
// pass stdout through byte-for-byte, so without this filter the marker
// becomes the channel reply (seen live: the 21-char marker was the ONLY
// reply to a completed build). Rule: the posted reply must be human
// text; marker-only or empty output is NO reply and takes the normal
// retry path below — a raw marker is never posted.
const PROTOCOL_KEYS = new Set(['end_of_turn', 'type', 'event', 'status', 'done', 'finish_reason', 'stop_reason']);

function isProtocolMarkerLine(line) {
  const t = line.trim();
  if (!/^\{.*\}$/.test(t)) return false;
  try {
    const obj = JSON.parse(t);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    const keys = Object.keys(obj);
    return keys.length > 0 && keys.every((k) => PROTOCOL_KEYS.has(k.toLowerCase()));
  } catch { return false; }
}

// Human-readable reply text with protocol-marker lines removed, or ''
// when the run produced nothing postable.
function extractReply(raw) {
  return String(raw ?? '').split('\n').filter((l) => !isProtocolMarkerLine(l)).join('\n').trim();
}

// messageId -> { count, nextTryAt, dead } — a failed/empty job backs off
// instead of burning a Gemini run every poll until the 30-min window ends.
const attempts = new Map();
const inFlight = new Set();
let lastPollError = '';

// Park logging must not spam every 12s poll. One line per park episode.
const _parkLoggedFor = new Map();
function logOncePerPark(provider, line) {
  const until = parkedUntil(provider)?.toISOString();
  if (_parkLoggedFor.get(provider) === until) return;
  _parkLoggedFor.set(provider, until);
  log(line);
}

function noteFailure(messageId) {
  const a = attempts.get(messageId) ?? { count: 0, nextTryAt: 0, dead: false };
  a.count += 1;
  a.nextTryAt = Date.now() + 60_000 * a.count;
  if (a.count >= MAX_ATTEMPTS) a.dead = true;
  attempts.set(messageId, a);
  return a;
}

async function runJob(item, provider) {
  const firstLine = String(item.message.body ?? '').split('\n')[0].slice(0, 120);
  log(`job start: provider=${provider} message=${item.message.id} channel=#${item.channel.slug} text="${firstLine}"`);
  // Composer "+" attachments: the payload's message.metadata becomes an
  // attachment context block prepended to the body (bridge position), and
  // a leading /skill lead is expanded through the real command registry
  // when it resolves. prepareJobMessage never throws on bad metadata —
  // worst case the job runs exactly as it did before attachments existed.
  const prepared = await prepareJobMessage(item.message, { workspace: JOB_WORKSPACE, tenantId });
  if (prepared.metadataDropped) {
    log(`job attachments: message=${item.message.id} metadata failed normalization — dropped, running without attachments`);
  } else if (prepared.contextText || prepared.expandedName) {
    log(`job attachments: message=${item.message.id} kinds=${prepared.attachmentKinds.join(',') || 'none'} webSearch=${prepared.webSearch === undefined ? 'unset' : prepared.webSearch} expanded=${prepared.expandedName ? `/${prepared.expandedName}` : 'none'}`);
  }
  const prompt = agentPrompt({
    provider,
    channelTitle: item.channel.title || item.channel.slug,
    members: item.members,
    context: item.context,
    message: { ...item.message, body: prepared.body },
    source: item.message.source,
  });
  // Bite 9: gemini jobs run in a VISIBLE terminal on the workspace screen
  // so anyone watching sees the work. If the visible path fails, fall back
  // to the hidden run — a job must never be lost because a window failed.
  // Grok has no screen: run-grok.mjs resolves the SuperGrok session from
  // the bridge vault and takes the turn against api.x.ai directly.
  let reply;
  if (provider === 'grok') {
    log(`job run: grok api path message=${item.message.id}`);
    reply = await runGrok(prompt);
  } else {
    log(`job run: visible terminal path message=${item.message.id}`);
    try {
      reply = await runGeminiVisible(prompt, item.message.id);
    } catch (visErr) {
      log(`job run: VISIBLE PATH FAILED message=${item.message.id}: ${visErr?.message ?? visErr} — FALLING BACK to hidden run-gemini.sh`);
      reply = await runGemini(prompt);
    }
  }
  const rawReply = reply;
  reply = extractReply(rawReply);
  if (rawReply && !reply) {
    log(`job reply discarded (protocol marker only, no human text): message=${item.message.id} raw=${JSON.stringify(String(rawReply).slice(0, 80))}`);
  }
  if (!reply) {
    const a = noteFailure(item.message.id);
    log(`job empty reply: message=${item.message.id} attempt=${a.count}${a.dead ? ' giving up on this message' : ''}`);
    return;
  }
  const body = reply.length > 4000 ? `${reply.slice(0, 3997)}...` : reply;
  await api('/api/admin/envoy/agent-messages', {
    method: 'POST',
    body: { channelId: item.channel.id, provider, replyTo: item.message.id, body },
  });
  attempts.delete(item.message.id);
  log(`job done: provider=${provider} message=${item.message.id} channel=#${item.channel.slug} reply posted (${body.length} chars)`);
}

async function poll() {
  let res;
  try {
    res = await api(`/api/admin/envoy/agent-work?providers=${PROVIDERS.join(',')}`);
    if (lastPollError) { log('poll recovered'); lastPollError = ''; }
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (msg !== lastPollError) { log('poll failed:', msg); lastPollError = msg; }
    return;
  }
  for (const item of res?.work ?? []) {
    for (const provider of item.agents ?? []) {
      if (!SERVED.has(provider)) { log(`skipped: provider not served (${provider}) message=${item.message.id}`); continue; }
      const key = `${provider}|${item.message.id}`;
      if (inFlight.has(key)) continue;
      // PARK GATE (park-fix): a quota-dead provider stays parked until its
      // window resets. Skip without failing the job — it is picked up
      // again on a later poll once the park expires.
      if (isParked(provider)) {
        logOncePerPark(provider, `parked until ${parkedUntil(provider).toISOString()} — skipping ${provider} jobs`);
        continue;
      }
      const a = attempts.get(item.message.id);
      if (a?.dead || (a && Date.now() < a.nextTryAt)) continue;
      // CLONE GUARD (park-fix): one live run per message id, ever.
      if (!claimOnce(item.message.id)) {
        log(`duplicate claim for message ${item.message.id} skipped (already running)`);
        continue;
      }
      inFlight.add(key);
      try {
        await runJob(item, provider);
      } catch (err) {
        const errText = String(err?.message ?? err);
        if (isQuotaError(errText)) {
          // QUOTA (park-fix): park the provider, do NOT count a retry, do
          // NOT mark the job dead. Retrying a dead quota is what cloned
          // three Gemini runs on 2026-10-24 — the job stays pending and
          // the park gate above holds it until the window resets.
          const until = parkProvider(provider, errText);
          log(`quota-class failure for ${provider}; parked until ${until.toISOString()}; job ${item.message.id} held, not retried`);
        } else {
          const att = noteFailure(item.message.id);
          log(`job failed: provider=${provider} message=${item.message.id} attempt=${att.count}${att.dead ? ' giving up on this message' : ''}:`, err?.message ?? err);
        }
      } finally {
        inFlight.delete(key);
        releaseClaim(item.message.id);
      }
    }
  }
}

log(`starting: providers=${PROVIDERS.join(',')} poll=${POLL_MS}ms presence=${PRESENCE_MS}ms cloud=${CLOUD}`);
await heartbeat();
await poll();
setInterval(() => { void heartbeat(); }, PRESENCE_MS);
setInterval(() => { void poll(); }, POLL_MS);
log('polling');
