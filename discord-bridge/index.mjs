// Helmian Discord bridge service. Runs on the Hetzner box next to hands and
// Guard (docker, 127.0.0.1 only, no inbound ports needed: it dials out to the
// Discord gateway and to helmian.cloud).
//
// Env (in /opt/helmian-discord-bridge/app.env, chmod 600, never in git or Vercel):
//   DISCORD_BOT_TOKEN           the Helmian Discord bot's token
//   HELMIAN_ENVOY_BRIDGE_TOKEN  shared secret, same value as the Vercel env var
//   HELMIAN_CLOUD               default https://helmian.cloud
//   STATE_DIR                   default /data
//   HEALTH_PORT / HEALTH_HOST   default 8095 on 0.0.0.0 inside the container; publish it as 127.0.0.1:8095 only
import http from 'node:http';
import { createBridge } from './bridge-core.mjs';

const cloud = process.env.HELMIAN_CLOUD || 'https://helmian.cloud';
const bridgeToken = String(process.env.HELMIAN_ENVOY_BRIDGE_TOKEN ?? '').trim();
const discordToken = String(process.env.DISCORD_BOT_TOKEN ?? '').trim();
const stateDir = process.env.STATE_DIR || '/data';
const log = (...a) => console.log(new Date().toISOString(), '[discord-bridge]', ...a);

const health = { discord: discordToken ? 'connecting' : 'not_configured', cloud: bridgeToken ? 'unknown' : 'not_configured', botUser: null, guilds: 0, inviteUrl: null };
const bridge = bridgeToken ? createBridge({ cloud, token: bridgeToken, stateDir, log }) : null;

http.createServer((req, res) => {
  if (req.url !== '/healthz') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, ...health, links: bridge?.links.length ?? 0, stats: bridge?.stats ?? null }));
}).listen(Number(process.env.HEALTH_PORT || 8095), process.env.HEALTH_HOST || '0.0.0.0');

async function main() {
  if (!bridge) { log('HELMIAN_ENVOY_BRIDGE_TOKEN is not set; idle.'); return; }
  await bridge.load();
  try { await bridge.refreshLinks(); health.cloud = 'ok'; log(`cloud ok, ${bridge.links.length} linked channel(s)`); }
  catch (e) { health.cloud = `error: ${e.message}`; log('cloud check failed:', e.message); }
  if (!discordToken) { log('DISCORD_BOT_TOKEN is not set; waiting. Add it to app.env and restart.'); return; }

  const { Client, GatewayIntentBits, Partials, PermissionFlagsBits, ChannelType } = await import('discord.js');
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildWebhooks], partials: [Partials.Channel] });

  const canManage = async (msg) => {
    try { return Boolean(msg.member?.permissionsIn(msg.channel).has(PermissionFlagsBits.ManageChannels)); } catch { return false; }
  };
  const getWebhook = async (channelId, cache) => {
    if (cache[channelId]) return cache[channelId];
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return null;
    const existing = (await channel.fetchWebhooks().catch(() => null))?.find((w) => w.owner?.id === client.user.id && w.token);
    const hook = existing ?? await channel.createWebhook({ name: 'Helmian', reason: 'Helmian Envoy mirror' });
    cache[channelId] = { id: hook.id, token: hook.token };
    await bridge.save();
    return cache[channelId];
  };

  client.on('ready', () => {
    health.discord = 'ready'; health.botUser = client.user.tag; health.guilds = client.guilds.cache.size;
    health.inviteUrl = `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot&permissions=${(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory | PermissionFlagsBits.ManageWebhooks).toString()}`;
    log(`gateway ready as ${client.user.tag} in ${health.guilds} server(s)`);
  });
  client.on('guildCreate', () => { health.guilds = client.guilds.cache.size; });
  client.on('messageCreate', (msg) => { bridge.onDiscordMessage(msg, { canManage }).catch((e) => { bridge.stats.errors += 1; bridge.stats.lastError = e.message; log('inbound failed:', e.message); }); });
  client.on('error', (e) => log('gateway error:', e.message));
  client.on('shardDisconnect', () => { health.discord = 'reconnecting'; });
  client.on('shardResume', () => { health.discord = 'ready'; });
  await client.login(discordToken);

  setInterval(() => { bridge.refreshLinks().then(() => { health.cloud = 'ok'; }).catch((e) => { health.cloud = `error: ${e.message}`; }); }, 30_000).unref();
  let busy = false;
  setInterval(async () => {
    if (busy || health.discord !== 'ready' || !bridge.links.length) return;
    busy = true;
    try { await bridge.pumpOutbound({ getWebhook }); }
    catch (e) { bridge.stats.errors += 1; bridge.stats.lastError = e.message; log('outbound failed:', e.message); }
    finally { busy = false; }
  }, 2000);
}

main().catch((e) => { log('fatal:', e.message); process.exitCode = 1; });
process.on('SIGTERM', () => process.exit(0));
