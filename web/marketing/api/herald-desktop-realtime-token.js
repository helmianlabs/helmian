import {
  bearer, fail, readJson, sendJson, validateNonce, validId,
} from './_herald-core.js';
import {
  authorizeDesktopRealtimeSession, authorizeRegisteredDesktop,
} from './_herald-account-store.js';
import {
  accountIdentityResolver, assertAccountIdentityConfigured,
} from './_herald-identity.js';
import {
  createDesktopSessionTokenRequest, tokenTtlForDesktopSession,
} from './_herald-realtime.js';

export function createHeraldDesktopRealtimeTokenHandler({
  accountResolver = accountIdentityResolver,
  authorizeDesktopFn = authorizeRegisteredDesktop,
  authorizeSessionFn = authorizeDesktopRealtimeSession,
  apiKey = () => process.env.ABLY_API_KEY,
  now = Date.now,
} = {}) {
  return async function handler(request, response) {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
      return;
    }
    try {
      assertAccountIdentityConfigured(accountResolver);
      const body = await readJson(request);
      const desktopId = String(body?.desktopId ?? '');
      const sessionId = String(body?.sessionId ?? '');
      if (!validId(desktopId) || !desktopId.startsWith('desktop_') || !validId(sessionId)) {
        sendJson(response, 400, {
          error: 'invalid_realtime_identity',
          message: 'Registered Desktop session identity is invalid.',
        });
        return;
      }
      await authorizeDesktopFn({
        desktopId,
        token: bearer(request),
        nonce: validateNonce(request.headers['x-helmian-nonce']),
      });
      const session = await authorizeSessionFn({ desktopId, sessionId });
      const timestamp = now();
      const value = createDesktopSessionTokenRequest({
        apiKey: apiKey(),
        realtimeChannel: session.realtime_channel,
        desktopId,
        grantIds: session.grants.map((grant) => grant.grant_id),
        ttl: tokenTtlForDesktopSession(session, { now: timestamp }),
        timestamp,
      });
      sendJson(response, 200, {
        provider: 'ably',
        role: 'registered-desktop',
        realtime: true,
        tokenRequest: value.tokenRequest,
        channels: value.channels,
        expiresAt: value.expiresAt,
      });
    } catch (error) { fail(response, error); }
  };
}

export default createHeraldDesktopRealtimeTokenHandler();
