import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { REQUIRED_MIGRATIONS } from './release-canary-contract.mjs';

export const RELEASE_SOURCE_INTEGRITY_FORMAT = 'helmian.cloud.release-source-integrity.v1';

export const REQUIRED_RELEASE_SOURCE_FILES = Object.freeze([
  'src/cloud/live-admin.mjs',
  'src/cloud/release-canary-contract.mjs',
  'src/cloud/release-canary-observation.mjs',
  'src/cora/clm-server.mjs',
  'src/cora/hume-session-descriptor.mjs',
  'src/cora/session-config-resolver.mjs',
  'web/cloud-admin/app.js',
  'web/cloud-admin/cora-config-client.mjs',
]);

function fail(message) {
  throw new Error(message);
}

function requireRoot(root) {
  if (typeof root !== 'string' || !root.trim()) fail('source root is required');
  return root;
}

/**
 * Verify only local, non-secret release inputs. This does not inspect Git,
 * databases, credentials, provider configuration, or deployed state.
 */
export async function validateReleaseSourceTree({ root, requiredMigrations = REQUIRED_MIGRATIONS, requiredFiles = REQUIRED_RELEASE_SOURCE_FILES } = {}) {
  const sourceRoot = requireRoot(root);
  if (!Array.isArray(requiredMigrations) || requiredMigrations.length === 0) fail('required migration list is invalid');
  if (!Array.isArray(requiredFiles) || requiredFiles.length === 0) fail('required source file list is invalid');

  const migrationDirectory = join(sourceRoot, 'sql');
  const entries = (await readdir(migrationDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{3}_.+\.sql$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'));
  const required = [...requiredMigrations];
  const missingMigrations = required.filter((name) => !entries.includes(name));
  const order = required.every((name, index) => entries.indexOf(name) === entries.indexOf(required[0]) + index);
  const missingFiles = [];
  for (const relativePath of requiredFiles) {
    try { await access(join(sourceRoot, relativePath)); }
    catch { missingFiles.push(relativePath); }
  }
  const result = Object.freeze({
    format: RELEASE_SOURCE_INTEGRITY_FORMAT,
    valid: missingMigrations.length === 0 && order && missingFiles.length === 0,
    migrationOrder: Object.freeze(required),
    missingMigrations: Object.freeze(missingMigrations),
    migrationsContiguous: order,
    missingFiles: Object.freeze(missingFiles),
    externalState: 'not_inspected',
  });
  return result;
}
