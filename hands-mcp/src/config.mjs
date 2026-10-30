// Configuration from the environment. Secrets live in /opt/helmian-hands-mcp/app.env
// (chmod 600) on the Hetzner box, never in git and never in Vercel.
//
// No provider API keys here (019 contract): this server only routes and gates.
//
// Required:
//   PUBLIC_URL        canonical https origin, no trailing slash (OAuth issuer + resource)
//   AUTH_PASSPHRASE   what Troy types on the consent page
// Optional:
//   SPOKE_TOKEN       a fixed bearer for the PC spoke (>= 32 chars). Normally unset:
//                     the PC pairs with `node bin/hands-spoke.mjs pair` (passphrase)
//                     and gets its own token, stored hashed in STATE_DIR.
//   HANDS_ENABLED     'true' to answer tool calls at all (kill switch; default false)
//   HANDS_HOLD_OPEN_WAIT_MS  how long a mutating call that is waiting on a human
//                     Guard decision stays open before it degrades to the
//                     pending + resume_action answer (default 840000 = 14 min,
//                     inside the 15-minute approval TTL)
//   GUARD_URL         Executive Guard base URL. Unset = Guard not live = every
//                     mutating tool is denied (fail closed).
//   GUARD_DEVICE_TOKEN  this server's device token at Guard
//   GUARD_PUBLIC_KEY_X  pinned Ed25519 public key (JWK "x", base64url) that signs decisions
//   GUARD_DEVICE_ID     the device id Guard binds decisions to (default 'hands-mcp')
//   STATE_DIR         where oauth-state.json and audit.jsonl live (default /data)
//   PORT              default 8090

function required(env, name) {
  const v = env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing required environment variable: ${name}`);
  return String(v).trim();
}

export function loadConfig(env = process.env) {
  const spokeToken = (env.SPOKE_TOKEN || '').trim() || null;
  if (spokeToken && spokeToken.length < 32) throw new Error('SPOKE_TOKEN must be at least 32 characters');
  const guardUrl = (env.GUARD_URL || '').trim().replace(/\/+$/, '') || null;
  return Object.freeze({
    publicUrl: required(env, 'PUBLIC_URL').replace(/\/+$/, ''),
    passphrase: required(env, 'AUTH_PASSPHRASE'),
    spokeToken,
    pairCodeIssuerToken: (env.PAIR_CODE_ISSUER_TOKEN || '').trim().length >= 32 ? env.PAIR_CODE_ISSUER_TOKEN.trim() : null,
    handsEnabled: String(env.HANDS_ENABLED || '').toLowerCase() === 'true',
    // 40 s default: ChatGPT's connector/code-mode call times out long before
    // 14 minutes, so an unanswered Guard approval used to surface as an opaque
    // "Code Mode execution timed out". After 40 s the call now returns a clear
    // "waiting for approval, call resume_action" message instead.
    holdOpenWaitMs: Number(env.HANDS_HOLD_OPEN_WAIT_MS || 40000) || 40000,
    guard: Object.freeze({
      url: guardUrl,
      deviceToken: (env.GUARD_DEVICE_TOKEN || '').trim() || null,
      publicKeyX: (env.GUARD_PUBLIC_KEY_X || '').trim() || null,
      deviceId: (env.GUARD_DEVICE_ID || 'hands-mcp').trim(),
      timeoutMs: Number(env.GUARD_TIMEOUT_MS || 5000),
      approvalWaitMs: Number(env.GUARD_APPROVAL_WAIT_MS || 45000),
    }),
    stateDir: (env.STATE_DIR || '/data').replace(/\/+$/, ''),
    port: parseInt(env.PORT || '8090', 10),
    mcpPath: '/mcp',
  });
}

export const AUTH_CODE_TTL_SECONDS = 600;
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
export const SCOPES = Object.freeze(['hands.read', 'hands.act']);
