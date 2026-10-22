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

## Tests

`npm run test:discord-bridge` from the repo root.
