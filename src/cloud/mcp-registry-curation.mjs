// MCP Registry CURATION (research pass 2026-11-10, report §2/§5):
// the editorial layer between the registry firehose and Helmian's
// connector catalog. The registry is deliberately unopinionated —
// tens of thousands of listings, spam included — so nothing reaches
// the shelf by feed alone. A server gets in by being NAMED here,
// after a person (or a curation pass standing in for one) has
// checked its live registry record with the client in
// mcp-registry.mjs. The facts below (endpoint, version) are that
// check's output, pulled live on the date stamped in
// REGISTRY_PICKS_AS_OF; a later curation pass re-pulls and re-checks
// with checkPickAgainstCandidate, and drift is a human decision,
// never a silent rewrite.
//
// The laws this module carries:
//   - A registry import is a LISTING, not a connection and not a
//     review. Its catalog trust label is 'community', always — the
//     registry's CC0 covers its metadata, not the servers, and
//     Helmian never upgrades a label it did not itself earn
//     (connector-catalog.mjs header law). 'verified' is not minted
//     here, however official the publisher looks.
//   - Picks prefer the publisher's own listing (Atlassian's,
//     Notion's, Linear's, Stripe's own registry records) over
//     third-party re-hosts of the same service, and a Streamable
//     HTTP remote over packages — a cloud shelf can only hand a
//     person a server Helmian can actually reach.
//   - Placement follows the shelf's own geography: a service pick
//     rides the seats whose libraries already carry that service as
//     a vendor mirror, so the Helmian-brokered road can later be
//     offered next to the mirror (the mirrors themselves are not
//     changed by this source). The weather pick is seat-agnostic
//     shelf stock — like the Helmian natives, it rides every seat.

export const REGISTRY_PICKS_AS_OF = '2026-11-10';

export const REGISTRY_PICKS = Object.freeze([
  Object.freeze({
    entryId: 'registry-weather',
    registryName: 'io.github.cyanheads/nws-weather-mcp-server',
    registryVersion: '0.12.0',
    repositoryUrl: 'https://github.com/cyanheads/nws-weather-mcp-server',
    name: 'Weather',
    // The server's publisher of record in the registry; the data it
    // serves is the US National Weather Service's (its oneLiner
    // says so). The Smithery-hosted NWS listing was passed over on
    // purpose: Smithery's hosted server URLs shut down 2026-10-31
    // (research §3), so its remote is a dead address.
    vendorName: 'cyanheads',
    oneLiner: 'US forecasts, alerts, and current observations from the National Weather Service',
    category: 'data',
    icon: 'weather',
    authMode: 'none',
    endpoint: 'https://nws.caseyjhand.com/mcp',
    seats: 'all',
  }),
  Object.freeze({
    entryId: 'registry-atlassian',
    registryName: 'com.atlassian/atlassian-mcp-server',
    registryVersion: '2.0.0',
    repositoryUrl: 'https://github.com/atlassian/atlassian-mcp-server',
    name: 'Atlassian',
    vendorName: 'Atlassian',
    oneLiner: 'Search Jira issues and Confluence pages',
    category: 'productivity',
    icon: 'atlassian',
    authMode: 'oauth',
    endpoint: 'https://mcp.atlassian.com/v2/mcp',
    scopesSummary: 'Search and work with Jira, Confluence, and Loom',
    seats: Object.freeze(['claude']),
  }),
  Object.freeze({
    entryId: 'registry-notion',
    registryName: 'com.notion/mcp',
    registryVersion: '1.0.1',
    repositoryUrl: null,
    name: 'Notion',
    vendorName: 'Notion',
    oneLiner: 'Search pages, summarise notes, and draft new pages',
    category: 'documents',
    icon: 'notion',
    authMode: 'oauth',
    endpoint: 'https://mcp.notion.com/mcp',
    scopesSummary: 'Search and work with your Notion workspace',
    seats: Object.freeze(['claude', 'chatgpt', 'grok']),
  }),
  Object.freeze({
    entryId: 'registry-linear',
    registryName: 'app.linear/linear',
    registryVersion: '1.0.2',
    repositoryUrl: null,
    name: 'Linear',
    vendorName: 'Linear',
    oneLiner: 'Look up issues, check project status, and file new work',
    category: 'productivity',
    icon: 'linear',
    authMode: 'oauth',
    endpoint: 'https://mcp.linear.app/mcp',
    scopesSummary: 'Find and manage issues, projects, and documents',
    seats: Object.freeze(['claude', 'grok']),
  }),
  Object.freeze({
    entryId: 'registry-stripe',
    registryName: 'com.stripe/mcp',
    registryVersion: '0.2.4',
    repositoryUrl: 'https://github.com/stripe/agent-toolkit',
    name: 'Stripe',
    vendorName: 'Stripe',
    oneLiner: 'Look up payments, customers, and invoices',
    category: 'data',
    icon: 'stripe',
    authMode: 'oauth',
    endpoint: 'https://mcp.stripe.com',
    scopesSummary: 'Look up customers, products, and payments',
    seats: Object.freeze(['claude']),
  }),
]);

export function registryPickByEntryId(entryId) {
  return REGISTRY_PICKS.find((pick) => pick.entryId === entryId) ?? null;
}

/** The picks that stock one seat's shelf (see the placement law above). */
export function registryPicksForSeat(seatId) {
  return REGISTRY_PICKS.filter((pick) => pick.seats === 'all' || pick.seats.includes(seatId));
}

/**
 * Rule one pick against its live registry record (a normalized
 * candidate from mcp-registry.mjs, or null when the registry no
 * longer carries the name). Returns { ok, problems } — the facts a
 * curation pass must face before the pick's shelf data may be
 * refreshed: the listing is gone, no longer active, lost its
 * reachable remote, or the remote moved (endpoint drift — the
 * pick keeps pointing where it pointed until a human rules).
 * Version movement is not a problem: versions move; the recorded
 * registryVersion is simply the version the check last saw.
 */
export function checkPickAgainstCandidate(pick, candidate) {
  const problems = [];
  if (!candidate) {
    return { ok: false, problems: [`${pick.registryName} is no longer in the registry`] };
  }
  if (candidate.registryName !== pick.registryName) {
    problems.push(`the registry answered for ${candidate.registryName}, not ${pick.registryName}`);
  }
  if (candidate.status !== 'active') {
    problems.push(`registry status is ${candidate.status ?? 'not confirmed active'}`);
  }
  if (!candidate.remoteUrl) {
    problems.push('the listing offers no Streamable HTTP remote — nothing a cloud shelf can reach');
  } else if (candidate.remoteUrl !== pick.endpoint) {
    problems.push(`endpoint drift: the registry now lists ${candidate.remoteUrl}, the pick points at ${pick.endpoint}`);
  }
  return { ok: problems.length === 0, problems };
}
