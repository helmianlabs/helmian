// Public, unauthenticated: reports the newest GitHub Release Windows installer for helmianlabs/helmian.
// Returns { available:false } until a release with a .exe/.msi asset exists — that is a live read of
// the repo's releases, not a hard-code. Successful reads are memoized per repo for 5 minutes in this
// instance (and cached 5 minutes at the edge via the handler's headers below). Failures are never
// memoized: a GitHub error reports unavailable for that request only, and the next request retries,
// so a transient outage can neither pin a false "unavailable" nor extend a stale "available".
export const RELEASE_REPO = 'helmianlabs/helmian';

const MEMO_MS = 5 * 60 * 1000;
const memoByRepo = new Map();

export function pickWindowsAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const asset = assets.find((a) => /\.(exe|msi)$/iu.test(a?.name ?? '')) ?? assets.find((a) => /win.*\.zip$/iu.test(a?.name ?? ''));
  if (!asset?.browser_download_url?.startsWith('https://github.com/')) return null;
  return { name: asset.name, url: asset.browser_download_url, version: release.tag_name ?? null, size: asset.size ?? null };
}

export async function latestWindowsRelease({ fetchImpl = fetch, repo = RELEASE_REPO, now = Date.now } = {}) {
  const memo = memoByRepo.get(repo);
  if (memo && now() - memo.at < MEMO_MS) return memo.value;
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'helmian-site' } });
    if (!r.ok) return { available: false };
    const asset = pickWindowsAsset(await r.json());
    const value = asset ? { available: true, ...asset } : { available: false };
    memoByRepo.set(repo, { at: now(), value });
    return value;
  } catch { return { available: false }; }
}

export default async function handler(request, response) {
  const body = await latestWindowsRelease();
  response.statusCode = 200;
  response.setHeader?.('content-type', 'application/json; charset=utf-8');
  response.setHeader?.('cache-control', 'public, s-maxage=300, stale-while-revalidate=600');
  response.end(JSON.stringify(body));
}
