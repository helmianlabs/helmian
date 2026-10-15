// Public, unauthenticated: reports the newest GitHub Release Windows installer for helmianlabs/helmian.
// Returns { available:false } until a release with a .exe/.msi asset exists. Cached 5 minutes at the edge.
export const RELEASE_REPO = 'helmianlabs/helmian';

export function pickWindowsAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const asset = assets.find((a) => /\.(exe|msi)$/iu.test(a?.name ?? '')) ?? assets.find((a) => /win.*\.zip$/iu.test(a?.name ?? ''));
  if (!asset?.browser_download_url?.startsWith('https://github.com/')) return null;
  return { name: asset.name, url: asset.browser_download_url, version: release.tag_name ?? null, size: asset.size ?? null };
}

export async function latestWindowsRelease({ fetchImpl = fetch, repo = RELEASE_REPO } = {}) {
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'helmian-site' } });
    if (!r.ok) return { available: false };
    const asset = pickWindowsAsset(await r.json());
    return asset ? { available: true, ...asset } : { available: false };
  } catch { return { available: false }; }
}

export default async function handler(request, response) {
  const body = await latestWindowsRelease();
  response.statusCode = 200;
  response.setHeader?.('content-type', 'application/json; charset=utf-8');
  response.setHeader?.('cache-control', 'public, s-maxage=300, stale-while-revalidate=600');
  response.end(JSON.stringify(body));
}
