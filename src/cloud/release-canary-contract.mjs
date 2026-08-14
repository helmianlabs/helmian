export const RELEASE_CANARY_FORMAT = 'helmian.cloud.release-canary.v1';
export const REQUIRED_MIGRATIONS = Object.freeze([
  '009_envoy_chat.sql',
  '010_cora_organization_config.sql',
  '011_cora_provider_usage.sql',
  '012_cora_workspace_preview_intents.sql',
  '013_cora_agent_task_intents.sql',
]);
export const EXACT_CANARY_SEQUENCE = Object.freeze([
  'verify-release-manifest',
  'verify-readiness',
  'deploy-canary',
  'health-check',
  'authenticated-organization-read',
  'normal-read-prepare',
  'provider-session-receipt-check',
  'observe',
  'rollback-on-criteria',
]);
export const EXACT_ROLLBACK_CRITERIA = Object.freeze([
  'health_or_auth_failure',
  'migration_mismatch',
  'cross_organization_access',
  'usage_receipt_duplicate_or_missing',
  'provider_session_claim_without_source_receipt',
]);

const SECRET_KEY = /(secret|token|password|api[_-]?key|credential|private[_-]?key|database[_-]?url|connection[_-]?string)/iu;
const SHA256 = /^[a-f0-9]{64}$/u;

function clean(value, name, max = 256) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max) throw new Error(`${name} is missing or too long`);
  return result;
}

function sameArray(actual, expected, name) {
  if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${name} does not match the required order`);
  }
}

function scanForSecrets(value, path = 'manifest') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'tokenMode' && SECRET_KEY.test(key)) throw new Error(`${path}.${key} is secret-bearing and is not allowed`);
    scanForSecrets(child, `${path}.${key}`);
  }
}

export function validateReleaseManifest(manifest = {}, expected = {}) {
  const errors = [];
  const checks = [];
  const check = (label, fn) => {
    try { fn(); checks.push([label, true]); } catch (error) { errors.push(`${label}: ${error?.message ?? String(error)}`); checks.push([label, false]); }
  };
  check('API/source commit', () => {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest must be an object');
    scanForSecrets(manifest);
    if (manifest.format !== RELEASE_CANARY_FORMAT) throw new Error('format is missing or unsupported');
    if (clean(manifest.api?.sourceCommit, 'api.sourceCommit') !== clean(expected.sourceCommit, 'expected.sourceCommit')) throw new Error('API/source commit mismatch');
  });
  check('migrations 009/010/011', () => sameArray(manifest.migrations, expected.migrations ?? REQUIRED_MIGRATIONS, 'migration order'));
  check('Organization config published state/version', () => {
    if (manifest.organizationConfig?.publishedState !== clean(expected.organizationConfig?.publishedState, 'expected organization published state')) throw new Error('Organization config published state mismatch');
    if (manifest.organizationConfig?.version !== expected.organizationConfig?.version) throw new Error('Organization config version mismatch');
  });
  check('Hume readiness/config metadata', () => {
    for (const field of ['readiness', 'configRevision', 'tokenMode']) if (manifest.hume?.[field] !== expected.hume?.[field]) throw new Error(`Hume ${field} mismatch`);
  });
  check('provider usage ledger enabled', () => {
    if (manifest.providerUsageLedger?.enabled !== true || manifest.providerUsageLedger?.enabled !== expected.providerUsageLedger?.enabled) throw new Error('provider usage ledger is not enabled as expected');
  });
  check('UI bundle revision', () => {
    if (clean(manifest.ui?.bundleRevision, 'ui.bundleRevision') !== clean(expected.ui?.bundleRevision, 'expected UI bundle revision')) throw new Error('UI bundle revision mismatch');
  });
  check('connector mode', () => { if (manifest.connector?.mode !== expected.connector?.mode) throw new Error('connector mode mismatch'); });
  check('Cora session tool manifest/hash', () => {
    const toolHash = clean(manifest.cora?.sessionToolManifestHash, 'cora.sessionToolManifestHash');
    if (!SHA256.test(toolHash) || toolHash !== clean(expected.cora?.sessionToolManifestHash, 'expected Cora tool manifest hash')) throw new Error('Cora session tool manifest hash mismatch');
  });
  check('test fixture version', () => {
    if (clean(manifest.tests?.fixtureVersion, 'tests.fixtureVersion') !== clean(expected.tests?.fixtureVersion, 'expected test fixture version')) throw new Error('test fixture version mismatch');
  });
  check('exact canary sequence/rollback criteria', () => {
    sameArray(manifest.canary?.sequence, expected.canary?.sequence ?? EXACT_CANARY_SEQUENCE, 'canary sequence');
    sameArray(manifest.canary?.rollbackCriteria, expected.canary?.rollbackCriteria ?? EXACT_ROLLBACK_CRITERIA, 'rollback criteria');
  });
  const checklist = checks.map(([label, pass]) => `${pass ? '[PASS]' : '[FAIL]'} ${label}`).join('\n');
  return Object.freeze({ format: RELEASE_CANARY_FORMAT, valid: errors.length === 0, errors: Object.freeze(errors), checks: Object.freeze(checks.map(([label, pass]) => Object.freeze({ label, pass }))), checklist });
}
