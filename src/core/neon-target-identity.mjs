export const NEON_TARGET_IDENTITY_FORMAT = 'helmion.neon.target-identity.v1';

const SECRET_KEY = /(secret|token|password|api[_-]?key|credential|private[_-]?key|database[_-]?url|connection[_-]?string)/iu;

function required(value, name) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 256) throw new Error(`${name} is missing or too long`);
  return text;
}

function scanKeys(value, path = 'manifest') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'secretValuesOmitted' && SECRET_KEY.test(key)) throw new Error(`${path}.${key} is secret-bearing and is not allowed`);
    scanKeys(child, `${path}.${key}`);
  }
}

export function validateNeonTargetIdentityManifest(manifest = {}, expected = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Neon target identity manifest must be an object');
  }
  scanKeys(manifest);
  if (manifest.format !== NEON_TARGET_IDENTITY_FORMAT) throw new Error('unsupported Neon target identity format');
  if (manifest.secretValuesOmitted !== true) throw new Error('secretValuesOmitted must be true');
  if (manifest.evidence !== 'neon-console') throw new Error('evidence must be neon-console');

  const actual = {
    projectName: required(manifest.projectName, 'projectName'),
    projectId: required(manifest.projectId, 'projectId'),
    branchName: required(manifest.branchName, 'branchName'),
    databaseName: required(manifest.databaseName, 'databaseName'),
    endpointId: required(manifest.endpointId, 'endpointId'),
  };
  for (const field of Object.keys(actual)) {
    if (actual[field] !== required(expected[field], `expected.${field}`)) {
      throw new Error(`${field} does not match the expected Helmion target`);
    }
  }
  return Object.freeze({ format: NEON_TARGET_IDENTITY_FORMAT, ...actual, evidence: manifest.evidence, secretValuesOmitted: true });
}
