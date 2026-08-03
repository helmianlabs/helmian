import {
  bearer, fail, randomChannel, readJson, sendJson, validateNonce, validId,
} from './_herald-core.js';
import {
  SESSION_PRESENCE_TTL_MS, normalizeDesktopPresence,
} from './_herald-account-core.js';
import {
  authorizeRegisteredDesktop, stopDesktopSession, upsertDesktopSession,
} from './_herald-account-store.js';
import {
  accountIdentityResolver, assertAccountIdentityConfigured,
} from './_herald-identity.js';

export function createHeraldDesktopHandler({
  accountResolver = accountIdentityResolver,
  store = {
    authorize: authorizeRegisteredDesktop,
    stopSession: stopDesktopSession,
    upsertSession: upsertDesktopSession,
  },
  now = Date.now,
  newChannel = randomChannel,
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
      if (!validId(desktopId) || !desktopId.startsWith('desktop_')) {
        sendJson(response, 400, {
          error: 'invalid_desktop', message: 'Registered Desktop identity is invalid.',
        });
        return;
      }
      const nonce = validateNonce(request.headers['x-helmian-nonce']);
      const token = bearer(request);
      const action = String(body?.action ?? '');

      if (action === 'status') {
        const desktop = await store.authorize({ desktopId, token, nonce });
        sendJson(response, 200, {
          registered: true,
          desktopId,
          credentialExpiresAt: new Date(desktop.credential_expires_at).toISOString(),
          serverTime: new Date(now()).toISOString(),
        });
        return;
      }

      if (action === 'heartbeat') {
        const presence = normalizeDesktopPresence(body.session);
        await store.authorize({ desktopId, token, nonce });
        const expiresAt = new Date(now() + SESSION_PRESENCE_TTL_MS);
        // upsertDesktopSession only stores realtimeChannel on first insert for
        // a (desktop, session) pair. Passing a fresh channel here is still
        // correct for new session ids; reusing the same session keeps the
        // existing Ably namespace so phone grants stay aligned.
        const session = await store.upsertSession({
          desktopId,
          presence,
          realtimeChannel: newChannel(),
          expiresAt,
        });
        sendJson(response, 200, {
          registered: true,
          desktopId,
          session: publicPresence(session),
          // Desktop polls ~1–2s; advertise a short window so clients re-mint
          // Ably tokens after a new control grant is created on the phone.
          nextHeartbeatBefore: new Date(now() + 5_000).toISOString(),
        });
        return;
      }

      if (action === 'stop-session' && validId(body.sessionId)) {
        await store.authorize({ desktopId, token, nonce });
        await store.stopSession({ desktopId, sessionId: body.sessionId });
        sendJson(response, 200, { stopped: true, desktopId, sessionId: body.sessionId });
        return;
      }

      sendJson(response, 404, {
        error: 'action_not_available',
        message: 'That registered Desktop action is not available.',
      });
    } catch (error) { fail(response, error); }
  };
}

function publicPresence(row) {
  return Object.freeze({
    sessionId: row.session_id,
    project: { id: row.project_id, name: row.project_name },
    name: row.session_name,
    state: row.session_state,
    agent: row.agent_id ? {
      id: row.agent_id, name: row.agent_name, state: row.agent_state,
    } : null,
    guard: { state: row.guard_state, detail: row.guard_detail ?? null },
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  });
}

export default createHeraldDesktopHandler();
