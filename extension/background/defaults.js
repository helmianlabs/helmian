// Shipped defaults for zero-friction Scribe setup (0.6.2).
//
// SCRIBE_DEFAULT_URL is the ONE place the hosted Scribe server address lives.
// It is a build-time constant: tools/package-guard.mjs rewrites the line below
// when given --scribe-url URL (or the HELMIAN_SCRIBE_URL environment variable).
// Users never type it; it stays editable under Advanced.

export const SCRIBE_DEFAULT_URL = 'https://5-78-222-178.sslip.io'; // @build:scribe-url

// The AIs a user can tick on the welcome page. `mailbox` is the Scribe mailbox
// Guard watches for that AI; `site` is the chat site auto-nudge may type into.
export const AI_CHOICES = Object.freeze([
  Object.freeze({ key: 'chatgpt', label: 'ChatGPT', site: 'chatgpt.com', mailbox: 'chatgpt' }),
  Object.freeze({ key: 'claude', label: 'Claude', site: 'claude.ai', mailbox: 'claude.ai' }),
  Object.freeze({ key: 'grok', label: 'Grok', site: 'grok.com', mailbox: 'grok' }),
  Object.freeze({ key: 'gemini', label: 'Gemini', site: 'gemini.google.com', mailbox: 'gemini' }),
]);

export const DEFAULT_NUDGE_IDLE_MIN = 3;
export const DEFAULT_NUDGE_DAILY_CAP = 20;

function picked(keys) {
  const want = new Set((Array.isArray(keys) ? keys : []).map((k) => String(k).toLowerCase()));
  return AI_CHOICES.filter((c) => want.has(c.key));
}
/** Mailboxes to watch for the ticked AIs, in a fixed order. Never typed. */
export function mailboxesForAis(keys) { return picked(keys).map((c) => c.mailbox); }
/** Per-site auto-nudge switches: on for the ticked AIs, off for the rest. */
export function nudgeSitesForAis(keys) {
  const on = new Set(picked(keys).map((c) => c.site));
  return Object.fromEntries(AI_CHOICES.map((c) => [c.site, on.has(c.site)]));
}

/** The redirect address the Scribe OAuth server sends the browser back to. */
export function redirectUrlFor(runtimeId, identity) {
  try { if (identity && typeof identity.getRedirectURL === 'function') return identity.getRedirectURL(); } catch { /* fall through */ }
  return runtimeId ? `https://${runtimeId}.chromiumapp.org/` : '';
}
