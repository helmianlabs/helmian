// Connector catalog read + routes (brief §(e) bite 2): card shaping
// from the bite 1 mirror rows, the live tools handshake against a
// fake fetch, and the route layer's own laws — member gate, seat
// validation, authority selectors refused, and the tools read
// resolving its endpoint from the catalog row, never the request.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  browseCardFromRow,
  createCatalogRead,
  featuredCardFromPick,
  fetchServerTools,
  parseMcpPayload,
} from '../src/cloud/connector-catalog-read.mjs';
import { handleConnectorCatalogRoute } from '../src/cloud/connector-catalog-route.mjs';
import { REGISTRY_PICKS } from '../src/cloud/mcp-registry-curation.mjs';

class TenantAuthorizationError extends Error {}
const ACTOR = { subject: 'user:troy', tenantId: 'tenant-a', role: 'owner' };
const activeTenantActor = async () => ACTOR;

function harness() {
  const sent = [];
  return {
    sent,
    send: (response, status, body) => { sent.push({ status, body: JSON.parse(body) }); },
    response: {},
  };
}
const req = (path) => ({
  request: { method: 'GET' },
  requestUrl: new URL(`https://helmian.cloud${path}`),
  activeTenantActor,
  TenantAuthorizationError,
});

const linearPick = REGISTRY_PICKS.find((pick) => pick.entryId === 'registry-linear');
const linearRow = {
  registry_name: 'app.linear/linear', repository_url: null, website_url: 'https://linear.app',
  version: '1.0.2', remotes: [{ transport: 'streamable-http', url: 'https://mcp.linear.app/mcp' }],
  curated: true, endpoint_live: true,
};

test('featured card: the pick over its mirror row', () => {
  const card = featuredCardFromPick(linearPick, linearRow);
  assert.equal(card.name, 'Linear');
  assert.equal(card.vendorName, 'Linear');
  assert.equal(card.authMode, 'oauth');
  assert.equal(card.endpoint, 'https://mcp.linear.app/mcp');
  assert.equal(card.endpointHost, 'mcp.linear.app');
  assert.equal(card.sourceUrl, 'https://linear.app');
  assert.equal(card.curated, true);
  assert.equal(card.inCatalog, true);
});

test('featured card: a pick with no mirror row still renders, honestly uncurated', () => {
  const card = featuredCardFromPick(linearPick, null);
  assert.equal(card.inCatalog, false);
  assert.equal(card.curated, false);
  assert.equal(card.endpoint, 'https://mcp.linear.app/mcp');
  assert.equal(card.endpointLive, null);
});

test('browse card: title falls back to the name tail, host from the remote', () => {
  const card = browseCardFromRow({
    registry_name: 'com.example/deep-research', publisher: 'com.example', title: null,
    description: 'd', repository_url: 'https://github.com/example/dr', website_url: null,
    source_kind: 'repository', version: '2.0.0',
    remotes: [{ transport: 'streamable-http', url: 'https://dr.example.com/mcp' }], endpoint_live: true,
  });
  assert.equal(card.name, 'deep-research');
  assert.equal(card.endpointHost, 'dr.example.com');
  assert.equal(card.sourceUrl, 'https://github.com/example/dr');
});

test('parseMcpPayload: plain JSON and SSE both land', () => {
  assert.deepEqual(parseMcpPayload('{"result":{"tools":[]}}', 'application/json'), { result: { tools: [] } });
  const sse = 'event: message\ndata: {"result":{"tools":[{"name":"a"}]}}\n\n';
  assert.deepEqual(parseMcpPayload(sse, 'text/event-stream'), { result: { tools: [{ name: 'a' }] } });
  assert.equal(parseMcpPayload('not json', 'application/json'), null);
});

function fakeMcpFetch({ initStatus = 200, listStatus = 200, session = 'sess-1' } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ method: body.method, sessionHeader: options.headers['mcp-session-id'] ?? null });
    const headers = new Map();
    if (body.method === 'initialize' && session) headers.set('mcp-session-id', session);
    const status = body.method === 'initialize' ? initStatus : body.method === 'tools/list' ? listStatus : 202;
    const payload = body.method === 'tools/list'
      ? { result: { tools: [{ name: 'nws_get_forecast', description: 'forecast' }] } }
      : { result: {} };
    return {
      status,
      headers: { get: (name) => headers.get(name.toLowerCase()) ?? (name === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify(payload),
    };
  };
  return { fetchImpl, calls };
}

test('fetchServerTools: the handshake carries the session and returns the tools', async () => {
  const { fetchImpl, calls } = fakeMcpFetch({});
  const result = await fetchServerTools('https://x.example.com/mcp', { fetchImpl });
  assert.equal(result.state, 'open');
  assert.deepEqual(result.tools, [{ name: 'nws_get_forecast', description: 'forecast' }]);
  assert.deepEqual(calls.map((c) => c.method), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.equal(calls[2].sessionHeader, 'sess-1');
});

test('fetchServerTools: a 401 at initialize is the auth state, and a throw is unreachable', async () => {
  const { fetchImpl } = fakeMcpFetch({ initStatus: 401 });
  assert.deepEqual(await fetchServerTools('https://x.example.com/mcp', { fetchImpl }), { state: 'auth', tools: [] });
  const down = async () => { throw new Error('getaddrinfo failed'); };
  const result = await fetchServerTools('https://gone.example.com/mcp', { fetchImpl: down });
  assert.equal(result.state, 'unreachable');
  assert.deepEqual(result.tools, []);
});

test('route: cards answer for a named seat and default to the first live seat', async () => {
  const read = {
    readCards: async ({ seatId }) => ({ featured: [{ seatId }], browse: [], totals: { listings: 10, curated: 4 } }),
    readToolsEndpoint: async () => null,
  };
  const h = harness();
  const handled = await handleConnectorCatalogRoute({ ...h, ...req('/api/admin/connector-catalog?seat=gemini'), read });
  assert.equal(handled, true);
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.sent[0].body.seatId, 'gemini');
  assert.equal(h.sent[0].body.totals.curated, 4);
  const h2 = harness();
  await handleConnectorCatalogRoute({ ...h2, ...req('/api/admin/connector-catalog'), read });
  assert.equal(h2.sent[0].body.seatId, 'claude');
});

test('route: unknown seat 400, authority selector 400, foreign path not ours', async () => {
  const read = { readCards: async () => ({ featured: [], browse: [], totals: {} }), readToolsEndpoint: async () => null };
  const h = harness();
  await handleConnectorCatalogRoute({ ...h, ...req('/api/admin/connector-catalog?seat=nobody'), read });
  assert.equal(h.sent[0].status, 400);
  assert.equal(h.sent[0].body.code, 'CONNECTOR_CATALOG_SEAT_INVALID');
  const h2 = harness();
  await handleConnectorCatalogRoute({ ...h2, ...req('/api/admin/connector-catalog?tenant_id=other'), read });
  assert.equal(h2.sent[0].status, 400);
  const h3 = harness();
  const handled = await handleConnectorCatalogRoute({ ...h3, ...req('/api/admin/something-else'), read });
  assert.equal(handled, false);
  assert.equal(h3.sent.length, 0);
});

test('route: tools resolve the endpoint from the catalog row; unknown name 404', async () => {
  const seen = [];
  const read = {
    readCards: async () => ({ featured: [], browse: [], totals: {} }),
    readToolsEndpoint: async (name) => (name === 'app.linear/linear' ? 'https://mcp.linear.app/mcp' : null),
  };
  const tools = async (endpoint) => { seen.push(endpoint); return { state: 'auth', tools: [] }; };
  const h = harness();
  await handleConnectorCatalogRoute({ ...h, ...req('/api/admin/connector-catalog/tools?name=app.linear%2Flinear'), read, tools });
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.sent[0].body.state, 'auth');
  assert.deepEqual(seen, ['https://mcp.linear.app/mcp']);
  const h2 = harness();
  await handleConnectorCatalogRoute({ ...h2, ...req('/api/admin/connector-catalog/tools?name=nope%2Fnope'), read, tools });
  assert.equal(h2.sent[0].status, 404);
});

test('the read: featured join and browse cap run over the pool', async () => {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push(sql);
      if (sql.includes('any($1)')) return { rows: [linearRow] };
      if (sql.includes('curated = true')) return { rows: [] };
      return { rows: [{ listings: 71827, curated: 33517 }] };
    },
  };
  const read = createCatalogRead({ pool });
  const result = await read.readCards({ seatId: 'claude' });
  assert.equal(result.featured.length, REGISTRY_PICKS.length);
  assert.equal(result.featured.find((c) => c.entryId === 'registry-linear').curated, true);
  assert.equal(result.totals.curated, 33517);
  assert.equal(await read.readToolsEndpoint('app.linear/linear'), null); // totals query shape answers no remotes
});
