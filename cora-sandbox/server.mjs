// Cora sandbox HTTP server. Binds to 127.0.0.1 by default; Caddy proxies to it.
// Inside Docker set CORA_SANDBOX_HOST=0.0.0.0 and publish only as 127.0.0.1:8110:8110.
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export function createServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && new URL(req.url, 'http://localhost').pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.CORA_SANDBOX_PORT || 8110);
  const host = process.env.CORA_SANDBOX_HOST || '127.0.0.1';
  createServer().listen(port, host, () => {
    console.log(`cora-sandbox listening on ${host}:${port}`);
  });
}
