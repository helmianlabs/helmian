// Scope reporting (spoke-scope permission spec, bite 1): the spoke includes
// its scope summary — tier, default roots, granted folders — in poll
// presence; the hub cleans it, shows it in presence, and surfaces the first
// report and every CHANGE through onScopeReport (wired to the audit log as
// scope.reported in index.mjs). Visibility only: a report grants nothing,
// and a spoke that reports nothing (older build, malformed summary, failed
// summary build) polls and works exactly as before this bite.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createSpokeHub } from '../src/spoke-hub.mjs';
import { createAudit } from '../src/audit.mjs';
import { createHands } from '../src/hands.mjs';
import { createOAuth } from '../src/oauth.mjs';
import { createGuardClient } from '../src/guard-client.mjs';
import { createApp } from '../src/server.mjs';
import { createSpokeTokens } from '../src/spoke-tokens.mjs';
import { loadConfig } from '../src/config.mjs';
import { cleanScopeSummary } from '../src/shared/protocol.mjs';
import { buildScopeSummary, deriveScopeTier, pairSpoke, readSpokeConfig, startSpoke } from '../../src/hands/pc-spoke.mjs';
import { activateRootGrant } from '../../src/hands/root-grants.mjs';
import { ROOT_GRANT_AUDIENCE } from '../src/shared/protocol.mjs';
import { mockGuard } from './helpers.mjs';

const PASS = 'correct horse battery staple';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iat = () => Math.floor(Date.now() / 1000);

const SCOPE_A = { tier: 'pick-folders', roots: ['E:\\Helmion'], grants: [] };
const SCOPE_A_REORDERED = { tier: 'pick-folders', roots: ['E:\\Helmion'], grants: [] };
const SCOPE_B = { tier: 'pick-folders', roots: ['E:\\Helmion'], grants: ['F:\\AutoVector'] };

function hubWithReports(opts = {}) {
  const reports = [];
  const hub = createSpokeHub({ pollWaitMs: 20, onScopeReport: (r) => reports.push(r), ...opts });
  return { hub, reports };
}

// ─── The cleaner (shared protocol) ──────────────────────────────────────────

test('cleanScopeSummary: canonicalizes order and duplicates; missing lists read as empty', () => {
  assert.deepEqual(
    cleanScopeSummary({ tier: 'pick-folders', roots: ['B:\\two', 'A:\\one', 'B:\\two'], grants: [] }),
    { tier: 'pick-folders', roots: ['A:\\one', 'B:\\two'], grants: [] });
  assert.deepEqual(cleanScopeSummary({ tier: 'full-pc' }), { tier: 'full-pc', roots: [], grants: [] });
});

test('cleanScopeSummary: anything malformed is no summary at all', () => {
  assert.equal(cleanScopeSummary(null), null);
  assert.equal(cleanScopeSummary('pick-folders'), null);
  assert.equal(cleanScopeSummary(['pick-folders']), null);
  assert.equal(cleanScopeSummary({ tier: 'everything' }), null);
  assert.equal(cleanScopeSummary({ tier: 'pick-folders', roots: 'E:\\Helmion' }), null);
  assert.equal(cleanScopeSummary({ tier: 'pick-folders', roots: [42] }), null);
  assert.equal(cleanScopeSummary({ tier: 'pick-folders', roots: [''] }), null);
  assert.equal(cleanScopeSummary({ tier: 'pick-folders', roots: ['x'.repeat(321)] }), null);
  assert.equal(cleanScopeSummary({ tier: 'pick-folders', grants: Array.from({ length: 33 }, (_, i) => `F:\\f${i}`) }), null);
});

// ─── Hub: reports, presence, change flags ───────────────────────────────────

test('hub: first scope report is stored, shown in presence, and surfaced once', async () => {
  const { hub, reports } = hubWithReports();
  await hub.nextJob({ deviceId: 'pc-a', capabilities: ['local-files'], scope: SCOPE_A });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].deviceId, 'pc-a');
  assert.equal(reports[0].changed, false);
  assert.equal(reports[0].first, true);
  assert.deepEqual(reports[0].scope, SCOPE_A);
  const entry = hub.presence().devices['pc-a'];
  assert.deepEqual(entry.scope, SCOPE_A);
  // The legacy pc slot carries it too.
  assert.deepEqual(hub.presence().pc.scope, SCOPE_A);
});

test('hub: identical re-reports (even reordered) surface nothing new', async () => {
  const { hub, reports } = hubWithReports();
  await hub.nextJob({ deviceId: 'pc-a', capabilities: [], scope: SCOPE_A });
  await hub.nextJob({ deviceId: 'pc-a', capabilities: [], scope: SCOPE_A_REORDERED });
  await hub.nextJob({ deviceId: 'pc-a', capabilities: [], scope: { ...SCOPE_A, roots: [...SCOPE_A.roots] } });
  assert.equal(reports.length, 1);
});

test('hub: a changed scope is flagged with the previous summary', async () => {
  const { hub, reports } = hubWithReports();
  await hub.nextJob({ deviceId: 'pc-a', capabilities: [], scope: SCOPE_A });
  await hub.nextJob({ deviceId: 'pc-a', capabilities: [], scope: SCOPE_B });
  assert.equal(reports.length, 2);
  assert.equal(reports[1].changed, true);
  assert.equal(reports[1].first, undefined);
  assert.deepEqual(reports[1].previous, SCOPE_A);
  assert.deepEqual(reports[1].scope, SCOPE_B);
  assert.deepEqual(hub.presence().devices['pc-a'].scope, SCOPE_B);
  // A tier change flags the same way.
  await hub.nextJob({ deviceId: 'pc-a', capabilities: [], scope: { tier: 'no-file-access', roots: [], grants: [] } });
  assert.equal(reports.length, 3);
  assert.equal(reports[2].changed, true);
  assert.deepEqual(reports[2].previous, SCOPE_B);
});

test('hub: a poll with no scope is byte-identical to before this bite — no report, no scope key', async () => {
  const { hub, reports } = hubWithReports();
  await hub.nextJob({ deviceId: 'pc-a', capabilities: ['local-files'] });
  assert.equal(reports.length, 0);
  const entry = hub.presence().devices['pc-a'];
  assert.deepEqual(Object.keys(entry).sort(), ['capabilities', 'lastSeenAt', 'online']);
  assert.deepEqual(Object.keys(hub.presence().pc).sort(), ['capabilities', 'deviceId', 'lastSeenAt', 'online']);
});

test('hub: malformed scope is treated as absent and never clears a stored scope', async () => {
  const { hub, reports } = hubWithReports();
  await hub.nextJob({ deviceId: 'pc-a', capabilities: [], scope: { tier: 'everything', roots: [] } });
  await hub.nextJob({ deviceId: 'pc-a', capabilities: [], scope: { tier: 'pick-folders', roots: [42] } });
  await hub.nextJob({ deviceId: 'pc-a', capabilities: [], scope: 'pick-folders' });
  assert.equal(reports.length, 0);
  assert.equal('scope' in hub.presence().devices['pc-a'], false);
  // A good report lands, then garbage cannot erase it.
  await hub.nextJob({ deviceId: 'pc-a', capabilities: [], scope: SCOPE_A });
  await hub.nextJob({ deviceId: 'pc-a', capabilities: [], scope: { tier: 'pick-folders', roots: 'wide open' } });
  assert.equal(reports.length, 1);
  assert.deepEqual(hub.presence().devices['pc-a'].scope, SCOPE_A);
});

test('hub: a scope-less poll does not clear a stored scope either', async () => {
  const { hub, reports } = hubWithReports();
  await hub.nextJob({ deviceId: 'pc-a', capabilities: [], scope: SCOPE_A });
  await hub.nextJob({ deviceId: 'pc-a', capabilities: [] });
  assert.equal(reports.length, 1);
  assert.deepEqual(hub.presence().devices['pc-a'].scope, SCOPE_A);
});

test('hub: a throwing onScopeReport never breaks polling or job flow', async () => {
  const hub = createSpokeHub({ pollWaitMs: 20, resultWaitMs: 1000, onScopeReport: () => { throw new Error('audit sink down'); } });
  const dispatched = hub.dispatch({ tool: 'list_files', args: { path: 'E:\\Helmion' } }, {});
  const job = await hub.nextJob({ deviceId: 'pc', capabilities: [], scope: SCOPE_A });
  assert.equal(job.tool, 'list_files');
  assert.equal(hub.complete(job.id, { ok: true, output: 'done' }, { deviceId: 'pc' }), true);
  const result = await dispatched;
  assert.equal(result.ok, true);
  assert.equal(result.output, 'done');
});

test('hub: scope reporting does not change job binding — jobs still go only to their device', async () => {
  const { hub } = hubWithReports();
  const dispatched = hub.dispatch({ tool: 'read_file', args: { path: 'x' }, targetDeviceId: 'pc-b' }, { waitMs: 200 });
  // pc-a polls with a scope; the job is bound to pc-b, so pc-a gets nothing.
  assert.equal(await hub.nextJob({ deviceId: 'pc-a', capabilities: [], scope: SCOPE_A }), null);
  const job = await hub.nextJob({ deviceId: 'pc-b', capabilities: [], scope: SCOPE_B });
  assert.equal(job.tool, 'read_file');
  assert.equal(hub.complete(job.id, { ok: true, output: 'read' }, { deviceId: 'pc-b' }), true);
  assert.equal((await dispatched).ok, true);
});

// ─── Spoke: tier derivation and summary building ────────────────────────────

test('deriveScopeTier: a recorded pick wins; otherwise the folders in force decide', () => {
  assert.equal(deriveScopeTier({ roots: ['E:\\Helmion'], scopePick: 'full' }), 'full-pc');
  assert.equal(deriveScopeTier({ roots: ['E:\\Helmion'], scopePick: 'full-pc' }), 'full-pc');
  assert.equal(deriveScopeTier({ roots: ['E:\\Helmion'], scopePick: 'none' }), 'no-file-access');
  assert.equal(deriveScopeTier({ roots: ['E:\\Helmion'], scopePick: 'folders' }), 'pick-folders');
  assert.equal(deriveScopeTier({ roots: ['E:\\Helmion'] }), 'pick-folders');
  assert.equal(deriveScopeTier({ roots: [], grantRoots: ['F:\\AutoVector'] }), 'pick-folders');
  assert.equal(deriveScopeTier({ roots: [], grantRoots: [] }), 'no-file-access');
  // An unknown pick is ignored, never trusted.
  assert.equal(deriveScopeTier({ roots: ['E:\\Helmion'], scopePick: 'everything' }), 'pick-folders');
  assert.equal(deriveScopeTier({ roots: [], scopePick: 'everything' }), 'no-file-access');
});

test('buildScopeSummary: no grants file means no granted folders', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-sum-'));
  const summary = await buildScopeSummary({ roots: ['E:\\Helmion'], rootGrantsPath: join(dir, 'roots.grants.json'), deviceId: 'pc-test' });
  assert.deepEqual(summary, { tier: 'pick-folders', roots: ['E:\\Helmion'], grants: [] });
});

test('buildScopeSummary: verified grants are listed; tampered ones are not', async () => {
  const guard = mockGuard();
  const dir = await mkdtemp(join(tmpdir(), 'scope-sum-'));
  const grantedRoot = join(dir, 'f-drive-folder');
  await mkdir(grantedRoot);
  const grantsPath = join(dir, 'roots.grants.json');
  const envelope = guard.forge({
    aud: ROOT_GRANT_AUDIENCE, grantType: 'root', grantId: 'grant-1', verdict: 'allow',
    approvalId: 'appr-1', decidedBy: 'troy', rootPath: grantedRoot, scope: 'read-only',
    spokeDeviceId: 'pc-test', iat: iat(), exp: iat() + 3600,
  });
  await activateRootGrant({ path: grantsPath, envelope, publicKeyX: guard.x, spokeDeviceId: 'pc-test' });
  const summary = await buildScopeSummary({ roots: ['E:\\Helmion'], rootGrantsPath: grantsPath, guardPublicKeyX: guard.x, deviceId: 'pc-test' });
  assert.deepEqual(summary, { tier: 'pick-folders', roots: ['E:\\Helmion'], grants: [grantedRoot] });

  // Tamper with the stored envelope: the folder drops out of the summary,
  // exactly as it drops out of enforcement.
  const stored = JSON.parse(await readFile(grantsPath, 'utf8'));
  stored.grants[0].envelope.signature = `${stored.grants[0].envelope.signature.slice(0, -2)}AA`;
  await writeFile(grantsPath, JSON.stringify(stored));
  const after = await buildScopeSummary({ roots: ['E:\\Helmion'], rootGrantsPath: grantsPath, guardPublicKeyX: guard.x, deviceId: 'pc-test' });
  assert.deepEqual(after.grants, []);
});

// ─── Spoke: the poll carries the summary; failure means no field ────────────

function fakeHubFetch(bodies) {
  return async (url, opts = {}) => {
    if (String(url).includes('/spoke/v1/poll')) {
      bodies.push(JSON.parse(opts.body));
      await sleep(15);
      return { ok: true, status: 200, json: async () => ({ job: null }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('startSpoke: every poll body carries the scope summary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-poll-'));
  const root = join(dir, 'root');
  await mkdir(root);
  const bodies = [];
  const spoke = startSpoke({
    config: { url: 'http://hub.test', token: 't', deviceId: 'pc-test', roots: [root], rootGrantsPath: join(dir, 'roots.grants.json'), usedDecisionsPath: join(dir, 'used.json') },
    fetchImpl: fakeHubFetch(bodies),
    log: () => {},
  });
  await sleep(200);
  spoke.stop();
  assert.ok(bodies.length >= 1, 'expected at least one poll');
  for (const body of bodies) {
    assert.deepEqual(body.scope, { tier: 'pick-folders', roots: [root], grants: [] });
  }
});

test('startSpoke: when the summary cannot be built, polls carry no scope field and keep flowing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-poll-'));
  const bodies = [];
  const spoke = startSpoke({
    config: { url: 'http://hub.test', token: 't', deviceId: 'pc-test', roots: [dir], usedDecisionsPath: join(dir, 'used.json') },
    fetchImpl: fakeHubFetch(bodies),
    log: () => {},
    scopeProvider: async () => { throw new Error('grants file exploded'); },
  });
  await sleep(200);
  spoke.stop();
  assert.ok(bodies.length >= 2, 'polling continued despite the failed summary');
  for (const body of bodies) assert.equal('scope' in body, false);
});

// ─── End to end: real spoke, real hub, the audit wiring from index.mjs ──────

async function boot() {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await mkdtemp(join(tmpdir(), 'hands-state-'));
  const config = loadConfig({ PUBLIC_URL: base, AUTH_PASSPHRASE: PASS, HANDS_ENABLED: 'true', STATE_DIR: state });
  const oauth = createOAuth({ resourceId: `${base}/mcp`, stateFile: join(state, 'oauth.json') });
  const guardClient = createGuardClient({ ...config.guard, pollMs: 50, timeoutMs: 1000 });
  const audit = createAudit(null);
  // The same wiring index.mjs uses: scope reports land in the audit.
  const hub = createSpokeHub({
    pollWaitMs: 300, resultWaitMs: 3000,
    onScopeReport: ({ deviceId, scope, changed, first = false, previous = null }) => audit.append({
      event: 'scope.reported', deviceId, tier: scope.tier, roots: scope.roots, grants: scope.grants,
      changed, ...(first ? { first: true } : {}), ...(previous ? { previous } : {}),
    }),
  });
  const hands = createHands({ config, guard: guardClient, hub, audit });
  const spokeTokens = createSpokeTokens({ file: join(state, 'spoke.json'), passphrase: PASS });
  server.on('request', createApp({ config, oauth, hands, hub, spokeTokens }));
  return { base, audit, hub, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

async function pairAndRun(base, roots, deviceId) {
  const configPath = join(await mkdtemp(join(tmpdir(), 'hands-cfg-')), 'hands-spoke.json');
  await pairSpoke({ url: base, passphrase: PASS, roots, configPath, deviceId });
  const config = { ...(await readSpokeConfig(configPath)), usedDecisionsPath: join(dirname(configPath), 'used.json') };
  const spoke = startSpoke({ config, log: () => {} });
  await sleep(250);
  return spoke;
}

async function until(fn, tries = 40) {
  for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await sleep(50); }
  return null;
}

test('end to end: a real spoke\'s scope lands in the audit once, and a wider restart flags the change', async () => {
  const app = await boot();
  const rootA = await mkdtemp(join(tmpdir(), 'hands-a-'));
  const rootB = await mkdtemp(join(tmpdir(), 'hands-b-'));

  const first = await pairAndRun(app.base, [rootA], 'pc-scope');
  const rows1 = await until(() => {
    const rows = app.audit.rows().filter((r) => r.event === 'scope.reported' && r.deviceId === 'pc-scope');
    return rows.length ? rows : null;
  });
  assert.ok(rows1, 'expected a scope.reported audit row');
  assert.equal(rows1.length, 1);
  assert.equal(rows1[0].tier, 'pick-folders');
  assert.deepEqual(rows1[0].roots, [rootA]);
  assert.deepEqual(rows1[0].grants, []);
  assert.equal(rows1[0].changed, false);
  assert.equal(rows1[0].first, true);
  // Presence (what hands_status serves) shows the same summary.
  assert.deepEqual(app.hub.presence().devices['pc-scope'].scope, { tier: 'pick-folders', roots: [rootA], grants: [] });
  first.stop();
  await sleep(150);

  // The spoke restarts with a wider roots list: the next report is flagged
  // as a change, carrying the previous summary — this is Shape 1's tripwire
  // for a silent local widening.
  const second = await pairAndRun(app.base, [rootA, rootB], 'pc-scope');
  const change = await until(() => app.audit.rows().find((r) => r.event === 'scope.reported' && r.changed === true) || null);
  assert.ok(change, 'expected a changed scope.reported audit row');
  assert.deepEqual(change.roots, [rootA, rootB].sort());
  assert.deepEqual(change.previous, { tier: 'pick-folders', roots: [rootA], grants: [] });
  assert.equal(app.audit.rows().filter((r) => r.event === 'scope.reported').length, 2);
  second.stop();
  await app.close();
});
