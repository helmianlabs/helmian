# Helmian Slack bridge

Mirrors linked Slack channels into Envoy. Runs on the Hetzner box next to the
Discord bridge, because Vercel functions cannot hold Slack's Socket Mode
websocket open.

- Slack to Envoy: every human message in a linked Slack channel is posted to
  `POST /api/admin/envoy/bridge/inbound` with `provider: 'slack'`. It shows in
  /app under the author's name with a SLACK badge carrying the Slack channel
  name. Slack redeliveries dedupe twice: a bounded seen-set here, and the
  cloud's `slack:<ts>` idempotency key as the durable backstop.
- Envoy to Slack: not in this service yet. Posting each author under their
  own name needs the bot token's `chat.postMessage`, a go-live step; the
  cloud already serves the feed (`/api/admin/envoy/bridge/outbound` excludes
  Slack-born messages so nothing echoes back). Agent replies reach Slack
  today through the signed webhook pipe (`HELMION_SLACK_WEBHOOK_URL`),
  proven 2026-10-24.
- Linking: an owner or admin presses **Link Slack** in /app and gets a code.
  Someone in the Slack channel types `helmian link CODE` (no leading slash —
  Slack eats `/…` as a slash command). Slack events carry no channel-admin
  permission bit, so the code itself is the credential: single use, expires
  after 15 minutes, stored server-side as a hash. Unlink from the same
  button in /app.

Socket Mode has no per-message HTTP signature by design: the connection is
the authentication. Only a socket opened with the app-level token receives
events; every bridge → cloud call carries the shared bridge-token bearer.
The signed HTTP pipe (`verifySlackRequest` over `HELMION_SLACK_SIGNING_SECRET`)
stays in place for the outbound webhook path.

## Environment (`/opt/helmian-slack-bridge/app.env`, mode 600)

| Name | What |
| --- | --- |
| `SLACK_APP_TOKEN` | App-level token (`xapp-…`) with `connections:write`, from the app's Basic Information → App-Level Tokens (the token named "helmian-socket"). **Its value was never recorded** — regenerate it in the Slack app settings and paste the new value here. Without it the bridge idles and `/healthz` reports `slack: not_configured`. |
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-…`) from the same app's OAuth & Permissions page. Optional: powers author display names (`users.info`) and the in-Slack link replies. Without it, inbound still mirrors with author name "Slack member". |
| `HELMIAN_ENVOY_BRIDGE_TOKEN` | Shared secret, at least 32 chars. Same value as the Vercel env var of that name (and the Discord bridge's). |
| `HELMIAN_CLOUD` | Optional, default `https://helmian.cloud`. |

Vercel also takes `HELMION_SLACK_APP_ID` (the public app id, `A…`) so /app can
report the Slack bot status next to the Discord one.

## Slack application settings

App "Helmian" (`A0CBUCYTVNW`), workspace HELMIAN (`T0BP40EFJ1W`):

1. **Socket Mode: ON** (Settings → Socket Mode) with an app-level token
   (`connections:write`).
2. **Event Subscriptions: ON**, subscribed bot event `message.channels`
   (add `message.groups` too if private channels should mirror).
3. Bot scopes: `channels:history`, `channels:read`, `users:read`, and
   `chat:write` (link replies now, per-author outbound later).
4. The app must be **in the channel** it mirrors — invite `@Helmian` to
   `#all-helmian` (`C0BN7LCK946`).

## Deploy

Target on the Hetzner box: `/opt/helmian-slack-bridge/` (not live yet):

- `src/` holds this folder (copy with `tar -C slack-bridge --exclude node_modules -czf - . | ssh root@HOST 'tar -C /opt/helmian-slack-bridge/src -xzf -'`).
- `app.env` holds the env above, mode 600.
- No state directory: the bridge keeps only an in-memory dedupe set; the
  cloud's idempotency key is the durable dedupe.
- Run: `docker build -t helmian-slack-bridge /opt/helmian-slack-bridge/src` and
  `docker run -d --name helmian-slack-bridge --restart unless-stopped --env-file /opt/helmian-slack-bridge/app.env -p 127.0.0.1:8096:8096 helmian-slack-bridge`
  (8095 is the Discord bridge, 8090 Hands, 8096 is free).

Zero npm dependencies: Socket Mode runs on Node 22's built-in WebSocket.

## Tests

`npm run test:slack-bridge` from the repo root.
