// Envoy realtime push for the PC bridge (v2): Ably instead of 5s polling.
//
// Two pieces:
//   1. publishEnvoyMessage: fire-and-forget REST publish after a message is
//      durably stored (hooked into envoy-chat.mjs appendMessage). Never throws.
//   2. POST /api/admin/envoy/ably-token: mints a subscribe-only Ably token
//      request for the bridge (device-token auth), following the Herald
//      signed-token-request pattern (web/marketing/api/_herald-realtime.js).
//
// The bridge subscribes; it still POSTs replies over HTTPS as before. The
// cloud reads the Ably key from the ABLY_API_KEY env var (same var Herald
// uses). Everything no-ops gracefully when the key is unset.

import { createHmac, randomBytes } from 'node:crypto';
import { handleRunnerPresenceRoute } from './runner-presence.mjs';
import { handleAgentSessionsRoute } from './agent-sessions.mjs';

export const ENVOY_ABLY_TOKEN_PATH = '/api/admin/envoy/ably-token';
export const ENVOY_ABLY_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 min; the bridge client auto-renews
const ENVOY_ABLY_REST = 'https://rest.ably.io';

// Ably channel names: keep alphanumerics plus : _ . - ; anything else
// becomes a dash so a tenant id can never break the name.
export function envoyChannelName(tenantId, channelId) {
  const safe = (value) => String(value ?? '').replace(/[^A-Za-z0-9:_.-]/g, '-').slice(0, 200);
  return `envoy:${safe(tenantId)}:${safe(channelId)}`;
}

export function envoyChannelPattern(tenantId) {
  const safe = String(tenantId ?? '').replace(/[^A-Za-z0-9:_.-]/g, '-').slice(0, 200);
  return `envoy:${safe}:*`;
}

export function parseAblyApiKey(value) {
  const match = String(value ?? '').trim().match(
    /^([A-Za-z0-9_-]{1,80}\.[A-Za-z0-9_-]{1,80}):([A-Za-z0-9_-]{16,160})$/,
  );
  if (!match) {
    const error = new Error('ABLY_API_KEY is not configured');
    error.status = 503;
    throw error;
  }
  return { keyName: match[1], keySecret: match[2] };
}

export function ablyConfigured(ablyKey = process.env.ABLY_API_KEY) {
  try { parseAblyApiKey(ablyKey); return true; }
  catch { return false; }
}

// Fire-and-forget publish of a stored envoy message to the bridge channel.
// Contract: never throws. Returns { published: true, channel } or
// { published: false, reason }.
export async function publishEnvoyMessage({
  tenantId,
  channelId,
  message,
  ablyKey = process.env.ABLY_API_KEY,
  fetchImpl = fetch,
  log = null,
} = {}) {
  let keyName;
  let keySecret;
  try {
    ({ keyName, keySecret } = parseAblyApiKey(ablyKey));
  } catch {
    return { published: false, reason: 'ably_not_configured' };
  }
  const channel = envoyChannelName(tenantId, channelId);
  const data = {
    id: String(message?.id ?? ''),
    channelId: String(channelId ?? ''),
    authorKind: String(message?.authorKind ?? ''),
    authorSubject: String(message?.authorSubject ?? ''),
    body: String(message?.body ?? ''),
    createdAt: message?.createdAt ?? message?.created_at ?? null,
  };
  try {
    const res = await fetchImpl(`${ENVOY_ABLY_REST}/channels/${encodeURIComponent(channel)}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${keyName}:${keySecret}`, 'utf8').toString('base64')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'message', data }),
    });
    if (!res?.ok) {
      log?.(`envoy ably publish failed: http ${res?.status ?? 'unknown'}`);
      return { published: false, reason: `http_${res?.status ?? 'unknown'}` };
    }
    return { published: true, channel };
  } catch (err) {
    log?.(`envoy ably publish error: ${err?.message ?? err}`);
    return { published: false, reason: 'error' };
  }
}

// Signed Ably token request for the bridge: subscribe-only on this tenant's
// envoy channels. The bridge never publishes via Ably (replies go over
// HTTPS), so no publish capability is granted. Same HMAC-SHA256 scheme as
// the Herald token service.
export function createBridgeTokenRequest({
  ablyKey = process.env.ABLY_API_KEY,
  tenantId,
  subject = null,
  channelId = null,
  ttl = ENVOY_ABLY_TOKEN_TTL_MS,
  timestamp = Date.now(),
  nonce = randomBytes(24).toString('base64url'),
} = {}) {
  const { keyName, keySecret } = parseAblyApiKey(ablyKey); // throws 503 when unset
  const safeTtl = Number(ttl);
  const safeTimestamp = Number(timestamp);
  if (!Number.isSafeInteger(safeTtl) || safeTtl < 30_000 || safeTtl > ENVOY_ABLY_TOKEN_TTL_MS) {
    throw new TypeError('Ably token TTL is invalid.');
  }
  if (!Number.isSafeInteger(safeTimestamp) || safeTimestamp < 1) {
    throw new TypeError('Ably token timestamp is invalid.');
  }
  if (!/^[A-Za-z0-9_-]{16,160}$/.test(String(nonce ?? ''))) {
    throw new TypeError('Ably token nonce is invalid.');
  }
  const pattern = envoyChannelPattern(tenantId);
  const capability = JSON.stringify({ [pattern]: ['subscribe'] });
  const clientId = subject
    ? `pc-bridge:${String(subject).replace(/[^A-Za-z0-9:_.-]/g, '-').slice(0, 120)}`
    : 'pc-bridge';
  const signText = `${keyName}\n${safeTtl}\n${capability}\n${clientId}\n${safeTimestamp}\n${nonce}\n`;
  const mac = createHmac('sha256', keySecret).update(signText, 'utf8').digest('base64');
  return Object.freeze({
    tokenRequest: Object.freeze({ keyName, ttl: safeTtl, capability, clientId, timestamp: safeTimestamp, nonce, mac }),
    channel: channelId ? envoyChannelName(tenantId, channelId) : pattern,
    channelPattern: pattern,
    expiresAt: new Date(safeTimestamp + safeTtl).toISOString(),
  });
}

// Route delegate: POST /api/admin/envoy/ably-token (device-token auth via
// the existing activeTenantActor, same as the envoy paths). Also delegates
// /api/admin/envoy/runner/presence to runner-presence.mjs: live-admin.mjs is
// frozen at the push size limit, so new envoy sub-routes hang off this hook.
// Returns false when the request is not ours.
export async function handleEnvoyAblyRoute({
  request,
  response,
  requestUrl,
  activeTenantActor,
  send,
  TenantAuthorizationError,
  readJson,
  ablyKey = process.env.ABLY_API_KEY,
  sessionIdentity,
} = {}) {
  // Signup: must run before tenant checks (new users have no tenant yet)
  if (requestUrl?.pathname === '/api/signup' || requestUrl?.pathname === '/api/admin/signup') {
    const { createSignupHandler } = await import('./signup.mjs');
    const handler = createSignupHandler();
    await handler(request, response);
    return true;
  }
  // User profile (nickname, avatar): authenticated, before tenant checks
  if (requestUrl?.pathname === '/api/profile' || requestUrl?.pathname === '/api/admin/profile') {
    const { createProfileHandler } = await import('./user-profile.mjs');
    const handler = createProfileHandler(sessionIdentity ? { getIdentity: () => sessionIdentity } : {});
    await handler(request, response);
    return true;
  }
  // User-level OAuth (Gemini/Google): token goes to browser, not cloud storage
  if (requestUrl?.pathname?.startsWith('/api/provider-oauth/')) {
    const { handleUserOAuthRoute } = await import('./user-oauth.mjs');
    if (await handleUserOAuthRoute({ request, response, requestUrl, send })) return true;
  }
  if (await handleRunnerPresenceRoute({ request, response, requestUrl, activeTenantActor, send, TenantAuthorizationError, readJson })) return true;
  if (await handleAgentSessionsRoute({ request, response, requestUrl, activeTenantActor, send, TenantAuthorizationError })) return true;
  if (request?.method !== 'POST' || requestUrl?.pathname !== ENVOY_ABLY_TOKEN_PATH) return false;
  const membershipError = (error) => error?.status === 403 || error instanceof TenantAuthorizationError;
  try {
    const actor = await activeTenantActor(request);
    if (!ablyConfigured(ablyKey)) {
      send(response, 503, JSON.stringify({ valid: false, code: 'ENVOY_ABLY_NOT_CONFIGURED' }));
      return true;
    }
    let channelId = null;
    try { channelId = (await readJson(request))?.channelId ?? null; } catch { /* body is optional */ }
    const token = createBridgeTokenRequest({ ablyKey, tenantId: actor.tenantId, subject: actor.subject, channelId });
    send(response, 200, JSON.stringify({ valid: true, ...token }));
  } catch (error) {
    const status = membershipError(error) ? 403 : (error?.status === 503 ? 503 : 400);
    const code = membershipError(error) ? 'ENVOY_MEMBERSHIP_REQUIRED'
      : (error?.status === 503 ? 'ENVOY_ABLY_NOT_CONFIGURED' : 'ENVOY_ABLY_TOKEN_FAILED');
    send(response, status, JSON.stringify({ valid: false, code }));
  }
  return true;
}
