import {
  fail, hashSecret, readJson, sendJson, validateNonce, validId,
} from './_herald-core.js';
import {
  CONTROL_GRANT_TTL_MS, controlCookie, newControlGrantIdentity,
  normalizeSessionReference,
} from './_herald-account-core.js';
import {
  consumeAccountNonce, createAccountControlGrant, listAccountDesktops, revokeAccountDesktop,
} from './_herald-account-store.js';
import {
  accountIdentityResolver, requireVerifiedAccount,
} from './_herald-identity.js';
import { isAblyConfigured } from './_herald-realtime.js';

export function createHeraldDesktopsHandler({
  accountResolver = accountIdentityResolver,
  store = {
    createGrant: createAccountControlGrant,
    consumeAccountNonce,
    list: listAccountDesktops,
    revoke: revokeAccountDesktop,
  },
  now = Date.now,
  newGrant = newControlGrantIdentity,
} = {}) {
  return async function handler(request, response) {
    try {
      const account = await requireVerifiedAccount(accountResolver, request);
      if (request.method === 'GET') {
        const desktops = await store.list(account);
        sendJson(response, 200, { desktops });
        return;
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'method_not_allowed' }, { allow: 'GET, POST' });
        return;
      }
      const body = await readJson(request);
      await store.consumeAccountNonce({
        account, nonce: validateNonce(request.headers['x-helmian-nonce']),
      });
      const action = String(body?.action ?? '');

      if (action === 'select') {
        const reference = normalizeSessionReference(body);
        const identity = newGrant();
        const expiresAt = new Date(now() + CONTROL_GRANT_TTL_MS);
        const selected = await store.createGrant({
          account,
          ...reference,
          grantId: identity.grantId,
          tokenHash: hashSecret(identity.token),
          expiresAt,
        });
        sendJson(response, 201, {
          selected: true,
          desktopId: selected.desktop_id,
          sessionId: selected.session_id,
          expiresAt: new Date(selected.expires_at).toISOString(),
          transport: isAblyConfigured() ? 'ably-scoped-realtime' : 'unavailable',
        }, {
          'set-cookie': controlCookie(
            identity.grantId,
            identity.token,
            Math.floor(CONTROL_GRANT_TTL_MS / 1000),
          ),
        });
        return;
      }

      if (action === 'revoke' && validId(body.desktopId) && body.confirmed === true) {
        await store.revoke({ account, desktopId: body.desktopId });
        sendJson(response, 200, { revoked: true, desktopId: body.desktopId });
        return;
      }

      sendJson(response, 404, {
        error: 'action_not_available',
        message: 'That account Desktop action is not available.',
      });
    } catch (error) { fail(response, error); }
  };
}

export default createHeraldDesktopsHandler();
