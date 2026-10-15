const NEON_HOST_SUFFIX = '.neon.tech';
const ENDPOINT_PATTERN = /^ep-[a-z0-9-]+$/;

function requiredText(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

export function normalizeNeonEndpointId(value) {
  const normalized = requiredText(value, 'expected Neon endpoint ID')
    .toLowerCase()
    .replace(/-pooler$/, '');
  if (!ENDPOINT_PATTERN.test(normalized)) {
    throw new TypeError('expected Neon endpoint ID must start with "ep-"');
  }
  return normalized;
}

export function describeDatabaseTarget(connectionString) {
  const value = requiredText(connectionString, 'HELMION_DATABASE_URL');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('HELMION_DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new TypeError('HELMION_DATABASE_URL must use the postgres or postgresql protocol');
  }

  const host = parsed.hostname.toLowerCase();
  const firstLabel = host.split('.')[0].replace(/-pooler$/, '');
  const endpointId = host.endsWith(NEON_HOST_SUFFIX) && ENDPOINT_PATTERN.test(firstLabel)
    ? firstLabel
    : null;
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!databaseName) throw new TypeError('HELMION_DATABASE_URL must include a database name');
  const sslMode = parsed.searchParams.get('sslmode')?.toLowerCase() ?? null;

  return Object.freeze({
    host,
    endpointId,
    databaseName,
    sslRequired: ['require', 'verify-ca', 'verify-full', 'no-verify'].includes(sslMode),
  });
}

// Self-hosted Postgres (single VPS, docker compose) pins the target as
// "self-hosted:<host>/<database>" instead of a Neon endpoint ID. The URL must
// match host and database exactly, so a mistyped URL still opens no connection.
export const SELF_HOSTED_PREFIX = 'self-hosted:';

export function assertExpectedSelfHostedTarget(connectionString, expected) {
  const target = describeDatabaseTarget(connectionString);
  const pin = requiredText(expected, 'expected self-hosted target').slice(SELF_HOSTED_PREFIX.length);
  const [host, ...rest] = pin.split('/');
  const databaseName = rest.join('/');
  if (!host || !databaseName) throw new TypeError('self-hosted target must look like self-hosted:<host>/<database>');
  if (target.host !== host.toLowerCase() || target.databaseName !== databaseName) {
    throw new Error(
      `Database target mismatch: configured ${target.host}/${target.databaseName}, `
      + `expected ${host.toLowerCase()}/${databaseName}; no connection was opened`,
    );
  }
  return Object.freeze({ ...target, selfHosted: true });
}

export function assertExpectedNeonEndpoint(connectionString, expectedEndpointId) {
  if (String(expectedEndpointId ?? '').trim().toLowerCase().startsWith(SELF_HOSTED_PREFIX)) {
    return assertExpectedSelfHostedTarget(connectionString, String(expectedEndpointId).trim());
  }
  const target = describeDatabaseTarget(connectionString);
  const expected = normalizeNeonEndpointId(expectedEndpointId);
  if (!target.endpointId) {
    throw new Error(
      'HELMION_DATABASE_URL is not a recognizable Neon endpoint; no connection was opened',
    );
  }
  if (target.endpointId !== expected) {
    throw new Error(
      `Database target mismatch: configured endpoint is ${target.endpointId}, `
      + `expected ${expected}; no connection was opened`,
    );
  }
  if (!target.sslRequired) {
    throw new Error('Neon target must explicitly require SSL; no connection was opened');
  }
  return target;
}
