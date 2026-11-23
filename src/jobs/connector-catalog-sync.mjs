// Connector catalog sync (connector catalog brief §(e), bite 1): the
// nightly pull of the official MCP Registry into Helmian's own catalog
// tables (sql/098), behind the curation funnel in
// src/cloud/connector-catalog-mirror.mjs.
//
//   node src/jobs/connector-catalog-sync.mjs
//
// Reads HELMION_DATABASE_URL from the environment, the fleet's database
// convention. A failed pull is a failed run — the sync-run row says so
// and the process exits non-zero; nothing here ever writes a partial
// pull over a good mirror and calls it fresh (the upserts land only
// after the whole walk and probe complete).
//
// Paging honesty, learned on the research crawl: the registry drops
// connections under brisk paging, so the walk paces itself and retries
// each page with backoff before it gives up, and the give-up is loud.

import {
  MCP_REGISTRY_BASE_URL,
  MCP_REGISTRY_API_PATH,
  normalizeRegistryEntry,
} from '../cloud/mcp-registry.mjs';
import {
  BULK_PUBLISHER_MAX,
  curateCandidates,
  endpointVerdict,
  probeEndpoint,
} from '../cloud/connector-catalog-mirror.mjs';

const PAGE_LIMIT = 100;
const PAGE_PACE_MS = 400;
const PAGE_ATTEMPTS = 6;
const PROBE_CONCURRENCY = 16;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchPage(fetchImpl, url) {
  let lastError = null;
  for (let attempt = 1; attempt <= PAGE_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < PAGE_ATTEMPTS) await sleep(2000 * attempt);
    }
  }
  throw new Error(`the registry page at ${url} failed ${PAGE_ATTEMPTS} times: ${lastError?.message ?? lastError}`);
}

/** Walk every latest-version listing. Returns raw items beside their normalized candidates. */
export async function walkRegistry({ fetchImpl = globalThis.fetch, baseUrl = MCP_REGISTRY_BASE_URL } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const entries = [];
  let cursor = null;
  let pages = 0;
  do {
    const params = new URLSearchParams({ version: 'latest', limit: String(PAGE_LIMIT) });
    if (cursor) params.set('cursor', cursor);
    const body = await fetchPage(fetchImpl, `${base}${MCP_REGISTRY_API_PATH}?${params}`);
    if (!body || !Array.isArray(body.servers)) {
      throw new Error('the registry server list did not carry a servers array');
    }
    pages += 1;
    for (const item of body.servers) {
      const candidate = normalizeRegistryEntry(item);
      if (candidate) entries.push({ raw: item?.server ?? item, candidate });
    }
    cursor = typeof body.metadata?.nextCursor === 'string' && body.metadata.nextCursor
      ? body.metadata.nextCursor
      : null;
    if (cursor) await sleep(PAGE_PACE_MS);
  } while (cursor);
  return { entries, pages };
}

async function probeAll(rows, probeImpl) {
  const targets = rows.filter((row) => row.probeTarget);
  let next = 0;
  async function worker() {
    while (next < targets.length) {
      const row = targets[next];
      next += 1;
      const verdict = endpointVerdict(await probeImpl(row.probeTarget));
      row.endpointLive = verdict.live;
      row.endpointDetail = verdict.detail;
    }
  }
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, () => worker()));
  return targets.filter((row) => row.endpointLive).length;
}

async function upsertServers(pool, rows) {
  // Statement 1: the listing itself, for every row the walk brought in.
  // A row that was not probed this run is not curated — it did not pass
  // this run's whole funnel — and its stored endpoint verdict is left
  // alone for statement 2 to refresh only where a probe actually ran.
  const CHUNK = 250;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const values = [];
    const params = [];
    chunk.forEach((row, i) => {
      const c = row.candidate;
      const base = i * 13;
      values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},now())`);
      params.push(
        c.registryName,
        row.publisher,
        c.title,
        c.description || null,
        c.version,
        c.repositoryUrl,
        c.websiteUrl,
        row.sourceKind,
        Array.isArray(row.raw?.icons) && typeof row.raw.icons[0]?.src === 'string' ? row.raw.icons[0].src : null,
        JSON.stringify(c.remotes ?? []),
        JSON.stringify(row.raw ?? {}),
        c.status,
        c.updatedAt,
      );
    });
    await pool.query(
      `insert into helmion.connector_catalog_servers
         (registry_name, publisher, title, description, version, repository_url, website_url,
          source_kind, icon_url, remotes, record, registry_status, registry_updated_at, last_synced_at)
       values ${values.join(',')}
       on conflict (registry_name) do update set
         publisher = excluded.publisher,
         title = excluded.title,
         description = excluded.description,
         version = excluded.version,
         repository_url = excluded.repository_url,
         website_url = excluded.website_url,
         source_kind = excluded.source_kind,
         icon_url = excluded.icon_url,
         remotes = excluded.remotes,
         record = excluded.record,
         registry_status = excluded.registry_status,
         registry_updated_at = excluded.registry_updated_at,
         curated = false,
         last_synced_at = now()`,
      params,
    );
  }
  // Statement 2: the endpoint verdicts, for probed rows only.
  const probed = rows.filter((row) => row.probeTarget);
  for (let start = 0; start < probed.length; start += CHUNK) {
    const chunk = probed.slice(start, start + CHUNK);
    await pool.query(
      `update helmion.connector_catalog_servers as s set
         endpoint_live = v.live,
         endpoint_detail = v.detail,
         endpoint_checked_at = now(),
         curated = v.live
       from (select unnest($1::text[]) as registry_name,
                    unnest($2::boolean[]) as live,
                    unnest($3::text[]) as detail) as v
       where s.registry_name = v.registry_name`,
      [
        chunk.map((row) => row.candidate.registryName),
        chunk.map((row) => row.endpointLive === true),
        chunk.map((row) => row.endpointDetail ?? ''),
      ],
    );
  }
}

export async function runCatalogSync({ pool, fetchImpl = globalThis.fetch, probeImpl = probeEndpoint, log = console.log } = {}) {
  const runInsert = await pool.query(
    `insert into helmion.connector_catalog_sync_runs (bulk_publisher_max) values ($1) returning id`,
    [BULK_PUBLISHER_MAX],
  );
  const runId = runInsert.rows[0].id;
  try {
    const { entries, pages } = await walkRegistry({ fetchImpl });
    log(`catalog sync: walked ${pages} pages, ${entries.length} latest listings`);
    const { rows, funnel } = curateCandidates(entries.map((entry) => entry.candidate));
    // Re-attach the raw records the upsert needs (record jsonb, icons).
    const rawByName = new Map(entries.map((entry) => [entry.candidate.registryName, entry.raw]));
    for (const row of rows) row.raw = rawByName.get(row.candidate.registryName) ?? {};
    const liveCount = await probeAll(rows, (url) => probeImpl(url, { fetchImpl }));
    await upsertServers(pool, rows);
    await pool.query(
      `update helmion.connector_catalog_sync_runs set
         finished_at = now(), status = 'complete', fetched = $2, active_count = $3,
         with_remote_count = $4, source_linked_count = $5, non_bulk_count = $6,
         endpoint_live_count = $7, curated_count = $7
       where id = $1`,
      [runId, funnel.fetched, funnel.active, funnel.withRemote, funnel.sourceLinked, funnel.nonBulk, liveCount],
    );
    log(`catalog sync: run ${runId} complete — ${JSON.stringify({ ...funnel, endpointLive: liveCount })}`);
    return { runId, funnel, endpointLive: liveCount };
  } catch (error) {
    await pool.query(
      `update helmion.connector_catalog_sync_runs set finished_at = now(), status = 'failed', detail = $2 where id = $1`,
      [runId, String(error?.message ?? error).slice(0, 500)],
    ).catch(() => {});
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const connectionString = process.env.HELMION_DATABASE_URL;
  if (!connectionString) {
    console.error('HELMION_DATABASE_URL is required');
    process.exit(1);
  }
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('sslmode=disable') ? false : undefined,
  });
  runCatalogSync({ pool })
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`catalog sync failed: ${error?.message ?? error}`);
      process.exit(1);
    });
}
