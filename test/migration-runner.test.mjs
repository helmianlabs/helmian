import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeMigrationSql, createNeonStore } from '../src/adapters/neon.mjs';

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
        if (String(sql).includes('create table if not exists helmion.tenants')) {
          pool.executedSql.push('004_tenant_audit_outbox.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('add column if not exists claim_token')) {
          pool.executedSql.push('005_tenant_audit_claims.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('create table if not exists helmion.audit_outbox_operations')) {
          pool.executedSql.push('006_tenant_audit_claim_operations.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('create table if not exists helmion.platform_action_policy')) {
          pool.executedSql.push('007_platform_action_policy.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('equipment_safety_status_enabled')) {
          pool.executedSql.push('008_equipment_safety_action_policy.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('CREATE TABLE IF NOT EXISTS helmion.envoy_channels')) {
          pool.executedSql.push('009_envoy_chat.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('create table if not exists helmion.cora_configs')) {
          pool.executedSql.push('010_cora_organization_config.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('create table if not exists helmion.cora_usage_budgets')) {
          pool.executedSql.push('011_cora_provider_usage.sql');
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
      ['004_tenant_audit_outbox.sql', true, 'committed'],
      ['005_tenant_audit_claims.sql', true, 'committed'],
      ['006_tenant_audit_claim_operations.sql', true, 'committed'],
      ['007_platform_action_policy.sql', true, 'committed'],
      ['008_equipment_safety_action_policy.sql', true, 'committed'],
      ['009_envoy_chat.sql', true, 'committed'],
      ['010_cora_organization_config.sql', true, 'committed'],
      ['011_cora_provider_usage.sql', true, 'committed'],
    ],
  );
  assert.deepEqual(
    pool.executedSql,
    [
      '001_helmion.sql',
      '002_maestro_phase_one.sql',
      '003_human_confirmations.sql',
      '004_tenant_audit_outbox.sql',
      '005_tenant_audit_claims.sql',
      '006_tenant_audit_claim_operations.sql',
      '007_platform_action_policy.sql',
      '008_equipment_safety_action_policy.sql',
      '009_envoy_chat.sql',
      '010_cora_organization_config.sql',
      '011_cora_provider_usage.sql',
    ],
  );

  const second = await store.migrate();
  assert.deepEqual(
    second.map((result) => result.applied),
    [false, false, false, false, false, false, false, false, false, false, false],
  );
  assert.deepEqual(
    pool.executedSql,
    [
      '001_helmion.sql',
      '002_maestro_phase_one.sql',
      '003_human_confirmations.sql',
      '004_tenant_audit_outbox.sql',
      '005_tenant_audit_claims.sql',
      '006_tenant_audit_claim_operations.sql',
      '007_platform_action_policy.sql',
      '008_equipment_safety_action_policy.sql',
      '009_envoy_chat.sql',
      '010_cora_organization_config.sql',
      '011_cora_provider_usage.sql',
    ],
  );
  assert.equal(pool.transactions.filter((entry) => entry === 'commit').length, 22);
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
