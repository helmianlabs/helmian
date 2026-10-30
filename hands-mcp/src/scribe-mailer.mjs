// Scribe mail-back for long-lived Guard approvals. When an AI's chat call
// returns before Troy decides, the result (or denial/expiry) is delivered to
// that AI's Scribe mailbox with send_message, referencing the request id.
//
// Talks to Scribe's MCP endpoint (Streamable HTTP, stateless JSON-RPC
// tools/call). Credentials come from the environment and are never logged
// or put in a mail body:
//   SCRIBE_MCP_URL            e.g. https://scribe.example/mcp
//   SCRIBE_MAIL_TOKEN         bearer for that endpoint (memory.write scope), and/or
//   SCRIBE_REFRESH_TOKEN + SCRIBE_CLIENT_ID  OAuth refresh (rotated token kept in STATE_DIR)
// Unset URL = mail-back off: hands falls back to the old resume_action reply.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { redactSecrets } from './shared/protocol.mjs';

export const MAIL_BODY_MAX = 19000;

export function createScribeMailer({ url, token = null, refreshToken = null, clientId = null, from = 'hands', stateFile = null, timeoutMs = 10000, fetchImpl = fetch } = {}) {
  if (!url) return null;
  let access = token;
  let refresh = refreshToken;
  if (stateFile && existsSync(stateFile)) {
    try { const s = JSON.parse(readFileSync(stateFile, 'utf8')); if (s.refreshToken) refresh = s.refreshToken; if (s.accessToken) access = s.accessToken; } catch { /* ignore bad state */ }
  }
  let rpcId = 0;

  async function post(target, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try { return await fetchImpl(target, { ...init, signal: ctrl.signal }); } finally { clearTimeout(timer); }
  }

  async function doRefresh() {
    if (!refresh || !clientId) return false;
    const res = await post(new URL('/token', url).toString(), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }) });
    if (!res.ok) return false;
    const t = await res.json().catch(() => null);
    if (!t?.access_token) return false;
    access = t.access_token;
    if (t.refresh_token) refresh = t.refresh_token;
    if (stateFile) { try { writeFileSync(stateFile, JSON.stringify({ accessToken: access, refreshToken: refresh }), { mode: 0o600 }); } catch { /* best effort */ } }
    return true;
  }

  async function rpc(args) {
    const res = await post(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(access ? { authorization: `Bearer ${access}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'send_message', arguments: args } }) });
    return res;
  }

  /** Never throws. Returns { sent: true, messageId? } | { sent: false, error } (error never carries a credential). */
  async function send({ to, subject, body, priority = 'normal' }) {
    const args = { to, from, subject: redactSecrets(subject).slice(0, 200), body: redactSecrets(body).slice(0, MAIL_BODY_MAX) || '(empty)', priority };
    try {
      let res = await rpc(args);
      if (res.status === 401 && (await doRefresh())) res = await rpc(args);
      if (!res.ok) return { sent: false, error: `scribe-http-${res.status}` };
      const text = await res.text();
      const json = text.trim().startsWith('{') ? JSON.parse(text) : JSON.parse((/^data: (.*)$/m.exec(text) || [])[1] || 'null');
      if (!json?.result || json.result.isError) return { sent: false, error: 'scribe-tool-error' };
      const m = /"id"\s*:\s*(\d+)/.exec(json.result.content?.map((c) => c.text).join('\n') || '');
      return { sent: true, messageId: m ? Number(m[1]) : null };
    } catch (e) {
      return { sent: false, error: e?.name === 'AbortError' ? 'scribe-timeout' : 'scribe-unreachable' };
    }
  }

  return { send, from };
}

/**
 * Which Scribe mailbox a hands connection belongs to, from its OAuth client
 * name (what the AI app registered as). An explicit `mailbox` argument on the
 * tool call wins. Unknown = null (no mail-back; old resume_action reply).
 */
export function mailboxForClient(clientName) {
  const n = String(clientName || '').toLowerCase();
  if (!n) return null;
  if (n.includes('claude code') || n.includes('claude-code')) return 'claude-code';
  if (n.includes('claude')) return 'claude.ai';
  if (n.includes('chatgpt') || n.includes('openai')) return 'chatgpt';
  if (n.includes('gemini')) return 'gemini';
  if (n.includes('grok')) return 'grok';
  if (n.includes('mistral') || n.includes('le chat')) return 'mistral';
  if (n.includes('copilot')) return 'copilot';
  if (n.includes('perplexity')) return 'perplexity';
  return null;
}

const MAILBOX_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
export function normalizeMailbox(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return MAILBOX_RE.test(s) && s !== 'all' ? s : null;
}
