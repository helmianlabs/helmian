// A tiny stand-in for Scribe's door-knock surface. /mailbox-status matches the
// real route on Scribe main; the letter and receipt routes are provisional.
import { createServer } from 'node:http';
export const MOCK_SCRIBE_TOKEN = 'smk_testmailboxtoken_0123456789';
export async function startMockScribe({ token = MOCK_SCRIBE_TOKEN } = {}) {
  const state = { requests: [], status: 200, retryAfter: null, receipts: [],
    mailboxes: [{ tag: 'for-troy', agent: 'troy', count: 2, newest: { id: 7, sender: 'paul', created_at: '2026-10-29T21:00:00Z', subject: 'Door-knock contract' } }],
    letters: { 7: { id: 7, from: 'paul', subject: 'Door-knock contract', body: 'Hello Troy', created_at: '2026-10-29T21:00:00Z' } } };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      state.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw });
      const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'invalid_token' });
      if (state.status !== 200) return send(state.status, { error: 'x' }, state.retryAfter ? { 'retry-after': String(state.retryAfter) } : {});
      if (req.method === 'GET' && req.url === '/mailbox-status') return send(200, { generated_at: new Date().toISOString(), mailboxes: state.mailboxes });
      const m = req.url.match(/^\/api\/courier\/messages\/([^/]+)(\/receipt)?$/);
      if (m && req.method === 'GET' && !m[2]) return state.letters[m[1]] ? send(200, state.letters[m[1]]) : send(404, { error: 'not found' });
      if (m && req.method === 'POST' && m[2]) { state.receipts.push(m[1]); return send(201, { ok: true }); }
      send(404, { error: 'not found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return Object.assign(state, { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
}
