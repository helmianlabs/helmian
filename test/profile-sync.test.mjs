// Profile sync S1 (2026-11-05): the button is real now. These tests pin
// the three honesty guarantees of the bite:
//   (a) a button press enqueues a job — no handler anywhere answers
//       with the old hardcoded file list or a markSynced-only path;
//   (b) the device side runs the real installer and its report matches
//       the files actually on disk in a temp HOME, hashes included —
//       and a no-op run reports every examined file as "current" with
//       its hash, never a padded write list and never silence;
//   (c) the page's result model renders exactly the device-reported
//       list, and failure/empty render as what they are.
// FIX-A5 (2026-11-16) adds the fourth:
//   (d) a report is checked, not believed — every job carries the
//       expected kit hashes from enqueue time; a reported kit file
//       whose hash differs renders FAILED and fails the sync's
//       rendered state, a matching one renders verified, and anything
//       no expectation covers renders as reported by the PC, not
//       verified — never a checkmark it did not earn (AT-4 T10 leg 2).
//
// Composition note (push batch 2026-11-16): FIX-S1's report-verb half
// and FIX-A5's kit-check half are composed in this file exactly as
// their sources are composed in src/cloud/profile-sync.mjs — the
// device-run tests are FIX-S1's (the 'current' verb is real in the
// composed report), the store and page-model tests are FIX-A5's
// (fileChecks are real in the composed store), and FIX-S1's canary
// test rides along below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createProfileSyncJobStore,
  handleProfileSyncRoute,
  sanitizeProfileSyncFiles,
  buildExpectedKitHashes,
  verifyProfileSyncFiles,
  reportedKitRelativePath,
  PROFILE_SYNC_PATH,
  PROFILE_SYNC_NO_DESKTOP_CODE,
  PROFILE_SYNC_NO_DESKTOP_MESSAGE,
  PROFILE_SYNC_EXPIRED_MESSAGE,
  PROFILE_SYNC_PENDING_TTL_MS,
} from '../src/cloud/profile-sync.mjs';
import { installAgentOsTargets, DEFAULT_TEMPLATES_ROOT, loadAgentOsTemplates, renderAgentOsFiles } from '../src/core/agent-os.mjs';
import { handleRunnerPresenceRoute } from '../src/cloud/runner-presence.mjs';
import { executeProfileSync } from '../src/core/profile-sync-report.mjs';
import { profileSyncResultModel } from '../web/marketing/app/app-model.mjs';
import { integrationSections } from '../web/marketing/app/integrations-view.mjs';

const readSource = (rel) => readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// ── fakes ────────────────────────────────────────────────────────────

function makeFakeJobPool({ missingTable = false, desktops = 1 } = {}) {
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
      if (sql.includes('from helmion.desktop_links')) {
        return { rows: [{ n: desktops }] };
      }
      if (sql.includes('from helmion.provenance_weighting_profiles')) {
        // Bite 5: no tenant in the fake has saved a provenance profile,
        // so enqueue falls back to the default payload.
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('insert into helmion.profile_sync_jobs')) {
        const row = { id: nextId++, kind: params[0], status: 'pending', requested_by: params[1], result: null, error: null, created_at: new Date(), claimed_at: null, completed_at: null, expected_files: params[2] ? JSON.parse(params[2]) : null, provenance_file: params[3] ? JSON.parse(params[3]) : null };
        rowsFor().push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("status = 'pending'") && sql.includes('interval')) {
        // The pending-expiry sweep: stale pending rows close as failed
        // with the plain reason, exactly as the real UPDATE does.
        const ttl = Number(params[2]);
        const now = Date.now();
        let swept = 0;
        for (const row of rowsFor()) {
          if (row.status === 'pending' && now - row.created_at.getTime() > ttl) {
            row.status = 'failed';
            row.error = params[0];
            row.result = params[1] ? JSON.parse(params[1]) : null;
            row.completed_at = new Date();
            swept += 1;
          }
        }
        return { rows: [], rowCount: swept };
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
      if (sql.includes('order by created_at desc')) {
        const rows = [...rowsFor()].sort((a, b) => (b.created_at - a.created_at) || (b.id - a.id));
        return { rows: rows.slice(0, 1) };
      }
      if (sql.includes('select id, kind, status')) {
        const row = rowsFor().find((r) => r.id === Number(params[0]));
        return { rows: row ? [row] : [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    release: () => {},
  };
  return {
    connect: async () => client,
    // Test hook: backdate a job's created_at so the expiry window can
    // be exercised without waiting for it.
    _setCreatedAt(tenant, id, when) {
      const row = (byTenant.get(tenant) ?? []).find((r) => r.id === Number(id));
      if (row) row.created_at = when;
    },
  };
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

test('bite 5: enqueue stamps the provenance profile file, and its read-back verifies or mismatches', async () => {
  const store = createProfileSyncJobStore(makeFakeJobPool());
  const job = await store.enqueue('t1', { requestedBy: 'user-1' });
  assert.ok(job.provenanceFile, 'the job carries the provenance file');
  assert.equal(job.provenanceFile.path, '.helmion/provenance/weighting-profile.json');
  assert.match(job.provenanceFile.content, /provenance-weighting-profile/);
  const stampedHash = createHash('sha256').update(job.provenanceFile.content, 'utf8').digest('hex');

  const claimed = await store.claimNext('t1');
  assert.equal(claimed.provenanceFile.content, job.provenanceFile.content, 'the claiming bridge receives the exact bytes');

  const done = await store.report('t1', job.id, {
    status: 'done',
    files: [{ path: '.helmion/provenance/weighting-profile.json', target: 'workspace', action: 'created', sha256: stampedHash }],
  });
  assert.deepEqual(done.fileChecks, ['verified'], 'a read-back matching the enqueue-time hash verifies');

  const store2 = createProfileSyncJobStore(makeFakeJobPool());
  const job2 = await store2.enqueue('t1', {});
  await store2.claimNext('t1');
  const done2 = await store2.report('t1', job2.id, {
    status: 'done',
    files: [{ path: '.helmion/provenance/weighting-profile.json', target: 'workspace', action: 'created', sha256: 'a'.repeat(64) }],
  });
  assert.deepEqual(done2.fileChecks, ['mismatch'], 'a fabricated read-back hash mismatches, never verifies');
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

// ── the estate-scale report vs the host body cap (2026-11-06) ─────
// Jobs 8, 11 and 14 landed ~216 file writes each and sat in 'claimed'
// forever: the admin host's shared body reader caps request bodies at
// 16 KB, the route's empty catch swallowed the 413, and the oversized
// report was re-read as a button press — a phantom job was enqueued,
// the bridge got a 202, and the real job was never completed.

// A readJson with the host reader's exact cap behavior (live-admin.mjs
// readJsonObject): 16 KB by default, a larger cap only when the
// caller passes one as the second argument.
function hostReadJson(rawBody) {
  return async (request, maxBytes = 16 * 1024) => {
    if (Buffer.byteLength(rawBody) > maxBytes) {
      throw Object.assign(new Error('Request body is too large'), { status: 413 });
    }
    return JSON.parse(rawBody);
  };
}

function bigFileList(n) {
  return Array.from({ length: n }, (_, i) => ({
    path: `C:\\Users\\someone\\.claude\\agent-os\\estate\\lessons\\lesson-${String(i).padStart(3, '0')}-entry.md`,
    target: 'claude',
    action: 'created',
    sha256: 'c'.repeat(64),
  }));
}

test('an estate-scale report (216 files, body over the 16 KB host cap) is recorded, not re-read as an enqueue', async () => {
  const store = createProfileSyncJobStore(makeFakeJobPool());
  const job = await store.enqueue('t1', { requestedBy: 'user-1' });
  const claimed = await store.claimNext('t1');
  assert.equal(claimed.id, job.id);

  const rawBody = JSON.stringify({ jobId: job.id, status: 'done', files: bigFileList(216) });
  assert.ok(Buffer.byteLength(rawBody) > 16 * 1024, 'the report body must exceed the host default cap for this test to mean anything');

  const h = routeHarness({ actor: DEVICE, store });
  await handleProfileSyncRoute({
    ...h.args,
    request: { method: 'POST' },
    requestUrl: new URL(`http://x${PROFILE_SYNC_PATH}`),
    readJson: hostReadJson(rawBody),
  });
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.sent[0].body.job.status, 'done');
  assert.equal(h.sent[0].body.job.files.length, 216);

  const reread = await store.get('t1', job.id);
  assert.equal(reread.status, 'done');
  assert.equal(reread.files.length, 216);
  assert.equal(await store.claimNext('t1'), null, 'no phantom job was minted by the report');
});

test('an unreadable report body answers its error, never an enqueue', async () => {
  const store = createProfileSyncJobStore(makeFakeJobPool());
  const h = routeHarness({ actor: DEVICE, store });
  await handleProfileSyncRoute({
    ...h.args,
    request: { method: 'POST' },
    requestUrl: new URL(`http://x${PROFILE_SYNC_PATH}`),
    readJson: async () => { throw Object.assign(new Error('Request body is too large'), { status: 413 }); },
  });
  assert.equal(h.sent[0].status, 413);
  assert.equal(h.sent[0].body.valid, false);
  assert.equal(await store.claimNext('t1'), null, 'nothing was enqueued');
});

test('sanitize keeps only well-formed file entries', () => {
  const current = { ...VALID_FILE, action: 'current' };
  const out = sanitizeProfileSyncFiles([
    VALID_FILE,
    current,
    { ...VALID_FILE, action: 'deleted' },
    { ...VALID_FILE, sha256: 'zz' },
    { ...VALID_FILE, path: '' },
    'a string',
    null,
  ]);
  assert.deepEqual(out, [VALID_FILE, current], 'created/updated/current survive; every other verb is dropped');
  assert.deepEqual(sanitizeProfileSyncFiles(undefined), []);
  assert.deepEqual(sanitizeProfileSyncFiles('nope'), []);
});

// ── (d) the report is checked against the expected kit ─────────────

test('the expected kit covers exactly the cloud-predictable files, hashed from the installer render', async () => {
  const templates = await loadAgentOsTemplates();
  const expected = buildExpectedKitHashes(templates);
  const contextFiles = { claude: 'CLAUDE.md', codex: 'AGENTS.md', gemini: 'GEMINI.md', grok: 'AGENTS.md' };
  for (const target of ['claude', 'codex', 'gemini', 'grok']) {
    const table = expected[target];
    // In: companions, the managed index, the hook scripts — bytes the
    // shipped templates fully determine.
    for (const rel of ['LESSONS.md', 'LEARNINGS.md', 'BLOCKERS.md', 'WINS.md', 'SESSION_BOARD.md', 'memory/MEMORY.md', 'agent-os/AGENT_OS.md', 'agent-os/hooks/session-start-context.mjs', 'agent-os/hooks/stop-capture.mjs']) {
      assert.ok(/^[a-f0-9]{64}$/.test(table[rel] ?? ''), `${target}:${rel} carries an expected hash`);
    }
    // Out: the context file (an append lands in the user's own bytes),
    // the hooks snippet and the merge instructions (both embed the
    // PC's own install path), and anything estate-shaped.
    assert.equal(table[contextFiles[target]], undefined, `${target}: the context file is never expected`);
    assert.equal(table['agent-os/settings.hooks.json'], undefined, `${target}: the snippet embeds the install path`);
    assert.equal(table['agent-os/hooks.json'], undefined, `${target}: the snippet embeds the install path`);
    assert.equal(table['agent-os/MERGE_HOOKS.md'], undefined, `${target}: the merge instructions embed the install path`);
    assert.ok(!Object.keys(table).some((rel) => rel.includes('estate')), `${target}: no estate path is ever expected`);
    // The expectation IS the installer's render, byte for byte.
    const rendered = renderAgentOsFiles({ target, templates, installDir: '/anywhere' });
    for (const [rel, hash] of Object.entries(table)) {
      const file = rendered.find((f) => f.path === rel);
      assert.ok(file, `${target}:${rel} is a rendered kit file`);
      assert.equal(hash, createHash('sha256').update(file.content, 'utf8').digest('hex'), `${target}:${rel} hash is the render's hash`);
    }
  }
});

test('verifyProfileSyncFiles: kit match verifies, kit fabrication mismatches, the rest are reported', async () => {
  const expected = buildExpectedKitHashes(await loadAgentOsTemplates());
  const kitHash = expected.claude['agent-os/AGENT_OS.md'];
  const fabricated = createHash('sha256').update('a string that is not the installed file').digest('hex');
  const files = [
    { path: 'C:\\Users\\x\\.claude\\agent-os\\AGENT_OS.md', target: 'claude', action: 'updated', sha256: kitHash },
    { path: '/home/x/.codex/agent-os/AGENT_OS.md', target: 'codex', action: 'created', sha256: fabricated },
    { path: 'C:\\Users\\x\\.claude\\agent-os\\estate\\LESSONS.md', target: 'claude', action: 'created', sha256: fabricated },
    { path: 'C:\\Users\\x\\.claude\\CLAUDE.md', target: 'claude', action: 'updated', sha256: kitHash },
    { path: 'C:\\Users\\x\\.claude\\agent-os\\AGENT_OS.md', target: 'mistral', action: 'updated', sha256: kitHash },
  ];
  assert.deepEqual(verifyProfileSyncFiles(files, expected), ['verified', 'mismatch', 'reported', 'reported', 'reported']);
  assert.deepEqual(verifyProfileSyncFiles(files, null), ['reported', 'reported', 'reported', 'reported', 'reported'], 'no expectation: nothing is verified, nothing is checkmarked');
  assert.equal(reportedKitRelativePath(files[0]), 'agent-os/AGENT_OS.md');
  assert.equal(reportedKitRelativePath({ path: 'no-target-dir-here.md', target: 'claude' }), null);
});

test('job store: a fabricated kit hash reads back as a mismatch and fails the page model', async () => {
  const store = createProfileSyncJobStore(makeFakeJobPool());
  const expected = buildExpectedKitHashes(await loadAgentOsTemplates());
  const job = await store.enqueue('t1', { requestedBy: 'user-1' });
  assert.deepEqual(job.fileChecks, [], 'a pending job has no report to check');
  await store.claimNext('t1');
  const fabricated = createHash('sha256').update('well-formed, and not any installed file').digest('hex');
  const done = await store.report('t1', job.id, {
    status: 'done',
    files: [
      { path: 'C:\\Users\\x\\.claude\\agent-os\\AGENT_OS.md', target: 'claude', action: 'updated', sha256: fabricated },
      { path: 'C:\\Users\\x\\.claude\\agent-os\\hooks\\stop-capture.mjs', target: 'claude', action: 'created', sha256: expected.claude['agent-os/hooks/stop-capture.mjs'] },
      { path: 'C:\\Users\\x\\.claude\\agent-os\\estate\\lessons\\lesson-001.md', target: 'claude', action: 'created', sha256: fabricated },
    ],
  });
  assert.equal(done.status, 'done', 'the device report still closes the job — the verdict rides beside it');
  assert.deepEqual(done.fileChecks, ['mismatch', 'verified', 'reported']);
  const reread = await store.get('t1', job.id);
  assert.deepEqual(reread.fileChecks, ['mismatch', 'verified', 'reported'], 'the verdict survives the read-back');
  const model = profileSyncResultModel(reread);
  assert.equal(model.state, 'failed');
  assert.deepEqual(model.lines.map((l) => l.mark), ['failed', 'verified', 'reported']);
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
  assert.ok(second.files.length > 0, 'a no-op sync still reports the seat — as current, not silence');
  assert.ok(
    second.files.every((f) => f.action === 'current'),
    'nothing is claimed written on a no-op run',
  );
  for (const f of second.files) {
    const bytes = await readFile(f.path);
    assert.equal(f.sha256, createHash('sha256').update(bytes).digest('hex'), `${f.path} current hash matches the disk`);
  }
});

test('executeProfileSync carries the estate and reports hashes that equal the sources', async () => {
  const home = await mkdtemp(join(tmpdir(), 'profile-sync-estate-'));
  const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
  const sources = {
    // The source doubles as the claude seat's context file and already
    // carries the CURRENT agent OS block — so the sync leaves the source
    // itself untouched and the estate snapshot is stable across runs.
    // (A stale block would be refreshed in place; that is D2, pinned by
    // the agent-os tests.)
    'CLAUDE.md': '# Hand-built rules\n\nEverything I taught this seat, in my own words.\n\n<!-- BEGIN AGENT OS -->\nAgent OS is installed. The core rules, the self-improvement loop, and the\nadvisory lane are in the imported file below. Your own grown files — your\nrules document and the flywheel companions, copied from your source seat\nand refreshed on every sync — are imported after it.\n\n@agent-os/AGENT_OS.md\n@agent-os/estate/CLAUDE-ESTATE.md\n@agent-os/estate/LESSONS.md\n@agent-os/estate/LEARNINGS.md\n<!-- END AGENT OS -->\n',
    'LESSONS.md': '# LESSONS\n\nThe grown flywheel, one hundred lessons deep.\n',
    'LEARNINGS.md': '# LEARNINGS\n\n- The copy is the proof.\n',
  };
  await mkdir(join(home, '.claude'), { recursive: true });
  for (const [name, content] of Object.entries(sources)) {
    await writeFile(join(home, '.claude', name), content, 'utf8');
  }
  await mkdir(join(home, '.grok'), { recursive: true });

  const destFor = {
    'CLAUDE.md': 'CLAUDE-ESTATE.md',
    'LESSONS.md': 'LESSONS.md',
    'LEARNINGS.md': 'LEARNINGS.md',
  };

  const first = await executeProfileSync({ home, targets: ['claude', 'grok'] });
  for (const target of ['claude', 'grok']) {
    for (const [source, dest] of Object.entries(destFor)) {
      const entry = first.files.find(
        (f) => f.target === target && f.path === join(home, `.${target === 'claude' ? 'claude' : 'grok'}`, 'agent-os', 'estate', dest),
      );
      assert.ok(entry, `${target} must report its estate copy of ${source}`);
      assert.equal(entry.action, 'created');
      // The copy is verbatim, so the reported hash IS the source's hash.
      assert.equal(entry.sha256, sha(sources[source]), `${target}:${dest} hash must equal the source hash`);
    }
  }

  // Unchanged sources: nothing is written, and the estate copies are
  // reported as current — with the sources' hashes, so the report still
  // proves what each seat is running instead of going silent.
  const second = await executeProfileSync({ home, targets: ['claude', 'grok'] });
  assert.ok(second.files.length > 0, 'a no-op sync reports current files, not an empty list');
  assert.ok(second.files.every((f) => f.action === 'current'), 'a no-op sync claims no writes');
  for (const target of ['claude', 'grok']) {
    for (const [source, dest] of Object.entries(destFor)) {
      const entry = second.files.find(
        (f) => f.target === target && f.path === join(home, `.${target}`, 'agent-os', 'estate', dest),
      );
      assert.ok(entry, `${target} still reports its estate copy of ${source}, as current`);
      assert.equal(entry.sha256, sha(sources[source]), `${target}:${dest} current hash equals the source hash`);
    }
  }

  // One source grows: exactly its two copies are reported as updates;
  // everything else stays current.
  const grown = `${sources['LESSONS.md']}One more lesson.\n`;
  await writeFile(join(home, '.claude', 'LESSONS.md'), grown, 'utf8');
  const third = await executeProfileSync({ home, targets: ['claude', 'grok'] });
  const updated = third.files.filter((f) => f.action === 'updated');
  assert.equal(updated.length, 2, 'only the refreshed estate copies are reported as updated');
  assert.ok(third.files.every((f) => f.action === 'updated' || f.action === 'current'));
  for (const entry of updated) {
    assert.ok(entry.path.endsWith(join('estate', 'LESSONS.md')));
    assert.equal(entry.sha256, sha(grown));
  }
});

test('FIX-S1: a canary rules change shows in the second sync report for codex and grok', async () => {
  const home = await mkdtemp(join(tmpdir(), 'profile-sync-canary-'));
  const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
  await mkdir(join(home, '.codex'), { recursive: true });
  await mkdir(join(home, '.grok'), { recursive: true });
  await writeFile(join(home, '.codex', 'AGENTS.md'), '# Codex own rules\n', 'utf8');
  await writeFile(join(home, '.grok', 'AGENTS.md'), '# Grok own rules\n', 'utf8');

  // Two template trees: the kit as shipped, and the kit with a canary
  // rule planted in the core rules.
  const rootV1 = await mkdtemp(join(tmpdir(), 'agent-os-templates-v1-'));
  await cp(DEFAULT_TEMPLATES_ROOT, rootV1, { recursive: true });
  const rootV2 = await mkdtemp(join(tmpdir(), 'agent-os-templates-v2-'));
  await cp(DEFAULT_TEMPLATES_ROOT, rootV2, { recursive: true });
  const rulesPath = join(rootV2, 'core', 'CORE_RULES.md');
  const rules = await readFile(rulesPath, 'utf8');
  await writeFile(rulesPath, `${rules}\nCANARY-RULE-7749: always check the canary.\n`, 'utf8');

  const installWith = (templatesRoot) => ({ targets, apply, home: h }) =>
    installAgentOsTargets({ targets, apply, home: h, templatesRoot });

  await executeProfileSync({ home, targets: ['codex', 'grok'], installImpl: installWith(rootV1) });
  const second = await executeProfileSync({ home, targets: ['codex', 'grok'], installImpl: installWith(rootV2) });
  for (const target of ['codex', 'grok']) {
    const entry = second.files.find((f) => f.target === target && f.path.endsWith('AGENTS.md'));
    assert.ok(entry, `${target}: its AGENTS.md is in the second report`);
    assert.equal(entry.action, 'updated', `${target}: the report shows the refresh landed`);
    const text = await readFile(entry.path, 'utf8');
    assert.ok(text.includes('CANARY-RULE-7749'), `${target}: the canary is in the loaded cargo`);
    assert.ok(text.includes(`# ${target === 'codex' ? 'Codex' : 'Grok'} own rules`), `${target}: the seat own content survives`);
    assert.equal(entry.sha256, sha(text), `${target}: the reported hash is the refreshed file hash`);
  }

  const third = await executeProfileSync({ home, targets: ['codex', 'grok'], installImpl: installWith(rootV2) });
  for (const target of ['codex', 'grok']) {
    const entry = third.files.find((f) => f.target === target && f.path.endsWith('AGENTS.md'));
    assert.equal(entry.action, 'current', `${target}: a landed refresh settles to current`);
  }
});

// ── (c) the page model renders exactly the device report ────────────

test('result model renders exactly the reported list on done', () => {
  // No fileChecks ride this job (the shape a job enqueued before the
  // kit check existed reads back as): nothing was verified, so every
  // line renders as reported by the PC, not verified — no checkmarks.
  const job = {
    status: 'done',
    files: [
      { path: 'C:\\Users\\x\\.claude\\CLAUDE.md', target: 'claude', action: 'updated', sha256: 'a'.repeat(64) },
      { path: 'C:\\Users\\x\\.codex\\AGENTS.md', target: 'codex', action: 'created', sha256: 'b'.repeat(64) },
    ],
  };
  const model = profileSyncResultModel(job);
  assert.equal(model.state, 'done');
  assert.equal(model.statusText, 'Synced 2 files — reported by your PC, not verified');
  assert.deepEqual(model.lines, [
    { text: 'C:\\Users\\x\\.claude\\CLAUDE.md (updated) — reported by your PC, not verified', mark: 'reported' },
    { text: 'C:\\Users\\x\\.codex\\AGENTS.md (created) — reported by your PC, not verified', mark: 'reported' },
  ]);
});

test('result model: a kit mismatch fails the rendered sync, a match verifies, the rest stay reported', () => {
  const job = {
    status: 'done',
    files: [
      { path: 'C:\\Users\\x\\.claude\\agent-os\\AGENT_OS.md', target: 'claude', action: 'updated', sha256: 'a'.repeat(64) },
      { path: 'C:\\Users\\x\\.claude\\agent-os\\hooks\\stop-capture.mjs', target: 'claude', action: 'created', sha256: 'b'.repeat(64) },
      { path: 'C:\\Users\\x\\.claude\\agent-os\\estate\\LESSONS.md', target: 'claude', action: 'created', sha256: 'c'.repeat(64) },
    ],
    fileChecks: ['mismatch', 'verified', 'reported'],
  };
  const model = profileSyncResultModel(job);
  assert.equal(model.state, 'failed', 'a mismatched kit file fails the rendered state even though the device said done');
  assert.match(model.statusText, /did not match the files Helmian shipped/);
  assert.deepEqual(model.lines.map((l) => l.mark), ['failed', 'verified', 'reported']);
  assert.match(model.lines[0].text, /FAILED: not the file Helmian shipped/);
  assert.equal(model.lines[1].text, 'C:\\Users\\x\\.claude\\agent-os\\hooks\\stop-capture.mjs (created)');
  assert.match(model.lines[2].text, /reported by your PC, not verified/);

  const clean = profileSyncResultModel({ ...job, fileChecks: ['verified', 'verified', 'reported'] });
  assert.equal(clean.state, 'done');
  assert.equal(clean.statusText, 'Synced 3 files — 2 verified against the kit Helmian shipped, 1 reported by your PC and not verified');

  const allVerified = profileSyncResultModel({ status: 'done', files: job.files.slice(0, 2), fileChecks: ['verified', 'verified'] });
  assert.equal(allVerified.state, 'done');
  assert.equal(allVerified.statusText, 'Synced 2 files — verified against the kit Helmian shipped');
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

// ── press truth, state truth, expiry (2026-11-10) ───────────────────
// Found live: with no desktop linked to the workspace, the press
// queued a job nothing could ever claim, the page spun on "Syncing",
// and minutes later both surfaces showed nothing at all — Settings
// blank, the Devices card back to "Ready" over a still-pending job.
// These tests pin the three fixes: the press answers with the fact,
// both surfaces render the newest job's real state, and an unclaimed
// job closes itself with the plain reason inside the window.

test('desktopLinked reads the tenant desktop links', async () => {
  assert.equal(await createProfileSyncJobStore(makeFakeJobPool({ desktops: 0 })).desktopLinked('t1'), false);
  assert.equal(await createProfileSyncJobStore(makeFakeJobPool({ desktops: 2 })).desktopLinked('t1'), true);
  assert.equal(await createProfileSyncJobStore(makeFakeJobPool({ missingTable: true })).desktopLinked('t1'), false, 'a missing links table reads as no link');
});

test('profile-sync route: a press with no desktop linked is refused at press time and queues nothing', async () => {
  const store = createProfileSyncJobStore(makeFakeJobPool({ desktops: 0 }));
  const h = routeHarness({ actor: MEMBER, body: {}, store });
  await handleProfileSyncRoute({ ...h.args, request: { method: 'POST' }, requestUrl: new URL(`http://x${PROFILE_SYNC_PATH}`) });
  assert.equal(h.sent[0].status, 409);
  assert.equal(h.sent[0].body.valid, false);
  assert.equal(h.sent[0].body.code, PROFILE_SYNC_NO_DESKTOP_CODE);
  assert.equal(h.sent[0].body.detail, PROFILE_SYNC_NO_DESKTOP_MESSAGE);
  assert.equal(await store.latest('t1'), null, 'no job was queued behind the refusal');
});

test('presence sync press with no desktop linked: refused before any stamp, nothing queued', async () => {
  const stamped = [];
  const presenceStore = {
    markSynced: async (tenantId, provider) => { stamped.push(provider); return { ok: true }; },
    list: async () => [],
    listActivity: async () => [],
  };
  const store = createProfileSyncJobStore(makeFakeJobPool({ desktops: 0 }));
  const { sent, args } = routeHarness({ actor: MEMBER, body: { syncProfile: true }, store: presenceStore });
  const handled = await handleRunnerPresenceRoute({
    ...args,
    request: { method: 'POST' },
    requestUrl: new URL('http://x/api/admin/envoy/runner/presence'),
    profileSyncJobs: store,
  });
  assert.equal(handled, true);
  assert.equal(sent[0].status, 409);
  assert.equal(sent[0].body.code, PROFILE_SYNC_NO_DESKTOP_CODE);
  assert.equal(sent[0].body.detail, PROFILE_SYNC_NO_DESKTOP_MESSAGE);
  assert.deepEqual(stamped, [], 'a refused press stamps no provider as synced');
  assert.equal(await store.latest('t1'), null, 'no job was queued behind the refusal');
});

test('presence sync press with a desktop linked still enqueues and stamps, as before', async () => {
  const stamped = [];
  const presenceStore = {
    markSynced: async (tenantId, provider) => { stamped.push(provider); return { ok: true }; },
    list: async () => [],
    listActivity: async () => [],
  };
  const store = createProfileSyncJobStore(makeFakeJobPool({ desktops: 1 }));
  const { sent, args } = routeHarness({ actor: MEMBER, body: { syncProfile: true }, store: presenceStore });
  await handleRunnerPresenceRoute({
    ...args,
    request: { method: 'POST' },
    requestUrl: new URL('http://x/api/admin/envoy/runner/presence'),
    profileSyncJobs: store,
  });
  assert.equal(sent[0].status, 202);
  assert.equal(sent[0].body.syncJob.status, 'pending');
  assert.deepEqual(sent[0].body.syncedFiles, []);
  assert.ok(stamped.includes('claude'), 'the happy path still stamps');
  assert.deepEqual(
    [...stamped].sort(),
    ['claude', 'gemini', 'grok', 'mistral', 'openai', 'qwen'],
    'the stamp set is exactly the write set — six stamps for six writes',
  );
  const latest = await store.latest('t1');
  assert.equal(latest.id, sent[0].body.syncJob.id);
  assert.equal(latest.status, 'pending');
});

test('the newest job is readable with no id — the state both surfaces render', async () => {
  const store = createProfileSyncJobStore(makeFakeJobPool());
  // Nothing queued yet: a clean null, not an error.
  let h = routeHarness({ actor: MEMBER, store });
  await handleProfileSyncRoute({ ...h.args, request: { method: 'GET' }, requestUrl: new URL(`http://x${PROFILE_SYNC_PATH}`) });
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.sent[0].body.job, null);

  const first = await store.enqueue('t1', { requestedBy: 'user-1' });
  const second = await store.enqueue('t1', { requestedBy: 'user-1' });
  assert.ok(first.id !== second.id);
  assert.equal((await store.latest('t1')).id, second.id, 'latest is the newest job');
  assert.equal(await store.latest('t2'), null, 'latest is tenant-scoped');

  h = routeHarness({ actor: MEMBER, store });
  await handleProfileSyncRoute({ ...h.args, request: { method: 'GET' }, requestUrl: new URL(`http://x${PROFILE_SYNC_PATH}`) });
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.sent[0].body.job.id, second.id);
  assert.equal(h.sent[0].body.job.status, 'pending');
});

test('a pending job no device claims inside the window is failed with the plain reason', async () => {
  const pool = makeFakeJobPool();
  const store = createProfileSyncJobStore(pool);
  const job = await store.enqueue('t1', { requestedBy: 'user-1' });
  pool._setCreatedAt('t1', job.id, new Date(Date.now() - PROFILE_SYNC_PENDING_TTL_MS - 60_000));
  assert.equal(await store.claimNext('t1'), null, 'an expired job is never handed to a device');
  const read = await store.get('t1', job.id);
  assert.equal(read.status, 'failed');
  assert.equal(read.expired, true);
  assert.equal(read.error, PROFILE_SYNC_EXPIRED_MESSAGE);
});

test('a fresh pending job and a claimed job are untouched by the expiry window', async () => {
  const pool = makeFakeJobPool();
  const store = createProfileSyncJobStore(pool);
  const job = await store.enqueue('t1', {});
  pool._setCreatedAt('t1', job.id, new Date(Date.now() - PROFILE_SYNC_PENDING_TTL_MS + 60_000));
  const readFresh = await store.get('t1', job.id);
  assert.equal(readFresh.status, 'pending');
  assert.equal(readFresh.expired, false);

  const claimed = await store.claimNext('t1');
  assert.equal(claimed.id, job.id);
  pool._setCreatedAt('t1', job.id, new Date(Date.now() - PROFILE_SYNC_PENDING_TTL_MS - 60_000));
  const readClaimed = await store.get('t1', job.id);
  assert.equal(readClaimed.status, 'claimed', 'a claimed job belongs to the PC that took it; the sweep closes only unclaimed work');
});

test('result model: waiting, running and expired read as what they are', () => {
  const queuedAt = new Date(Date.now() - 5 * 60_000);
  const pending = profileSyncResultModel({ status: 'pending', createdAt: queuedAt.toISOString() });
  assert.equal(pending.state, 'running');
  assert.match(pending.statusText, /Waiting for your computer/);
  assert.match(pending.statusText, /waiting for its report/);

  const claimed = profileSyncResultModel({ status: 'claimed', createdAt: queuedAt.toISOString(), claimedAt: new Date().toISOString() });
  assert.equal(claimed.state, 'running');
  assert.match(claimed.statusText, /Sync running on your PC/);
  assert.match(claimed.statusText, /waiting for its report/);

  const expired = profileSyncResultModel({ status: 'failed', expired: true, error: PROFILE_SYNC_EXPIRED_MESSAGE });
  assert.equal(expired.state, 'failed');
  assert.equal(expired.statusText, PROFILE_SYNC_EXPIRED_MESSAGE, 'an expired job renders its plain reason whole, not as a failure on the PC');
});

test('the Devices sync card renders the newest job, not a resting lie', () => {
  const cardFor = (job) => integrationSections({ profileSyncJob: job })
    .find((s) => s.id === 'devices').cards.find((c) => c.key === 'profile-sync');
  assert.equal(cardFor(null).statusText, 'Ready', 'no job yet keeps the resting state');
  const pending = cardFor({ status: 'pending', createdAt: new Date().toISOString(), files: [] });
  assert.match(pending.statusText, /Waiting for your computer/);
  const expired = cardFor({ status: 'failed', expired: true, error: PROFILE_SYNC_EXPIRED_MESSAGE, files: [] });
  assert.equal(expired.status, 'off');
  assert.equal(expired.statusText, PROFILE_SYNC_EXPIRED_MESSAGE);
  const done = cardFor({ status: 'done', files: [VALID_FILE] });
  assert.equal(done.status, 'on');
  assert.equal(done.statusText, 'Synced 1 file — reported by your PC, not verified');
});

test('web sources: the state read is wired and no surface stamps a fake success', async () => {
  const appSource = await readSource('../web/marketing/app/app.js');
  assert.ok(appSource.includes('loadProfileSyncStatus'), 'Settings load reads the newest job');
  assert.ok(appSource.includes('PROFILE_SYNC_NO_DESKTOP'), 'the press renders the no-computer answer');
  assert.ok(!appSource.includes("textContent = 'Synced ✓'"), 'no handler stamps a success the job never reported');
  const viewSource = await readSource('../web/marketing/app/integrations-view.mjs');
  assert.ok(viewSource.includes('profileSyncResultModel'), 'the Devices card renders the same job model as Settings');
});
