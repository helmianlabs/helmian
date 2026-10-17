import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireWorkspaceLease, releaseWorkspaceLease } from '../src/cora/workspace-lease.mjs';

function fakePool({ leases = [], missingTable = false } = {}) {
  const rows = leases.map((l, i) => ({ id: i + 1, ...l }));
  const client = {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q)) return { rows: [], rowCount: 0 };
      if (missingTable) { const error = new Error('relation "helmion.workspace_write_leases" does not exist'); error.code = '42P01'; throw error; }
      if (q.includes('from helmion.workspace_write_leases') && q.includes('for update')) {
        if (q.includes('lease_token=$2')) {
          const found = rows.find((l) => l.lease_token === params[1]);
          return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
        }
        const active = rows.find((l) => l.status === 'ACTIVE');
        return { rows: active ? [active] : [], rowCount: active ? 1 : 0 };
      }
      if (q.startsWith('insert into helmion.workspace_write_leases')) {
        if (rows.some((l) => l.status === 'ACTIVE')) { const error = new Error('duplicate'); error.code = '23505'; throw error; }
        rows.push({ id: rows.length + 1, tenant_id: params[0], project_key: params[1], holder: params[2], lease_token: params[3], status: 'ACTIVE', expires_at: params[4] });
        return { rowCount: 1, rows: [] };
      }
      if (q.startsWith('update helmion.workspace_write_leases')) {
        const target = rows.find((l) => l.id === params[params.length - 1]);
        if (target) { target.status = q.includes("'expired'") ? 'EXPIRED' : 'RELEASED'; target.closed_at = new Date().toISOString(); }
        return { rowCount: 1, rows: [] };
      }
      if (q.startsWith('insert into helmion.audit_events')) return { rowCount: 1, rows: [{ id: '9' }] };
      throw new Error(`unexpected ${q}`);
    },
    release() {},
  };
  return { pool: { connect: async () => client }, rows };
}

const base = { tenantId: 't-a', holder: 'worker:test' };

test('acquire grants the lease when free and blocks a second holder', async () => {
  const { pool, rows } = fakePool();
  const first = await acquireWorkspaceLease({ pool, ...base });
  assert.equal(first.acquired, true);
  assert.match(first.leaseToken, /^[0-9a-f-]{36}$/);
  const second = await acquireWorkspaceLease({ pool, ...base, holder: 'worker:other' });
  assert.equal(second.acquired, false);
  assert.equal(second.reason, 'held');
  assert.equal(second.holder, 'worker:test');
  assert.equal(rows.filter((l) => l.status === 'ACTIVE').length, 1);
});

test('a stale lease can be taken over', async () => {
  const { pool, rows } = fakePool({
    leases: [{ tenant_id: 't-a', project_key: null, holder: 'worker:old', lease_token: '22222222-2222-4222-8222-222222222222', status: 'ACTIVE', expires_at: new Date(Date.now() - 1000).toISOString() }],
  });
  const result = await acquireWorkspaceLease({ pool, ...base });
  assert.equal(result.acquired, true);
  assert.equal(rows.find((l) => l.holder === 'worker:old').status, 'EXPIRED', 'stale lease kept as history');
});

test('release only works with the token', async () => {
  const { pool } = fakePool();
  const { leaseToken } = await acquireWorkspaceLease({ pool, ...base });
  const wrong = await releaseWorkspaceLease({ pool, tenantId: 't-a', leaseToken: '33333333-3333-4333-8333-333333333333' });
  assert.equal(wrong.released, false);
  const right = await releaseWorkspaceLease({ pool, tenantId: 't-a', leaseToken });
  assert.equal(right.released, true);
  const again = await releaseWorkspaceLease({ pool, tenantId: 't-a', leaseToken });
  assert.equal(again.released, false, 'double release is a no-op');
});

test('missing table fails closed, never free', async () => {
  const { pool } = fakePool({ missingTable: true });
  const acquired = await acquireWorkspaceLease({ pool, ...base });
  assert.equal(acquired.acquired, false);
  assert.equal(acquired.reason, 'unavailable');
});

test('path-shaped project keys are rejected', async () => {
  const { pool } = fakePool();
  for (const bad of ['../etc', 'C:\\win', 'a/b', 'c:foo']) {
    await assert.rejects(() => acquireWorkspaceLease({ pool, ...base, projectKey: bad }), /invalid/);
  }
  const ok = await acquireWorkspaceLease({ pool, ...base, projectKey: 'helmian-cloud' });
  assert.equal(ok.acquired, true);
  assert.equal(ok.projectKey, 'helmian-cloud');
});

test('invalid inputs are rejected', async () => {
  const { pool } = fakePool();
  await assert.rejects(() => acquireWorkspaceLease({ pool }));
  await assert.rejects(() => acquireWorkspaceLease({ pool, tenantId: 't-a' }));
  await assert.rejects(() => releaseWorkspaceLease({ pool, tenantId: 't-a', leaseToken: 'nope' }));
});
