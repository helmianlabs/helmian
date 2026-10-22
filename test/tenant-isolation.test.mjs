// Production connects as a role that is not subject to row-level security, so
// every tenant-scoped query must filter by tenant explicitly. These fakes behave
// like a database with RLS bypassed: a query without a tenant filter sees every
// tenant's rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvoyStore } from '../src/cloud/envoy-chat.mjs';
import { createSessionsStore } from '../src/cloud/agent-sessions.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function rlsBypassedPool(tables) {
  let tenantSetting = null;
  return {
    async connect() {
      return {
        async query(text, vals = []) {
          const sql = String(text).replace(/\s+/g, ' ').trim();
          if (/^(begin|commit|rollback)/i.test(sql)) return { rows: [], rowCount: 0 };
          if (sql.includes("set_config('helmion.tenant_id'")) { tenantSetting = vals[0]; return { rows: [], rowCount: 0 }; }
          if (sql.includes('from helmion.tenant_memberships')) return { rows: [{ role: 'owner' }], rowCount: 1 };
          const table = Object.keys(tables).find((name) => sql.includes(`helmion.${name}`));
          if (!table) throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
          let rows = tables[table];
          if (/where tenant_id ?= ?\$1/.test(sql)) rows = rows.filter((r) => r.tenant_id === vals[0]);
          else if (sql.includes("tenant_id = current_setting('helmion.tenant_id', true)")) rows = rows.filter((r) => r.tenant_id === tenantSetting);
          if (/^delete/i.test(sql)) { const hit = rows.filter((r) => r.id === vals[0]); return { rows: [], rowCount: hit.length }; }
          if (/^update/i.test(sql)) { const hit = rows.filter((r) => r.id === vals[vals.length - 1]); return { rows: hit, rowCount: hit.length }; }
          return { rows, rowCount: rows.length };
        },
        release() {},
      };
    },
  };
}

const actor = (tenantId) => ({ tenantId, subject: `user_${tenantId.slice(0, 4)}`, role: 'owner', sessionId: 's', requestId: 'r' });

test('Envoy listChannels returns only the caller tenant channels', async () => {
  const pool = rlsBypassedPool({ envoy_channels: [
    { tenant_id: A, id: 'a1', slug: 'team', title: 'Team', kind: 'team', created_by_subject: 'u', created_at: '2026-10-01' },
    { tenant_id: B, id: 'b1', slug: 'envoy', title: 'Envoy', kind: 'team', created_by_subject: 'v', created_at: '2026-10-02' },
  ] });
  const { channels } = await createEnvoyStore(pool).listChannels(actor(A));
  assert.deepEqual(channels.map((c) => c.id), ['a1']);
});

test('agent sessions list/update/close are tenant-scoped', async () => {
  const rows = [
    { tenant_id: A, id: 'sa', name: 'mine', provider: 'claude', routing_tier: 'auto', status: 'idle' },
    { tenant_id: B, id: 'sb', name: 'theirs', provider: 'gemini', routing_tier: 'auto', status: 'idle' },
  ];
  const store = createSessionsStore(rlsBypassedPool({ workspace_agent_sessions: rows }));
  assert.deepEqual((await store.list(A)).map((s) => s.id), ['sa']);
  await assert.rejects(() => store.update(A, 'sb', { status: 'active' }), /session not found/);
  await assert.rejects(() => store.close(A, 'sb'), /session not found/);
  assert.equal((await store.close(A, 'sa')).closed, true);
});
