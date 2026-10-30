// Scribe one-time SIGN-IN (OAuth 2.1 + PKCE + Dynamic Client Registration) and
// the MCP read Guard uses to count unread mail once signed in. 0.6.0.
//
// Why: Troy does not want pasted API keys. The Scribe server (shared-memory-mcp,
// live at connect.helmian.cloud) is its own OAuth authorization server:
//   GET  /.well-known/oauth-authorization-server   (verified live 2026-10-29)
//   POST /register   (RFC 7591 DCR, public client, token_endpoint_auth_method "none")
//   GET  /authorize  (passphrase consent page; Troy signs in once)
//   POST /token      (authorization_code + PKCE S256, refresh_token)
// The browser runs the consent page in chrome.identity.launchWebAuthFlow /
// browser.identity.launchWebAuthFlow, and redirects to the extension's own
// https://<id>.chromiumapp.org/ (Firefox: https://<id>.extensions.allizom.org/).
//
// Guard asks for memory.read ONLY. It never asks for memory.write, so it cannot
// send mail, ack or mark read: it only knocks. Unread counts come from the MCP
// tool inbox_status (no bodies, no receipts), because the self-host
// /mailbox/unread route accepts only the static MAILBOX_STATUS_TOKEN (and is not
// served on connect.helmian.cloud as of 2026-10-29).
//
// The access and refresh tokens live in the ledger storage under
// SCRIBE_OAUTH_KEY, are never returned to the popup or a page, and are never logged.

export const SCRIBE_OAUTH_KEY = 'helmion.scribe.oauth';
export const GUARD_SCOPE = 'memory.read';
export const CLIENT_NAME = 'Helmian Guard (browser)';
const TIMEOUT_MS = 8000;

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomString(n = 32) { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); }
export async function pkcePair() {
  const verifier = randomString(48);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

async function req(fetchImpl, url, init = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  try {
    const res = await doFetch(url, { credentials: 'omit', cache: 'no-store', ...init, ...(ctl ? { signal: ctl.signal } : {}) });
    const type = res.headers && typeof res.headers.get === 'function' ? String(res.headers.get('content-type') || '') : '';
    const text = typeof res.text === 'function' ? await res.text() : JSON.stringify(await res.json());
    return { status: res.status, type, text };
  } finally { if (t) clearTimeout(t); }
}
function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }

function sameOrigin(a, b) { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } }

/** Discover the authorization server. Every endpoint must be https on the Scribe origin. */
export async function discover(baseUrl, { fetchImpl } = {}) {
  let r;
  try { r = await req(fetchImpl, `${baseUrl}/.well-known/oauth-authorization-server`, { method: 'GET', headers: { accept: 'application/json' } }); }
  catch (e) { throw new Error(`Could not reach the Scribe server at ${baseUrl} (${(e && e.name === 'AbortError') ? 'timed out' : 'network error'}). Check your internet connection and the Scribe URL.`); }
  const m = r.status === 200 ? parseJson(r.text) : null;
  if (!m || !m.authorization_endpoint || !m.token_endpoint) throw new Error('This Scribe server does not offer sign-in (no OAuth metadata)');
  for (const k of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
    if (m[k] && !sameOrigin(m[k], baseUrl)) throw new Error(`Scribe ${k} is on a different origin; refusing`);
  }
  if (!m.registration_endpoint) throw new Error('This Scribe server has no client registration endpoint (DCR)');
  if (Array.isArray(m.code_challenge_methods_supported) && !m.code_challenge_methods_supported.includes('S256')) throw new Error('Scribe does not support PKCE S256');
  if (Array.isArray(m.scopes_supported) && !m.scopes_supported.includes(GUARD_SCOPE)) throw new Error(`Scribe does not offer the ${GUARD_SCOPE} scope`);
  return m;
}

async function register(meta, redirectUri, { fetchImpl }) {
  const r = await req(fetchImpl, meta.registration_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_name: CLIENT_NAME, redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: GUARD_SCOPE }),
  });
  const j = parseJson(r.text);
  if (r.status < 200 || r.status >= 300 || !j || !j.client_id) throw new Error(`Scribe client registration failed (${r.status})`);
  return j.client_id;
}

async function exchange(meta, form, { fetchImpl }) {
  const r = await req(fetchImpl, meta.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  const j = parseJson(r.text);
  if (r.status !== 200 || !j || !j.access_token) { const e = new Error(`Scribe token request failed (${r.status})`); e.status = r.status; throw e; }
  return j;
}

/**
 * One-time sign-in. `launch(url)` must open the consent page and resolve to the
 * final redirect URL (chrome.identity.launchWebAuthFlow in the worker).
 */
export async function signIn(storage, baseUrl, { launch, redirectUri, fetchImpl, now = Date.now() } = {}) {
  if (typeof launch !== 'function' || !redirectUri) throw new Error('Sign-in needs the browser identity API');
  const meta = await discover(baseUrl, { fetchImpl });
  const clientId = await register(meta, redirectUri, { fetchImpl });
  const { verifier, challenge } = await pkcePair();
  const state = randomString(18);
  const resource = `${baseUrl}/mcp`;
  const u = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: GUARD_SCOPE,
    state, code_challenge: challenge, code_challenge_method: 'S256', resource })) u.searchParams.set(k, v);
  const final = await launch(u.toString());
  let back;
  try { back = new URL(String(final)); } catch { throw new Error('Sign-in was cancelled'); }
  if (!String(final).startsWith(redirectUri)) throw new Error('Sign-in returned to an unexpected address');
  if (back.searchParams.get('error')) throw new Error(`Scribe refused sign-in: ${back.searchParams.get('error')}`);
  if (back.searchParams.get('state') !== state) throw new Error('Sign-in state did not match; refusing');
  const iss = back.searchParams.get('iss');
  if (iss && meta.issuer && iss !== meta.issuer) throw new Error('Sign-in issuer did not match; refusing');
  const code = back.searchParams.get('code');
  if (!code) throw new Error('Scribe sent no authorization code');
  const tok = await exchange(meta, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource }, { fetchImpl });
  const saved = {
    baseUrl, clientId, tokenEndpoint: meta.token_endpoint, resource,
    accessToken: tok.access_token, refreshToken: tok.refresh_token || null,
    expiresAt: now + (Number(tok.expires_in) > 0 ? Number(tok.expires_in) * 1000 : 3600 * 1000),
    scope: String(tok.scope || GUARD_SCOPE), signedInAt: now,
  };
  await storage.set(SCRIBE_OAUTH_KEY, saved);
  return authView(saved);
}

export function authView(o) {
  if (!o || !o.accessToken) return { signedIn: false };
  return { signedIn: true, baseUrl: o.baseUrl, scope: o.scope, signedInAt: o.signedInAt || null, canRefresh: Boolean(o.refreshToken) };
}
export async function getAuth(storage) { return authView(await storage.get(SCRIBE_OAUTH_KEY)); }
export async function signOut(storage) { await storage.set(SCRIBE_OAUTH_KEY, null); return { signedIn: false }; }

/** A valid access token, refreshing first if it is about to expire. null if not signed in or refresh failed. */
export async function accessToken(storage, { fetchImpl, now = Date.now(), forceRefresh = false } = {}) {
  const o = await storage.get(SCRIBE_OAUTH_KEY);
  if (!o || !o.accessToken) return null;
  if (!forceRefresh && o.expiresAt - now > 60 * 1000) return o.accessToken;
  if (!o.refreshToken) return forceRefresh ? null : o.accessToken;
  try {
    const tok = await exchange({ token_endpoint: o.tokenEndpoint }, { grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: o.clientId, resource: o.resource }, { fetchImpl });
    const next = { ...o, accessToken: tok.access_token, refreshToken: tok.refresh_token || o.refreshToken,
      expiresAt: now + (Number(tok.expires_in) > 0 ? Number(tok.expires_in) * 1000 : 3600 * 1000) };
    await storage.set(SCRIBE_OAUTH_KEY, next);
    return next.accessToken;
  } catch (e) {
    if (e && (e.status === 400 || e.status === 401)) await storage.set(SCRIBE_OAUTH_KEY, { ...o, accessToken: null });
    return null;
  }
}

/** Parse a Streamable-HTTP MCP response (JSON or a one-shot SSE stream). */
export function parseMcpBody(text, type) {
  if (/text\/event-stream/i.test(type || '') || /^\s*(event|data):/m.test(text)) {
    const datas = String(text).split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    for (let i = datas.length - 1; i >= 0; i -= 1) { const j = parseJson(datas[i]); if (j && (j.result || j.error)) return j; }
    return null;
  }
  return parseJson(text);
}

/**
 * Call the MCP tool inbox_status for one mailbox with the OAuth token.
 * Returns the same {status, json} shape as the /mailbox/unread call, so the
 * poller's state machine is shared. Stateless server: a single tools/call POST.
 */
export async function inboxStatusViaMcp(baseUrl, token, agent, sinceId, { fetchImpl } = {}) {
  const r = await req(fetchImpl, `${baseUrl}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'inbox_status', arguments: { agent_name: agent, since_id: Math.max(0, Math.floor(Number(sinceId) || 0)) } } }),
  });
  if (r.status !== 200) return { status: r.status, json: parseJson(r.text) };
  const j = parseMcpBody(r.text, r.type);
  if (!j || j.error) return { status: 500, json: { error: 'mcp_error' } };
  const res = j.result || {};
  const txt = Array.isArray(res.content) ? res.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('') : '';
  if (res.isError) {
    if (/courier_not_installed|does not exist|42P01/i.test(txt)) return { status: 503, json: { error: 'courier_not_installed' } };
    return { status: 400, json: { error: 'bad_request' } };
  }
  const payload = res.structuredContent && typeof res.structuredContent === 'object' ? res.structuredContent : parseJson(txt);
  if (!payload || typeof payload !== 'object') return { status: 500, json: { error: 'unreadable' } };
  return { status: 200, json: { poll_after_seconds: 60, ...payload } };
}
