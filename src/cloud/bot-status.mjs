// Public bot status for the Discord / Slack link surfaces. Client id /
// app id are public; the bridge token only contributes a yes/no. These
// are pure env reads with no imports, so any store or route can carry
// the status without dragging in the mesh (envoy-mesh.mjs re-exports
// them for its existing callers).

// A bridge provider reads as configured when the cloud could accept
// its calls: the provider's own per-provider token
// (HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD / _SLACK) OR the shared
// HELMIAN_ENVOY_BRIDGE_TOKEN, which the provider-scoped routes still
// accept as the rotation fallback. The usable test is the gate's own
// (envoy-mesh's bridgeTokenOk): the trimmed value is at least 32
// chars — a short value configures nothing, on either name. Reading
// per provider keeps the status truthful during the rotation and
// after the shared value is retired: one provider's token never
// configures the other.
function bridgeConfigured(env, scopedName) {
  return [env[scopedName], env.HELMIAN_ENVOY_BRIDGE_TOKEN]
    .some((value) => String(value ?? '').trim().length >= 32);
}

const DISCORD_INVITE_PERMISSIONS = String(1024 + 2048 + 65536 + 536870912); // view, send, history, manage webhooks
export function discordBotStatus(env = process.env) {
  const clientId = String(env.HELMIAN_DISCORD_CLIENT_ID ?? '').trim();
  const valid = /^\d{15,25}$/.test(clientId);
  return {
    configured: valid && bridgeConfigured(env, 'HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD'),
    inviteUrl: valid ? `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=${DISCORD_INVITE_PERMISSIONS}` : null,
  };
}

// Public bot status for the Slack link, same shape as discordBotStatus.
// The app id is public; there is no invite URL (Slack installs go through
// OAuth, a later step), so configured means "the bridge can be serving":
// a valid-looking app id plus a usable bridge token (Slack's own
// per-provider value, or the shared fallback).
export function slackBotStatus(env = process.env) {
  const appId = String(env.HELMION_SLACK_APP_ID ?? '').trim();
  const valid = /^A[A-Z0-9]{6,20}$/.test(appId);
  return {
    configured: valid && bridgeConfigured(env, 'HELMIAN_ENVOY_BRIDGE_TOKEN_SLACK'),
    inviteUrl: null,
  };
}
