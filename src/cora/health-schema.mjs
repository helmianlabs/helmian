// The opt-in Cora health-detail contract.
//
// This is deliberately a schema for a lossy, server-owned posture view. It
// rejects identifiers, content, credentials, paths, and any future ad-hoc
// fields instead of allowing them to drift into the diagnostics boundary.

export const CORA_HEALTH_DIAGNOSTICS_SCHEMA_VERSION = 1;
export const CORA_HEALTH_DIAGNOSTICS_SUPPORTED_VERSIONS = Object.freeze([
  CORA_HEALTH_DIAGNOSTICS_SCHEMA_VERSION,
]);
export const CORA_HEALTH_PHASES = Object.freeze(['queued', 'running', 'timed-out']);
export const CORA_HEALTH_POLICY_MODES = Object.freeze(['tools-enabled', 'chat-only']);
export const MAX_CORA_HEALTH_DETAIL_SESSIONS = 16;
export const MAX_CORA_HEALTH_PHASE_COUNT = 100;
export const MAX_CORA_HEALTH_AGE_MS = 30 * 60_000;
export const MAX_CORA_HEALTH_TURNS = 1_000_000;
export const MAX_CORA_HEALTH_IN_FLIGHT = 100;

export const CORA_HEALTH_DIAGNOSTICS_SCHEMA = Object.freeze({
  version: CORA_HEALTH_DIAGNOSTICS_SCHEMA_VERSION,
  phases: CORA_HEALTH_PHASES,
  policyModes: CORA_HEALTH_POLICY_MODES,
  maxSessions: MAX_CORA_HEALTH_DETAIL_SESSIONS,
  maxPhaseCount: MAX_CORA_HEALTH_PHASE_COUNT,
  maxAgeMs: MAX_CORA_HEALTH_AGE_MS,
});

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

/** Return the advertised version when a local consumer can read it. */
export function negotiateCoraHealthDiagnosticsVersion(
  advertisedVersion,
  supportedVersions = CORA_HEALTH_DIAGNOSTICS_SUPPORTED_VERSIONS,
) {
  if (!Number.isInteger(advertisedVersion) || !Array.isArray(supportedVersions)) return null;
  const supported = supportedVersions.filter((version) => Number.isInteger(version));
  return supported.includes(advertisedVersion) ? advertisedVersion : null;
}

function fail(path, message) {
  throw new TypeError(`Invalid Cora health diagnostics at ${path}: ${message}`);
}

function objectAt(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object');
  return value;
}

function exactKeys(value, keys, path) {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !hasOwn(value, key))) {
    fail(path, `expected exactly ${keys.join(', ')}`);
  }
}

function booleanAt(value, path) {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean');
}

function integerAt(value, path, max) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    fail(path, `expected an integer from 0 through ${max}`);
  }
}

function phaseAt(value, path, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!CORA_HEALTH_PHASES.includes(value)) fail(path, 'unknown phase');
}

function phaseCountsAt(value, path) {
  objectAt(value, path);
  exactKeys(value, CORA_HEALTH_PHASES, path);
  for (const phase of CORA_HEALTH_PHASES) integerAt(value[phase], `${path}.${phase}`, MAX_CORA_HEALTH_PHASE_COUNT);
}

function truncationAt(value, path, counts) {
  booleanAt(value, path);
  if (value && !CORA_HEALTH_PHASES.some((phase) => counts[phase] === MAX_CORA_HEALTH_PHASE_COUNT)) {
    fail(path, 'true requires at least one capped phase count');
  }
}

function sessionAt(value, path) {
  objectAt(value, path);
  exactKeys(value, [
    'mode', 'turns', 'inFlight', 'active', 'phase', 'activeTurnPhases', 'lastSeenAgeMs',
  ], path);
  if (!CORA_HEALTH_POLICY_MODES.includes(value.mode)) fail(`${path}.mode`, 'unknown policy mode');
  integerAt(value.turns, `${path}.turns`, MAX_CORA_HEALTH_TURNS);
  integerAt(value.inFlight, `${path}.inFlight`, MAX_CORA_HEALTH_IN_FLIGHT);
  booleanAt(value.active, `${path}.active`);
  phaseAt(value.phase, `${path}.phase`, { nullable: true });
  if (!Array.isArray(value.activeTurnPhases)) fail(`${path}.activeTurnPhases`, 'expected an array');
  if (value.activeTurnPhases.length > MAX_CORA_HEALTH_DETAIL_SESSIONS) {
    fail(`${path}.activeTurnPhases`, 'exceeds the diagnostics bound');
  }
  value.activeTurnPhases.forEach((phase, index) => phaseAt(phase, `${path}.activeTurnPhases[${index}]`));
  integerAt(value.lastSeenAgeMs, `${path}.lastSeenAgeMs`, MAX_CORA_HEALTH_AGE_MS);

  const expectedPhase = value.activeTurnPhases.includes('timed-out')
    ? 'timed-out'
    : value.activeTurnPhases.includes('running')
      ? 'running'
      : value.activeTurnPhases.includes('queued')
        ? 'queued'
        : null;
  if (value.phase !== expectedPhase || value.active !== (value.inFlight > 0)) {
    fail(path, 'phase and active state do not match the phase list');
  }
}

/** Assert the exact, bounded, identifier-free shape consumed by local clients. */
export function assertCoraHealthDiagnostics(
  value,
  { supportedVersions = CORA_HEALTH_DIAGNOSTICS_SUPPORTED_VERSIONS } = {},
) {
  objectAt(value, 'diagnostics');
  if (negotiateCoraHealthDiagnosticsVersion(value.schemaVersion, supportedVersions) === null) {
    fail('diagnostics.schemaVersion', 'unsupported schema version');
  }
  exactKeys(value, [
    'schemaVersion',
    'sessions',
    'phaseCounts',
    'phaseCountsTruncated',
    'phaseCountsByMode',
    'phaseCountsByModeTruncated',
    'truncated',
  ], 'diagnostics');

  if (!Array.isArray(value.sessions)) fail('diagnostics.sessions', 'expected an array');
  if (value.sessions.length > MAX_CORA_HEALTH_DETAIL_SESSIONS) {
    fail('diagnostics.sessions', 'exceeds the diagnostics bound');
  }
  value.sessions.forEach((session, index) => sessionAt(session, `diagnostics.sessions[${index}]`));

  phaseCountsAt(value.phaseCounts, 'diagnostics.phaseCounts');
  truncationAt(value.phaseCountsTruncated, 'diagnostics.phaseCountsTruncated', value.phaseCounts);

  objectAt(value.phaseCountsByMode, 'diagnostics.phaseCountsByMode');
  exactKeys(value.phaseCountsByMode, CORA_HEALTH_POLICY_MODES, 'diagnostics.phaseCountsByMode');
  for (const mode of CORA_HEALTH_POLICY_MODES) {
    phaseCountsAt(value.phaseCountsByMode[mode], `diagnostics.phaseCountsByMode.${mode}`);
  }

  objectAt(value.phaseCountsByModeTruncated, 'diagnostics.phaseCountsByModeTruncated');
  exactKeys(
    value.phaseCountsByModeTruncated,
    CORA_HEALTH_POLICY_MODES,
    'diagnostics.phaseCountsByModeTruncated',
  );
  for (const mode of CORA_HEALTH_POLICY_MODES) {
    truncationAt(
      value.phaseCountsByModeTruncated[mode],
      `diagnostics.phaseCountsByModeTruncated.${mode}`,
      value.phaseCountsByMode[mode],
    );
  }
  booleanAt(value.truncated, 'diagnostics.truncated');
  return value;
}
