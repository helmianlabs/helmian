import { fail, sendJson, validateNonce } from './_herald-core.js';
import {
  clearControlCookie, parseControlCookie,
} from './_herald-account-core.js';
import {
  accountIdentityResolver, requireVerifiedAccount,
} from './_herald-identity.js';
import {
  createAccountControlTokenRequest, tokenTtlForAccountControl,
} from './_herald-realtime.js';
import { authorizeAccountControlGrant, consumeAccountNonce } from './_herald-account-store.js';

export function createHeraldRealtimeTokenHandler({
  authorizeGrantFn = authorizeAccountControlGrant,
  consumeAccountNonceFn = consumeAccountNonce,
  accountResolver = accountIdentityResolver,
  apiKey = () => process.env.ABLY_API_KEY,
  now = Date.now,
} = {}) {
  return async function handler(request, response) {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
      return;
    }
    try {
      const account = await requireVerifiedAccount(accountResolver, request);
      await consumeAccountNonceFn({
        account, nonce: validateNonce(request.headers['x-helmian-nonce']),
      });
      const identity = parseControlCookie(request);
      if (!identity) {
        sendJson(response, 401, {
          error: 'control_denied',
          message: 'Select an active account-owned Desktop session.',
        }, { 'set-cookie': clearControlCookie() });
        return;
      }
      const grant = await authorizeGrantFn({ account, ...identity });
      const timestamp = now();
      const value = createAccountControlTokenRequest({
        apiKey: apiKey(),
        realtimeChannel: grant.realtime_channel,
        grantId: grant.grant_id,
        ttl: tokenTtlForAccountControl(grant, { now: timestamp }),
        timestamp,
      });
      sendJson(response, 200, {
        provider: 'ably',
        role: 'account-control',
        realtime: true,
        tokenRequest: value.tokenRequest,
        channels: value.channels,
        expiresAt: value.expiresAt,
      });
    } catch (error) {
      if ([401, 404].includes(Number(error?.status))) {
        response.setHeader('set-cookie', clearControlCookie());
      }
      fail(response, error);
    }
  };
}

export default createHeraldRealtimeTokenHandler();
