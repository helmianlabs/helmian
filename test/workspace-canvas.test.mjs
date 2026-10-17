import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvasStore, handleCanvasRoute, CANVAS_PATH } from '../src/cloud/workspace-canvas.mjs';
import { TenantAuthorizationError } from '../src/core/tenant-context.mjs';

const ACTOR = { tenantId: 'tenant-a', subject: 'user-1', role: 'member', sessionId: 's', requestId: 'r' };

function missingTable() {
  const error = new Error('relation "helmion.workspace_project_canvases" does not exist');
  error.code = '42P01';
  return error;
}

// Fake pool: handles the tenant-context plumbing (begin/commit/rollback,
// set_config, membership) and answers canvas/project/audit queries from
// canned state. `tables.workspace_project_canvases` may be '42P01' to
// simulate the migration not being applied.
function canvasPool({ role = 'member', canvasRow = null, canvasMissing = false, projectExists = true } = {}) {
  const client = {
    async query(sql, params) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
      if (q.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ role }] };
      if (q.includes('from helmion.workspace_project_canvases')) {
        if (canvasMissing) throw missingTable();
        return canvasRow ? { rowCount: 1, rows: [canvasRow] } : { rowCount: 0, rows: [] };
      }
      if (q.includes('from helmion.workspace_projects')) return projectExists ? { rowCount: 1, rows: [{}] } : { rowCount: 0, rows: [] };
      if (q.includes('insert into helmion.workspace_project_canvases')) {
        if (canvasMissing) throw missingTable();
        assert.equal(params[0], ACTOR.tenantId);
        assert.equal(params[1], 'demo');
        return { rowCount: 1, rows: [] };
      }
      if (q.includes('insert into helmion.audit_events')) {
        assert.equal(params[5], 'workspace.canvas.saved');
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
  assert.equal(result.decisionText, '');
  assert.equal(result.updatedAt, null);
  assert.equal(result.canvasUnavailable, false);
});

test('canvas store loads saved note and decision text', async () => {
  const store = createCanvasStore(canvasPool({
    canvasRow: { note_text: 'Remember the lease', decision_text: 'Ship it', updated_at: new Date('2026-10-16T20:00:00Z') },
  }));
  const result = await store.load(ACTOR, 'demo');
  assert.equal(result.noteText, 'Remember the lease');
  assert.equal(result.decisionText, 'Ship it');
  assert.equal(result.updatedAt, '2026-10-16T20:00:00.000Z');
});

test('canvas store degrades gracefully when migration 053 is not applied', async () => {
  const store = createCanvasStore(canvasPool({ canvasMissing: true }));
  const result = await store.load(ACTOR, 'demo');
  assert.equal(result.canvasUnavailable, true);
  assert.equal(result.noteText, '');
});

test('canvas store saves and returns an audit receipt', async () => {
  const store = createCanvasStore(canvasPool());
  const result = await store.save(ACTOR, { projectKey: 'demo', noteText: 'n', decisionText: 'd' });
  assert.equal(result.durable, true);
  assert.equal(result.receiptId, '42');
  assert.equal(result.projectKey, 'demo');
});

test('canvas store rejects a save for an unknown project', async () => {
  const store = createCanvasStore(canvasPool({ projectExists: false }));
  await assert.rejects(store.save(ACTOR, { projectKey: 'demo', noteText: '', decisionText: '' }), (error) => {
    assert.equal(error.status, 404);
    return true;
  });
});

test('canvas store reports 503 when the table is missing on save', async () => {
  const store = createCanvasStore(canvasPool({ canvasMissing: true }));
  await assert.rejects(store.save(ACTOR, { projectKey: 'demo', noteText: '', decisionText: '' }), (error) => {
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
  await assert.rejects(store.save(ACTOR, { projectKey: 'demo', noteText: 'x'.repeat(32769), decisionText: '' }), (error) => {
    assert.equal(error.status, 400);
    return true;
  });
});

test('canvas store requires active tenant membership', async () => {
  const store = createCanvasStore(canvasPool({ role: 'owner' }));
  await assert.rejects(store.load(ACTOR, 'demo'), (error) => error instanceof TenantAuthorizationError);
});

// --- route handling ---

function routeHarness({ store = null, actor = ACTOR, method = 'GET', url = `${CANVAS_PATH}?projectKey=demo`, body = null } = {}) {
  const sent = {};
  let resolveBody = null;
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
});

test('canvas route PUT saves and returns a receipt', async () => {
  const { args, sent } = routeHarness({
    store: createCanvasStore(canvasPool()),
    method: 'PUT',
    url: CANVAS_PATH,
    body: { projectKey: 'demo', noteText: 'n', decisionText: 'd' },
  });
  assert.equal(await handleCanvasRoute(args), true);
  assert.equal(sent.status, 200);
  assert.equal(sent.payload.receiptId, '42');
});

test('canvas route PUT rejects unknown body fields', async () => {
  const { args, sent } = routeHarness({
    store: createCanvasStore(canvasPool()),
    method: 'PUT',
    url: CANVAS_PATH,
    body: { projectKey: 'demo', noteText: '', decisionText: '', tenantId: 'evil' },
  });
  assert.equal(await handleCanvasRoute(args), true);
  assert.equal(sent.status, 400);
  assert.equal(sent.payload.code, 'CANVAS_SAVE_INVALID');
});

test('canvas route ignores non-canvas paths', async () => {
  const { args } = routeHarness({ url: '/api/admin/other' });
  assert.equal(await handleCanvasRoute(args), false);
});
