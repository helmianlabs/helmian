// User-level OAuth for AI providers (Gemini/Google first).
// Unlike the admin OAuth (which stores credentials server-side), this flow
// returns the token to the browser so the user stores it in their runner vault.
// The cloud never persists provider credentials (019 contract).

import { randomBytes, createHash } from 'node:crypto';
import { resolveGeminiUserOAuthConfig, createGeminiOAuthPkce } from './provider-oauth-config.mjs';

export const USER_GEMINI_OAUTH_START = '/api/provider-oauth/gemini/start';
export const USER_GEMINI_OAUTH_CALLBACK = '/api/provider-oauth/gemini/callback';
export const USER_OPENAI_OAUTH_START = '/api/provider-oauth/openai/start';
export const USER_OPENAI_OAUTH_CALLBACK = '/api/provider-oauth/openai/callback';
export const USER_GROK_OAUTH_START = '/api/provider-oauth/grok/start';
export const USER_GROK_OAUTH_POLL = '/api/provider-oauth/grok/poll';

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
    const config = resolveGeminiUserOAuthConfig(process.env, origin);

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
    const config = resolveGeminiUserOAuthConfig(process.env, origin);

    if (!config.configured) {
      send(response, 503, JSON.stringify({ error: 'Gemini OAuth not configured', code: config.code }));
      return true;
    }

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

  // OpenAI "Sign in with ChatGPT" - Start
  if (request?.method === 'GET' && pathname === USER_OPENAI_OAUTH_START) {
    const clientId = process.env.HELMION_OPENAI_OAUTH_CLIENT_ID;
    if (!clientId) {
      send(response, 503, JSON.stringify({ error: 'ChatGPT OAuth not configured' }));
      return true;
    }
    const origin = `${requestUrl.protocol}//${requestUrl.host}`;
    const redirectUri = `${origin}${USER_OPENAI_OAUTH_CALLBACK}`;
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    const authUrl = new URL('https://auth.openai.com/api/accounts/authorize');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid profile email offline_access');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    send(response, 302, '', 'text/plain', {
      location: authUrl.toString(),
      'set-cookie': [
        oauthCookie('helmion_user_openai_state', state),
        oauthCookie('helmion_user_openai_verifier', verifier),
      ],
    });
    return true;
  }

  // OpenAI "Sign in with ChatGPT" - Callback
  if (request?.method === 'GET' && pathname === USER_OPENAI_OAUTH_CALLBACK) {
    const state = requestUrl.searchParams.get('state');
    const code = requestUrl.searchParams.get('code');
    const savedState = getCookie(request, 'helmion_user_openai_state');
    const verifier = getCookie(request, 'helmion_user_openai_verifier');

    if (!state || !code || state !== savedState || !verifier) {
      send(response, 400, 'OAuth state invalid. <a href="/app">Back to app</a>', 'text/html');
      return true;
    }

    const origin = `${requestUrl.protocol}//${requestUrl.host}`;
    const redirectUri = `${origin}${USER_OPENAI_OAUTH_CALLBACK}`;
    const clientId = process.env.HELMION_OPENAI_OAUTH_CLIENT_ID;

    try {
      const tokenRes = await fetch('https://auth.openai.com/api/accounts/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          code,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.access_token) {
        throw new Error(tokenData.error_description || 'Token exchange failed');
      }

      const html = `<!DOCTYPE html>
<html><head><title>ChatGPT Connected</title>
<style>body{font-family:system-ui;max-width:600px;margin:40px auto;padding:20px;background:#0B1120;color:#e2e8f0}
code{background:#1e293b;padding:12px;display:block;word-break:break-all;border-radius:8px;margin:12px 0}
button{background:#3b82f6;color:white;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:16px}
a{color:#60a5fa}</style></head>
<body>
<h2>ChatGPT Connected</h2>
<p>Your access token (copy this):</p>
<code id="token">${tokenData.access_token}</code>
<button onclick="navigator.clipboard.writeText(document.getElementById('token').textContent).then(()=>this.textContent='Copied!')">Copy Token</button>
<h3>Store it on your runner:</h3>
<code>echo "PASTE_TOKEN_HERE" | node bin/runner-vault.mjs store openai --stdin</code>
<p>Then restart the bridge.</p>
<p><a href="/app">Back to Helmian</a></p>
<p style="color:#64748b;font-size:12px">This token was not stored on our servers.</p>
</body></html>`;
      send(response, 200, html, 'text/html; charset=utf-8');
      return true;
    } catch (err) {
      send(response, 500, `OAuth failed: ${err.message}. <a href="/app">Back to app</a>`, 'text/html');
      return true;
    }
  }

  // Grok (xAI) Device Code Flow - Start: get device code and show user code
  if (request?.method === 'GET' && pathname === USER_GROK_OAUTH_START) {
    try {
      const deviceRes = await fetch('https://auth.x.ai/oauth2/device/code', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
          scope: 'openid profile email offline_access api:access',
        }),
      });
      const deviceData = await deviceRes.json();
      if (!deviceRes.ok || !deviceData.device_code) {
        throw new Error(deviceData.error_description || 'Device code request failed');
      }

      const html = `<!DOCTYPE html>
<html><head><title>Connect Grok</title>
<style>body{font-family:system-ui;max-width:600px;margin:40px auto;padding:20px;background:#0B1120;color:#e2e8f0}
.code{background:#1e293b;padding:20px;display:block;border-radius:8px;margin:12px 0;font-size:32px;letter-spacing:4px;text-align:center;font-weight:bold}
a{color:#60a5fa}.btn{background:#3b82f6;color:white;border:none;padding:12px 24px;border-radius:8px;cursor:pointer;font-size:16px;text-decoration:none;display:inline-block;margin:10px 0}
#status{margin:20px 0;padding:12px;border-radius:8px;background:#1e293b}</style></head>
<body>
<h2>Connect Grok</h2>
<p>1. Go to: <a href="${deviceData.verification_uri}" target="_blank">${deviceData.verification_uri}</a></p>
<p>2. Enter this code:</p>
<div class="code">${deviceData.user_code}</div>
<p>3. Wait here — this page checks automatically.</p>
<div id="status">Waiting for approval...</div>
<script>
const deviceCode = ${JSON.stringify(deviceData.device_code)};
const interval = ${(deviceData.interval || 5) * 1000};
async function poll() {
  try {
    const res = await fetch('/api/provider-oauth/grok/poll', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({ device_code: deviceCode }),
    });
    const data = await res.json();
    if (data.access_token) {
      document.getElementById('status').innerHTML = '<p style="color:#22c55e">Connected!</p><p>Your access token:</p><code style="background:#1e293b;padding:12px;display:block;word-break:break-all;border-radius:8px;margin:12px 0">' + data.access_token + '</code><button class="btn" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent).then(()=>this.textContent=\\'Copied!\\')">Copy Token</button><h3>Store it on your runner:</h3><code style="background:#1e293b;padding:12px;display:block;border-radius:8px">echo "PASTE_TOKEN_HERE" | node bin/runner-vault.mjs store grok --stdin</code><p>Then restart the bridge.</p><p><a href="/app">Back to Helmian</a></p>';
    } else if (data.error === 'authorization_pending') {
      setTimeout(poll, interval);
    } else {
      document.getElementById('status').textContent = 'Error: ' + (data.error_description || data.error);
    }
  } catch (e) {
    document.getElementById('status').textContent = 'Poll failed, retrying...';
    setTimeout(poll, interval);
  }
}
setTimeout(poll, interval);
</script>
<p style="color:#64748b;font-size:12px">This token was not stored on our servers.</p>
</body></html>`;
      send(response, 200, html, 'text/html; charset=utf-8');
      return true;
    } catch (err) {
      send(response, 500, `Grok OAuth failed: ${err.message}. <a href="/app">Back to app</a>`, 'text/html');
      return true;
    }
  }

  // Grok (xAI) Device Code Flow - Poll: check if user approved
  if (request?.method === 'POST' && pathname === USER_GROK_OAUTH_POLL) {
    let body = '';
    for await (const chunk of request) body += chunk;
    const { device_code } = JSON.parse(body || '{}');
    if (!device_code) {
      send(response, 400, JSON.stringify({ error: 'missing_device_code' }));
      return true;
    }
    try {
      const tokenRes = await fetch('https://auth.x.ai/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
          device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      const tokenData = await tokenRes.json();
      send(response, 200, JSON.stringify(tokenData), 'application/json');
      return true;
    } catch (err) {
      send(response, 500, JSON.stringify({ error: 'poll_failed', error_description: err.message }));
      return true;
    }
  }

  return false;
}
