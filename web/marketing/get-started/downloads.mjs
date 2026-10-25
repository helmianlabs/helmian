// Pure download planning for the get-started delivery step. Given the product's
// items, the /api/latest-release answer, and the Guard bundle descriptor, decide
// what the page may actually offer. No DOM, no fetch — unit-tested directly.
// The exe is "ready" only when the release endpoint says a real GitHub release
// with a Windows installer exists; until then the plan says not-ready and the
// page tells the visitor so instead of starting a dead download.
export function planDownloads({ items = [], release = null, guard = null } = {}) {
  const plan = [];
  for (const item of items) {
    if (item === 'exe') {
      if (release?.available && typeof release.url === 'string' && release.url.startsWith('https://')) {
        plan.push({ kind: 'exe', ready: true, name: release.name ?? 'Helmian-Setup.exe', url: release.url, version: release.version ?? null });
      } else {
        plan.push({ kind: 'exe', ready: false });
      }
    } else if (item === 'guard') {
      if (typeof guard?.url === 'string' && guard.url) {
        plan.push({ kind: 'guard', ready: true, name: guard.name ?? 'Helmian Guard', url: guard.url });
      } else {
        plan.push({ kind: 'guard', ready: false });
      }
    }
  }
  return plan;
}
