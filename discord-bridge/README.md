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

```sh
rsync -a --exclude node_modules discord-bridge/ root@HOST:/opt/helmian-discord-bridge/src/
ssh root@HOST 'cd /opt/helmian-discord-bridge/src && docker build -t helmian-discord-bridge:$(git rev-parse --short HEAD 2>/dev/null || date +%s) -t helmian-discord-bridge:latest . &&
  docker rm -f helmian-discord-bridge; docker run -d --name helmian-discord-bridge --restart unless-stopped \
  --env-file /opt/helmian-discord-bridge/app.env -v /opt/helmian-discord-bridge/data:/data \
  -p 127.0.0.1:8095:8095 helmian-discord-bridge:latest'
curl -s http://127.0.0.1:8095/healthz   # on the box
```

After changing `app.env`, restart with `docker restart helmian-discord-bridge`
(an env file is read at container start; use `docker rm -f` + `docker run` if
the token was added for the first time and the container predates the file).

## Tests

`npm run test:discord-bridge` from the repo root.
