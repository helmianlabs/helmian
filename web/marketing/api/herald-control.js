import { fail, sendJson, validateNonce } from './_herald-core.js';
import {
  clearControlCookie, parseControlCookie,
} from './_herald-account-core.js';
import {
  authorizeAccountControlGrant, consumeAccountNonce, revokeAccountControlGrant,
} from './_herald-account-store.js';
import {
  accountIdentityResolver, requireVerifiedAccount,
} from './_herald-identity.js';
import { isAblyConfigured } from './_herald-realtime.js';

export function createHeraldControlHandler({
  accountResolver = accountIdentityResolver,
  store = {
    authorize: authorizeAccountControlGrant,
    consumeAccountNonce,
    revoke: revokeAccountControlGrant,
  },
} = {}) {
  return async function handler(request, response) {
    try {
      const account = await requireVerifiedAccount(accountResolver, request);
      const identity = parseControlCookie(request);
      if (!identity) {
        sendJson(response, 401, {
          error: 'control_denied', message: 'Select an active account-owned Desktop session.',
        }, { 'set-cookie': clearControlCookie() });
        return;
      }
      if (request.method === 'GET') {
        const grant = await store.authorize({ account, ...identity });
        sendJson(response, 200, { selected: true, session: publicSelectedSession(grant) });
        return;
      }
      if (request.method === 'DELETE') {
        await store.consumeAccountNonce({
          account, nonce: validateNonce(request.headers['x-helmian-nonce']),
        });
        await store.revoke({ account, grantId: identity.grantId });
        sendJson(response, 200, { selected: false }, { 'set-cookie': clearControlCookie() });
        return;
      }
      sendJson(response, 405, { error: 'method_not_allowed' }, { allow: 'GET, DELETE' });
    } catch (error) {
      if (Number(error?.status) === 401) response.setHeader('set-cookie', clearControlCookie());
      fail(response, error);
    }
  };
}

function publicSelectedSession(value) {
  return Object.freeze({
    desktop: { id: value.desktop_id, name: value.display_name },
    project: { id: value.project_id, name: value.project_name },
    session: { id: value.session_id, name: value.session_name, state: value.session_state },
    agent: value.agent_id ? {
      id: value.agent_id, name: value.agent_name, state: value.agent_state,
    } : null,
    guard: { state: value.guard_state, detail: value.guard_detail ?? null },
    lastSeenAt: new Date(value.session_last_seen_at).toISOString(),
    transport: isAblyConfigured() ? 'ably-scoped-realtime' : 'unavailable',
  });
}

export default createHeraldControlHandler();
