import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderOAuthMigrationPlan } from '../src/adapters/provider-oauth-migration-plan.mjs';

function inspection() {
  const migrations = [];
  for (let version = 1; version <= 34; version += 1) {
    const padded = String(version).padStart(3, '0');
    const names = {
      1: '001_helmion.sql',
      2: '002_maestro_phase_one.sql',
      3: '003_human_confirmations.sql',
      4: '004_tenant_audit_outbox.sql',
      5: '005_tenant_audit_claims.sql',
      6: '006_tenant_audit_claim_operations.sql',
      7: '007_platform_action_policy.sql',
      8: '008_equipment_safety_action_policy.sql',
      9: '009_envoy_chat.sql',
      10: '010_cora_organization_config.sql',
      11: '011_cora_provider_usage.sql',
      30: '030_helmion_billing_entitlements.sql',
      31: '031_helmion_provider_connections.sql',
      32: '032_workspace_projects.sql',
      33: '033_console_command_intents.sql',
      34: '034_helmion_provider_oauth.sql',
    };
    migrations.push({ version: padded, name: names[version] ?? `${padded}_fixture.sql`, status: version <= 11 ? 'applied' : 'pending' });
  }
  return { migrations };
}

test('provider OAuth plan identifies 004, 031, and 034 without executing', () => {
  const plan = createProviderOAuthMigrationPlan(inspection());
  assert.deepEqual(plan.providerOAuthDependencyClosure.map(({ version, status }) => [version, status]), [
    ['004', 'applied'],
    ['031', 'pending'],
    ['034', 'pending'],
  ]);
  assert.deepEqual(plan.pendingOutsideClosure.map(({ version, status }) => [version, status]), Array.from({ length: 19 }, (_, index) => [String(index + 12).padStart(3, '0'), 'pending']));
  assert.equal(plan.providerOAuthMigrationReady, false);
  assert.equal(plan.readOnly, true);
  assert.equal(plan.execution, 'not_performed');
  assert.equal(plan.databaseWrites, 'not_performed');
});

test('provider OAuth plan treats an applied closure as ready while keeping outside pending work visible', () => {
  const source = inspection();
  source.migrations = source.migrations.map((migration) => (
    ['004', '031', '034'].includes(migration.version) ? { ...migration, status: 'applied' } : migration
  ));
  const plan = createProviderOAuthMigrationPlan(source);
  assert.equal(plan.providerOAuthMigrationReady, true);
  assert.deepEqual(plan.pendingOutsideClosure.map(({ version }) => version), Array.from({ length: 19 }, (_, index) => String(index + 12).padStart(3, '0')));
});

test('provider OAuth plan refuses malformed inspection instead of implying readiness', () => {
  assert.throws(() => createProviderOAuthMigrationPlan(), /must contain migrations/);
});
