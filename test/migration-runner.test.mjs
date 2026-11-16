import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeMigrationSql, createNeonStore } from '../src/adapters/neon.mjs';

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The fake pool recognises a migration body by its exact canonical
// content, derived from the sql/ directory with the same selection and
// ordering rule the runner itself uses (src/adapters/neon.mjs
// loadMigrations). The hand-kept snippet list this replaces stopped at
// migration 044 while sql/ grew past it, which is why this suite broke
// silently once it was wired into the gate: a new migration file must
// be recognised here without anyone editing the test.
const migrationsDir = fileURLToPath(new URL('../sql', import.meta.url));
const migrationNames = (await readdir(migrationsDir))
  .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
  .sort((a, b) => a.localeCompare(b));
const migrationBodies = new Map();
for (const name of migrationNames) {
  migrationBodies.set(canonicalizeMigrationSql(await readFile(join(migrationsDir, name), 'utf8')), name);
}

test('migration SQL has one cross-platform checksum representation', () => {
  const linux = 'create table helmion.example (id integer);\n';
  const windows = 'create table helmion.example (id integer);\r\n';
  const legacyMac = 'create table helmion.example (id integer);\r';
  assert.equal(canonicalizeMigrationSql(windows), linux);
  assert.equal(canonicalizeMigrationSql(legacyMac), linux);
  assert.equal(canonicalizeMigrationSql(linux), linux);
});

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
        const bodyName = migrationBodies.get(canonicalizeMigrationSql(String(sql)));
        if (bodyName) {
          pool.executedSql.push(bodyName);
          return { rowCount: 0, rows: [] };
        }
        if (normalized.includes('create schema if not exists helmion')) {
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
    migrationNames.map((name) => [name, true, 'committed']),
  );
  assert.deepEqual(pool.executedSql, migrationNames);
  const second = await store.migrate();
  assert.deepEqual(
    second.map((result) => result.applied),
    Array(migrationNames.length).fill(false),
  );
  assert.deepEqual(pool.executedSql, migrationNames);
  assert.equal(pool.transactions.filter((entry) => entry === 'commit').length, 2 * migrationNames.length);
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
