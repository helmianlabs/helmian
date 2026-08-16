const PROVIDER_OAUTH_CLOSURE = Object.freeze([
  Object.freeze({
    version: '004',
    name: '004_tenant_audit_outbox.sql',
    purpose: 'tenant-and-membership-runtime-prerequisite',
    objects: Object.freeze(['helmion.tenants', 'helmion.tenant_memberships']),
  }),
  Object.freeze({
    version: '031',
    name: '031_helmion_provider_connections.sql',
    purpose: 'provider-connection-metadata',
    objects: Object.freeze(['helmion.provider_connections']),
  }),
  Object.freeze({
    version: '034',
    name: '034_helmion_provider_oauth.sql',
    purpose: 'oauth-state-and-encrypted-token-vault',
    objects: Object.freeze(['helmion.provider_oauth_transactions', 'helmion.provider_oauth_tokens']),
  }),
]);

const OUTSIDE_CLOSURE = Object.freeze({ first: 12, last: 30 });

function versionNumber(version) {
  const value = Number.parseInt(String(version), 10);
  return Number.isInteger(value) ? value : null;
}

function migrationStatus(migrations, expected) {
  const found = migrations.find((migration) => String(migration?.version) === expected.version);
  if (!found) return Object.freeze({ version: expected.version, name: expected.name, status: 'missing_from_manifest' });
  return Object.freeze({
    version: expected.version,
    name: expected.name,
    status: found.status,
    objects: expected.objects,
    purpose: expected.purpose,
  });
}

export function createProviderOAuthMigrationPlan(inspection = {}) {
  if (!Array.isArray(inspection.migrations)) throw new TypeError('migration inspection must contain migrations');
  const closure = PROVIDER_OAUTH_CLOSURE.map((expected) => migrationStatus(inspection.migrations, expected));
  const closureVersions = new Set(PROVIDER_OAUTH_CLOSURE.map((migration) => migration.version));
  const pendingOutsideClosure = inspection.migrations
    .filter((migration) => {
      const number = versionNumber(migration?.version);
      return number !== null
        && number >= OUTSIDE_CLOSURE.first
        && number <= OUTSIDE_CLOSURE.last
        && !closureVersions.has(String(migration.version))
        && migration.status === 'pending';
    })
    .sort((left, right) => versionNumber(left.version) - versionNumber(right.version))
    .map((migration) => Object.freeze({ version: String(migration.version), name: migration.name, status: migration.status }));
  const closureReady = closure.every((migration) => migration.status === 'applied');
  return Object.freeze({
    readOnly: true,
    execution: 'not_performed',
    databaseWrites: 'not_performed',
    providerOAuthDependencyClosure: closure,
    pendingOutsideClosure,
    providerOAuthMigrationReady: closureReady,
    nextAction: closureReady
      ? 'provider-oauth-closure-applied; authenticated canary remains separate'
      : 'review provider-oauth closure before any migration execution',
  });
}

export const providerOAuthMigrationClosure = PROVIDER_OAUTH_CLOSURE;
