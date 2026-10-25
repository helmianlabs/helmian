// Helmian Discord MCP server: the Discord mirror as tools (mcp-core.mjs),
// served the way the hands server is served \u2014 streamable HTTP with a
// bearer token \u2014 plus a stdio mode for local launches and tests.
//
// Env (in /opt/helmian-discord-bridge/app.env on Hetzner, mode 600):
//   HELMIAN_DISCORD_MCP_TOKEN   bearer callers present to THIS server. It is
//                               a token Helmian issues for the server, never
//                               a Discord credential. HTTP mode refuses to
//                               start without it (fail closed).
//   HELMIAN_ENVOY_BRIDGE_TOKEN  the bridge's existing cloud credential \u2014
//                               the same value the bridge itself uses.
//                               No second Discord bot, no new Discord token.
//   HELMIAN_CLOUD               default https://helmian.cloud
//   DISCORD_MCP_PORT            default 8097 (127.0.0.1 only by default)
//   DISCORD_MCP_HOST            default 127.0.0.1
//   STATE_DIR                   default /data \u2014 the bridge's state dir;
//                               its webhook cache is read (never written)
//                               to deliver approved posts.
//
// Guard posture today: no Guard client is wired for this service yet, so
// the core runs with its fail-closed default \u2014 discord_post_message
// reports the Guard outcome (denied: Guard not live) and posts nothing.
// Wiring a real authorizer is a placement step, named in the README.
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDiscordMcpCore, createWebhookPoster } from './mcp-core.mjs';

const env = process.env;
const log = (...a) => console.log(new Date().toISOString(), '[discord-mcp]', ...a);

export function readConfig(source = env) {
  return {
    cloud: String(source.HELMIAN_CLOUD || 'https://helmian.cloud'),
    bridgeToken: String(source.HELMIAN_ENVOY_BRIDGE_TOKEN ?? '').trim(),
    mcpToken: String(source.HELMIAN_DISCORD_MCP_TOKEN ?? '').trim(),
    port: Number(source.DISCORD_MCP_PORT || 8097),
    host: String(source.DISCORD_MCP_HOST || '127.0.0.1'),
    stateDir: String(source.STATE_DIR || '/data'),
  };
}

function tokenOk(header, expected) {
  const got = String(header ?? '').startsWith('Bearer ') ? String(header).slice(7).trim() : '';
  if (!got || !expected) return false;
  const a = createHash('sha256').update(got).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The bridge's cached channel webhooks, read fresh per post (the bridge
 *  process owns the file; this server never writes it). */
export function cachedWebhookLookup(stateDir, readFileImpl = readFile) {
  return async (discordChannelId) => {
    try {
      const state = JSON.parse(await readFileImpl(join(stateDir, 'discord-bridge-state.json'), 'utf8'));
      const hook = state?.webhooks?.[String(discordChannelId)];
      return hook?.id && hook?.token ? { id: hook.id, token: hook.token } : null;
    } catch { return null; }
  };
}

export function buildCore(config, overrides = {}) {
  const poster = createWebhookPoster({ getWebhook: cachedWebhookLookup(config.stateDir), ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}) });
  return createDiscordMcpCore({
    cloud: config.cloud,
    token: config.bridgeToken,
    poster,
    ...(overrides.guard ? { guard: overrides.guard } : {}),
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  });
}

export function createHttpServer(config, core) {
  return http.createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    const path = String(req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/healthz') {
      return json(200, { ok: true, service: 'helmian-discord-mcp', tools: core.tools.length, guard: core.guardLive ? 'live' : 'not wired (mutating tools denied)' });
    }
    if (path !== '/mcp') return json(404, { error: 'not found' });
    if (req.method !== 'POST') return json(405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Use POST.' }, id: null });
    if (!tokenOk(req.headers.authorization, config.mcpToken)) return json(401, { jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null });
    let raw = '';
    let tooBig = false;
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 256 * 1024) { tooBig = true; req.destroy(); } });
    req.on('end', async () => {
      if (tooBig) return;
      let message;
      try { message = JSON.parse(raw); } catch { return json(400, { jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null }); }
      try {
        if (Array.isArray(message)) {
          const out = [];
          for (const m of message) { const r = await core.handleMessage(m); if (r) out.push(r); }
          return out.length ? json(200, out) : json(202, undefined);
        }
        const response = await core.handleMessage(message);
        return response ? json(200, response) : json(202, undefined);
      } catch (error) {
        return json(500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    });
  });
}

async function runStdio(core) {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    let message;
    try { message = JSON.parse(text); } catch { continue; }
    const response = await core.handleMessage(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

async function main() {
  const config = readConfig();
  const core = buildCore(config);
  if (process.argv.includes('--stdio')) {
    await runStdio(core);
    return;
  }
  if (!config.mcpToken) {
    log('HELMIAN_DISCORD_MCP_TOKEN is not set; refusing to start (an unauthenticated tool server is not a thing Helmian runs).');
    process.exitCode = 1;
    return;
  }
  const server = createHttpServer(config, core);
  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  const bound = server.address();
  log(`listening on http://${config.host}:${bound.port}/mcp (guard: ${core.guardLive ? 'live' : 'not wired \u2014 mutating tools denied'})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { log('fatal:', e.message); process.exitCode = 1; });
  process.on('SIGTERM', () => process.exit(0));
}
