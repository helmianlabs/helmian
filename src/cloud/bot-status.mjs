// Public bot status for the Discord / Slack link surfaces. Client id /
// app id are public; the bridge token only contributes a yes/no. These
// are pure env reads with no imports, so any store or route can carry
// the status without dragging in the mesh (envoy-mesh.mjs re-exports
// them for its existing callers).

const DISCORD_INVITE_PERMISSIONS = String(1024 + 2048 + 65536 + 536870912); // view, send, history, manage webhooks
export function discordBotStatus(env = process.env) {
  const clientId = String(env.HELMIAN_DISCORD_CLIENT_ID ?? '').trim();
  const valid = /^\d{15,25}$/.test(clientId);
  return {
    configured: valid && String(env.HELMIAN_ENVOY_BRIDGE_TOKEN ?? '').length >= 32,
    inviteUrl: valid ? `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=${DISCORD_INVITE_PERMISSIONS}` : null,
  };
}

// Public bot status for the Slack link, same shape as discordBotStatus.
// The app id is public; there is no invite URL (Slack installs go through
// OAuth, a later step), so configured means "the bridge can be serving":
// a valid-looking app id plus the shared bridge token present.
export function slackBotStatus(env = process.env) {
  const appId = String(env.HELMION_SLACK_APP_ID ?? '').trim();
  const valid = /^A[A-Z0-9]{6,20}$/.test(appId);
  return {
    configured: valid && String(env.HELMIAN_ENVOY_BRIDGE_TOKEN ?? '').length >= 32,
    inviteUrl: null,
  };
}
