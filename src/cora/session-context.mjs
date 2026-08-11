// Server-side boundaries for Cora's short-lived voice sessions.
//
// Hume sends `custom_session_id` in the message body, so it is useful as a
// conversation label but it is not an authorization credential. The CLM
// server must bind that label to the WebSocket connection that first presents
// it; otherwise another connection can join the same agent history and tool
// runtime by guessing the label.

/** Keep untrusted session labels small enough to stay cheap in memory and logs. */
// A signed AimForge bridge carries bounded tenant/user/role claims plus an
// HMAC. Keep the wire value bounded, but large enough for that compact token.
export const DEFAULT_MAX_SESSION_ID_CHARS = 2_048;

/**
 * Validate and normalize one Hume session label.
 *
 * Empty/missing labels are valid: they receive a socket-local, read-only
 * session in the server. Non-string values and control characters are not
 * valid labels, and an overlong label is refused rather than silently clipped
 * (clipping could make two distinct caller values collide).
 */
export function validateSessionId(value, {
  maxChars = DEFAULT_MAX_SESSION_ID_CHARS,
} = {}) {
  if (value === null || value === undefined || value === '') {
    return { ok: true, id: null };
  }
  if (typeof value !== 'string') {
    return { ok: false, id: null, reason: 'custom_session_id must be a string' };
  }

  const id = value.trim();
  if (!id) return { ok: true, id: null };
  const limit = Number.isInteger(maxChars) && maxChars > 0
    ? maxChars
    : DEFAULT_MAX_SESSION_ID_CHARS;
  if (id.length > limit) {
    return { ok: false, id: null, reason: `custom_session_id exceeds ${limit} characters` };
  }
  if (/[\u0000-\u001f\u007f]/u.test(id)) {
    return { ok: false, id: null, reason: 'custom_session_id contains a control character' };
  }
  return { ok: true, id };
}

/**
 * Decide whether an existing session may be used by this connection.
 *
 * A new session is allowed. Reusing it from its owner connection is allowed.
 * Reusing it from any other connection is refused, even if both connections
 * passed the socket-level credential check: the conversation history and its
 * runtime are connection-scoped authority, not shared global state.
 */
export function authorizeSessionConnection(existing, connectionId) {
  if (!existing) return { ok: true, reason: 'new session' };
  if (existing.connectionId === connectionId) {
    return { ok: true, reason: 'session owner connection' };
  }
  return {
    ok: false,
    reason: 'custom_session_id is already bound to another voice connection',
  };
}

