// Connector catalog MIRROR (connector catalog brief §(e), bite 1): the
// supply layer under the curated connector library. The library's picks
// (mcp-registry-curation.mjs) are named one by one by a person; this
// mirror is the whole official MCP Registry, pulled nightly into
// Helmian's own tables (sql/098) behind the brief's curation filters, so
// a later bite can open the curated mirror into the catalog without any
// surface ever reading the public firehose live.
//
// The funnel, in order, every stage counted on the sync run's row:
//   1. latest version only, registry status 'active' (the registry
//      client's own exclusion of deprecated/deleted stands upstream of
//      this module too — records arrive normalized by mcp-registry.mjs,
//      the one normalizer, never a second record logic);
//   2. the listing carries a remote endpoint (a cloud shelf can only
//      hand a person a server Helmian can actually reach);
//   3. source-linked: a repository URL, or failing that a website URL,
//      is on the record — a listing that links nowhere is not a listing
//      Helmian can stand behind;
//   4. the publisher is not a bulk publisher: its total latest listings
//      across the whole registry stay at or under BULK_PUBLISHER_MAX;
//   5. the remote endpoint answers a live probe (run by the sync job,
//      not this module — probing is network, this module stays pure).
// A row passing 1–4 and answering 5 is `curated`.
//
// Trust law carried from the curation layer: a mirror row is a LISTING,
// never a review and never a connection. No trust label is minted here.

import { execFile } from 'node:child_process';

/** A publisher above this many latest listings is a bulk publisher. */
export const BULK_PUBLISHER_MAX = 25;

/** The publisher of a registry name: its namespace before the first "/". */
export function publisherOf(registryName) {
  const name = String(registryName ?? '');
  const cut = name.indexOf('/');
  return cut > 0 ? name.slice(0, cut) : name;
}

/** Where a listing's source link points: its repository, its website, or nowhere. */
export function sourceKindOf(candidate) {
  if (candidate?.repositoryUrl) return 'repository';
  if (candidate?.websiteUrl) return 'website';
  return 'none';
}

/** Publisher → how many latest listings it holds across the whole pull. */
export function countPublishers(candidates) {
  const counts = new Map();
  for (const candidate of candidates ?? []) {
    const publisher = publisherOf(candidate?.registryName);
    if (!publisher) continue;
    counts.set(publisher, (counts.get(publisher) ?? 0) + 1);
  }
  return counts;
}

/**
 * Run funnel stages 1–4 over normalized candidates (mcp-registry.mjs
 * shape). Returns { rows, funnel }: each row carries its candidate, its
 * publisher and source kind, the stage verdicts, and `probeTarget` (the
 * URL stage 5 probes) or null when an earlier stage already ended it.
 * funnel counts every stage, fetched included, so a sync run's numbers
 * always add up in the open.
 */
export function curateCandidates(candidates, { bulkPublisherMax = BULK_PUBLISHER_MAX } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const publisherCounts = countPublishers(list);
  const funnel = {
    fetched: list.length,
    active: 0,
    withRemote: 0,
    sourceLinked: 0,
    nonBulk: 0,
  };
  const rows = list.map((candidate) => {
    const publisher = publisherOf(candidate?.registryName);
    const sourceKind = sourceKindOf(candidate);
    const stages = {
      active: candidate?.status === 'active',
      withRemote: Array.isArray(candidate?.remotes) && candidate.remotes.length > 0,
      sourceLinked: sourceKind !== 'none',
      nonBulk: (publisherCounts.get(publisher) ?? 0) <= bulkPublisherMax,
    };
    if (stages.active) funnel.active += 1;
    if (stages.active && stages.withRemote) funnel.withRemote += 1;
    if (stages.active && stages.withRemote && stages.sourceLinked) funnel.sourceLinked += 1;
    if (stages.active && stages.withRemote && stages.sourceLinked && stages.nonBulk) funnel.nonBulk += 1;
    const passes = stages.active && stages.withRemote && stages.sourceLinked && stages.nonBulk;
    return {
      candidate,
      publisher,
      sourceKind,
      stages,
      probeTarget: passes ? (candidate.remoteUrl ?? candidate.remotes[0]?.url ?? null) : null,
    };
  });
  return { rows, funnel };
}

/**
 * What a probe outcome means. Any HTTP answer at all — 200, a 401 auth
 * wall, a 405 — is a live server: something real is listening and
 * speaking HTTP. Only a transport failure (DNS, connect, timeout)
 * marks the endpoint dead.
 */
export function endpointVerdict(outcome) {
  if (outcome?.type === 'http') {
    return { live: true, detail: `HTTP ${outcome.status}` };
  }
  return { live: false, detail: String(outcome?.message ?? 'probe failed').slice(0, 200) };
}

/**
 * Probe one remote endpoint with an MCP initialize call. fetchImpl is
 * injectable for tests; the default is the global fetch with a hard
 * timeout. Never throws: the outcome object is the result.
 */
/**
 * What a curl probe outcome means — the server-side road. Production
 * probing runs as plain curl processes on the server itself (Main's
 * order, 2026-11-23): endpoint checks never run from a workstation,
 * whose outbound connections card the owner per domain touched. The
 * mapping matches endpointVerdict: any HTTP status at all is live;
 * curl's 000 (no answer) or a non-zero exit is dead.
 */
export function endpointVerdictFromCurl({ exitCode, httpCode } = {}) {
  const code = String(httpCode ?? '').trim();
  if ((exitCode === 0 || exitCode == null) && code && code !== '000') {
    return { live: true, detail: `curl HTTP ${code}` };
  }
  return { live: false, detail: exitCode != null ? `curl exit ${exitCode}` : `curl HTTP ${code || '000'}` };
}

export async function probeEndpoint(url, { fetchImpl, timeoutMs = 5000 } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'helmian-catalog-probe', version: '1.0.0' },
        },
      }),
      signal: controller.signal,
      redirect: 'manual',
    });
    return { type: 'http', status: response.status };
  } catch (error) {
    return { type: 'error', message: error?.name === 'AbortError' ? `timeout after ${timeoutMs} ms` : (error?.message ?? String(error)) };
  } finally {
    clearTimeout(timer);
  }
}

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'helmian-catalog-probe', version: '1.0.0' },
  },
});

/**
 * Probe one endpoint as a plain curl process — the production road,
 * selected by the sync job with HELMION_CATALOG_PROBE=curl so every
 * check originates from the server itself. execFileImpl is injectable
 * for tests. Never throws: the verdict object is the result.
 */
export function probeEndpointCurl(url, { execFileImpl = execFile, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    execFileImpl('curl', [
      '-s', '-o', '/dev/null', '-w', '%{http_code}',
      '-X', 'POST', url,
      '-H', 'content-type: application/json',
      '-H', 'accept: application/json, text/event-stream',
      '--data', INITIALIZE_BODY,
      '--max-time', String(Math.max(1, Math.round(timeoutMs / 1000))),
    ], { timeout: timeoutMs + 10000 }, (error, stdout) => {
      resolve(endpointVerdictFromCurl({
        exitCode: error ? (error.code ?? 1) : 0,
        httpCode: stdout,
      }));
    });
  });
}
