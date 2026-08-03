import { createHmac, randomBytes } from 'node:crypto';
import { httpError, validId } from './_herald-core.js';

export const ABLY_TOKEN_TTL_MS = 5 * 60 * 1000;

export function parseAblyApiKey(value) {
  const match = String(value ?? '').trim().match(
    /^([A-Za-z0-9_-]{1,80}\.[A-Za-z0-9_-]{1,80}):([A-Za-z0-9_-]{16,160})$/,
  );
  if (!match) throw new Error('ABLY_API_KEY is not configured');
  return Object.freeze({ keyName: match[1], keySecret: match[2] });
}

export function isAblyConfigured(environment = process.env) {
  try {
    parseAblyApiKey(environment.ABLY_API_KEY);
    return true;
  } catch { return false; }
}

export function realtimeChannels(channel, deviceId) {
  if (!/^herald_[A-Za-z0-9_-]{20,80}$/.test(String(channel ?? '')) || !validId(deviceId)) {
    throw httpError(400, 'invalid_realtime_identity', 'Realtime session identity is invalid.');
  }
  const namespace = `helmian:herald:${channel}`;
  return Object.freeze({
    requests: `${namespace}:requests`,
    results: `${namespace}:device:${deviceId}:results`,
  });
}

export function accountRealtimeChannels(realtimeChannel, grantId) {
  if (!/^herald_[A-Za-z0-9_-]{20,80}$/.test(String(realtimeChannel ?? ''))
    || !/^control_[A-Za-z0-9_-]{20,80}$/.test(String(grantId ?? ''))) {
    throw httpError(400, 'invalid_realtime_identity', 'Account Remote Control identity is invalid.');
  }
  const namespace = `helmian:herald:${realtimeChannel}`;
  return Object.freeze({
    requests: `${namespace}:requests`,
    results: `${namespace}:control:${grantId}:results`,
  });
}

export function tokenTtlForDevice(device, { now = Date.now(), maximumMs = ABLY_TOKEN_TTL_MS } = {}) {
  const expiries = [device?.expires_at, device?.session_expires_at]
    .map((value) => value ? new Date(value).getTime() : Number.NaN)
    .filter(Number.isFinite);
  if (expiries.length < 2) throw httpError(401, 'realtime_denied', 'Pairing expiry is unavailable.');
  const remaining = Math.min(...expiries) - now;
  const ttl = Math.min(maximumMs, remaining);
  if (!Number.isFinite(ttl) || ttl < 30_000) {
    throw httpError(401, 'realtime_denied', 'Pairing is too close to expiry.');
  }
  return Math.floor(ttl);
}

export function createAblyTokenRequest({
  apiKey,
  channel,
  deviceId,
  ttl,
  timestamp = Date.now(),
  nonce = randomBytes(24).toString('base64url'),
} = {}) {
  const channels = realtimeChannels(channel, deviceId);
  const clientId = `herald-phone:${deviceId}`;
  return signAblyTokenRequest({
    apiKey, clientId, ttl, timestamp, nonce,
    capabilities: {
      [channels.requests]: ['publish'],
      [channels.results]: ['subscribe'],
    },
    channels,
  });
}

export function createAccountControlTokenRequest({
  apiKey,
  realtimeChannel,
  grantId,
  ttl,
  timestamp = Date.now(),
  nonce = randomBytes(24).toString('base64url'),
} = {}) {
  const channels = accountRealtimeChannels(realtimeChannel, grantId);
  return signAblyTokenRequest({
    apiKey,
    clientId: `herald-control:${grantId}`,
    ttl,
    timestamp,
    nonce,
    capabilities: {
      [channels.requests]: ['publish'],
      [channels.results]: ['subscribe'],
    },
    channels,
  });
}

export function createDesktopSessionTokenRequest({
  apiKey,
  realtimeChannel,
  desktopId,
  grantIds,
  ttl,
  timestamp = Date.now(),
  nonce = randomBytes(24).toString('base64url'),
} = {}) {
  if (!validId(desktopId) || !String(desktopId).startsWith('desktop_')) {
    throw httpError(400, 'invalid_realtime_identity', 'Registered Desktop identity is invalid.');
  }
  const safeGrantIds = [...new Set(Array.isArray(grantIds) ? grantIds : [])];
  if (safeGrantIds.length < 1 || safeGrantIds.length > 16) {
    throw httpError(409, 'realtime_not_selected',
      'No active account control grant is available for this Desktop session.');
  }
  const channelSets = safeGrantIds.map((grantId) => accountRealtimeChannels(realtimeChannel, grantId));
  const capabilities = { [channelSets[0].requests]: ['subscribe'] };
  for (const channels of channelSets) capabilities[channels.results] = ['publish'];
  return signAblyTokenRequest({
    apiKey,
    clientId: `herald-desktop:${desktopId}`,
    ttl,
    timestamp,
    nonce,
    capabilities,
    channels: Object.freeze({
      requests: channelSets[0].requests,
      results: Object.freeze(channelSets.map((channels) => channels.results)),
    }),
  });
}

export function tokenTtlForAccountControl(value, {
  now = Date.now(), maximumMs = ABLY_TOKEN_TTL_MS,
} = {}) {
  return tokenTtlForExpiries([
    value?.expires_at,
    value?.session_expires_at,
    value?.desktop_credential_expires_at,
  ], { now, maximumMs });
}

export function tokenTtlForDesktopSession(value, {
  now = Date.now(), maximumMs = ABLY_TOKEN_TTL_MS,
} = {}) {
  const grantExpiries = Array.isArray(value?.grants)
    ? value.grants.map((grant) => grant?.expires_at)
    : [];
  if (grantExpiries.length < 1) {
    throw httpError(409, 'realtime_not_selected',
      'No active account control grant is available for this Desktop session.');
  }
  return tokenTtlForExpiries([
    value?.credential_expires_at,
    value?.session_expires_at,
    ...grantExpiries,
  ], { now, maximumMs });
}

function signAblyTokenRequest({
  apiKey, clientId, ttl, timestamp, nonce, capabilities, channels,
}) {
  const { keyName, keySecret } = parseAblyApiKey(apiKey);
  const safeTtl = Number(ttl);
  const safeTimestamp = Number(timestamp);
  if (!Number.isSafeInteger(safeTtl) || safeTtl < 30_000 || safeTtl > ABLY_TOKEN_TTL_MS) {
    throw new TypeError('Ably token TTL is invalid.');
  }
  if (!Number.isSafeInteger(safeTimestamp) || safeTimestamp < 1) {
    throw new TypeError('Ably token timestamp is invalid.');
  }
  if (!/^[A-Za-z0-9_-]{16,160}$/.test(String(nonce ?? ''))) {
    throw new TypeError('Ably token nonce is invalid.');
  }

  const capability = canonicalCapability(capabilities);
  const signText = `${keyName}\n${safeTtl}\n${capability}\n${clientId}\n${safeTimestamp}\n${nonce}\n`;
  const mac = createHmac('sha256', keySecret).update(signText, 'utf8').digest('base64');
  return Object.freeze({
    tokenRequest: Object.freeze({
      keyName,
      ttl: safeTtl,
      capability,
      clientId,
      timestamp: safeTimestamp,
      nonce,
      mac,
    }),
    channels,
    expiresAt: new Date(safeTimestamp + safeTtl).toISOString(),
  });
}

function tokenTtlForExpiries(expiriesInput, { now, maximumMs }) {
  const expiries = expiriesInput
    .map((value) => value ? new Date(value).getTime() : Number.NaN)
    .filter(Number.isFinite);
  if (expiries.length !== expiriesInput.length) {
    throw httpError(401, 'realtime_denied', 'Remote Control expiry is unavailable.');
  }
  const ttl = Math.min(maximumMs, Math.min(...expiries) - now);
  if (!Number.isFinite(ttl) || ttl < 30_000) {
    throw httpError(401, 'realtime_denied', 'Remote Control is too close to expiry.');
  }
  return Math.floor(ttl);
}

export function canonicalCapability(value) {
  const normalized = {};
  for (const channel of Object.keys(value ?? {}).sort()) {
    const operations = [...new Set(Array.isArray(value[channel]) ? value[channel] : [])].sort();
    if (operations.length) normalized[channel] = operations;
  }
  return JSON.stringify(normalized);
}
