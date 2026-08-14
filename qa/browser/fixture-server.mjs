import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../web/cloud-admin/', import.meta.url));
const port = Number(process.env.HELMION_UI_FIXTURE_PORT ?? 4177);
const MIME = Object.freeze({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' });

function cookie(request, name) {
  const prefix = `${name}=`;
  return String(request.headers.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length) ?? '';
}

function json(response, body, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://fixture.local');
  if (url.pathname === '/admin/' && request.method === 'GET') {
    const role = url.searchParams.get('role') === 'admin' ? 'admin' : 'member';
    const state = ['empty', 'reconnecting', 'revoked', 'pollingFallback'].includes(url.searchParams.get('envoy')) ? url.searchParams.get('envoy') : 'connected';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': [`ui_fixture_role=${role}; Path=/`, `ui_fixture_envoy=${state}; Path=/`] });
    response.end(await readFile(join(root, 'index.html')));
    return;
  }
  const asset = url.pathname === '/admin/assets/app.js' ? 'app.js' : url.pathname.startsWith('/admin/assets/') ? url.pathname.slice('/admin/assets/'.length) : null;
  if (asset && request.method === 'GET' && !asset.includes('..')) {
    const safe = normalize(join(root, asset));
    if (safe.startsWith(normalize(root))) { response.writeHead(200, { 'content-type': MIME[extname(asset)] ?? 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); response.end(await readFile(safe)); return; }
  }
  if (url.pathname.startsWith('/api/admin/')) {
    const role = cookie(request, 'ui_fixture_role') === 'admin' ? 'admin' : 'member';
    const state = cookie(request, 'ui_fixture_envoy') || 'connected';
    if (url.pathname === '/api/admin/session') return json(response, { authenticated: true, actor: { subject: `fixture-${role}`, tenantId: 'fixture-organization', role } });
    if (url.pathname === '/api/admin/envoy/channels') return json(response, { channels: state === 'empty' ? [] : [{ id: 'fixture-channel', title: 'Operations', slug: 'operations', kind: 'team' }] });
    if (url.pathname === '/api/admin/envoy/messages') return json(response, { messages: [], nextCursor: null });
    if (url.pathname === '/api/admin/envoy/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-cache', 'x-content-type-options': 'nosniff' });
      if (state === 'revoked') response.end('event: envoy_error\ndata: {"code":"ENVOY_MEMBERSHIP_REVOKED","retryable":false}\n\n');
      else response.end('event: ready\ndata: {"status":"connected","cursor":null}\n\n');
      return;
    }
    if (url.pathname === '/api/admin/events') return json(response, { events: [] });
    if (url.pathname === '/api/admin/workspace') return json(response, { workspace: { agents: ['Maestro', 'Claude', 'ChatGPT', 'Grok', 'Gemini'].map((label) => ({ label, status: 'idle', lastAction: null })) } });
    if (url.pathname === '/api/admin/control-surface') return json(response, { result: { authorization: 'fixture_membership_verified' } });
    if (url.pathname === '/api/admin/action-policy') return json(response, { policy: { version: 0, source: 'fixture', enabledActions: [] }, allowedActions: [] });
    if (url.pathname === '/api/admin/cora/config') return json(response, { status: 'published', config: { style: 'professional_brief', interruptMode: 'barge_in', turnMode: 'concise' } });
    if (url.pathname === '/api/admin/cora/knowledge-sources') return json(response, { sources: [] });
    if (url.pathname === '/api/admin/cora/knowledge/query') return json(response, { status: 'no_approved_source_match', excerpts: [], answer: null, providerCall: 'not_performed' });
    if (url.pathname === '/api/admin/cora/usage') return json(response, { source: 'tenant_append_only_ledger', budget: null, totals: { eventCount: 0, estimatedCostMinor: null, reconciledCostMinor: null }, providerCalls: 'not_performed' });
    if (url.pathname === '/api/admin/cora/workspace/previews' || url.pathname === '/api/admin/cora/tasks') return json(response, { receipts: [] });
    return json(response, { valid: true, receipt: { durable: true, replayed: false } });
  }
  response.writeHead(404); response.end('not found');
});

server.listen(port, '127.0.0.1', () => console.log(`Helmian Cloud UI fixture server listening on http://127.0.0.1:${port}/admin/`));
