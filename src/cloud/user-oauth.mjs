// User-level OAuth for AI providers (Gemini/Google first).
// Unlike the admin OAuth (which stores credentials server-side), this flow
// returns the token to the browser so the user stores it in their runner vault.
// The cloud never persists provider credentials (019 contract).

import { randomBytes, createHash } from 'node:crypto';
import { resolveGeminiOAuthConfig, createGeminiOAuthPkce } from './provider-oauth-config.mjs';

export const USER_GEMINI_OAUTH_START = '/api/provider-oauth/gemini/start';
export const USER_GEMINI_OAUTH_CALLBACK = '/api/provider-oauth/gemini/callback';

function oauthCookie(name, value) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
}

function getCookie(request, name) {
  const header = request.headers?.cookie || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export async function handleUserOAuthRoute({ request, response, requestUrl, send }) {
  const pathname = requestUrl?.pathname;

  // Start: redirect to Google
  if (request?.method === 'GET' && pathname === USER_GEMINI_OAUTH_START) {
    const origin = `${requestUrl.protocol}//${requestUrl.host}`;
    const config = resolveGeminiOAuthConfig(process.env, origin);

    if (!config.configured) {
      send(response, 503, JSON.stringify({ error: 'Gemini OAuth not configured', code: config.code }));
      return true;
    }

    const pkce = createGeminiOAuthPkce();
    const authUrl = new URL(config.authorizationEndpoint);
    authUrl.searchParams.set('client_id', config.clientId);
    authUrl.searchParams.set('redirect_uri', config.redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', config.scopes.join(' '));
    authUrl.searchParams.set('state', pkce.state);
    authUrl.searchParams.set('code_challenge', pkce.codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');

    send(response, 302, '', 'text/plain', {
      location: authUrl.toString(),
      'set-cookie': [
        oauthCookie('helmion_user_gemini_state', pkce.state),
        oauthCookie('helmion_user_gemini_verifier', pkce.codeVerifier),
      ],
    });
    return true;
  }

  // Callback: exchange code for token, show it to the user
  if (request?.method === 'GET' && pathname === USER_GEMINI_OAUTH_CALLBACK) {
    const state = requestUrl.searchParams.get('state');
    const code = requestUrl.searchParams.get('code');
    const error = requestUrl.searchParams.get('error');

    if (error) {
      send(response, 400, `OAuth failed: ${error}. <a href="/app">Back to app</a>`, 'text/html');
      return true;
    }

    const savedState = getCookie(request, 'helmion_user_gemini_state');
    const verifier = getCookie(request, 'helmion_user_gemini_verifier');

    if (!state || !code || state !== savedState || !verifier) {
      send(response, 400, 'OAuth state invalid. <a href="/app">Back to app</a>', 'text/html');
      return true;
    }

    const origin = `${requestUrl.protocol}//${requestUrl.host}`;
    const config = resolveGeminiOAuthConfig(process.env, origin);

    try {
      // Exchange code for token
      const tokenRes = await fetch(config.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          code,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: config.redirectUri,
        }),
      });

      const tokenData = await tokenRes.json();

      if (!tokenRes.ok || !tokenData.access_token) {
        throw new Error(tokenData.error_description || 'Token exchange failed');
      }

      // Success: show the token to the user with vault instructions
      // The token is NOT stored in the cloud.
      const html = `<!DOCTYPE html>
<html><head><title>Gemini Connected</title>
<style>body{font-family:system-ui;max-width:600px;margin:40px auto;padding:20px;background:#0B1120;color:#e2e8f0}
code{background:#1e293b;padding:12px;display:block;word-break:break-all;border-radius:8px;margin:12px 0}
button{background:#3b82f6;color:white;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:16px}
a{color:#60a5fa}</style></head>
<body>
<h2>Gemini Connected</h2>
<p>Your Google OAuth token (copy this):</p>
<code id="token">${tokenData.access_token}</code>
<button onclick="navigator.clipboard.writeText(document.getElementById('token').textContent).then(()=>this.textContent='Copied!')">Copy Token</button>
<h3>Store it on your runner:</h3>
<p>On your runner or PC, run:</p>
<code>echo "PASTE_TOKEN_HERE" | node bin/runner-vault.mjs store gemini --stdin</code>
<p>Then restart the bridge. The app will show Gemini as connected.</p>
<p><a href="/app">Back to Helmian</a></p>
<p style="color:#64748b;font-size:12px">This token was not stored on our servers. It only exists in your browser right now.</p>
</body></html>`;

      send(response, 200, html, 'text/html; charset=utf-8', {
        'set-cookie': [
          oauthCookie('helmion_user_gemini_state', ''),
          oauthCookie('helmion_user_gemini_verifier', ''),
        ],
      });
      return true;
    } catch (err) {
      send(response, 500, `OAuth failed: ${err.message}. <a href="/app">Back to app</a>`, 'text/html');
      return true;
    }
  }

  return false;
}
