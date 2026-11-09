// "Add from GitHub" — the GitHub file source for the plus menu
// (mirror-design §4, build bite M2).
//
// A connected connector contributes ACTION rows to the seat's menu;
// the file-source kind ("Add from X") opens that service as a file
// picker and the picked file joins the message through the existing
// file-attach road. GitHub is the one source Helmian can serve
// today: the room's repo truth is the per-channel repo link (a
// channel whose config carries github.repo is linked — that link is
// the connection the room lives by, connector-library-read.mjs), and
// the read below runs against exactly those linked repos.
//
// THE HONEST BOUNDS, stated in the code because they are the
// product's truth:
//   - The repo must be one this workspace's channels link to. This
//     is never an arbitrary-repo proxy: a repo no channel names is
//     refused before any fetch.
//   - The cloud holds no GitHub token (no env, no vault record — the
//     workspace's GitHub sign-in lives on the person's own roads),
//     so the fetch is the public GitHub API read, the same
//     unauthenticated read live-admin already makes for releases. A
//     private repo answers 404 from that API, and the refusal says
//     plainly that the file could not be read — it never invents a
//     listing.
//   - Files ride the attach road's bounds: 256 KB per file, and the
//     kinds a turn can receive (text-shaped + PNG/JPEG/WebP). A
//     bigger or unreadable file is refused with the reason, here —
//     before its bytes travel — and again by the metadata validator
//     on send.

export const CONNECTOR_GITHUB_FILE_PATH = '/api/admin/connector-library/github-file';
export const GITHUB_FILE_MAX_BYTES = 256 * 1024;

const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function failure(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/** One contents-API entry → the picker's row shape, or null. */
export function githubEntryRow(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || !entry.name) return null;
  if (entry.type === 'dir') return Object.freeze({ name: entry.name, path: entry.path, kind: 'dir', size: null });
  if (entry.type === 'file') return Object.freeze({ name: entry.name, path: entry.path, kind: 'file', size: Number.isSafeInteger(entry.size) ? entry.size : null });
  return null;
}

/**
 * The read itself, injectable for tests: `envoyStore` is the envoy
 * channel store (its listChannels is the repo-link truth), `fetchImpl`
 * the GitHub API transport. Returns one of:
 *   { kind: 'dir', repo, path, entries: [...] }   — a listing
 *   { kind: 'file', repo, path, name, size, mediaType, data }  — base64
 * and throws a status-coded error with plain words for every refusal.
 */
export function createGithubFileRead({ envoyStore, fetchImpl = globalThis.fetch } = {}) {
  if (!envoyStore || typeof envoyStore.listChannels !== 'function') {
    throw new TypeError('createGithubFileRead needs the envoy store (listChannels is the repo-link truth)');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('createGithubFileRead needs a fetch implementation');

  async function linkedRepos(actor) {
    const { channels } = await envoyStore.listChannels(actor);
    const repos = new Set();
    for (const channel of Array.isArray(channels) ? channels : []) {
      const repo = String(channel?.github?.repo ?? '').trim();
      if (repo) repos.add(repo.toLowerCase());
    }
    return repos;
  }

  return async function readGithubFile(actor, { repo, path = '' } = {}) {
    const repoName = String(repo ?? '').trim();
    if (!REPO_PATTERN.test(repoName) || repoName.includes('..')) {
      throw failure(400, 'GITHUB_REPO_INVALID', 'name the repository as owner/name');
    }
    const linked = await linkedRepos(actor);
    if (!linked.has(repoName.toLowerCase())) {
      throw failure(404, 'GITHUB_REPO_NOT_LINKED', 'that repository is not linked to any channel in this workspace — link it to a channel first');
    }
    const cleanPath = String(path ?? '').split('/').filter((seg) => seg && seg !== '.' && seg !== '..').join('/');
    const url = `https://api.github.com/repos/${repoName.split('/').map(encodeURIComponent).join('/')}/contents/${cleanPath.split('/').map(encodeURIComponent).join('/')}`;
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'helmian-cloud' },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw failure(502, 'GITHUB_FILE_UNAVAILABLE', 'GitHub could not be reached to read that file');
    }
    if (!response?.ok) {
      // A private repo is indistinguishable from a missing one on
      // the public read (404 either way) — the words cover both and
      // claim neither.
      throw failure(404, 'GITHUB_FILE_UNAVAILABLE', 'that file could not be read from GitHub — it may be missing, or the repository may be private (Helmian\u2019s cloud read holds no GitHub sign-in)');
    }
    const body = await response.json().catch(() => null);
    if (Array.isArray(body)) {
      return { kind: 'dir', repo: repoName, path: cleanPath, entries: body.map(githubEntryRow).filter(Boolean) };
    }
    if (body && body.type === 'file' && typeof body.content === 'string') {
      const size = Number.isSafeInteger(body.size) ? body.size : null;
      if (size !== null && size > GITHUB_FILE_MAX_BYTES) {
        throw failure(413, 'GITHUB_FILE_TOO_BIG', `that file is ${Math.ceil(size / 1024)} KB — the attach limit is 256 KB per file`);
      }
      const data = body.content.replace(/\s+/g, '');
      const decoded = Math.floor(data.length / 4) * 3; // upper bound; the attach road re-verifies exactly
      if (decoded > GITHUB_FILE_MAX_BYTES + 3) {
        throw failure(413, 'GITHUB_FILE_TOO_BIG', 'that file is over the 256 KB attach limit');
      }
      return {
        kind: 'file', repo: repoName, path: cleanPath,
        name: String(body.name ?? cleanPath.split('/').pop() ?? 'file'),
        size, mediaType: '', data,
      };
    }
    throw failure(502, 'GITHUB_FILE_UNAVAILABLE', 'GitHub answered in a shape Helmian cannot read');
  };
}
