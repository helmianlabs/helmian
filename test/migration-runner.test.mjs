import test from 'node:test';
import assert from 'node:assert/strict';
import { createNeonStore } from '../src/adapters/neon.mjs';

class MigrationPool {
  constructor(seed = []) {
    this.migrations = new Map(seed.map((row) => [row.version, row]));
    this.executedSql = [];
    this.transactions = [];
  }

  async connect() {
    const pool = this;
    return {
      async query(sql, parameters = []) {
        const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
        if (normalized === 'begin' || normalized === 'commit' || normalized === 'rollback') {
          pool.transactions.push(normalized);
          return { rowCount: 0, rows: [] };
        }
        if (normalized.startsWith('select pg_advisory_xact_lock')) {
          return { rowCount: 1, rows: [{}] };
        }
        if (normalized.startsWith('create schema if not exists helmion')) {
          if (String(sql).includes('helmion.projects')) pool.executedSql.push('001_helmion.sql');
          return { rowCount: 0, rows: [] };
        }
        if (normalized.startsWith('create table if not exists helmion.schema_migrations')) {
          return { rowCount: 0, rows: [] };
        }
        if (normalized.startsWith('select name, checksum from helmion.schema_migrations')) {
          const existing = pool.migrations.get(parameters[0]);
          return existing
            ? { rowCount: 1, rows: [existing] }
            : { rowCount: 0, rows: [] };
        }
        if (normalized.startsWith('insert into helmion.schema_migrations')) {
          pool.migrations.set(parameters[0], {
            version: parameters[0],
            name: parameters[1],
            checksum: parameters[2],
          });
          return { rowCount: 1, rows: [] };
        }
        if (String(sql).includes('helmion.human_identity_keys')) {
          pool.executedSql.push('003_human_confirmations.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('helmion.maestro_operations')) {
          pool.executedSql.push('002_maestro_phase_one.sql');
          return { rowCount: 0, rows: [] };
        }
        throw new Error(`Unexpected migration query: ${normalized.slice(0, 100)}`);
      },
      release() {},
    };
  }
}

test('migration runner applies ordered migrations once and confirms durable commits', async () => {
  const pool = new MigrationPool();
  const store = await createNeonStore(null, { pool });
  const first = await store.migrate();
  assert.deepEqual(
    first.map((result) => [result.migration, result.applied, result.durability]),
    [
      ['001_helmion.sql', true, 'committed'],
      ['002_maestro_phase_one.sql', true, 'committed'],
      ['003_human_confirmations.sql', true, 'committed'],
    ],
  );
  assert.deepEqual(
    pool.executedSql,
    ['001_helmion.sql', '002_maestro_phase_one.sql', '003_human_confirmations.sql'],
  );

  const second = await store.migrate();
  assert.deepEqual(second.map((result) => result.applied), [false, false, false]);
  assert.deepEqual(
    pool.executedSql,
    ['001_helmion.sql', '002_maestro_phase_one.sql', '003_human_confirmations.sql'],
  );
  assert.equal(pool.transactions.filter((entry) => entry === 'commit').length, 6);
  assert.equal(pool.transactions.includes('rollback'), false);
});

test('migration runner rejects a checksum mismatch and rolls back', async () => {
  const pool = new MigrationPool([{
    version: '001',
    name: '001_helmion.sql',
    checksum: 'stale-checksum',
  }]);
  const store = await createNeonStore(null, { pool });
  await assert.rejects(store.migrate(), /does not match/);
  assert.equal(pool.transactions.at(-1), 'rollback');
  assert.equal(pool.executedSql.length, 0);
});
