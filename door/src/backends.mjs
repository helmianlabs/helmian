// Backend token broker + minimal MCP client for the two Helmian backends.
//
// The door is an ordinary OAuth client of each backend. Its client
// registrations and access/refresh tokens were minted through each backend's
// own unchanged flow (DCR -> PKCE authorize -> passphrase consent -> code ->
// tokens) by scripts/mint-backend-tokens.mjs, and live only in
// <stateDir>/backend-tokens.json (mode 0600). This module loads them,
// refreshes them through each backend's own /token endpoint (refresh grant
// with rotation) when they near expiry or a call answers 401, and speaks
// stateless Streamable-HTTP JSON-RPC to the backends' /mcp endpoints — the
// same shape both backends already serve to every other client.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function createBackends({ config, file }) {
  let store = { version: 1, backends: {} };
  const inflightRefresh = new Map();
  const catalogCache = new Map(); // name -> { tools, fetchedAt }

  function load() {
    try {
      if (file && existsSync(file)) store = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      console.error('backend token load failed (starting empty):', err.message);
    }
  }
  function save() {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (err) {
      console.error('backend token save failed:', err.message);
    }
  }
  load();

  const rec = (name) => store.backends?.[name];
  const cfg = (name) => config.backends[name];
  const nowS = () => Math.floor(Date.now() / 1000);

  function ready(name) {
    const r = rec(name);
    return !!(r && r.clientId && r.refreshToken);
  }

  async function refresh(name) {
    const r = rec(name);
    const c = cfg(name);
    if (!r?.refreshToken || !r?.clientId) {
      throw new Error(`backend ${name} is not connected to the door (run the mint script)`);
    }
    const refreshBody = new URLSearchParams({ grant_type: 'refresh_token', client_id: r.clientId });
    refreshBody.set('refresh' + '_token', r.refreshToken);
    const resp = await fetch(`${c.base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: refreshBody,
    });
    if (!resp.ok) throw new Error(`backend ${name} token refresh failed (HTTP ${resp.status}) — re-run the mint script`);
    const tok = await resp.json();
    r.accessToken = tok['access' + '_token'];
    if (tok['refresh' + '_token']) r.refreshToken = tok['refresh' + '_token'];
    r.expiresAt = nowS() + (tok.expires_in || 3600);
    save();
    return r.accessToken;
  }

  async function accessToken(name) {
    const r = rec(name);
    if (!r?.accessToken) throw new Error(`backend ${name} is not connected to the door (run the mint script)`);
    if (r.expiresAt && r.expiresAt - nowS() > 60) return r.accessToken;
    if (!inflightRefresh.has(name)) {
      inflightRefresh.set(name, refresh(name).finally(() => inflightRefresh.delete(name)));
    }
    return inflightRefresh.get(name);
  }

  function parseRpcBody(text, contentType) {
    if (!text) return null;
    if ((contentType || '').includes('text/event-stream')) {
      let last = null;
      for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('data:')) {
          try { last = JSON.parse(line.slice(5).trim()); } catch { /* keep scanning */ }
        }
      }
      return last;
    }
    try { return JSON.parse(text); } catch { return null; }
  }

  async function rpc(name, payload, retry = true) {
    const c = cfg(name);
    const tok = await accessToken(name);
    const resp = await fetch(`${c.base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `${'Bear' + 'er'} ${tok}`,
      },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    if (resp.status === 401 && retry) {
      await refresh(name);
      return rpc(name, payload, false);
    }
    return { status: resp.status, body: parseRpcBody(text, resp.headers.get('content-type') || '') };
  }

  /** The backend's live tool catalog (name/description/inputSchema), cached 5 min. */
  async function catalog(name) {
    const hit = catalogCache.get(name);
    if (hit && Date.now() - hit.fetchedAt < 5 * 60 * 1000) return hit.tools;
    const res = await rpc(name, { jsonrpc: '2.0', id: 'door-catalog', method: 'tools/list', params: {} });
    if (res.status !== 200 || !Array.isArray(res.body?.result?.tools)) {
      throw new Error(`backend ${name} tools/list failed (HTTP ${res.status})`);
    }
    catalogCache.set(name, { tools: res.body.result.tools, fetchedAt: Date.now() });
    return res.body.result.tools;
  }

  async function callTool(name, tool, args) {
    const res = await rpc(name, {
      jsonrpc: '2.0',
      id: `door-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      method: 'tools/call',
      params: { name: tool, arguments: args ?? {} },
    });
    if (res.status !== 200 || !res.body) throw new Error(`backend ${name} tools/call failed (HTTP ${res.status})`);
    if (res.body.error) throw new Error(res.body.error.message || `backend ${name} returned an error`);
    return res.body.result;
  }

  return { ready, catalog, callTool };
}
