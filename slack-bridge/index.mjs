// Helmian Slack bridge service. Runs on the Hetzner box next to the Discord
// bridge (docker, 127.0.0.1 only, no inbound ports: it dials out to Slack's
// Socket Mode websocket and to helmian.cloud). Vercel functions cannot hold
// the socket open, which is why inbound lives here — same reason as Discord.
//
// Socket Mode has no per-message HTTP signature by design: the connection
// itself is the authentication. Only a socket opened with the app-level
// token (apps.connections.open) receives events, and every bridge -> cloud
// call carries the shared HELMIAN_ENVOY_BRIDGE_TOKEN bearer. The signed
// HTTP pipe (HELMION_SLACK_SIGNING_SECRET, verifySlackRequest) stays in
// place for the outbound webhook path.
//
// Env (in /opt/helmian-slack-bridge/app.env, chmod 600, never in git or Vercel):
//   SLACK_APP_TOKEN             xapp-… app-level token with connections:write (Socket Mode)
//   SLACK_BOT_TOKEN             xoxb-… bot token from the same install; optional —
//                               without it, author names fall back to "Slack member",
//                               link confirmations get no reply in Slack, and named
//                               outbound is off (/healthz reports outbound:
//                               webhook-only — Envoy reaches Slack only through
//                               the HELMION_SLACK_WEBHOOK_URL pipe, unnamed)
//   HELMIAN_ENVOY_BRIDGE_TOKEN  shared secret, same value as the Vercel env var
//   HELMIAN_CLOUD               default https://helmian.cloud
//   HEALTH_PORT / HEALTH_HOST   default 8096 on 0.0.0.0 inside the container; publish it as 127.0.0.1:8096 only
import http from 'node:http';
import { createBridge, normalizeSlackEvent, outboundMode } from './bridge-core.mjs';

const cloud = process.env.HELMIAN_CLOUD || 'https://helmian.cloud';
const bridgeToken = String(process.env.HELMIAN_ENVOY_BRIDGE_TOKEN ?? '').trim();
const appToken = String(process.env.SLACK_APP_TOKEN ?? '').trim();
const botToken = String(process.env.SLACK_BOT_TOKEN ?? '').trim();
const log = (...a) => console.log(new Date().toISOString(), '[slack-bridge]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const health = { slack: appToken ? 'connecting' : 'not_configured', cloud: bridgeToken ? 'unknown' : 'not_configured', connections: 0, outbound: outboundMode(Boolean(botToken)) };
const bridge = bridgeToken ? createBridge({ cloud, token: bridgeToken }) : null;

http.createServer((req, res) => {
  if (req.url !== '/healthz') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, ...health, links: bridge?.links.length ?? 0, stats: bridge?.stats ?? null }));
}).listen(Number(process.env.HEALTH_PORT || 8096), process.env.HEALTH_HOST || '0.0.0.0');

// --- Slack Web API helpers (bot token; names are best effort) ---
const nameCaches = { user: new Map(), channel: new Map(), team: new Map() };
async function slackApi(method, params = {}) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { authorization: `Bearer ${botToken}` } });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method}: ${data.error ?? res.status}`);
  return data;
}
async function cached(cache, key, load) {
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  let value = null;
  try { value = await load(); } catch { /* names are decoration; never block a message */ }
  if (cache.size > 500) cache.clear();
  cache.set(key, value);
  return value;
}
const userName = (id) => (botToken ? cached(nameCaches.user, id, async () => {
  const d = await slackApi('users.info', { user: id });
  return d.user?.profile?.display_name || d.user?.profile?.real_name || d.user?.name || null;
}) : Promise.resolve(null));
const channelName = (id) => (botToken ? cached(nameCaches.channel, id, async () => (await slackApi('conversations.info', { channel: id })).channel?.name ?? null) : Promise.resolve(null));
const teamName = (id) => (botToken ? cached(nameCaches.team, id, async () => (await slackApi('team.info', { team: id })).team?.name ?? null) : Promise.resolve(null));
const postMessage = async (channel, text) => { await slackApi('chat.postMessage', { channel, text }); };

// chat.postMessage for outbound carries up to ~4k of text — too long for
// the query-string helper above, so it goes as a JSON POST.
async function slackApiPost(method, payload) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method}: ${data.error ?? res.status}`);
  return data;
}
const postSlackMessage = async ({ channel, text }) => { await slackApiPost('chat.postMessage', { channel, text }); };

// --- Socket Mode ---
async function handleEnvelope(ws, raw) {
  let env;
  try { env = JSON.parse(String(raw)); } catch { return; }
  if (env.type === 'hello') { health.slack = 'ready'; health.connections = env.num_connections ?? 1; log(`socket hello (${health.connections} connection(s))`); return; }
  if (env.type === 'disconnect') { log('slack asked for a fresh socket:', env.reason ?? ''); try { ws.close(); } catch {} return; }
  // Ack first, always: Slack wants the envelope acked within 3 seconds.
  if (env.envelope_id) { try { ws.send(JSON.stringify({ envelope_id: env.envelope_id })); } catch {} }
  if (env.type !== 'events_api' || env.payload?.type !== 'event_callback') return;
  const evt = normalizeSlackEvent(env.payload.event, env.payload.team_id);
  if (!evt) return;
  evt.userName = await userName(evt.userId);
  evt.channelName = await channelName(evt.channelId);
  evt.teamName = await teamName(evt.teamId);
  const reply = botToken ? (text) => postMessage(evt.channelId, text) : null;
  await bridge.onSlackMessage(evt, { reply });
}

async function connectOnce() {
  const res = await fetch('https://slack.com/api/apps.connections.open', { method: 'POST', headers: { authorization: `Bearer ${appToken}` } });
  const data = await res.json().catch(() => ({}));
  if (!data.ok || !data.url) throw new Error(`apps.connections.open: ${data.error ?? res.status}`);
  health.slack = 'connecting';
  const ws = new WebSocket(data.url);
  await new Promise((resolve) => {
    ws.addEventListener('message', (ev) => { handleEnvelope(ws, ev.data).catch((e) => { bridge.stats.errors += 1; bridge.stats.lastError = e.message; log('inbound failed:', e.message); }); });
    ws.addEventListener('close', resolve);
    ws.addEventListener('error', () => { try { ws.close(); } catch {} });
  });
  health.slack = 'reconnecting';
}

async function runSocket() {
  let delay = 1000;
  for (;;) {
    try { await connectOnce(); delay = 1000; }
    catch (e) { health.slack = `error: ${e.message}`; log('socket:', e.message); }
    await sleep(delay);
    delay = Math.min(delay * 2, 30_000);
  }
}

async function main() {
  if (!bridge) { log('HELMIAN_ENVOY_BRIDGE_TOKEN is not set; idle.'); return; }
  try { await bridge.refreshLinks(); health.cloud = 'ok'; log(`cloud ok, ${bridge.links.length} linked channel(s)`); }
  catch (e) { health.cloud = `error: ${e.message}`; log('cloud check failed:', e.message); }
  setInterval(() => { bridge.refreshLinks().then(() => { health.cloud = 'ok'; }).catch((e) => { health.cloud = `error: ${e.message}`; }); }, 30_000).unref();
  // Named outbound needs only the cloud + the bot token (no socket), so
  // it runs even while the socket is down; without a bot token it stays
  // off and says so, here and on /healthz.
  if (botToken) {
    let busy = false;
    setInterval(async () => {
      if (busy) return;
      busy = true;
      try { await bridge.pumpOutbound({ postMessage: postSlackMessage }); }
      catch (e) { bridge.stats.errors += 1; bridge.stats.lastError = e.message; log('outbound failed:', e.message); }
      finally { busy = false; }
    }, 2000).unref();
  } else {
    log('SLACK_BOT_TOKEN is not set; named outbound is off (outbound: webhook-only). Envoy messages reach Slack only through the webhook pipe.');
  }
  if (!appToken) { log('SLACK_APP_TOKEN is not set; waiting. Add it to app.env and restart.'); return; }
  void runSocket();
}

main().catch((e) => { log('fatal:', e.message); process.exitCode = 1; });
process.on('SIGTERM', () => process.exit(0));
