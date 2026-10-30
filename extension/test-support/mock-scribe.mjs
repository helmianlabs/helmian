// A stand-in for Scribe's door-knock route, mirroring troy83352/shared-memory-mcp
// PR #3 (branch door-knock/courier-receipts): server.src/app/src/single.ts
// GET /mailbox/unread and courier/store.ts unreadSummary(). Same status codes,
// bodies, headers and cursor arithmetic. In memory, no database.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mailboxName } from '../background/scribe-client.js';

export const MOCK_SCRIBE_TOKEN = 'mock-mailbox-status-token-0123456789';
const BROADCAST = 'all';

function agentName(raw) { // PR #3 courier/store.ts agentName()
  const n = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+|[._-]+$/g, '').slice(0, 40);
  return n || null;
}
function constantTimeEquals(a, b) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }

export async function startMockScribe({ token = MOCK_SCRIBE_TOKEN, installed = true } = {}) {
  const state = { token, installed, requests: [], messages: [], reads: new Set(), legacy: [], nextId: 1, forceStatus: null, retryAfter: null };
  state.send = ({ to, from, subject, priority = 'normal' }) => {
    const m = { id: state.nextId++, to_agent: to === BROADCAST ? BROADCAST : mailboxName(to), from_agent: mailboxName(from), subject, priority, created_at: new Date().toISOString() };
    state.messages.push(m); return m;
  };
  state.markRead = (id, agent) => state.reads.add(`${id}:${mailboxName(agent)}`);
  function unreadSummary(agentRaw, sinceId) {
    const a = agentName(agentRaw);
    if (!a || a === BROADCAST) { const e = new Error("Pass a mailbox name, e.g. 'paul'."); e.postOffice = true; throw e; }
    const me = mailboxName(a);
    const waiting = state.messages.filter((m) => (m.to_agent === me || (m.to_agent === BROADCAST && m.from_agent !== me)) && !state.reads.has(`${m.id}:${me}`));
    const since = Math.max(0, Math.floor(sinceId) || 0);
    const fresh = waiting.filter((m) => m.id > since).sort((x, y) => x.id - y.id).slice(0, 20);
    const newest = waiting.length ? Math.max(...waiting.map((m) => m.id)) : null;
    const cursor = Math.max(Math.floor(sinceId) || 0, newest ?? 0, ...fresh.map((x) => x.id));
    return { agent: me, unread_count: waiting.length, newest_id: newest, cursor,
      new: fresh.map((x) => ({ id: x.id, from: x.from_agent, subject: x.subject, priority: x.priority, created_at: x.created_at })) };
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization });
    const headers = {};
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET' || url.pathname !== '/mailbox/unread') return json(404, { error: 'not found' });
    if (!state.token) return json(404, { error: 'not found' });
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!presented || !constantTimeEquals(presented, state.token)) return json(401, { error: 'unauthorized' });
    headers['Cache-Control'] = 'no-store';
    if (state.forceStatus === 429) { headers['retry-after'] = String(state.retryAfter ?? 60); return json(429, { error: 'rate_limited' }); } // not in PR #3; for client backoff tests
    if (state.forceStatus === 500) return json(500, { error: 'mailbox status unavailable' });
    const since = Number(url.searchParams.get('since_id') ?? 0);
    try {
      if (!state.installed) { const e = new Error('relation "agent_messages" does not exist'); e.code = '42P01'; throw e; }
      const out = { generated_at: new Date().toISOString(), poll_after_seconds: 60, ...unreadSummary(url.searchParams.get('agent') ?? '', Number.isFinite(since) ? since : 0) };
      if (url.searchParams.get('include_legacy') === '1') {
        const name = out.agent;
        const tags = [`for-${name}`];
        const hits = state.legacy.filter((l) => tags.some((t) => l.text.toLowerCase().includes(t)));
        out.legacy = { tags, recent_count: hits.length, newest_id: hits.length ? Math.max(...hits.map((h) => h.id)) : null, window_days: 14, note: 'Legacy letters have no read state; counts are by recency.' };
      }
      return json(200, out);
    } catch (e) {
      if (e.postOffice) return json(400, { error: 'bad_request', error_description: e.message });
      if (e.code === '42P01') return json(503, { error: 'courier_not_installed' });
      return json(500, { error: 'mailbox status unavailable' });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return Object.assign(state, { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
}
