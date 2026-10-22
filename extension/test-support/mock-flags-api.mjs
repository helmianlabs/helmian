// A stand-in for the Flags API (Paul's, not yet published). Implements only the
// provisional contract background/flags-client.js codes against, and records
// every request so tests can check exactly what left the browser.
import http from 'node:http';

export async function startMockFlagsApi({ token = 'flags-token-aaaaaaaaaaaaaaaaaaaa', status = 200 } = {}) {
  const requests = [];
  const state = { status };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"unauthorized"}');
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/flags') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not-found"}');
        return;
      }
      const parsed = body ? JSON.parse(body) : { flags: [] };
      res.writeHead(state.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state.status < 300 ? { accepted: parsed.flags.length } : { error: 'mock-failure' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, token, requests, state, close: () => new Promise((r) => server.close(r)) };
}

export function memoryStorage() {
  const bag = new Map();
  return {
    bag,
    async get(key) { return bag.has(key) ? structuredClone(bag.get(key)) : undefined; },
    async set(key, value) { bag.set(key, structuredClone(value)); },
  };
}
