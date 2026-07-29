// Stage 1 of the MCP install security pipeline: FIND CANDIDATES.
//
// Searches GitHub for MCP servers matching a stated need and records the
// provenance facts a human needs at stage 4: repo, stars, last commit, license.
//
// Unauthenticated requests are fine and are the default — GitHub allows 10
// search requests/minute unauthenticated. Rate limiting is handled explicitly
// rather than surfacing as a confusing 403, because "we could not search" and
// "there are no results" must never look the same to the caller.
//
// NOTE ON WHAT STARS MEAN: nothing, security-wise. A popular repo is a more
// attractive supply-chain target, not a safer one. Stars are recorded because
// they are useful CONTEXT for a human, and they are deliberately never an input
// to any automatic decision in this pipeline.

const GITHUB_SEARCH_URL = 'https://api.github.com/search/repositories';
const USER_AGENT = 'helmion-mcp-install-security';

export class DiscoveryRateLimitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DiscoveryRateLimitError';
    this.details = details;
  }
}

export class DiscoveryError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DiscoveryError';
    this.details = details;
  }
}

function normalizeRepository(item) {
  return {
    name: item.name,
    fullName: item.full_name,
    htmlUrl: item.html_url,
    cloneUrl: item.clone_url,
    description: item.description ?? null,
    stars: item.stargazers_count ?? 0,
    forks: item.forks_count ?? 0,
    openIssues: item.open_issues_count ?? 0,
    lastCommit: item.pushed_at ?? null,
    createdAt: item.created_at ?? null,
    license: item.license?.spdx_id ?? item.license?.name ?? null,
    archived: Boolean(item.archived),
    owner: item.owner?.login ?? null,
    defaultBranch: item.default_branch ?? null,
  };
}

/**
 * Provenance signals worth surfacing to a human. These are OBSERVATIONS, not a
 * score — nothing here auto-approves or auto-rejects anything.
 */
export function provenanceNotes(repo, now = new Date()) {
  const notes = [];
  if (repo.archived) notes.push('Repository is ARCHIVED — it is not receiving security fixes.');
  if (!repo.license) notes.push('No license detected — redistribution and liability are undefined.');
  if (repo.lastCommit) {
    const days = Math.floor((now - new Date(repo.lastCommit)) / 86400000);
    if (days > 365) notes.push(`Last commit was ${days} days ago — likely unmaintained.`);
  } else {
    notes.push('No last-commit date available.');
  }
  if (repo.createdAt) {
    const ageDays = Math.floor((now - new Date(repo.createdAt)) / 86400000);
    if (ageDays < 30) {
      notes.push(`Repository is only ${ageDays} days old — new repos are a common vehicle for typosquatting an established server.`);
    }
  }
  if (repo.stars < 5) notes.push(`Only ${repo.stars} stars — effectively unreviewed by anyone else.`);
  return notes;
}

/**
 * Search GitHub for candidate MCP servers.
 *
 * `fetchImpl` is injectable so tests can drive rate-limit and error branches
 * without touching the network.
 */
export async function discoverMcpServers({
  need,
  limit = 10,
  fetchImpl = globalThis.fetch,
  token = null,
  now = new Date(),
} = {}) {
  const trimmed = String(need ?? '').trim();
  if (!trimmed) throw new DiscoveryError('A stated task need is required to search for an MCP server');

  // `in:name,description` and NOT readme. Including readme was measured against
  // the live API and returned awesome-lists (vinta/awesome-python, ★310872)
  // that merely MENTION the words, because sort=stars then puts the biggest
  // repository on the internet above every actual MCP server. Restricting to
  // name and description returned real servers (bytebase/dbhub, a database MCP
  // server) at the top instead.
  const query = `${trimmed} mcp server in:name,description`;
  const url = `${GITHUB_SEARCH_URL}?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${Math.min(limit, 50)}`;

  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': USER_AGENT,
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetchImpl(url, { headers });
  } catch (error) {
    throw new DiscoveryError(`GitHub search request failed: ${error.message}`, { cause: error.message });
  }

  const remaining = response.headers?.get?.('x-ratelimit-remaining');
  const resetAt = response.headers?.get?.('x-ratelimit-reset');

  if (response.status === 403 || response.status === 429) {
    const resetDate = resetAt ? new Date(Number(resetAt) * 1000) : null;
    throw new DiscoveryRateLimitError(
      'GitHub rate limit reached while searching for MCP servers. '
      + (resetDate ? `Resets at ${resetDate.toISOString()}. ` : '')
      + 'This is NOT "no results found" — the search did not run. Retry after the reset, '
      + 'or supply a token to raise the limit.',
      { status: response.status, remaining, resetAt: resetDate?.toISOString() ?? null },
    );
  }
  if (!response.ok) {
    throw new DiscoveryError(`GitHub search returned ${response.status}`, { status: response.status });
  }

  const body = await response.json();
  const repositories = (body.items ?? []).slice(0, limit).map((item) => {
    const repo = normalizeRepository(item);
    return { ...repo, provenanceNotes: provenanceNotes(repo, now) };
  });

  return {
    stage: 'discovery',
    need: trimmed,
    query,
    totalCount: body.total_count ?? repositories.length,
    rateLimitRemaining: remaining === undefined || remaining === null ? null : Number(remaining),
    repositories,
    caveat:
      'Stars, forks, and age are context for a human, not a safety signal. A popular repository is a '
      + 'more attractive supply-chain target, not a safer one. Nothing in this pipeline auto-approves '
      + 'on the basis of any field returned here.',
  };
}

export function formatDiscoveryReport(report) {
  const lines = [];
  lines.push(`DISCOVERY — need: "${report.need}"`);
  lines.push(`  ${report.totalCount} repositories matched; showing ${report.repositories.length}`);
  if (report.rateLimitRemaining !== null) lines.push(`  GitHub rate limit remaining: ${report.rateLimitRemaining}`);
  for (const repo of report.repositories) {
    lines.push(`  - ${repo.fullName}  ★${repo.stars}  license=${repo.license ?? 'NONE'}  last commit ${repo.lastCommit ?? 'unknown'}`);
    for (const note of repo.provenanceNotes) lines.push(`      ! ${note}`);
  }
  lines.push(`  NOTE: ${report.caveat}`);
  return lines.join('\n');
}
