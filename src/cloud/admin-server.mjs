import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildCloudAdminControlSurface } from './admin-control-plane.mjs';
import { searchNormalizedSampleLoads } from './load-board-provider-registry.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = join(here, '..', '..', 'web', 'cloud-admin', 'index.html');
export const DEFAULT_CLOUD_ADMIN_PORT = 7430;

function loopback(host) { return ['127.0.0.1', 'localhost', '::1'].includes(String(host).toLowerCase()); }
function send(response, status, body, type = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(body);
}

export async function startHelmianCloudAdmin({ host = '127.0.0.1', port = DEFAULT_CLOUD_ADMIN_PORT } = {}) {
  if (!loopback(host)) throw new Error('The sample Cloud admin service only binds loopback; a real cloud identity gateway is required before public bind.');
  const page = await readFile(pagePath, 'utf8');
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/') return send(response, 200, page, 'text/html; charset=utf-8');
    const scope = { tenant_id: url.searchParams.get('tenant_id') ?? '', actor_role: url.searchParams.get('actor_role') ?? '' };
    if (request.method === 'GET' && url.pathname === '/api/control-surface') {
      const result = buildCloudAdminControlSurface(scope); return send(response, result.valid ? 200 : 400, JSON.stringify(result));
    }
    if (request.method === 'GET' && url.pathname === '/api/sample-loads') {
      const criteria = Object.fromEntries(['origin', 'destination', 'equipment', 'pickup_date']
        .map((key) => [key, url.searchParams.get(key)])
        .filter(([, value]) => value != null && value !== ''));
      const result = searchNormalizedSampleLoads({ ...scope, provider_id: url.searchParams.get('provider_id') ?? 'dat', criteria });
      return send(response, result.valid ? 200 : 400, JSON.stringify(result));
    }
    send(response, 404, JSON.stringify({ valid: false, code: 'CLOUD_ADMIN_ROUTE_NOT_FOUND' }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const address = server.address();
  return { url: `http://${host}:${address.port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}
