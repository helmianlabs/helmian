import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadSeatLibrary, preloadLibrarySession, resetLibrarySession } from '../app/envoy-workspace.js';

// Boot-load fix (2026-11-11): the cold start's two client-side
// multipliers. Production request log, Troy's own tab, 2026-11-11:
// the approvals read arrived dozens of times in parallel at 18:03
// MST, each copy ~55 s, because loadFeedData was fired bare by the
// boot line, the first view's loader and the desktop loader, and the
// 6-second heartbeat kept firing while slow answers were still out;
// and the connector-library preload walked the fourteen seats
// strictly one at a time (18:04:59–18:06:46 MST, 1.8 s growing to
// 27 s per read, ~135 s for the chain). These tests pin the fixed
// shapes: ONE in-flight feed load with a staleness window and a
// forced re-read after writes (app.js, by source — app.js is a
// classic script, the house pattern for it), and the library batch +
// per-seat in-flight share (envoy-workspace.js, driven for real).

const libRow = (seatId, entryId, name, over = {}) => ({
  entryId, seatId, name,
  oneLiner: `The ${name} line`,
  vendorLabel: 'Vendor',
  trustLabel: 'Helmian-brokered',
  state: 'available',
  stateDetail: null,
  accountIdentity: null,
  brokerMode: 'helmian',
  kind: 'native',
  ...over,
});

test('library preload: every seat read fires as ONE batch, not a seat-at-a-time chain', async () => {
  const started = [];
  const releases = new Map();
  const api = (path) => {
    if (path === '/api/admin/connector-library/seats') return Promise.resolve({ seats: [{ seatId: 'claude' }, { seatId: 'grok' }, { seatId: 'gemini' }] });
    if (path.startsWith('/api/admin/connector-library?seat=')) {
      const seatId = decodeURIComponent(path.split('seat=')[1]);
      started.push(seatId);
      return new Promise((resolve) => releases.set(seatId, () => resolve({ connectedCount: 0, rows: [libRow(seatId, 'gmail', 'Gmail')] })));
    }
    if (path === '/api/admin/plugins') return Promise.resolve({ plugins: [], unavailable: [] });
    if (path === '/api/admin/skills') return Promise.resolve({ skills: [] });
    return Promise.reject(new Error(`unexpected read: ${path}`));
  };
  resetLibrarySession({ api });
  preloadLibrarySession();
  // Under the old chain the second seat's read could not start until
  // the first seat's read settled; here nothing has been released,
  // so all three reads standing open at once IS the batch.
  for (let i = 0; i < 50 && started.length < 3; i++) await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([...started].sort(), ['claude', 'gemini', 'grok'],
    'every seat read started before any of them settled — one batch, not a chain');
  for (const release of releases.values()) release();
  // The batch landed in the session cache: an open reads no more.
  const library = await loadSeatLibrary('claude', Date.now());
  assert.deepEqual(library.rows.map((r) => r.entryId), ['gmail'], 'the open serves the preloaded library');
  assert.equal(started.length, 3, 'no fetch-on-open once the batch has landed');
});

test('seat library: concurrent loads of one seat share the single in-flight read', async () => {
  let reads = 0;
  let release;
  const api = async (path) => {
    if (path === '/api/admin/connector-library/seats') return { seats: [{ seatId: 'claude' }] };
    if (path.startsWith('/api/admin/connector-library?seat=')) {
      reads += 1;
      await new Promise((r) => { release = r; });
      return { connectedCount: 1, rows: [libRow('claude', 'gmail', 'Gmail', { state: 'connected' })] };
    }
    throw new Error(`unexpected read: ${path}`);
  };
  resetLibrarySession({ api });
  const t0 = 1_000_000;
  const p1 = loadSeatLibrary('claude', t0);
  const p2 = loadSeatLibrary('claude', t0);
  for (let i = 0; i < 50 && reads < 1; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(reads, 1, 'the second concurrent load joined the first instead of firing its own read');
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a, b, 'both callers were served the same library');
  assert.equal(a.rows[0].state, 'connected');
  // The in-flight entry cleared when the read settled: the copy in
  // the session cache stands inside its window, as before.
  const c = await loadSeatLibrary('claude', t0 + 30_000);
  assert.equal(reads, 1, 'the settled copy is served from cache — no re-read, no stuck in-flight entry');
  assert.equal(c, a);
});

const appJs = readFileSync(new URL('../app/app.js', import.meta.url), 'utf8');
const envoyJs = readFileSync(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');

test('feed load: one in-flight load, a staleness window, and the same three reads inside', () => {
  const feed = appJs.slice(appJs.indexOf('async function loadFeedData'), appJs.indexOf('async function decide'));
  assert.ok(feed.includes('if (feedLoadInFlight) return feedLoadInFlight'),
    'concurrent callers join the in-flight load instead of each firing the three reads');
  assert.ok(feed.includes('FEED_STALE_MS'), 'a just-finished load is served from state inside the window');
  for (const path of ['/api/admin/events', '/api/admin/cora/approvals', '/api/admin/guard/findings']) {
    assert.ok(feed.includes(`api('${path}')`), `the shared load still reads ${path} — the herd was the callers, not the reads`);
  }
});

test('feed load: writes force their refresh — a decision and an ack never serve the window', () => {
  assert.ok(appJs.includes("await loadFeedData({ force: true }); if (shell.dataset.view === 'approvals') renderApprovals();"),
    'decide() forces the re-read that paints the decision');
  const ackStart = appJs.indexOf('async function ackFinding');
  const ack = appJs.slice(ackStart, ackStart + 2000);
  assert.ok(ack.includes('loadFeedData({ force: true })'), 'ackFinding forces its refresh on both paths');
  assert.ok(envoyJs.includes('ws.ctx.loadFeedData?.({ force: true })'),
    'the Guard panel’s own refresh button forces its re-read');
});

test('desktop paint: the workspace mount no longer waits on the feed load', () => {
  const desktop = appJs.slice(appJs.indexOf('async function loadDesktop'), appJs.indexOf('await workspaceModule.mountWorkspace'));
  assert.ok(desktop.includes('void loadFeedData().catch(() => {})'),
    'the feed load is fired unawaited — the feed fills in when the shared load lands');
  assert.ok(!desktop.includes('await loadFeedData()'),
    'no awaited feed load stands between entering the Desktop view and mounting the workspace');
});
