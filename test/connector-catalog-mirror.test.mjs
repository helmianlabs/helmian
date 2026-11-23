// Connector catalog mirror (brief §(e) bite 1): the curation funnel over
// normalized registry candidates, the endpoint verdict, and the sync
// job's registry walk over a stubbed fetch. No network, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BULK_PUBLISHER_MAX,
  countPublishers,
  curateCandidates,
  endpointVerdict,
  probeEndpoint,
  publisherOf,
  sourceKindOf,
} from '../src/cloud/connector-catalog-mirror.mjs';
import { walkRegistry } from '../src/jobs/connector-catalog-sync.mjs';

function candidate(overrides = {}) {
  return {
    registryName: 'io.example/widget',
    title: 'Widget',
    description: 'A widget server',
    version: '1.0.0',
    status: 'active',
    isLatest: true,
    publishedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    repositoryUrl: 'https://github.com/example/widget',
    websiteUrl: null,
    remotes: [{ transport: 'streamable-http', url: 'https://widget.example.com/mcp' }],
    remoteUrl: 'https://widget.example.com/mcp',
    packages: [],
    ...overrides,
  };
}

test('publisherOf takes the namespace before the first slash', () => {
  assert.equal(publisherOf('io.github.owner/server'), 'io.github.owner');
  assert.equal(publisherOf('bare-name'), 'bare-name');
  assert.equal(publisherOf(''), '');
  assert.equal(publisherOf(null), '');
});

test('sourceKindOf prefers the repository, falls back to the website, else none', () => {
  assert.equal(sourceKindOf(candidate()), 'repository');
  assert.equal(sourceKindOf(candidate({ repositoryUrl: null, websiteUrl: 'https://widget.example.com' })), 'website');
  assert.equal(sourceKindOf(candidate({ repositoryUrl: null, websiteUrl: null })), 'none');
});

test('the funnel keeps a clean listing and counts every stage', () => {
  const { rows, funnel } = curateCandidates([candidate()]);
  assert.deepEqual(funnel, { fetched: 1, active: 1, withRemote: 1, sourceLinked: 1, nonBulk: 1 });
  assert.equal(rows[0].probeTarget, 'https://widget.example.com/mcp');
  assert.equal(rows[0].publisher, 'io.example');
  assert.equal(rows[0].sourceKind, 'repository');
});

test('each funnel stage drops its own failures and the counts still add up', () => {
  const { rows, funnel } = curateCandidates([
    candidate({ registryName: 'a.one/ok' }),
    candidate({ registryName: 'a.two/deprecated', status: 'deprecated' }),
    candidate({ registryName: 'a.three/local-only', remotes: [], remoteUrl: null }),
    candidate({ registryName: 'a.four/unlinked', repositoryUrl: null, websiteUrl: null }),
  ]);
  assert.deepEqual(funnel, { fetched: 4, active: 3, withRemote: 2, sourceLinked: 1, nonBulk: 1 });
  assert.equal(rows.filter((row) => row.probeTarget).length, 1);
  assert.equal(rows[1].stages.active, false);
  assert.equal(rows[2].stages.withRemote, false);
  assert.equal(rows[3].stages.sourceLinked, false);
});

test('a bulk publisher is cut at the named threshold, counted over the whole pull', () => {
  const bulk = Array.from({ length: BULK_PUBLISHER_MAX + 1 }, (_, i) =>
    candidate({ registryName: `spam.example/server-${i}` }));
  const { rows, funnel } = curateCandidates([...bulk, candidate({ registryName: 'io.example/widget' })]);
  assert.equal(countPublishers(bulk).get('spam.example'), BULK_PUBLISHER_MAX + 1);
  assert.equal(funnel.nonBulk, 1, 'only the small publisher survives the bulk stage');
  assert.ok(rows.filter((row) => row.publisher === 'spam.example').every((row) => row.probeTarget === null));
});

test('the bulk threshold is a caller choice, not a buried constant', () => {
  const pair = [candidate({ registryName: 'duo.example/a' }), candidate({ registryName: 'duo.example/b' })];
  assert.equal(curateCandidates(pair, { bulkPublisherMax: 1 }).funnel.nonBulk, 0);
  assert.equal(curateCandidates(pair, { bulkPublisherMax: 2 }).funnel.nonBulk, 2);
});

test('endpoint verdicts: any HTTP answer is live, transport failure is dead', () => {
  assert.deepEqual(endpointVerdict({ type: 'http', status: 200 }), { live: true, detail: 'HTTP 200' });
  assert.deepEqual(endpointVerdict({ type: 'http', status: 401 }), { live: true, detail: 'HTTP 401' });
  const dead = endpointVerdict({ type: 'error', message: 'getaddrinfo ENOTFOUND x' });
  assert.equal(dead.live, false);
  assert.match(dead.detail, /ENOTFOUND/);
});

test('probeEndpoint posts an MCP initialize and maps the outcome', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: init.method, body: JSON.parse(init.body) });
    return { status: 401 };
  };
  const outcome = await probeEndpoint('https://widget.example.com/mcp', { fetchImpl });
  assert.deepEqual(outcome, { type: 'http', status: 401 });
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].body.method, 'initialize');

  const failing = async () => { throw new Error('connect ECONNREFUSED'); };
  const dead = await probeEndpoint('https://dead.example.com/mcp', { fetchImpl: failing });
  assert.equal(dead.type, 'error');
  assert.match(dead.message, /ECONNREFUSED/);
});

test('walkRegistry pages to exhaustion and normalizes with the shared client logic', async () => {
  const page = (servers, nextCursor) => ({
    ok: true,
    status: 200,
    json: async () => ({ servers, metadata: nextCursor ? { nextCursor, count: servers.length } : { count: servers.length } }),
  });
  const item = (name) => ({
    server: { name, description: 'd', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://x.example.com/mcp' }] },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } },
  });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return calls.length === 1 ? page([item('a.one/first')], 'a.one/first:1.0.0') : page([item('a.two/second')], null);
  };
  const { entries, pages } = await walkRegistry({ fetchImpl, baseUrl: 'https://registry.example.com' });
  assert.equal(pages, 2);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].candidate.registryName, 'a.one/first');
  assert.equal(entries[0].candidate.remoteUrl, 'https://x.example.com/mcp');
  assert.match(calls[1], /cursor=a\.one%2Ffirst%3A1\.0\.0/);
});
