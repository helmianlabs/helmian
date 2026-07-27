import test from 'node:test';
import assert from 'node:assert/strict';
import { createNeonStore } from '../src/adapters/neon.mjs';

const evidence = {
  outcome: '8/8 resolution tests passed',
  citation: 'src/resolver.mjs:42',
  root_cause: 'The update path treated an already closed blocker as open',
  snippet: 'where id=$1 and status <> RESOLVED',
  lesson: 'A resolution must update exactly one open blocker',
};

function resolutionPool(updateResult) {
  const events = [];
  return {
    events,
    async connect() {
      return {
        async query(sql) {
          const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
          events.push(normalized.split(' ')[0]);
          if (normalized === 'begin' || normalized === 'commit' || normalized === 'rollback') {
            return { rowCount: 0, rows: [] };
          }
          if (normalized.startsWith('update helmion.blockers')) return updateResult;
          throw new Error(`Unexpected query: ${normalized}`);
        },
        release() {},
      };
    },
  };
}

test('a successful blocker resolution returns a durable commit confirmation', async () => {
  const pool = resolutionPool({
    rowCount: 1,
    rows: [{ id: 7, status: 'RESOLVED' }],
  });
  const store = await createNeonStore(null, { pool });
  const result = await store.resolveBlocker(7, evidence);
  assert.equal(result.durability, 'committed');
  assert.equal(result.data.status, 'RESOLVED');
  assert.equal(pool.events.at(-1), 'commit');
});

test('duplicate or missing blocker resolution rejects and rolls back', async () => {
  const pool = resolutionPool({ rowCount: 0, rows: [] });
  const store = await createNeonStore(null, { pool });
  await assert.rejects(store.resolveBlocker(7, evidence), /was not found/);
  assert.equal(pool.events.at(-1), 'rollback');
});
