# Helmian Discord bridge

Mirrors Envoy channels to Discord channels and back. Runs on the Hetzner box
next to Guard and Hands, because Vercel functions cannot hold the Discord
gateway socket open.

- Discord to Envoy: the bot reads messages in linked channels and posts them to
  `POST /api/admin/envoy/bridge/inbound`. They show in /app with a DISCORD tag.
- Envoy to Discord: the bridge polls `/api/admin/envoy/bridge/outbound` every
  2 s and posts through a channel webhook, so each person and each agent
  (Maestro, Claude, ChatGPT, Grok, Gemini) shows under its own name and avatar.
  Mentions are disabled on everything it posts (`allowed_mentions: {parse: []}`).
- Linking: an owner or admin presses **Link Discord** in /app and gets a code.
  Someone with Manage Channels in that Discord channel sends `helmian link CODE`.
  Codes are single use and expire after 15 minutes. Unlink from the same button.

No provider keys live here or in Vercel. Agents run on the user's PC bridge
(`bin/pc-bridge.mjs`) with keys from the PC's vault.

## Environment (`/opt/helmian-discord-bridge/app.env`, mode 600)

| Name | What |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Bot token from the Discord developer portal. Without it the bridge idles and `/healthz` reports `discord: not_configured`. |
| `HELMIAN_ENVOY_BRIDGE_TOKEN` | Shared secret, at least 32 chars. Same value as the Vercel env var of that name. |
| `HELMIAN_CLOUD` | Optional, default `https://helmian.cloud`. |

Vercel also takes `HELMIAN_DISCORD_CLIENT_ID` (the public application id) so the
Link Discord dialog can show an "Add to Discord" invite link.

## Discord application settings

1. https://discord.com/developers/applications → New Application → Bot.
2. Turn on **Message Content Intent** (Privileged Gateway Intents).
3. Reset Token → copy it into `app.env` as `DISCORD_BOT_TOKEN`.
4. Copy the Application ID into Vercel as `HELMIAN_DISCORD_CLIENT_ID`.

Invite permissions: View Channel, Send Messages, Read Message History,
Manage Webhooks (`536939520`).

## Deploy

Live on the Hetzner box at `/opt/helmian-discord-bridge/`:

- `src/` holds this folder (copy with `tar -C discord-bridge --exclude node_modules -czf - . | ssh root@HOST 'tar -C /opt/helmian-discord-bridge/src -xzf -'`).
- `app.env` holds the env above, mode 600.
- `data/` holds the state file (webhook ids, poll cursor).
- `run.sh` builds the image and recreates the container (`helmian-discord-bridge`,
  `127.0.0.1:8095`, restart unless-stopped), then prints `/healthz`.

Run `run.sh` again after any change to `app.env`; `docker restart` does not re-read an env file.

## Discord as MCP tools (`mcp-server.mjs` + `mcp-core.mjs`)

The mirror is also an MCP tool server Helmian agents can call — the first
real tool connector (connector-truth bite 2). Same plumbing, no second bot,
no new Discord token: reads go through the cloud bridge routes with the
bridge's own `HELMIAN_ENVOY_BRIDGE_TOKEN`; an approved post goes out through
the bridge's channel webhook (the cached webhook in the state file, read
read-only).

Tools:

| Tool | Mutating | What it does |
| --- | --- | --- |
| `discord_list_channels` | no | The linked channels: Discord channel + server ids, the Envoy channel each mirrors, the agents seated in it. |
| `discord_read_messages` | no | Recent messages of one linked channel from the mirror feed — the Helmian half of the conversation (Discord-origin posts are excluded by the cloud's anti-echo filter). |
| `discord_post_message` | yes | Post to a linked channel. Carries the Executive Guard outcome surface of the hands pattern: the call is put to Guard first, the result reports the outcome, and nothing posts without a Guard allow. |

Run it (HTTP, bearer `HELMIAN_DISCORD_MCP_TOKEN` — a Helmian-issued token
for this server, never a Discord credential; the entry refuses to start
without it), or `--stdio` for a local launch:

```
HELMIAN_DISCORD_MCP_TOKEN=... node mcp-server.mjs            # 127.0.0.1:8097/mcp, /healthz
HELMIAN_ENVOY_BRIDGE_TOKEN=... node mcp-server.mjs --stdio
```

Guard posture today: no Guard client is wired for this service yet, so the
core runs fail-closed — `discord_post_message` reports "Executive Guard is
not live yet" and posts nothing. Wiring a real authorizer (a Guard client
for the discord-mcp identity) is a placement step. The plugin declaration
lives in `plugin/` (`.mcp.json` names a token SOURCE only) for registration
in `tool_connections` and a real `tools/list` probe receipt.

## Tests

`npm run test:discord-bridge` from the repo root; the MCP tools are covered
by `test/discord-mcp-tools.test.mjs` in root `npm test`.
