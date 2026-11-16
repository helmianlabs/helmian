import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createNeonStore } from '../src/adapters/neon.mjs';

// The expected pending set is derived from the sql/ directory with the
// same selection and ordering rule the runner uses (loadMigrations in
// src/adapters/neon.mjs). The hand-kept list this replaces stopped at
// migration 056 while sql/ grew past it, so the preflight's full
// enumeration read as a failure once the suite was wired into the gate.
const migrationNames = readdirSync(fileURLToPath(new URL('../sql', import.meta.url)))
  .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
  .sort((a, b) => a.localeCompare(b));

class PreflightPool {
  constructor() {
    this.projects = new Map();
    this.transactions = [];
  }

  async query(sql) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.startsWith('select current_database()')) {
      return {
        rowCount: 1,
        rows: [{
          database_name: 'neondb',
          role_name: 'neondb_owner',
          server_version: '17.5',
        }],
      };
    }
    if (normalized.startsWith("select to_regnamespace('helmion')")) {
      return { rowCount: 1, rows: [{ schema_exists: false }] };
    }
    if (normalized.startsWith('select c.relname as object_name')) {
      return { rowCount: 0, rows: [] };
    }
    throw new Error(`Unexpected pool query: ${normalized}`);
  }

  async connect() {
    const pool = this;
    return {
      async query(sql, parameters = []) {
        const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
        if (['begin', 'commit', 'rollback'].includes(normalized)) {
          pool.transactions.push(normalized);
          return { rowCount: 0, rows: [] };
        }
        if (normalized.startsWith('insert into helmion.projects')) {
          if (pool.projects.has(parameters[0])) return { rowCount: 0, rows: [] };
          const row = {
            slug: parameters[0],
            name: parameters[1],
            root_path: parameters[2],
          };
          pool.projects.set(parameters[0], row);
          return { rowCount: 1, rows: [row] };
        }
        if (normalized.startsWith('select * from helmion.projects')) {
          const row = pool.projects.get(parameters[0]);
          return row
            ? { rowCount: 1, rows: [row] }
            : { rowCount: 0, rows: [] };
        }
        throw new Error(`Unexpected client query: ${normalized}`);
      },
      release() {},
    };
  }
}

test('database preflight reports a fresh Helmion schema without writing', async () => {
  const pool = new PreflightPool();
  const store = await createNeonStore(null, { pool });
  const inspection = await store.inspectDatabase();

  assert.equal(inspection.identity.database_name, 'neondb');
  assert.equal(inspection.helmion.schemaExists, false);
  assert.deepEqual(
    inspection.migrations.map(({ name, status }) => [name, status]),
    migrationNames.map((name) => [name, 'pending']),
  );
  assert.equal(inspection.migrationsReady, false);
  assert.deepEqual(pool.transactions, []);
});

test('isolated test-project creation is durable, idempotent, and metadata-bound', async () => {
  const pool = new PreflightPool();
  const store = await createNeonStore(null, { pool });
  const input = {
    projectSlug: 'helmion-phase-two-switch-test',
    name: 'Helmion Phase Two isolated switch test',
    rootPath: null,
  };

  const created = await store.ensureProject(input);
  const replay = await store.ensureProject(input);
  assert.equal(created.durability, 'committed');
  assert.equal(created.created, true);
  assert.equal(replay.durability, 'committed');
  assert.equal(replay.created, false);
  assert.equal(pool.projects.size, 1);

  await assert.rejects(
    store.ensureProject({ ...input, name: 'Different project' }),
    /different metadata/,
  );
  assert.equal(pool.transactions.at(-1), 'rollback');
});
