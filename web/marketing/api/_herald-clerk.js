import { createClerkClient } from '@clerk/backend';
import { httpError } from './_herald-core.js';

export const CLERK_CONFIGURATION_STATES = Object.freeze({
  UNCONFIGURED: 'unconfigured',
  MISCONFIGURED: 'misconfigured',
  READY: 'ready',
});

export function readClerkConfiguration(environment = process.env) {
  const publishableKey = String(environment.CLERK_PUBLISHABLE_KEY ?? '').trim();
  const secretKey = String(environment.CLERK_SECRET_KEY ?? '').trim();
  const authorizedPartiesValue = String(
    environment.HELMION_HERALD_CLERK_AUTHORIZED_PARTIES ?? '',
  ).trim();
  const supplied = [publishableKey, secretKey, authorizedPartiesValue].filter(Boolean).length;
  if (supplied === 0) {
    return Object.freeze({
      state: CLERK_CONFIGURATION_STATES.UNCONFIGURED,
      configured: false,
      publishableKey: null,
      authorizedParties: [],
    });
  }

  const authorizedParties = authorizedPartiesValue.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const validParties = authorizedParties.length > 0
    && authorizedParties.every(validAuthorizedParty);
  const valid = /^pk_(?:test|live)_[A-Za-z0-9_-]{8,}\$?$/.test(publishableKey)
    && /^sk_(?:test|live)_[A-Za-z0-9_-]{8,}$/.test(secretKey)
    && validParties;
  return Object.freeze({
    state: valid ? CLERK_CONFIGURATION_STATES.READY : CLERK_CONFIGURATION_STATES.MISCONFIGURED,
    configured: valid,
    publishableKey: valid ? publishableKey : null,
    authorizedParties: valid ? Object.freeze([...authorizedParties]) : [],
  });
}

export function createClerkAccountVerifier({
  environment = process.env,
  authenticateRequest,
} = {}) {
  const configuration = readClerkConfiguration(environment);
  const secretKey = String(environment.CLERK_SECRET_KEY ?? '').trim();
  let authenticate = authenticateRequest;
  if (configuration.configured && authenticate === undefined) {
    const clerk = createClerkClient({
      publishableKey: configuration.publishableKey,
      secretKey,
    });
    authenticate = (request) => clerk.authenticateRequest(request, {
      acceptsToken: 'session_token',
      authorizedParties: configuration.authorizedParties,
    });
  }
  if (authenticate !== undefined && typeof authenticate !== 'function') {
    throw new TypeError('authenticateRequest must be a server-side Clerk verifier.');
  }

  return Object.freeze({
    ...configuration,
    async verify(incomingRequest) {
      if (!configuration.configured || !authenticate) {
        throw httpError(503, 'account_not_configured',
          'Helmian account sign-in is not configured.');
      }
      const state = await authenticate(toWebRequest(incomingRequest));
      if (state?.isAuthenticated !== true || typeof state.toAuth !== 'function') return null;
      const auth = state.toAuth();
      const subject = typeof auth?.userId === 'string' ? auth.userId.trim() : '';
      if (!/^user_[A-Za-z0-9_-]{4,120}$/.test(subject)) {
        throw httpError(401, 'account_denied', 'Clerk did not provide a valid user identity.');
      }
      return Object.freeze({ provider: 'clerk', subject, displayName: null });
    },
  });
}

function toWebRequest(request) {
  if (request instanceof Request) return request;
  const headers = new Headers();
  for (const [name, value] of Object.entries(request?.headers ?? {})) {
    if (Array.isArray(value)) headers.set(name, value.join(', '));
    else if (value !== undefined) headers.set(name, String(value));
  }
  const forwarded = String(headers.get('x-forwarded-proto') ?? '').split(',')[0].trim();
  const protocol = forwarded === 'http' ? 'http' : 'https';
  const host = headers.get('host') ?? 'helmian.vercel.app';
  const path = String(request?.url ?? '/');
  return new Request(new URL(path, `${protocol}://${host}`), {
    method: String(request?.method ?? 'GET').toUpperCase(),
    headers,
  });
}

function validAuthorizedParty(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    return url.protocol === 'https:'
      || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
  } catch { return false; }
}
