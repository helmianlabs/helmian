import assert from 'node:assert/strict';
import test from 'node:test';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import {
  createLiveHelmianCloudAdminHandler,
  LIVE_ADMIN_MAESTRO_HANDOFFS_PATH,
  LIVE_ADMIN_MAESTRO_CHECKPOINTS_PATH,
  LIVE_ADMIN_RUNS_LEDGER_PATH,
  LIVE_ADMIN_LEASES_POSTURE_PATH,
} from '../src/cloud/live-admin.mjs';
import { createEvidenceStore } from '../src/cloud/evidence.mjs';

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };

function missingTable() {
  const error = new Error('relation "helmion.missing" does not exist');
  error.code = '42P01';
  return error;
}

// Fake pool for store unit tests: handles the tenant-context plumbing and
// answers table reads from canned rows (or throws 42P01 per table).
// `roles` maps actor subject -> role for the membership check.
function storePool({ tables = {}, roles = {} } = {}) {
  const client = {
    async query(sql, params) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
      if (q.includes('from helmion.tenant_memberships')) {
        const subject = params?.[1];
        return { rowCount: 1, rows: [{ role: roles[subject] ?? 'owner' }] };
      }
      for (const [name, rows] of Object.entries(tables)) {
        if (q.includes(`from helmion.${name}`)) {
          if (rows === '42P01') throw missingTable();
          const limit = Number(params?.[params.length - 1]);
          const sliced = Number.isFinite(limit) ? rows.slice(0, limit) : rows;
          return { rowCount: sliced.length, rows: sliced };
        }
      }
      throw new Error(`unexpected query ${q}`);
    },
    release() {},
  };
  return { connect: async () => client };
}

const HANDOFF_ROW = {
  id: 7, project_slug: 'aimforge', from_coordinator_id: 'maestro-a', to_coordinator_id: 'maestro-b',
  status: 'COMPLETE', warning: null, requires_human_confirmation: false, confirmed_by: null,
  confirmed_at: null, checkpoint_id: 3, payload: { summary: 'Shift change', evidence: 'Checkpoint #3 verified' },
  switched_by: 'owner-1', created_at: new Date('2026-10-16T18:00:00Z'),
};

const CHECKPOINT_ROW = {
  id: 3, project_slug: 'aimforge', coordinator_id: 'maestro-a', work_completed: 'Built the widget',
  files_changed: ['app.js'], test_results: ['12/12 pass'], open_blockers: [], unresolved_risks: ['none'],
  next_safe_action: 'Ship it', created_at: new Date('2026-10-16T17:00:00Z'),
};

test('evidence store lists handoffs latest-first with a bounded limit', async () => {
  const store = createEvidenceStore(storePool({ tables: { maestro_handoffs: [HANDOFF_ROW] } }));
  const actor = { tenantId: 'customer-a', subject: 'owner-1', role: 'owner', sessionId: 's', requestId: 'r' };
  const result = await store.listHandoffs(actor, 200);
  assert.equal(result.handoffs.length, 1);
  assert.equal(result.handoffs[0].direction, 'maestro-a → maestro-b');
  assert.equal(result.handoffs[0].summary, 'Shift change');
  assert.equal(result.migrationPending, false);
});

test('evidence store clamps the limit and defaults it', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ ...HANDOFF_ROW, id: i + 1 }));
  const store = createEvidenceStore(storePool({ tables: { maestro_handoffs: rows } }));
  const actor = { tenantId: 'customer-a', subject: 'owner-1', role: 'owner', sessionId: 's', requestId: 'r' };
  assert.equal((await store.listHandoffs(actor, 2)).handoffs.length, 2);
  assert.equal((await store.listHandoffs(actor, 9999)).handoffs.length, 5);
  assert.equal((await store.listHandoffs(actor, 'nope')).handoffs.length, 5);
});

test('evidence store degrades gracefully when pre-tenant tables are missing', async () => {
  const store = createEvidenceStore(storePool({ tables: { maestro_handoffs: '42P01', project_checkpoints: '42P01', maestro_leases: '42P01' } }));
  const actor = { tenantId: 'customer-a', subject: 'owner-1', role: 'owner', sessionId: 's', requestId: 'r' };
  const handoffs = await store.listHandoffs(actor);
  assert.deepEqual(handoffs.handoffs, []);
  assert.equal(handoffs.migrationPending, true);
  const checkpoints = await store.listCheckpoints(actor);
  assert.deepEqual(checkpoints.checkpoints, []);
  assert.equal(checkpoints.migrationPending, true);
});

test('evidence store maps checkpoint cards fully', async () => {
  const store = createEvidenceStore(storePool({ tables: { project_checkpoints: [CHECKPOINT_ROW] }, roles: { 'admin-1': 'admin' } }));
  const actor = { tenantId: 'customer-a', subject: 'admin-1', role: 'admin', sessionId: 's', requestId: 'r' };
  const result = await store.listCheckpoints(actor);
  assert.equal(result.checkpoints[0].workCompleted, 'Built the widget');
  assert.deepEqual(result.checkpoints[0].filesChanged, ['app.js']);
  assert.equal(result.checkpoints[0].nextSafeAction, 'Ship it');
});

test('evidence store refuses handoffs and checkpoints for non-admin roles', async () => {
  const store = createEvidenceStore(storePool({ tables: { maestro_handoffs: [HANDOFF_ROW] } }));
  const actor = { tenantId: 'customer-a', subject: 'member-1', role: 'member', sessionId: 's', requestId: 'r' };
  await assert.rejects(() => store.listHandoffs(actor), (error) => error?.status === 403);
  await assert.rejects(() => store.listCheckpoints(actor), (error) => error?.status === 403);
  await assert.rejects(() => store.listRunLedger(actor), (error) => error?.status === 403);
  await assert.rejects(() => store.listLeasePosture(actor), (error) => error?.status === 403);
});

test('run ledger unions the three run tables and normalizes rows', async () => {
  const store = createEvidenceStore(storePool({
    tables: {
      console_command_runs: [{ id: 1, receipt_id: 'cc-1', outcome: 'completed', result: { activeProjects: 2 }, created_at: new Date('2026-10-16T10:00:00Z') }],
      cora_agent_task_runs: [{ id: 2, task_receipt_id: 'at-1', outcome: 'needs_desktop', result: { reason: 'Waiting for desktop runner' }, created_at: new Date('2026-10-16T12:00:00Z') }],
      cora_artifact_execution_runs: '42P01',
    },
  }));
  const actor = { tenantId: 'customer-a', subject: 'owner-1', role: 'owner', sessionId: 's', requestId: 'r' };
  const result = await store.listRunLedger(actor);
  assert.equal(result.runs.length, 2);
  assert.equal(result.runs[0].kind, 'agent_task');
  assert.equal(result.runs[0].receipt, 'at-1');
  assert.equal(result.runs[0].summary, 'Waiting for desktop runner');
  assert.equal(result.runs[1].kind, 'console_command');
  assert.equal(result.migrationPending, true);
});

test('lease posture merges workspace and maestro leases with remaining seconds', async () => {
  const store = createEvidenceStore(storePool({
    tables: {
      workspace_write_leases: [{ scope: 'aimforge', holder: 'worker:console', expires_at: new Date(Date.now() + 45000), seconds_remaining: '45.2' }],
      maestro_leases: [{ scope: 'maestro:aimforge', holder: 'maestro-a', expires_at: new Date(Date.now() - 5000), seconds_remaining: '-5.1' }],
    },
  }));
  const actor = { tenantId: 'customer-a', subject: 'owner-1', role: 'owner', sessionId: 's', requestId: 'r' };
  const result = await store.listLeasePosture(actor);
  assert.equal(result.leases.length, 2);
  assert.equal(result.leases[0].scope, 'aimforge');
  assert.equal(result.leases[0].secondsRemaining, 45);
  assert.equal(result.leases[1].secondsRemaining, -5);
  assert.equal(result.migrationPending, false);
});

// Route tests: injected evidence store, fake pool only serves the actor lookup.
function routePool(role = 'owner') {
  const client = {
    async query(sql) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
      if (q.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ tenant_id: 'customer-a', role }] };
      throw new Error(`unexpected query ${q}`);
    },
    release() {},
  };
  return { connect: async () => client };
}

function identity() { return { getSession: (id) => id === 'active-session' ? { subject: 'user-1' } : null }; }

async function startServer(t, { role = 'owner', evidenceStore } = {}) {
  const admin = await createLiveHelmianCloudAdminHandler({
    env, pool: routePool(role), identity: identity(), page: '<p>test</p>', script: 'void 0;',
    expectedMigrations: [], evidenceStore,
  });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 'test' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  return clm.healthUrl.replace('/healthz', '');
}

test('evidence routes serve handoffs, checkpoints, ledger, and leases to owners', async (t) => {
  const evidenceStore = {
    async listHandoffs() { return { handoffs: [{ id: 1, direction: 'a → b' }], migrationPending: false }; },
    async listCheckpoints() { return { checkpoints: [{ id: 2 }], migrationPending: false }; },
    async listRunLedger() { return { runs: [{ kind: 'console_command', id: 3 }], migrationPending: false }; },
    async listLeasePosture() { return { leases: [{ scope: 'x' }], migrationPending: false }; },
  };
  const base = await startServer(t, { evidenceStore });
  const headers = { cookie: 'helmion_admin_session=active-session' };
  for (const [path, key] of [
    [LIVE_ADMIN_MAESTRO_HANDOFFS_PATH, 'handoffs'],
    [LIVE_ADMIN_MAESTRO_CHECKPOINTS_PATH, 'checkpoints'],
    [LIVE_ADMIN_RUNS_LEDGER_PATH, 'runs'],
    [LIVE_ADMIN_LEASES_POSTURE_PATH, 'leases'],
  ]) {
    const response = await fetch(`${base}${path}`, { headers });
    assert.equal(response.status, 200, path);
    const body = await response.json();
    assert.equal(body.valid, true, path);
    assert.ok(Array.isArray(body[key]), path);
  }
});

test('evidence routes return 403 for members', async (t) => {
  const evidenceStore = {
    async listHandoffs() { throw Object.assign(new Error('Owner or admin membership required'), { status: 403 }); },
    async listCheckpoints() { throw Object.assign(new Error('Owner or admin membership required'), { status: 403 }); },
    async listRunLedger() { throw Object.assign(new Error('Owner or admin membership required'), { status: 403 }); },
    async listLeasePosture() { throw Object.assign(new Error('Owner or admin membership required'), { status: 403 }); },
  };
  const base = await startServer(t, { role: 'member', evidenceStore });
  const headers = { cookie: 'helmion_admin_session=active-session' };
  for (const path of [LIVE_ADMIN_MAESTRO_HANDOFFS_PATH, LIVE_ADMIN_MAESTRO_CHECKPOINTS_PATH, LIVE_ADMIN_RUNS_LEDGER_PATH, LIVE_ADMIN_LEASES_POSTURE_PATH]) {
    const response = await fetch(`${base}${path}`, { headers });
    assert.equal(response.status, 403, path);
    assert.equal((await response.json()).code, 'EVIDENCE_MEMBERSHIP_REQUIRED', path);
  }
});

test('evidence routes degrade gracefully when tables are missing', async (t) => {
  const empty = { migrationPending: true };
  const evidenceStore = {
    async listHandoffs() { return { ...empty, handoffs: [] }; },
    async listCheckpoints() { return { ...empty, checkpoints: [] }; },
    async listRunLedger() { return { ...empty, runs: [] }; },
    async listLeasePosture() { return { ...empty, leases: [] }; },
  };
  const base = await startServer(t, { evidenceStore });
  const headers = { cookie: 'helmion_admin_session=active-session' };
  const response = await fetch(`${base}${LIVE_ADMIN_MAESTRO_HANDOFFS_PATH}`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.handoffs, []);
  assert.equal(body.migrationPending, true);
});
