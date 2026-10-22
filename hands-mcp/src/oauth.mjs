// OAuth 2.1 authorization server for the hands MCP server: DCR, auth code + PKCE
// (verified by the SDK token handler), refresh rotation, bearer verification.
// Ported from the claude-memory-mcp provider on the same box so both connectors
// behave the same; the human gate is the passphrase consent page.
//
// Scopes: hands.read (read-only tools) and hands.act (may REQUEST mutating tools;
// a hands.act token still cannot bypass Executive Guard).

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  ACCESS_TOKEN_TTL_SECONDS, AUTH_CODE_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS, SCOPES,
} from './config.mjs';
import { renderConsentPage } from './consent.mjs';

const nowS = () => Math.floor(Date.now() / 1000);
const token = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Only scopes we know; empty request = read-only. */
export function normalizeScopes(requested) {
  const list = (Array.isArray(requested) ? requested : []).filter((s) => SCOPES.includes(s));
  return list.length ? [...new Set(list)] : ['hands.read'];
}

export function createOAuth({ resourceId, stateFile }) {
  const clients = new Map();
  const authCodes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  const pendingAuth = new Map();

  function load() {
    try {
      if (!stateFile || !existsSync(stateFile)) return;
      const raw = JSON.parse(readFileSync(stateFile, 'utf8'));
      const t = nowS();
      for (const c of raw.clients ?? []) if (c?.client_id) clients.set(c.client_id, c);
      for (const a of raw.accessTokens ?? []) if (a?.token && a.expiresAt >= t) accessTokens.set(a.token, a);
      for (const r of raw.refreshTokens ?? []) if (r?.token && r.expiresAt >= t) refreshTokens.set(r.token, r);
    } catch (err) {
      console.error('oauth state load failed (starting empty):', err.message);
    }
  }
  function save() {
    if (!stateFile) return;
    try {
      mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
      const tmp = `${stateFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({
        version: 1,
        clients: [...clients.values()],
        accessTokens: [...accessTokens.values()],
        refreshTokens: [...refreshTokens.values()],
      }), { mode: 0o600 });
      renameSync(tmp, stateFile);
    } catch (err) {
      console.error('oauth state save failed:', err.message);
    }
  }
  load();

  const clientsStore = {
    getClient: (id) => clients.get(id),
    registerClient(client) {
      const full = { ...client, client_id: `hands-client-${randomUUID()}`, client_id_issued_at: nowS() };
      clients.set(full.client_id, full);
      save();
      return full;
    },
  };

  function issueTokens(clientId, scopes, resource) {
    const accessToken = token(32);
    const refreshToken = token(32);
    accessTokens.set(accessToken, { token: accessToken, clientId, scopes, resource, expiresAt: nowS() + ACCESS_TOKEN_TTL_SECONDS });
    refreshTokens.set(refreshToken, { token: refreshToken, clientId, scopes, resource, expiresAt: nowS() + REFRESH_TOKEN_TTL_SECONDS });
    save();
    return { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refreshToken, scope: scopes.join(' ') };
  }

  const provider = {
    get clientsStore() { return clientsStore; },
    async authorize(client, params, res) {
      const pendingId = token(18);
      const scopes = normalizeScopes(params.scopes);
      pendingAuth.set(pendingId, {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        scopes,
        state: params.state,
        resource: params.resource?.toString(),
        createdAt: nowS(),
      });
      res.status(200).set('Content-Type', 'text/html; charset=utf-8')
        .send(renderConsentPage({ pendingId, clientName: client.client_name || client.client_id, scopes }));
    },
    async challengeForAuthorizationCode(_client, code) {
      const rec = authCodes.get(code);
      if (!rec) throw new Error('Invalid authorization code');
      return rec.codeChallenge;
    },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
      const rec = authCodes.get(code);
      if (!rec) throw new Error('Invalid authorization code');
      authCodes.delete(code);
      if (rec.expiresAt < nowS()) throw new Error('Authorization code expired');
      if (rec.clientId !== client.client_id) throw new Error('Authorization code was issued to a different client');
      if (redirectUri && redirectUri !== rec.redirectUri) throw new Error('redirect_uri mismatch');
      return issueTokens(client.client_id, rec.scopes, resource?.toString() ?? rec.resource ?? resourceId);
    },
    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      const rec = refreshTokens.get(refreshToken);
      if (!rec) throw new Error('Invalid refresh token');
      refreshTokens.delete(refreshToken);
      if (rec.expiresAt < nowS()) { save(); throw new Error('Refresh token expired'); }
      if (rec.clientId !== client.client_id) throw new Error('Refresh token was issued to a different client');
      // A refresh can narrow scopes, never widen them.
      const granted = scopes && scopes.length ? scopes.filter((s) => rec.scopes.includes(s)) : rec.scopes;
      return issueTokens(client.client_id, granted.length ? granted : rec.scopes, resource?.toString() ?? rec.resource ?? resourceId);
    },
    async verifyAccessToken(accessToken) {
      const rec = accessTokens.get(accessToken);
      if (!rec) throw new InvalidTokenError('Invalid or unknown access token');
      if (rec.expiresAt < nowS()) { accessTokens.delete(accessToken); save(); throw new InvalidTokenError('Access token expired'); }
      return { token: rec.token, clientId: rec.clientId, scopes: rec.scopes, expiresAt: rec.expiresAt, resource: rec.resource ? new URL(rec.resource) : undefined };
    },
    async revokeToken(_client, request) {
      if (accessTokens.delete(request.token) || refreshTokens.delete(request.token)) save();
    },
  };

  function approve(pendingId) {
    const p = pendingAuth.get(pendingId);
    if (!p) return null;
    pendingAuth.delete(pendingId);
    const code = token(24);
    authCodes.set(code, { ...p, code, expiresAt: nowS() + AUTH_CODE_TTL_SECONDS });
    const url = new URL(p.redirectUri);
    url.searchParams.set('code', code);
    if (p.state !== undefined) url.searchParams.set('state', p.state);
    return url.toString();
  }
  function deny(pendingId) {
    const p = pendingAuth.get(pendingId);
    if (!p) return null;
    pendingAuth.delete(pendingId);
    const url = new URL(p.redirectUri);
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'The user denied the authorization request.');
    if (p.state !== undefined) url.searchParams.set('state', p.state);
    return url.toString();
  }
  function sweep() {
    const t = nowS();
    let changed = false;
    for (const [k, v] of authCodes) if (v.expiresAt < t) authCodes.delete(k);
    for (const [k, v] of accessTokens) if (v.expiresAt < t) { accessTokens.delete(k); changed = true; }
    for (const [k, v] of refreshTokens) if (v.expiresAt < t) { refreshTokens.delete(k); changed = true; }
    for (const [k, v] of pendingAuth) if (v.createdAt + AUTH_CODE_TTL_SECONDS < t) pendingAuth.delete(k);
    if (changed) save();
  }

  return {
    provider,
    approve,
    deny,
    getPending: (id) => pendingAuth.get(id),
    clientName: (id) => clients.get(id)?.client_name || id,
    sweep,
  };
}
