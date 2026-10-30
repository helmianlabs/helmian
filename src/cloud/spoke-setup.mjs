// "Set up this PC" (web app, Settings). Two routes:
//   GET  /api/admin/spoke/download?os=windows|macos|linux
//        302 to the newest spoke release asset for that OS (Setup .exe first,
//        else the .zip). macOS/Linux answer 200 { available:false } until built.
//   POST /api/admin/spoke/pair-code
//        signed-in tenant member only. Asks the hands server for a 10-minute,
//        single-use pairing code so nobody types the hands passphrase.
//        Needs HELMIAN_HANDS_URL + HELMIAN_PAIR_CODE_ISSUER_TOKEN on the web
//        app and the same PAIR_CODE_ISSUER_TOKEN on the hands server; without
//        them it answers an honest 503 and the UI falls back to the passphrase.
export const SPOKE_DOWNLOAD_PATH = '/api/admin/spoke/download';
export const SPOKE_PAIR_CODE_PATH = '/api/admin/spoke/pair-code';
const REPO = 'helmianlabs/helmian';
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

export function pickSpokeAsset(releases, os = 'windows') {
  if (os !== 'windows') return null;
  const spoke = (Array.isArray(releases) ? releases : []).filter((r) => /^spoke-v/i.test(r?.tag_name || '') && !r.draft && !r.prerelease);
  for (const r of spoke) {
    const assets = Array.isArray(r.assets) ? r.assets : [];
    const exe = assets.find((a) => /^Helmian-Spoke-Setup-.*win-x64\.exe$/i.test(a?.name || ''));
    const zip = assets.find((a) => /^Helmian-Spoke-.*win-x64\.zip$/i.test(a?.name || ''));
    const a = exe || zip;
    if (a?.browser_download_url) return { url: a.browser_download_url, name: a.name, tag: r.tag_name, kind: exe ? 'installer' : 'zip' };
  }
  return null;
}

export async function handleSpokeSetupRoute({ request, response, requestUrl, activeTenantActor, send, TenantAuthorizationError, env = process.env, fetchImpl = fetch } = {}) {
  const pathname = requestUrl?.pathname;
  if (pathname === SPOKE_DOWNLOAD_PATH && request?.method === 'GET') {
    const os = String(requestUrl.searchParams.get('os') || 'windows').toLowerCase();
    if (os !== 'windows') {
      send(response, 200, JSON.stringify({ available: false, os, message: 'The spoke for this system is coming soon. Windows is ready now.' }));
      return true;
    }
    let asset = null;
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases?per_page=30`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'helmian-cloud' }, signal: AbortSignal.timeout(8000) });
      if (res.ok) asset = pickSpokeAsset(await res.json(), os);
    } catch { /* fall through to the releases page */ }
    send(response, 302, '', 'text/plain', { location: asset?.url || RELEASES_PAGE, 'cache-control': 'no-store' });
    return true;
  }
  if (pathname === SPOKE_PAIR_CODE_PATH) {
    if (request?.method !== 'POST') { send(response, 405, JSON.stringify({ valid: false, code: 'METHOD_NOT_ALLOWED' })); return true; }
    try {
      await activeTenantActor(request);
    } catch (error) {
      const denied = error?.status === 403 || (TenantAuthorizationError && error instanceof TenantAuthorizationError);
      send(response, denied ? 403 : 401, JSON.stringify({ valid: false, code: 'SIGN_IN_REQUIRED' }));
      return true;
    }
    const handsUrl = String(env.HELMIAN_HANDS_URL || '').trim().replace(/\/+$/, '');
    const issuer = String(env.HELMIAN_PAIR_CODE_ISSUER_TOKEN || '').trim();
    if (!/^https:\/\//.test(handsUrl) || issuer.length < 32) {
      send(response, 503, JSON.stringify({ valid: false, code: 'PAIR_CODE_NOT_CONFIGURED' }));
      return true;
    }
    try {
      const res = await fetchImpl(`${handsUrl}/spoke/v1/pair-code`, { method: 'POST', headers: { authorization: `Bearer ${issuer}` }, signal: AbortSignal.timeout(8000) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.code) { send(response, 502, JSON.stringify({ valid: false, code: res.status === 404 ? 'PAIR_CODE_NOT_ENABLED_ON_HANDS' : 'PAIR_CODE_FAILED' })); return true; }
      send(response, 200, JSON.stringify({ valid: true, code: body.code, expiresAt: body.expiresAt }), 'application/json', { 'cache-control': 'no-store' });
    } catch {
      send(response, 502, JSON.stringify({ valid: false, code: 'HANDS_UNREACHABLE' }));
    }
    return true;
  }
  return false;
}
