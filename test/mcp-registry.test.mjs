// MCP Registry client + curation + catalog Source 3 tests.
//
// The registry fixtures below are RECORDED from the live registry
// (registry.modelcontextprotocol.io, pulled 2026-11-10 during the
// curation pass) and trimmed to the fields the client reads —
// names, versions, remotes, statuses and timestamps are the live
// values. The 'deleted' list item is synthetic (same shape): no
// deleted record was pulled live, and the branch still needs a pin.
// NO test in this file touches the network: the client is always
// built on a fake fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMcpRegistryClient,
  normalizeRegistryEntry,
  McpRegistryError,
} from '../src/cloud/mcp-registry.mjs';
import {
  REGISTRY_PICKS,
  registryPicksForSeat,
  registryPickByEntryId,
  checkPickAgainstCandidate,
} from '../src/cloud/mcp-registry-curation.mjs';
import {
  LIVE_SEATS,
  CONNECTOR_CATALOG,
  catalogEntriesForSeat,
  catalogEntryById,
  createCatalogRefresh,
} from '../src/cloud/connector-catalog.mjs';

const official = (status, at) => ({
  _meta: {
    'io.modelcontextprotocol.registry/official': {
      status, statusChangedAt: at, publishedAt: at, updatedAt: at, isLatest: true,
    },
  },
});

const WEATHER_RECORD = {
  server: {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    name: 'io.github.cyanheads/nws-weather-mcp-server',
    description: 'Get US weather forecasts, active alerts, and current observations.',
    repository: { url: 'https://github.com/cyanheads/nws-weather-mcp-server' },
    version: '0.12.0',
    packages: [{ registryType: 'npm', identifier: '@cyanheads/nws-weather-mcp-server' }],
    remotes: [{ type: 'streamable-http', url: 'https://nws.caseyjhand.com/mcp' }],
  },
  ...official('active', '2026-10-28T07:43:28.575795Z'),
};

const ATLASSIAN_RECORD = {
  server: {
    name: 'com.atlassian/atlassian-mcp-server',
    title: 'Atlassian Rovo MCP Server',
    description: 'Connect to Atlassian Jira, Confluence, Loom, and more to search, create, and manage your work.',
    repository: { url: 'https://github.com/atlassian/atlassian-mcp-server' },
    version: '2.0.0',
    remotes: [
      { type: 'streamable-http', url: 'https://mcp.atlassian.com/v2/mcp' },
      { type: 'streamable-http', url: 'https://mcp.atlassian.com/v1/mcp/authv2' },
    ],
  },
  ...official('active', '2026-09-09T17:53:32.01107Z'),
};

const NOTION_RECORD = {
  server: {
    name: 'com.notion/mcp',
    description: 'Official Notion MCP server',
    version: '1.0.1',
    remotes: [
      { type: 'streamable-http', url: 'https://mcp.notion.com/mcp' },
      { type: 'sse', url: 'https://mcp.notion.com/sse' },
    ],
  },
  ...official('active', '2025-09-11T22:25:50.737872Z'),
};

const LINEAR_RECORD = {
  server: {
    name: 'app.linear/linear',
    title: 'Linear',
    description: 'Find and manage issues, projects, and documents in your Linear workspace.',
    version: '1.0.2',
    remotes: [
      { type: 'streamable-http', url: 'https://mcp.linear.app/mcp' },
      { type: 'streamable-http', url: 'https://mcp.linear.app/mcp/readonly' },
    ],
  },
  ...official('active', '2026-10-22T16:47:17.1938Z'),
};

const STRIPE_RECORD = {
  server: {
    name: 'com.stripe/mcp',
    description: 'MCP server integrating with Stripe - tools for customers, products, payments, and more.',
    repository: { url: 'https://github.com/stripe/agent-toolkit' },
    version: '0.2.4',
    remotes: [{ type: 'streamable-http', url: 'https://mcp.stripe.com' }],
  },
  ...official('active', '2025-10-28T22:06:18.495159Z'),
};

// A real deprecated listing, as the live registry returned it.
const DEPRECATED_RECORD = {
  server: {
    name: 'io.github.CSOAI-ORG/meok-stripe-acp-checkout-mcp',
    description: 'MEOK Stripe ACP Checkout MCP',
    version: '1.0.0',
    remotes: [{ type: 'streamable-http', url: 'https://api.meok.ai/v1/a2a/stripe-acp-checkout' }],
  },
  ...official('deprecated', '2026-10-20T00:00:00.000Z'),
};

// Synthetic, same shape — the deleted branch's pin.
const DELETED_RECORD = {
  server: {
    name: 'io.github.example/removed-server',
    description: 'A listing the registry removed.',
    version: '0.1.0',
    remotes: [{ type: 'streamable-http', url: 'https://removed.example.com/mcp' }],
  },
  ...official('deleted', '2026-10-20T00:00:00.000Z'),
};

// A packages-only listing (recorded): software to run, no remote.
const PACKAGES_ONLY_RECORD = {
  server: {
    name: 'io.ausdata/au-weather-mcp',
    description: 'Query Australian weather + air quality — forecasts, current obs, 80yr archive (BOM).',
    repository: { url: 'https://github.com/Bigred97/au-weather-mcp' },
    version: '1.0.0',
    packages: [{ registryType: 'npm', identifier: 'au-weather-mcp' }],
  },
  ...official('active', '2026-10-20T00:00:00.000Z'),
};

const RECORD_BY_PICK = {
  'registry-weather': WEATHER_RECORD,
  'registry-atlassian': ATLASSIAN_RECORD,
  'registry-notion': NOTION_RECORD,
  'registry-linear': LINEAR_RECORD,
  'registry-stripe': STRIPE_RECORD,
};

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// ------------------------------------------------------------ normalize

test('normalize: a recorded record becomes a candidate with its reachable remote', () => {
  const candidate = normalizeRegistryEntry(WEATHER_RECORD);
  assert.equal(candidate.registryName, 'io.github.cyanheads/nws-weather-mcp-server');
  assert.equal(candidate.version, '0.12.0');
  assert.equal(candidate.status, 'active');
  assert.equal(candidate.isLatest, true);
  assert.equal(candidate.repositoryUrl, 'https://github.com/cyanheads/nws-weather-mcp-server');
  assert.deepEqual(candidate.remotes, [{ transport: 'streamable-http', url: 'https://nws.caseyjhand.com/mcp' }]);
  assert.equal(candidate.remoteUrl, 'https://nws.caseyjhand.com/mcp');
  assert.deepEqual(candidate.packages, [{ registryType: 'npm', identifier: '@cyanheads/nws-weather-mcp-server' }]);
});

test('normalize: the Streamable HTTP remote wins over an SSE sibling; packages-only has no remoteUrl', () => {
  const sseFirst = {
    server: {
      name: 'io.github.example/two-transports',
      description: 'Both transports, SSE declared first.',
      version: '1.0.0',
      remotes: [
        { type: 'sse', url: 'https://example.com/sse' },
        { type: 'streamable-http', url: 'https://example.com/mcp' },
      ],
    },
    ...official('active', '2026-10-20T00:00:00.000Z'),
  };
  assert.equal(normalizeRegistryEntry(sseFirst).remoteUrl, 'https://example.com/mcp');
  const packagesOnly = normalizeRegistryEntry(PACKAGES_ONLY_RECORD);
  assert.equal(packagesOnly.remoteUrl, null);
  assert.deepEqual(packagesOnly.remotes, []);
  assert.equal(normalizeRegistryEntry(null), null);
  assert.equal(normalizeRegistryEntry({ server: { description: 'no name' } }), null);
});

// ------------------------------------------------------------ listServers

test('listServers: pages by cursor, asks for latest, excludes deprecated and deleted', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (!String(url).includes('cursor=')) {
      return jsonResponse({ servers: [WEATHER_RECORD, NOTION_RECORD], metadata: { nextCursor: 'c2', count: 2 } });
    }
    return jsonResponse({ servers: [DEPRECATED_RECORD, DELETED_RECORD, STRIPE_RECORD], metadata: { count: 3 } });
  };
  const client = createMcpRegistryClient({ fetchImpl });
  const { candidates, pages, truncated } = await client.listServers({ search: 'weather' });
  assert.equal(pages, 2);
  assert.equal(truncated, false);
  assert.deepEqual(
    candidates.map((c) => c.registryName),
    ['io.github.cyanheads/nws-weather-mcp-server', 'com.notion/mcp', 'com.stripe/mcp'],
    'deprecated and deleted listings never reach the shelf pull',
  );
  assert.ok(seen[0].includes('version=latest') && seen[0].includes('search=weather'), 'first page asks for latest + the search');
  assert.ok(seen[1].includes('cursor=c2'), 'second page follows the cursor');
});

test('listServers: a pull stopped by maxPages reports itself truncated, never complete', async () => {
  const fetchImpl = async () => jsonResponse({ servers: [WEATHER_RECORD], metadata: { nextCursor: 'always-more', count: 1 } });
  const client = createMcpRegistryClient({ fetchImpl });
  const { candidates, pages, truncated } = await client.listServers({ maxPages: 2 });
  assert.equal(pages, 2);
  assert.equal(candidates.length, 2);
  assert.equal(truncated, true);
});

test('listServers: registry failures throw named errors — a silent empty list is impossible', async () => {
  const unreachable = createMcpRegistryClient({ fetchImpl: async () => { throw new Error('socket closed'); } });
  await assert.rejects(() => unreachable.listServers(), (e) => e instanceof McpRegistryError && e.code === 'MCP_REGISTRY_UNREACHABLE');
  const httpError = createMcpRegistryClient({ fetchImpl: async () => jsonResponse({}, 503) });
  await assert.rejects(() => httpError.listServers(), (e) => e.code === 'MCP_REGISTRY_HTTP_ERROR');
  const badJson = createMcpRegistryClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }),
  });
  await assert.rejects(() => badJson.listServers(), (e) => e.code === 'MCP_REGISTRY_BAD_RESPONSE');
  const wrongShape = createMcpRegistryClient({ fetchImpl: async () => jsonResponse({ nope: true }) });
  await assert.rejects(() => wrongShape.listServers(), (e) => e.code === 'MCP_REGISTRY_BAD_RESPONSE');
});

// ------------------------------------------------------------ getServer

test('getServer: the fact-checking road — record as it stands, 404 is null', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (String(url).includes(encodeURIComponent('com.stripe/mcp'))) return jsonResponse(STRIPE_RECORD);
    if (String(url).includes(encodeURIComponent('io.github.CSOAI-ORG/meok-stripe-acp-checkout-mcp'))) return jsonResponse(DEPRECATED_RECORD);
    return jsonResponse({ error: 'not found' }, 404);
  };
  const client = createMcpRegistryClient({ fetchImpl });
  const stripe = await client.getServer('com.stripe/mcp');
  assert.equal(stripe.remoteUrl, 'https://mcp.stripe.com');
  const deprecated = await client.getServer('io.github.CSOAI-ORG/meok-stripe-acp-checkout-mcp');
  assert.equal(deprecated.status, 'deprecated', 'a deprecated record is returned with its status visible, not filtered');
  assert.equal(await client.getServer('io.github.example/absent'), null);
  assert.ok(seen.every((u) => u.includes('/versions/latest')), 'every lookup reads the latest version record');
});

// ------------------------------------------------------------ curation

test('curation: every pick rules clean against its recorded live record', () => {
  for (const pick of REGISTRY_PICKS) {
    const candidate = normalizeRegistryEntry(RECORD_BY_PICK[pick.entryId]);
    const { ok, problems } = checkPickAgainstCandidate(pick, candidate);
    assert.ok(ok, `${pick.entryId}: ${problems.join('; ')}`);
  }
});

test('curation: drift, deprecation, and disappearance are all named problems', () => {
  const pick = registryPickByEntryId('registry-notion');
  const moved = { ...normalizeRegistryEntry(NOTION_RECORD), remoteUrl: 'https://mcp.notion.com/moved', remotes: [{ transport: 'streamable-http', url: 'https://mcp.notion.com/moved' }] };
  assert.match(checkPickAgainstCandidate(pick, moved).problems.join(' '), /endpoint drift/);
  const deprecated = { ...normalizeRegistryEntry(NOTION_RECORD), status: 'deprecated' };
  assert.equal(checkPickAgainstCandidate(pick, deprecated).ok, false);
  assert.match(checkPickAgainstCandidate(pick, null).problems.join(' '), /no longer in the registry/);
  const packagesOnly = normalizeRegistryEntry(PACKAGES_ONLY_RECORD);
  assert.equal(checkPickAgainstCandidate(pick, packagesOnly).ok, false);
});

test('curation: the picks are well-formed shelf data', () => {
  const ids = new Set(REGISTRY_PICKS.map((p) => p.entryId));
  assert.equal(ids.size, REGISTRY_PICKS.length, 'pick entry ids are unique');
  for (const pick of REGISTRY_PICKS) {
    assert.ok(pick.entryId.startsWith('registry-'), `${pick.entryId}: prefixed id`);
    assert.ok(pick.endpoint.startsWith('https://'), `${pick.entryId}: HTTPS endpoint`);
    assert.ok(['oauth', 'none', 'header'].includes(pick.authMode), `${pick.entryId}: a real auth mode`);
    assert.ok(pick.seats === 'all' || pick.seats.every((s) => LIVE_SEATS.includes(s)), `${pick.entryId}: seats are live seats`);
  }
});

// ------------------------------------------------------------ catalog wiring

test('catalog: the picks stock the seats the placement law names, as community Helmian listings', () => {
  // ffebe55e baseline: 54 day-one entries. Source 3 adds 21:
  // weather ×14 seats, atlassian ×1, notion ×3, linear ×2, stripe ×1.
  // Source 4 (the vendor-published Vercel server, Helmian-brokered)
  // adds 1 entry on each of claude, chatgpt, grok: 78 in all. The
  // Source 4 entry itself is pinned in connector-vercel.test.mjs.
  // Bite R2 adds the team-work family to Source 4 — Slack, Asana,
  // HubSpot, one brokered entry on each of claude, chatgpt, grok
  // (+9) — and the Figma mirror row on claude and chatgpt (+2):
  // 89 in all. The R2 entries are pinned in
  // connector-r2-team-work.test.mjs.
  assert.equal(CONNECTOR_CATALOG.length, 89);
  for (const seatId of LIVE_SEATS) {
    const defs = catalogEntriesForSeat(seatId);
    for (const pick of registryPicksForSeat(seatId)) {
      const def = defs.find((d) => d.id === pick.entryId);
      assert.ok(def, `${seatId}/${pick.entryId}: stocked`);
      assert.equal(def.kind, 'catalog');
      assert.equal(def.brokerMode, 'helmian', `${seatId}/${pick.entryId}: a reachable pipe, Helmian-brokered`);
      assert.equal(def.trustLabel, 'community', `${seatId}/${pick.entryId}: registry imports are never labelled verified`);
      assert.equal(def.mcpEndpointUrl, pick.endpoint);
      assert.equal(def.authMode, pick.authMode);
      assert.equal(def.registryName, pick.registryName, 'provenance rides the definition');
      assert.equal(def.addedBy, 'system');
    }
    const ids = new Set(defs.map((d) => d.id));
    assert.equal(ids.size, defs.length, `${seatId}: no id collisions with mirrors or natives`);
  }
  // Placement spot-pins: the weather pick rides every seat; service
  // picks ride only the seats carrying that service's mirror today.
  for (const seatId of LIVE_SEATS) assert.ok(catalogEntryById(seatId, 'registry-weather'), `${seatId}: weather stocked`);
  assert.ok(catalogEntryById('claude', 'registry-atlassian'));
  assert.equal(catalogEntryById('chatgpt', 'registry-atlassian'), null);
  assert.ok(catalogEntryById('grok', 'registry-notion'));
  assert.equal(catalogEntryById('gemini', 'registry-notion'), null);
  assert.ok(catalogEntryById('claude', 'registry-stripe'));
  assert.equal(catalogEntryById('grok', 'registry-stripe'), null);
});

test('catalog: stocking the shelf changed no mirror and no native', () => {
  const byId = (seat, id) => catalogEntryById(seat, id);
  assert.equal(byId('claude', 'atlassian').brokerMode, 'vendor', 'the Atlassian mirror is still a mirror');
  assert.equal(byId('claude', 'github').brokerMode, 'vendor');
  assert.equal(byId('grok', 'vercel').brokerMode, 'vendor');
  assert.equal(byId('grok', 'github').brokerMode, 'helmian', 'the pre-existing Helmian GitHub pipe is untouched');
  for (const seatId of LIVE_SEATS) {
    assert.equal(byId(seatId, 'helmian-github').kind, 'helmian-native');
    assert.equal(byId(seatId, 'helmian-github').trustLabel, 'verified', 'the native keeps the label it earned');
  }
});

test('refresh road: the seed/heal refresh carries the registry definitions like any catalog data', async () => {
  const recorded = [];
  const fakeStore = {
    createEntry: async (tenantId, subject, def) => { recorded.push(def); return def; },
  };
  const refresh = createCatalogRefresh({ libraryStore: fakeStore, subject: 'system' });
  const claude = await refresh.refreshSeat('tenant-a', 'claude');
  assert.deepEqual(claude.conflicts, []);
  for (const entryId of ['registry-weather', 'registry-atlassian', 'registry-notion', 'registry-linear', 'registry-stripe']) {
    assert.ok(claude.applied.includes(entryId), `claude seed applies ${entryId}`);
    const def = recorded.find((d) => d.seatId === 'claude' && d.id === entryId);
    assert.equal(def.brokerMode, 'helmian');
    assert.equal(def.trustLabel, 'community');
  }
  const mistral = await refresh.refreshSeat('tenant-a', 'mistral');
  assert.deepEqual(mistral.applied, ['registry-weather', 'helmian-github'], 'a seat with no vendor directory seeds the shelf pick and the native');
});
