// User-level OAuth for AI providers — RETIRED (one-road removal pass,
// Bite 12, 2026-11-02).
//
// This module used to serve the user-level connect flows under
// /api/provider-oauth/*: Gemini/Google OAuth (start + callback),
// "Sign in with ChatGPT" OAuth (start + callback), and the Grok (xAI)
// device-code flow (start + poll). Under the owner's one-road law an
// AI connects with its account email and password on its Integrations
// card (password_session); OAuth redirects, token hand-offs to the
// browser, and device codes are not connect roads anymore.
//
// The flows are gone. handleUserOAuthRoute remains only as a fence:
// it answers 410 for the retired paths so nothing can quietly revive
// them, and the router in envoy-ably.mjs no longer delegates here at
// all (it answers 410 for the whole /api/provider-oauth/ prefix).
// The path constants stay exported because tests and the fenced
// provider-oauth-config.mjs still name them. Do not re-add flows.

export const USER_GEMINI_OAUTH_START = '/api/provider-oauth/gemini/start';
export const USER_GEMINI_OAUTH_CALLBACK = '/api/provider-oauth/gemini/callback';
export const USER_OPENAI_OAUTH_START = '/api/provider-oauth/openai/start';
export const USER_OPENAI_OAUTH_CALLBACK = '/api/provider-oauth/openai/callback';
export const USER_GROK_OAUTH_START = '/api/provider-oauth/grok/start';
export const USER_GROK_OAUTH_POLL = '/api/provider-oauth/grok/poll';

const RETIRED_PATHS = new Set([
  USER_GEMINI_OAUTH_START,
  USER_GEMINI_OAUTH_CALLBACK,
  USER_OPENAI_OAUTH_START,
  USER_OPENAI_OAUTH_CALLBACK,
  USER_GROK_OAUTH_START,
  USER_GROK_OAUTH_POLL,
]);

export async function handleUserOAuthRoute({ request, response, requestUrl, send }) {
  const pathname = requestUrl?.pathname;
  if (!RETIRED_PATHS.has(pathname)) return false;
  send(response, 410, JSON.stringify({ error: 'provider_oauth_retired', code: 'PROVIDER_OAUTH_RETIRED' }));
  return true;
}
