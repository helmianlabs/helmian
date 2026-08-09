# Team connectors: Slack and Discord

Helmian uses one provider-neutral Team conversation pane. Slack and Discord are
sources for that pane; they are not separate chat products inside Helmian.

## Current live boundary

- The desktop asks the current-user Helmion Local Service to start authorization.
- The local service reads provider app configuration from its process environment,
  creates and validates OAuth `state`, exchanges the temporary code, and protects
  the resulting grant with Windows CurrentUser DPAPI.
- Discord returns directly to an HTTP loopback listener owned by the Local Service.
  Slack requires HTTPS, so it returns to Helmian's hosted handoff. That service
  stores only an AES-256-GCM-encrypted, ten-minute authorization code and releases
  it once to the initiating desktop. It never receives the Slack client secret and
  never exchanges or stores a Slack access/refresh token.
- The desktop receives only a provider authorization URL and redacted connection,
  workspace/server, channel, and message DTOs. It has no credential input or secret
  field and does not receive access, refresh, or bot tokens.
- Once a user has authorized an already configured provider app, the adapter can
  perform harmless reads to list available workspaces/servers and channels, then
  read up to 50 recent messages from the explicitly selected channel.
- There is no Team send command in the live pipe surface. The contract models send
  as an external write that requires an exact destination, local draft ID, SHA-256
  payload evidence, real approval ID, and idempotency key. Provider posting remains
  unavailable until that approval/audit gateway is connected.

If configuration is absent or invalid, Connect returns a small setup-needed status
and makes no provider request.

## Slack: hosted HTTPS callback and one-time desktop handoff

Slack requires OAuth redirect URLs to use HTTPS. A loopback `http://127.0.0.1`
callback is therefore not a viable Slack production flow. Deploy the source-level
handoff included in `web/marketing/api/team-oauth/slack/` before attempting to
connect Slack.

### Hosted deployment steps

1. Provision a dedicated Postgres database/role and apply
   `sql/team-oauth-handoffs.sql`.
2. Configure the hosted `web/marketing` deployment with:

   ```text
   HELMION_TEAM_OAUTH_DATABASE_URL
   HELMION_TEAM_OAUTH_ENCRYPTION_KEY
   HELMION_TEAM_OAUTH_HANDOFF_TOKEN_HASH
   ```

   `HELMION_TEAM_OAUTH_ENCRYPTION_KEY` must decode from base64url to exactly 32
   random bytes. `HELMION_TEAM_OAUTH_HANDOFF_TOKEN_HASH` is the base64url SHA-256
   hash of a separate random handoff token at least 32 characters long. The
   plaintext handoff token belongs only in the Local Service environment.
3. Deploy `web/marketing` to the intended HTTPS origin. Verify that these routes
   are live and accept only their documented methods:

   ```text
   POST https://<host>/api/team-oauth/slack/start
   GET  https://<host>/api/team-oauth/slack/callback
   POST https://<host>/api/team-oauth/slack/redeem
   ```

4. Add the exact callback URL from step 3 to the Slack app's OAuth & Permissions
   Redirect URLs. Do not configure a loopback or HTTP URL.

The hosted start/redeem calls require both the service bearer credential and a
per-request redemption proof. OAuth `state` is stored only as a hash; the code is
encrypted at rest, can be redeemed once, expires after ten minutes, and is cleared
on redemption. Edge rate limits and request-volume monitoring are still required
at deployment time.

### Slack app and Local Service steps

Create and own a Slack app outside Helmian, then configure:

1. Bot token scopes for the read foundation:
   `channels:read`, `channels:history`, `groups:read`, and `groups:history`.
   The app/bot must be a member of a channel to read history available to its token.
2. Do not add `chat:write`; this build rejects non-read scopes and has no Team send
   command.
3. Install/authorize the app in the intended workspace through Slack's normal OAuth
   page.

Set these only in the Local Service process environment (never in XAML, desktop
settings, command arguments, logs, or project files):

```text
HELMION_SLACK_CLIENT_ID
HELMION_SLACK_CLIENT_SECRET
HELMION_SLACK_HANDOFF_BASE_URI=https://<host>/api/team-oauth/slack/
HELMION_SLACK_HANDOFF_TOKEN
HELMION_SLACK_SCOPES=channels:read,channels:history,groups:read,groups:history
```

Slack reference: <https://docs.slack.dev/authentication/installing-with-oauth/>

## Discord provider-side prerequisites

Discord user OAuth alone can identify a user and list their servers, but ordinary
Discord REST channel/history access is performed by an installed bot with server
permissions. Create and own a Discord application and its bot outside Helmian, then
configure:

1. One exact OAuth redirect URL ending in `/`, for example
   `http://127.0.0.1:47824/oauth/discord/`.
2. OAuth scopes `identify guilds bot` so the user can sign in, Helmian can list the
   user's servers, and the app can be installed into the chosen server.
3. Bot permissions `View Channels` (1024) and `Read Message History` (65536), a
   combined permission value of `66560`. Server/channel overrides must also allow
   the bot to see the selected channel.
4. A service-owned bot token. It is never returned through the named pipe.
5. Enable the privileged **Message Content intent** on the app's Bot page. Helmian
   validates the current application flags before storing a connection because
   Discord otherwise returns empty message-content fields through HTTP as well as
   the Gateway.
6. Do not add `Send Messages` (2048). Helmian always requests `66560`, never marks a
   Team channel sendable, and exposes no Team send command.

Set these only in the Local Service process environment:

```text
HELMION_DISCORD_CLIENT_ID
HELMION_DISCORD_CLIENT_SECRET
HELMION_DISCORD_REDIRECT_URI
HELMION_DISCORD_BOT_TOKEN
HELMION_DISCORD_SCOPES=identify guilds bot
```

Discord reference: <https://docs.discord.com/developers/topics/oauth2>

Before a Discord connection is stored, Helmian verifies the OAuth scopes, verifies
that the bot token belongs to the configured application, verifies Message Content
intent, and finds at least one server shared by the authorizing user and bot where
the bot has both requested read permissions. Each selected channel history call is
still checked live by Discord, so channel overrides fail visibly instead of being
reported as a successful read.
