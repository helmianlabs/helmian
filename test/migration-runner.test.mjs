import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeMigrationSql, createNeonStore, listExpectedMigrationManifest } from '../src/adapters/neon.mjs';
import { runExplicitMigrationCommand } from '../src/adapters/explicit-migration-cli.mjs';

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
        if (String(sql).includes('helmion.billing_events')) {
          pool.executedSql.push('030_helmion_billing_entitlements.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('helmion.provider_connections')) {
          pool.executedSql.push('031_helmion_provider_connections.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('helmion.cora_app_build_execution_results')) {
          pool.executedSql.push('039_cora_app_build_execution_results.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('helmion.cora_app_build_execution_requests')) {
          pool.executedSql.push('038_cora_app_build_execution_requests.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('helmion.workspace_projects')) {
          pool.executedSql.push('032_workspace_projects.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('helmion.console_command_intents')) {
          pool.executedSql.push('033_console_command_intents.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('helmion.provider_oauth_transactions')) {
          pool.executedSql.push('034_helmion_provider_oauth.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('helmion.cora_app_build_revisions')) {
          pool.executedSql.push('037_cora_app_build_revisions.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('helmion.cora_app_build_requests')) {
          pool.executedSql.push('035_cora_app_build_requests.sql');
          return { rowCount: 0, rows: [] };
        }
        if (normalized.includes('create schema if not exists helmion')) {
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
        if (String(sql).includes('create table if not exists helmion.cora_workspace_preview_intents')) {
          pool.executedSql.push('012_cora_workspace_preview_intents.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('create table if not exists helmion.cora_agent_task_intents')) {
          pool.executedSql.push('013_cora_agent_task_intents.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('create table if not exists helmion.cora_agent_task_claims')) {
          pool.executedSql.push('014_cora_agent_task_claims.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('create table if not exists helmion.cora_agent_task_execution_results')) {
          pool.executedSql.push('036_cora_approved_knowledge_task_results.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('alter table helmion.cora_knowledge_sources') && !String(sql).includes('cora_knowledge_sources_effective_idx')) {
          pool.executedSql.push('015_cora_knowledge_retrieval_metadata.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('create table if not exists helmion.cora_artifact_studio_intents')) {
          pool.executedSql.push('016_cora_artifact_studio_intents.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('create table if not exists helmion.cora_artifact_sources')) {
          pool.executedSql.push('017_cora_artifact_sources.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('create table if not exists helmion.cora_artifact_script_revisions')) {
          pool.executedSql.push('018_cora_artifact_script_revisions.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('create table if not exists helmion.cora_artifact_execution_requests')) {
          pool.executedSql.push('019_cora_artifact_execution_requests.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('create table if not exists helmion.cora_personal_preferences')) {
          pool.executedSql.push('020_cora_personal_preferences.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('create table if not exists helmion.organization_database_registry')) {
          pool.executedSql.push('021_organization_database_registry.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('create table if not exists helmion.workspace_layout_role_defaults')) {
          pool.executedSql.push('022_workspace_layout_preferences.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('cora_knowledge_sources_effective_idx')) {
          pool.executedSql.push('023_cora_knowledge_management.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('create table if not exists helmion.cora_usage_budget_allocations')) {
          pool.executedSql.push('024_cora_usage_budget_allocations.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('create table if not exists helmion.cora_approval_decisions')) {
          pool.executedSql.push('025_cora_approval_decisions.sql');
          return { rowCount: 0, rows: [] };
        }
        if (String(sql).includes('create table if not exists helmion.cora_connector_registrations')) {
          pool.executedSql.push('026_cora_connector_registrations.sql');
          return { rowCount: 0, rows: [] };
        }
        throw new Error(`Unexpected migration query: ${normalized.slice(0, 100)}`);
      },
      release() {},
    };
  }
}

async function exactMigrationSeed(...versions) {
  const manifest = await listExpectedMigrationManifest();
  return versions.map((version) => {
    const migration = manifest.find((entry) => entry.version === version);
    if (!migration) throw new Error(`Test migration ${version} is absent`);
    return migration;
  });
}

test('scoped migration accepts dependency-closed 035 then 037 and returns durable read-back receipts', async () => {
  const pool = new MigrationPool(await exactMigrationSeed('004'));
  const store = await createNeonStore(null, { pool });
  const result = await store.migrateExplicitlyAllowedSet(['035', '037']);
  assert.deepEqual(result.requestedVersions, ['035', '037']);
  assert.deepEqual(result.results.map((entry) => [entry.migration, entry.applied, entry.durability]), [
    ['035_cora_app_build_requests.sql', true, 'committed'],
    ['037_cora_app_build_revisions.sql', true, 'committed'],
  ]);
  assert.deepEqual(result.receipts.map((entry) => entry.version), ['035', '037']);
  assert.deepEqual(pool.executedSql, ['035_cora_app_build_requests.sql', '037_cora_app_build_revisions.sql']);
});

test('scoped migration accepts the dependency-closed app-build execution-request set', async () => {
  const pool = new MigrationPool(await exactMigrationSeed('004'));
  const store = await createNeonStore(null, { pool });
  const result = await store.migrateExplicitlyAllowedSet(['032', '035', '037', '038']);
  assert.deepEqual(result.requestedVersions, ['032', '035', '037', '038']);
  assert.deepEqual(pool.executedSql, ['032_workspace_projects.sql', '035_cora_app_build_requests.sql', '037_cora_app_build_revisions.sql', '038_cora_app_build_execution_requests.sql']);
});

test('scoped migration accepts the execution-result receipt after its request prerequisite', async () => {
  const pool = new MigrationPool(await exactMigrationSeed('004'));
  const store = await createNeonStore(null, { pool });
  const result = await store.migrateExplicitlyAllowedSet(['032', '035', '037', '038', '039']);
  assert.deepEqual(result.requestedVersions, ['032', '035', '037', '038', '039']);
  assert.equal(pool.executedSql.at(-1), '039_cora_app_build_execution_results.sql');
});

test('explicit migration CLI emits the verified target from a real scoped Neon store result', async () => {
  const pool = new MigrationPool(await exactMigrationSeed('004'));
  const store = await createNeonStore(
    'postgresql://app:password@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require',
    { pool, expectedEndpointId: 'ep-silent-rain-a1b2c3d4' },
  );
  const output = [];
  await runExplicitMigrationCommand({
    rawVersions: '035,037',
    createStore: async () => store,
    write: (value) => output.push(value),
  });
  const receipt = JSON.parse(output.join(''));
  assert.deepEqual(receipt.target, {
    host: 'ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech',
    endpointId: 'ep-silent-rain-a1b2c3d4',
    databaseName: 'neondb',
    sslRequired: true,
  });
  assert.deepEqual(receipt.requestedVersions, ['035', '037']);
  assert.deepEqual(receipt.receipts.map((entry) => entry.version), ['035', '037']);
  assert.deepEqual(pool.executedSql, ['035_cora_app_build_requests.sql', '037_cora_app_build_revisions.sql']);
});

test('scoped migration refuses 036 without its complete 013 then 014 prerequisite chain', async () => {
  const pool = new MigrationPool(await exactMigrationSeed('004'));
  const store = await createNeonStore(null, { pool });
  await assert.rejects(store.migrateExplicitlyAllowedSet(['036']), /missing prerequisite 013/u);
  await assert.rejects(store.migrateExplicitlyAllowedSet(['013', '036']), /missing prerequisite 014/u);
  assert.deepEqual(pool.executedSql, []);
});

test('scoped migration rejects unknown, duplicate, unordered, and checksum-mismatched allowlists before SQL', async () => {
  const seed = await exactMigrationSeed('004', '035');
  seed[1] = { ...seed[1], checksum: 'wrong-checksum' };
  const pool = new MigrationPool(seed);
  const store = await createNeonStore(null, { pool });
  await assert.rejects(store.migrateExplicitlyAllowedSet(['999']), /not in the checked-in manifest/u);
  await assert.rejects(store.migrateExplicitlyAllowedSet(['035', '035']), /duplicate/u);
  await assert.rejects(store.migrateExplicitlyAllowedSet(['037', '035']), /manifest order/u);
  await assert.rejects(store.migrateExplicitlyAllowedSet(['035']), /does not match/u);
  assert.deepEqual(pool.executedSql, []);
});

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
      ['012_cora_workspace_preview_intents.sql', true, 'committed'],
      ['013_cora_agent_task_intents.sql', true, 'committed'],
      ['014_cora_agent_task_claims.sql', true, 'committed'],
      ['015_cora_knowledge_retrieval_metadata.sql', true, 'committed'],
      ['016_cora_artifact_studio_intents.sql', true, 'committed'],
      ['017_cora_artifact_sources.sql', true, 'committed'],
      ['018_cora_artifact_script_revisions.sql', true, 'committed'],
      ['019_cora_artifact_execution_requests.sql', true, 'committed'],
      ['020_cora_personal_preferences.sql', true, 'committed'],
      ['021_organization_database_registry.sql', true, 'committed'],
      ['022_workspace_layout_preferences.sql', true, 'committed'],
      ['023_cora_knowledge_management.sql', true, 'committed'],
      ['024_cora_usage_budget_allocations.sql', true, 'committed'],
      ['025_cora_approval_decisions.sql', true, 'committed'],
      ['026_cora_connector_registrations.sql', true, 'committed'],
      ['030_helmion_billing_entitlements.sql', true, 'committed'],
      ['031_helmion_provider_connections.sql', true, 'committed'],
      ['032_workspace_projects.sql', true, 'committed'],
      ['033_console_command_intents.sql', true, 'committed'],
      ['034_helmion_provider_oauth.sql', true, 'committed'],
      ['035_cora_app_build_requests.sql', true, 'committed'],
      ['036_cora_approved_knowledge_task_results.sql', true, 'committed'],
      ['037_cora_app_build_revisions.sql', true, 'committed'],
      ['038_cora_app_build_execution_requests.sql', true, 'committed'],
      ['039_cora_app_build_execution_results.sql', true, 'committed'],
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
      '012_cora_workspace_preview_intents.sql',
      '013_cora_agent_task_intents.sql',
      '014_cora_agent_task_claims.sql',
      '015_cora_knowledge_retrieval_metadata.sql',
      '016_cora_artifact_studio_intents.sql',
      '017_cora_artifact_sources.sql',
      '018_cora_artifact_script_revisions.sql',
      '019_cora_artifact_execution_requests.sql',
      '020_cora_personal_preferences.sql',
      '021_organization_database_registry.sql',
      '022_workspace_layout_preferences.sql',
      '023_cora_knowledge_management.sql',
      '024_cora_usage_budget_allocations.sql',
      '025_cora_approval_decisions.sql',
      '026_cora_connector_registrations.sql',
      '030_helmion_billing_entitlements.sql',
      '031_helmion_provider_connections.sql',
      '032_workspace_projects.sql',
      '033_console_command_intents.sql',
      '034_helmion_provider_oauth.sql',
      '035_cora_app_build_requests.sql',
      '036_cora_approved_knowledge_task_results.sql',
      '037_cora_app_build_revisions.sql',
      '038_cora_app_build_execution_requests.sql',
      '039_cora_app_build_execution_results.sql',
    ],
  );

  const second = await store.migrate();
  assert.deepEqual(
    second.map((result) => result.applied),
    Array(36).fill(false),
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
      '012_cora_workspace_preview_intents.sql',
      '013_cora_agent_task_intents.sql',
      '014_cora_agent_task_claims.sql',
      '015_cora_knowledge_retrieval_metadata.sql',
      '016_cora_artifact_studio_intents.sql',
      '017_cora_artifact_sources.sql',
      '018_cora_artifact_script_revisions.sql',
      '019_cora_artifact_execution_requests.sql',
      '020_cora_personal_preferences.sql',
      '021_organization_database_registry.sql',
      '022_workspace_layout_preferences.sql',
      '023_cora_knowledge_management.sql',
      '024_cora_usage_budget_allocations.sql',
      '025_cora_approval_decisions.sql',
      '026_cora_connector_registrations.sql',
      '030_helmion_billing_entitlements.sql',
      '031_helmion_provider_connections.sql',
      '032_workspace_projects.sql',
      '033_console_command_intents.sql',
      '034_helmion_provider_oauth.sql',
      '035_cora_app_build_requests.sql',
      '036_cora_approved_knowledge_task_results.sql',
      '037_cora_app_build_revisions.sql',
      '038_cora_app_build_execution_requests.sql',
      '039_cora_app_build_execution_results.sql',
    ],
  );
  assert.equal(pool.transactions.filter((entry) => entry === 'commit').length, 72);
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
