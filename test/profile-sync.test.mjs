// Profile sync S1 (2026-11-05): the button is real now. These tests pin
// the three honesty guarantees of the bite:
//   (a) a button press enqueues a job — no handler anywhere answers
//       with the old hardcoded file list or a markSynced-only path;
//   (b) the device side runs the real installer and its report matches
//       the files actually on disk in a temp HOME, hashes included —
//       and a no-op run reports an empty list, not a success story;
//   (c) the page's result model renders exactly the device-reported
//       list, and failure/empty render as what they are.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createProfileSyncJobStore,
  handleProfileSyncRoute,
  sanitizeProfileSyncFiles,
  PROFILE_SYNC_PATH,
} from '../src/cloud/profile-sync.mjs';
import { handleRunnerPresenceRoute } from '../src/cloud/runner-presence.mjs';
import { executeProfileSync } from '../src/core/profile-sync-report.mjs';
import { profileSyncResultModel } from '../web/marketing/app/app-model.mjs';

const readSource = (rel) => readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// ── fakes ────────────────────────────────────────────────────────────

function makeFakeJobPool({ missingTable = false } = {}) {
  const byTenant = new Map();
  let nextId = 1;
  let currentTenant = null;
  const rowsFor = () => {
    if (!byTenant.has(currentTenant)) byTenant.set(currentTenant, []);
    return byTenant.get(currentTenant);
  };
  const client = {
    query: async (sql, params = []) => {
      if (missingTable) { const e = new Error('missing'); e.code = '42P01'; throw e; }
      if (sql.includes('set_config')) { currentTenant = params[0]; return { rows: [] }; }
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return {};
      if (sql.includes('insert into helmion.profile_sync_jobs')) {
        const row = { id: nextId++, kind: params[0], status: 'pending', requested_by: params[1], result: null, error: null, created_at: new Date(), claimed_at: null, completed_at: null };
        rowsFor().push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("set status = 'claimed'")) {
        const row = rowsFor().filter((r) => r.status === 'pending').sort((a, b) => a.id - b.id)[0];
        if (!row) return { rows: [], rowCount: 0 };
        row.status = 'claimed'; row.claimed_at = new Date();
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('completed_at = clock_timestamp()')) {
        const row = rowsFor().find((r) => r.id === Number(params[0]) && r.status === 'claimed');
        if (!row) return { rows: [], rowCount: 0 };
        row.status = params[1];
        row.result = params[2] ? JSON.parse(params[2]) : null;
        row.error = params[3];
        row.completed_at = new Date();
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('select id, kind, status')) {
        const row = rowsFor().find((r) => r.id === Number(params[0]));
        return { rows: row ? [row] : [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    release: () => {},
  };
  return { connect: async () => client };
}

function routeHarness({ actor, body = {}, store }) {
  const sent = [];
  return {
    sent,
    args: {
      request: { method: 'GET' },
      response: {},
      activeTenantActor: async () => actor,
      send: (response, status, text) => { sent.push({ status, body: JSON.parse(text) }); },
      TenantAuthorizationError: class extends Error {},
      readJson: async () => body,
      store,
    },
  };
}

const MEMBER = { tenantId: 't1', subject: 'user-1' };
const DEVICE = { tenantId: 't1', subject: 'device-1', viaDeviceToken: true };
const VALID_FILE = { path: 'C:\\Users\\x\\.claude\\CLAUDE.md', target: 'claude', action: 'updated', sha256: 'a'.repeat(64) };

// ── (a) the button enqueues a job ────────────────────────────────────

test('presence sync branch enqueues a job and returns no file list', async () => {
  const enqueued = [];
  const presenceStore = {
    markSynced: async () => ({ ok: true }),
    list: async () => [],
    listActivity: async () => [],
  };
  const jobs = {
    enqueue: async (tenantId, opts) => {
      enqueued.push({ tenantId, opts });
      return { id: '7', kind: 'profile-sync', status: 'pending' };
    },
  };
  const { sent, args } = routeHarness({ actor: MEMBER, body: { syncProfile: true }, store: presenceStore });
  const handled = await handleRunnerPresenceRoute({
    ...args,
    request: { method: 'POST' },
    requestUrl: new URL('http://x/api/admin/envoy/runner/presence'),
    profileSyncJobs: jobs,
  });
  assert.equal(handled, true);
  assert.equal(enqueued.length, 1, 'exactly one job enqueued');
  assert.equal(enqueued[0].tenantId, 't1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].status, 202);
  assert.equal(sent[0].body.syncJob.id, '7');
  assert.equal(sent[0].body.syncJob.status, 'pending');
  assert.deepEqual(sent[0].body.syncedFiles, [], 'no file list may ride the enqueue answer');
  assert.ok(!JSON.stringify(sent[0].body).includes('Scribe Shared Memory'), 'the old fiction strings are gone');
});

test('no handler source carries the hardcoded synced-files list anymore', async () => {
  for (const rel of ['../src/cloud/runner-presence.mjs', '../src/cloud/envoy-ably.mjs']) {
    const source = await readSource(rel);
    assert.ok(!source.includes('Scribe Shared Memory & Flywheel rules'), rel);
    assert.ok(!source.includes('~/.claude/CLAUDE.md (+ agent-os/'), rel);
    assert.ok(!source.includes('~/.helmion/autonomy_rules.json (Helmian Guard'), rel);
  }
  const appSource = await readSource('../web/marketing/app/app.js');
  assert.ok(!appSource.includes('Synced ${list.length} targets'), 'the fake success line is gone');
  assert.ok(!appSource.includes('r.syncedFiles'), 'the page never renders a server-supplied list');
  assert.ok(appSource.includes('profileSyncResultModel'), 'the page renders the device-report model');
});

test('job store round-trips enqueue → claim → report, tenant-scoped', async () => {
  const pool = makeFakeJobPool();
  const store = createProfileSyncJobStore(pool);
  const job = await store.enqueue('t1', { requestedBy: 'user-1' });
  assert.equal(job.status, 'pending');
  assert.equal(job.requestedBy, 'user-1');
  assert.deepEqual(job.files, []);

  assert.equal(await store.get('t2', job.id), null, 'another tenant cannot read the job');

  const claimed = await store.claimNext('t1');
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, 'claimed');
  assert.equal(await store.claimNext('t1'), null, 'a claimed job is not handed out twice');

  const done = await store.report('t1', job.id, {
    status: 'done',
    files: [VALID_FILE, { path: 'x', target: 'claude', action: 'created', sha256: 'not-a-hash' }, { nope: true }],
  });
  assert.equal(done.status, 'done');
  assert.deepEqual(done.files, [VALID_FILE], 'the report is sanitized on the way in');

  const reread = await store.get('t1', job.id);
  assert.deepEqual(reread.files, [VALID_FILE]);
});

test('a report for an unclaimed job is refused', async () => {
  const store = createProfileSyncJobStore(makeFakeJobPool());
  const job = await store.enqueue('t1', {});
  await assert.rejects(() => store.report('t1', job.id, { status: 'done', files: [] }), (e) => e?.status === 409);
});

test('job store 503s when the migration is not applied', async () => {
  const store = createProfileSyncJobStore(makeFakeJobPool({ missingTable: true }));
  await assert.rejects(() => store.enqueue('t1', {}), (e) => e?.status === 503);
});

test('profile-sync route: members enqueue and read, only devices claim and report', async () => {
  const store = createProfileSyncJobStore(makeFakeJobPool());

  // member enqueues through the route's own POST (no jobId in body)
  let h = routeHarness({ actor: MEMBER, body: {}, store });
  await handleProfileSyncRoute({ ...h.args, request: { method: 'POST' }, requestUrl: new URL(`http://x${PROFILE_SYNC_PATH}`) });
  assert.equal(h.sent[0].status, 202);
  const jobId = h.sent[0].body.job.id;

  // member tries to claim work → refused
  h = routeHarness({ actor: MEMBER, store });
  await handleProfileSyncRoute({ ...h.args, request: { method: 'GET' }, requestUrl: new URL(`http://x${PROFILE_SYNC_PATH}?work=1`) });
  assert.equal(h.sent[0].status, 403);

  // member tries to report → refused
  h = routeHarness({ actor: MEMBER, body: { jobId, status: 'done', files: [VALID_FILE] }, store });
  await handleProfileSyncRoute({ ...h.args, request: { method: 'POST' }, requestUrl: new URL(`http://x${PROFILE_SYNC_PATH}`) });
  assert.equal(h.sent[0].status, 403);

  // device claims
  h = routeHarness({ actor: DEVICE, store });
  await handleProfileSyncRoute({ ...h.args, request: { method: 'GET' }, requestUrl: new URL(`http://x${PROFILE_SYNC_PATH}?work=1`) });
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.sent[0].body.job.id, jobId);

  // device reports
  h = routeHarness({ actor: DEVICE, body: { jobId, status: 'done', files: [VALID_FILE] }, store });
  await handleProfileSyncRoute({ ...h.args, request: { method: 'POST' }, requestUrl: new URL(`http://x${PROFILE_SYNC_PATH}`) });
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.sent[0].body.job.status, 'done');

  // member reads the finished job back
  h = routeHarness({ actor: MEMBER, store });
  await handleProfileSyncRoute({ ...h.args, request: { method: 'GET' }, requestUrl: new URL(`http://x${PROFILE_SYNC_PATH}?job=${jobId}`) });
  assert.equal(h.sent[0].status, 200);
  assert.deepEqual(h.sent[0].body.job.files, [VALID_FILE]);

  // a foreign path is not ours
  const out = await handleProfileSyncRoute({
    ...routeHarness({ actor: MEMBER, store }).args,
    request: { method: 'GET' },
    requestUrl: new URL('http://x/api/admin/envoy/channels'),
  });
  assert.equal(out, false);
});

test('sanitize keeps only well-formed file entries', () => {
  const out = sanitizeProfileSyncFiles([
    VALID_FILE,
    { ...VALID_FILE, action: 'deleted' },
    { ...VALID_FILE, sha256: 'zz' },
    { ...VALID_FILE, path: '' },
    'a string',
    null,
  ]);
  assert.deepEqual(out, [VALID_FILE]);
  assert.deepEqual(sanitizeProfileSyncFiles(undefined), []);
  assert.deepEqual(sanitizeProfileSyncFiles('nope'), []);
});

// ── (b) the device run reports what is actually on disk ─────────────

test('executeProfileSync reports files that match the disk, hashes included', async () => {
  const home = await mkdtemp(join(tmpdir(), 'profile-sync-home-'));
  const { files } = await executeProfileSync({ home, targets: ['claude'] });
  assert.ok(files.length > 0, 'a first install writes files');
  for (const f of files) {
    assert.equal(f.target, 'claude');
    assert.equal(f.action, 'created', `${f.path} is newly written on a fresh home`);
    assert.ok(f.path.startsWith(join(home, '.claude')), `${f.path} lives under the temp HOME`);
    const bytes = await readFile(f.path);
    assert.ok((await stat(f.path)).isFile());
    assert.equal(f.sha256, createHash('sha256').update(bytes).digest('hex'), `${f.path} hash matches the disk`);
  }
  const second = await executeProfileSync({ home, targets: ['claude'] });
  assert.deepEqual(second.files, [], 'a no-op sync reports an empty list, not a success story');
});

// ── (c) the page model renders exactly the device report ────────────

test('result model renders exactly the reported list on done', () => {
  const job = {
    status: 'done',
    files: [
      { path: 'C:\\Users\\x\\.claude\\CLAUDE.md', target: 'claude', action: 'updated', sha256: 'a'.repeat(64) },
      { path: 'C:\\Users\\x\\.codex\\AGENTS.md', target: 'codex', action: 'created', sha256: 'b'.repeat(64) },
    ],
  };
  const model = profileSyncResultModel(job);
  assert.equal(model.state, 'done');
  assert.equal(model.statusText, 'Synced 2 files — as reported by your PC');
  assert.deepEqual(model.lines, [
    'C:\\Users\\x\\.claude\\CLAUDE.md (updated)',
    'C:\\Users\\x\\.codex\\AGENTS.md (created)',
  ]);
});

test('result model: empty report, failure, and pending never look like success', () => {
  const empty = profileSyncResultModel({ status: 'done', files: [] });
  assert.equal(empty.state, 'done');
  assert.deepEqual(empty.lines, []);
  assert.match(empty.statusText, /no files written/);

  const failed = profileSyncResultModel({ status: 'failed', error: 'disk full', files: [VALID_FILE] });
  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.lines, [], 'a failed job renders no file list');
  assert.match(failed.statusText, /Sync failed on your PC: disk full/);

  for (const status of ['pending', 'claimed']) {
    const running = profileSyncResultModel({ status });
    assert.equal(running.state, 'running');
    assert.deepEqual(running.lines, []);
    assert.match(running.statusText, /waiting for its report/);
  }

  assert.deepEqual(profileSyncResultModel(null), { state: 'idle', statusText: '', lines: [] });
});
