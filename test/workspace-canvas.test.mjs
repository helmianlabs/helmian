import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvasStore, handleCanvasRoute, CANVAS_PATH, DECISIONS_PATH } from '../src/cloud/workspace-canvas.mjs';
import { TenantAuthorizationError } from '../src/core/tenant-context.mjs';

const ACTOR = { tenantId: 'tenant-a', subject: 'user-1', role: 'member', sessionId: 's', requestId: 'r' };

function missingTable(name) {
  const error = new Error(`relation "helmion.${name}" does not exist`);
  error.code = '42P01';
  return error;
}

// Fake pool: handles the tenant-context plumbing (begin/commit/rollback,
// set_config, membership) and answers canvas/project/decision/audit queries
// from canned state. `canvasMissing` simulates migration 053 not applied;
// `decisionsMissing` simulates migration 056 not applied (notes still work).
function canvasPool({ role = 'member', canvasRow = null, canvasMissing = false, decisionRows = [], decisionsMissing = false, projectExists = true } = {}) {
  const seen = [];
  const client = {
    seen,
    async query(sql, params) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      seen.push(q);
      if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
      if (q.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ role }] };
      if (q.includes('from helmion.workspace_project_canvases')) {
        if (canvasMissing) throw missingTable('workspace_project_canvases');
        return canvasRow ? { rowCount: 1, rows: [canvasRow] } : { rowCount: 0, rows: [] };
      }
      if (q.includes('from helmion.workspace_project_decisions')) {
        if (decisionsMissing) throw missingTable('workspace_project_decisions');
        return { rowCount: decisionRows.length, rows: decisionRows };
      }
      if (q.includes('from helmion.workspace_projects')) return projectExists ? { rowCount: 1, rows: [{}] } : { rowCount: 0, rows: [] };
      if (q.includes('insert into helmion.workspace_project_canvases')) {
        if (canvasMissing) throw missingTable('workspace_project_canvases');
        assert.equal(params[0], ACTOR.tenantId);
        assert.equal(params[1], 'demo');
        assert.equal(params.length, 3);
        return { rowCount: 1, rows: [] };
      }
      if (q.includes('insert into helmion.workspace_project_decisions')) {
        if (decisionsMissing) throw missingTable('workspace_project_decisions');
        assert.equal(params[0], ACTOR.tenantId);
        assert.equal(params[1], 'demo');
        return { rowCount: 1, rows: [{ id: 7, decision_text: params[2], recorded_by_subject: params[3], recorded_at: new Date('2026-10-17T00:30:00Z') }] };
      }
      if (q.includes('insert into helmion.audit_events')) {
        assert.ok(['workspace.canvas.saved', 'workspace.canvas.decision.recorded'].includes(params[5]));
        return { rowCount: 1, rows: [{ id: 42 }] };
      }
      throw new Error(`unexpected query ${q}`);
    },
    release() {},
  };
  return { connect: async () => client };
}

test('canvas store loads an empty canvas when no row exists', async () => {
  const store = createCanvasStore(canvasPool());
  const result = await store.load(ACTOR, 'demo');
  assert.equal(result.projectKey, 'demo');
  assert.equal(result.noteText, '');
  assert.equal(result.updatedAt, null);
  assert.deepEqual(result.decisions, []);
  assert.equal(result.decisionsUnavailable, false);
  assert.equal(result.canvasUnavailable, false);
});

test('canvas store loads saved note plus the decision log oldest-first', async () => {
  const pool = canvasPool({
    canvasRow: { note_text: 'Remember the lease', updated_at: new Date('2026-10-16T20:00:00Z') },
    decisionRows: [
      { id: 2, decision_text: 'Second', recorded_by_subject: 'user-1', recorded_at: new Date('2026-10-16T21:00:00Z') },
      { id: 1, decision_text: 'First', recorded_by_subject: 'user-1', recorded_at: new Date('2026-10-16T20:30:00Z') },
    ],
  });
  const store = createCanvasStore(pool);
  const result = await store.load(ACTOR, 'demo');
  assert.equal(result.noteText, 'Remember the lease');
  assert.equal(result.updatedAt, '2026-10-16T20:00:00.000Z');
  assert.equal(result.decisions.length, 2);
  assert.equal(result.decisions[0].id, '2');
  assert.equal(result.decisions[0].decisionText, 'Second');
  assert.equal(result.decisions[0].recordedBy, 'user-1');
  assert.equal(result.decisions[0].recordedAt, '2026-10-16T21:00:00.000Z');
  assert.equal(result.decisions[1].decisionText, 'First');
});

test('canvas store asks the database for decisions in recorded order', async () => {
  const client = { seen: [] };
  const pool = canvasPool();
  const raw = await pool.connect();
  client.seen = raw.seen;
  const store = createCanvasStore({ connect: async () => raw });
  await store.load(ACTOR, 'demo');
  const decisionsQuery = client.seen.find((q) => q.includes('from helmion.workspace_project_decisions'));
  assert.ok(decisionsQuery.includes('order by recorded_at asc, id asc'));
  assert.ok(decisionsQuery.includes('limit 200'));
});

test('canvas store keeps notes working when migration 056 is not applied', async () => {
  const store = createCanvasStore(canvasPool({
    canvasRow: { note_text: 'notes survive', updated_at: new Date('2026-10-16T20:00:00Z') },
    decisionsMissing: true,
  }));
  const result = await store.load(ACTOR, 'demo');
  assert.equal(result.noteText, 'notes survive');
  assert.equal(result.decisionsUnavailable, true);
  assert.deepEqual(result.decisions, []);
});

test('canvas store degrades gracefully when migration 053 is not applied', async () => {
  const store = createCanvasStore(canvasPool({ canvasMissing: true }));
  const result = await store.load(ACTOR, 'demo');
  assert.equal(result.canvasUnavailable, true);
  assert.equal(result.noteText, '');
});

test('canvas store saves notes and returns an audit receipt', async () => {
  const store = createCanvasStore(canvasPool());
  const result = await store.save(ACTOR, { projectKey: 'demo', noteText: 'n' });
  assert.equal(result.durable, true);
  assert.equal(result.receiptId, '42');
  assert.equal(result.projectKey, 'demo');
});

test('canvas store rejects a save for an unknown project', async () => {
  const store = createCanvasStore(canvasPool({ projectExists: false }));
  await assert.rejects(store.save(ACTOR, { projectKey: 'demo', noteText: '' }), (error) => {
    assert.equal(error.status, 404);
    return true;
  });
});

test('canvas store reports 503 when the table is missing on save', async () => {
  const store = createCanvasStore(canvasPool({ canvasMissing: true }));
  await assert.rejects(store.save(ACTOR, { projectKey: 'demo', noteText: '' }), (error) => {
    assert.equal(error.status, 503);
    return true;
  });
});

test('canvas store rejects invalid project keys and overlong text', async () => {
  const store = createCanvasStore(canvasPool());
  await assert.rejects(store.load(ACTOR, '../escape'), (error) => {
    assert.equal(error.status, 400);
    return true;
  });
  await assert.rejects(store.save(ACTOR, { projectKey: 'demo', noteText: 'x'.repeat(32769) }), (error) => {
    assert.equal(error.status, 400);
    return true;
  });
});

test('canvas store requires active tenant membership', async () => {
  const store = createCanvasStore(canvasPool({ role: 'owner' }));
  await assert.rejects(store.load(ACTOR, 'demo'), (error) => error instanceof TenantAuthorizationError);
});

// --- decision log ---

test('canvas store records a decision and returns an audit receipt', async () => {
  const store = createCanvasStore(canvasPool());
  const result = await store.recordDecision(ACTOR, { projectKey: 'demo', decisionText: 'Ship it' });
  assert.equal(result.durable, true);
  assert.equal(result.receiptId, '42');
  assert.equal(result.decision.id, '7');
  assert.equal(result.decision.decisionText, 'Ship it');
  assert.equal(result.decision.recordedBy, 'user-1');
  assert.equal(result.decision.recordedAt, '2026-10-17T00:30:00.000Z');
});

test('canvas store rejects empty or overlong decision text', async () => {
  const store = createCanvasStore(canvasPool());
  await assert.rejects(store.recordDecision(ACTOR, { projectKey: 'demo', decisionText: '   ' }), (error) => {
    assert.equal(error.status, 400);
    return true;
  });
  await assert.rejects(store.recordDecision(ACTOR, { projectKey: 'demo', decisionText: 'x'.repeat(32769) }), (error) => {
    assert.equal(error.status, 400);
    return true;
  });
});

test('canvas store rejects a decision for an unknown project', async () => {
  const store = createCanvasStore(canvasPool({ projectExists: false }));
  await assert.rejects(store.recordDecision(ACTOR, { projectKey: 'demo', decisionText: 'x' }), (error) => {
    assert.equal(error.status, 404);
    return true;
  });
});

test('canvas store reports 503 when the decision table is missing', async () => {
  const store = createCanvasStore(canvasPool({ decisionsMissing: true }));
  await assert.rejects(store.recordDecision(ACTOR, { projectKey: 'demo', decisionText: 'x' }), (error) => {
    assert.equal(error.status, 503);
    return true;
  });
});

// --- route handling ---

function routeHarness({ store = null, actor = ACTOR, method = 'GET', url = `${CANVAS_PATH}?projectKey=demo`, body = null } = {}) {
  const sent = {};
  const request = {
    method,
    headers: {},
    [Symbol.asyncIterator]() {
      let done = false;
      return {
        next: async () => {
          if (done) return { done: true };
          done = true;
          return { done: false, value: Buffer.from(JSON.stringify(body ?? {})) };
        },
      };
    },
  };
  return {
    sent,
    args: {
      request,
      response: {},
      requestUrl: new URL(url, 'http://local'),
      pool: canvasPool(),
      canvas: store,
      activeTenantActor: async () => actor,
      send: (res, status, payload) => { sent.status = status; sent.payload = JSON.parse(payload); },
      readJsonObject: async () => body ?? {},
      exactKeys: (value, keys) => {
        for (const k of Object.keys(value)) if (!keys.includes(k)) throw new Error('unexpected field');
      },
      TenantAuthorizationError,
    },
  };
}

test('canvas route GET loads the canvas', async () => {
  const { args, sent } = routeHarness({ store: createCanvasStore(canvasPool()) });
  assert.equal(await handleCanvasRoute(args), true);
  assert.equal(sent.status, 200);
  assert.equal(sent.payload.valid, true);
  assert.equal(sent.payload.projectKey, 'demo');
  assert.deepEqual(sent.payload.decisions, []);
});

test('canvas route PUT saves and returns a receipt', async () => {
  const { args, sent } = routeHarness({
    store: createCanvasStore(canvasPool()),
    method: 'PUT',
    url: CANVAS_PATH,
    body: { projectKey: 'demo', noteText: 'n' },
  });
  assert.equal(await handleCanvasRoute(args), true);
  assert.equal(sent.status, 200);
  assert.equal(sent.payload.receiptId, '42');
});

test('canvas route PUT rejects decisionText in the body', async () => {
  const { args, sent } = routeHarness({
    store: createCanvasStore(canvasPool()),
    method: 'PUT',
    url: CANVAS_PATH,
    body: { projectKey: 'demo', noteText: 'n', decisionText: 'stale' },
  });
  assert.equal(await handleCanvasRoute(args), true);
  assert.equal(sent.status, 400);
  assert.equal(sent.payload.code, 'CANVAS_SAVE_INVALID');
});

test('canvas route PUT rejects unknown body fields', async () => {
  const { args, sent } = routeHarness({
    store: createCanvasStore(canvasPool()),
    method: 'PUT',
    url: CANVAS_PATH,
    body: { projectKey: 'demo', noteText: '', tenantId: 'evil' },
  });
  assert.equal(await handleCanvasRoute(args), true);
  assert.equal(sent.status, 400);
  assert.equal(sent.payload.code, 'CANVAS_SAVE_INVALID');
});

test('canvas route POST records a decision', async () => {
  const { args, sent } = routeHarness({
    store: createCanvasStore(canvasPool()),
    method: 'POST',
    url: DECISIONS_PATH,
    body: { projectKey: 'demo', decisionText: 'Ship it' },
  });
  assert.equal(await handleCanvasRoute(args), true);
  assert.equal(sent.status, 200);
  assert.equal(sent.payload.valid, true);
  assert.equal(sent.payload.decision.decisionText, 'Ship it');
  assert.equal(sent.payload.receiptId, '42');
});

test('canvas route POST rejects a decision for an unknown project', async () => {
  const { args, sent } = routeHarness({
    store: createCanvasStore(canvasPool({ projectExists: false })),
    method: 'POST',
    url: DECISIONS_PATH,
    body: { projectKey: 'demo', decisionText: 'x' },
  });
  assert.equal(await handleCanvasRoute(args), true);
  assert.equal(sent.status, 404);
  assert.equal(sent.payload.code, 'CANVAS_PROJECT_NOT_FOUND');
});

test('canvas route POST reports 503 when migration 056 is pending', async () => {
  const { args, sent } = routeHarness({
    store: createCanvasStore(canvasPool({ decisionsMissing: true })),
    method: 'POST',
    url: DECISIONS_PATH,
    body: { projectKey: 'demo', decisionText: 'x' },
  });
  assert.equal(await handleCanvasRoute(args), true);
  assert.equal(sent.status, 503);
  assert.equal(sent.payload.code, 'CANVAS_MIGRATION_PENDING');
});

test('canvas route has no PUT or DELETE on the decisions path', async () => {
  for (const method of ['PUT', 'DELETE']) {
    const { args } = routeHarness({ method, url: DECISIONS_PATH, body: { projectKey: 'demo', decisionText: 'x' } });
    assert.equal(await handleCanvasRoute(args), false, `expected false for ${method} ${DECISIONS_PATH}`);
  }
});

test('canvas route ignores non-canvas paths', async () => {
  const { args } = routeHarness({ url: '/api/admin/other' });
  assert.equal(await handleCanvasRoute(args), false);
});
