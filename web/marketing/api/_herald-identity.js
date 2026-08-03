import { httpError, validId } from './_herald-core.js';
import { createClerkAccountVerifier } from './_herald-clerk.js';

export const ACCOUNT_IDENTITY_STATES = Object.freeze({
  UNCONFIGURED: 'unconfigured',
  SIGNED_OUT: 'signed-out',
  VERIFIED: 'verified',
  UNAVAILABLE: 'unavailable',
});

const PAIRING_ONLY_ACCOUNT = Object.freeze({
  state: ACCOUNT_IDENTITY_STATES.UNCONFIGURED,
  provider: null,
  subject: null,
  displayName: null,
});

// Account verification is an injected boundary. Clerk verification happens on
// the server only; when its full configuration is absent this resolver remains
// explicitly unconfigured and never infers an account from pairing or headers.
export function createAccountIdentityResolver({
  verifyAccount,
  configurationState = typeof verifyAccount === 'function' ? 'ready' : 'unconfigured',
} = {}) {
  if (verifyAccount !== undefined && typeof verifyAccount !== 'function') {
    throw new TypeError('verifyAccount must be a server-side verifier.');
  }

  return Object.freeze({
    configured: typeof verifyAccount === 'function',
    configurationState,
    async resolve(request) {
      if (!verifyAccount) return PAIRING_ONLY_ACCOUNT;
      const value = await verifyAccount(request);
      if (!value) {
        return Object.freeze({
          state: ACCOUNT_IDENTITY_STATES.SIGNED_OUT,
          provider: null,
          subject: null,
          displayName: null,
        });
      }
      const provider = cleanId(value.provider);
      const subject = cleanId(value.subject);
      if (!provider || !subject) throw new Error('Verified account identity is invalid.');
      return Object.freeze({
        state: ACCOUNT_IDENTITY_STATES.VERIFIED,
        provider,
        subject,
        displayName: cleanText(value.displayName, 80),
      });
    },
  });
}

export const clerkAccountVerifier = createClerkAccountVerifier();
export const accountIdentityResolver = createAccountIdentityResolver({
  verifyAccount: clerkAccountVerifier.configured ? clerkAccountVerifier.verify : undefined,
  configurationState: clerkAccountVerifier.state,
});

export async function resolveAccountForRequest(resolver, request) {
  const account = await resolver.resolve(request);
  if (resolver.configured && account.state !== ACCOUNT_IDENTITY_STATES.VERIFIED) {
    throw httpError(401, 'account_denied', 'Sign in with the enrolled Helmian account.');
  }
  return account;
}

export async function requireVerifiedAccount(resolver, request) {
  assertAccountIdentityConfigured(resolver);
  const account = await resolver.resolve(request);
  if (account.state !== ACCOUNT_IDENTITY_STATES.VERIFIED) {
    throw httpError(401, 'account_denied', 'Sign in with your Helmian account.');
  }
  return account;
}

export function assertAccountIdentityConfigured(resolver) {
  if (resolver?.configured) return;
  throw httpError(503, 'account_not_configured',
    resolver?.configurationState === 'misconfigured'
      ? 'Helmian account sign-in configuration is incomplete.'
      : 'Helmian account sign-in is not configured.');
}

export function publicDeviceIdentity(device) {
  const deviceId = validId(device?.device_id) ? device.device_id : null;
  return Object.freeze({
    state: deviceId ? 'paired' : 'unknown',
    deviceId,
    displayName: cleanText(device?.display_name, 60),
    expiresAt: safeDate(device?.expires_at),
    scopes: Array.isArray(device?.scopes)
      ? device.scopes.filter((scope) => typeof scope === 'string').slice(0, 16)
      : [],
  });
}

export function publicTransportStatus(device, { realtimeConfigured = false } = {}) {
  return Object.freeze({
    adapter: 'same-origin-secure-polling',
    realtime: false,
    realtimeAvailable: realtimeConfigured === true,
    realtimeProvider: realtimeConfigured === true ? 'ably-token-service' : 'not-configured',
    credentialMode: 'http-only-device-cookie',
    desktopState: 'online',
    desktopLastSeenAt: safeDate(device?.last_desktop_seen_at),
  });
}

function cleanId(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9._:@/-]{1,128}$/.test(text) ? text : null;
}

function cleanText(value, maxLength) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, maxLength) : null;
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
