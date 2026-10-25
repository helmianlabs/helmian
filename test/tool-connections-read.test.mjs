// Bite 1b read-path: GET /api/admin/tool-connections serves the tenant's
// tool_connections rows to the app surfaces. The delegate is exercised
// with a fake store + fake actor — no database, no HTTP server.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleToolConnectionsRoute, TOOL_CONNECTIONS_PATH } from '../src/cloud/tool-connections-read.mjs';

const ROW = {
  id: 7, tenantId: 'tenant-1', scopeKind: 'workspace', scopeId: 'workspace', serviceId: 'github',
  kind: 'mcp-http', serverRef: 'github', credentialReference: null, accountLabel: null,
  grantedScopes: [], state: 'verified', lastVerifiedAt: '2026-10-25T17:00:00.000Z',
  probeMethod: 'tools/list', lastToolsCount: 12, lastError: null,
  updatedBySubject: 'probe', createdAt: '2026-10-25T16:00:00.000Z', updatedAt: '2026-10-25T17:00:00.000Z',
};

function harness({ actor = { tenantId: 'tenant-1', subject: 'user-1' }, actorError = null, rows = [ROW] } = {}) {
  const calls = [];
  const sent = [];
  const store = { async list(tenantId, filter) { calls.push([tenantId, filter]); return rows; } };
  const deps = {
    activeTenantActor: async () => { if (actorError) throw actorError; return actor; },
    send: (response, status, body) => { sent.push({ status, body: JSON.parse(body) }); },
    TenantAuthorizationError: class TenantAuthorizationError extends Error {},
    store,
  };
  return { calls, sent, deps };
}
const req = (method, url) => ({ method, url });
const url = (u) => new URL(u, 'http://local');

test('read route: returns the tenant rows in the store shape', async () => {
  const { calls, sent, deps } = harness();
  const handled = await handleToolConnectionsRoute({ request: req('GET', TOOL_CONNECTIONS_PATH), response: {}, requestUrl: url(TOOL_CONNECTIONS_PATH), ...deps });
  assert.equal(handled, true);
  assert.deepEqual(calls, [['tenant-1', {}]], 'the read is scoped to the actor tenant, all scopes');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].status, 200);
  assert.equal(sent[0].body.valid, true);
  assert.deepEqual(sent[0].body.connections, [ROW]);
});

test('read route: not our path → false, nothing sent', async () => {
  const { sent, deps } = harness();
  const handled = await handleToolConnectionsRoute({ request: req('GET', '/api/admin/overview'), response: {}, requestUrl: url('/api/admin/overview'), ...deps });
  assert.equal(handled, false);
  assert.equal(sent.length, 0);
});

test('read route: authority selectors are refused, never honoured', async () => {
  const { calls, sent, deps } = harness();
  const handled = await handleToolConnectionsRoute({ request: req('GET', `${TOOL_CONNECTIONS_PATH}?tenant_id=other`), response: {}, requestUrl: url(`${TOOL_CONNECTIONS_PATH}?tenant_id=other`), ...deps });
  assert.equal(handled, true);
  assert.equal(sent[0].status, 400);
  assert.equal(sent[0].body.code, 'TOOL_CONNECTIONS_SELECTOR_INVALID');
  assert.equal(calls.length, 0, 'the store is never reached');
});

test('read route: writes do not exist on the read path', async () => {
  const { calls, sent, deps } = harness();
  await handleToolConnectionsRoute({ request: req('PUT', TOOL_CONNECTIONS_PATH), response: {}, requestUrl: url(TOOL_CONNECTIONS_PATH), ...deps });
  assert.equal(sent[0].status, 405);
  assert.equal(calls.length, 0);
});

test('read route: a membership failure is a 403, not data', async () => {
  const { sent, deps } = harness({ actorError: Object.assign(new Error('not a member'), { status: 403 }) });
  await handleToolConnectionsRoute({ request: req('GET', TOOL_CONNECTIONS_PATH), response: {}, requestUrl: url(TOOL_CONNECTIONS_PATH), ...deps });
  assert.equal(sent[0].status, 403);
  assert.equal(sent[0].body.valid, false);
});
