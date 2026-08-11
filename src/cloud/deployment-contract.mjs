import { assertExpectedNeonEndpoint } from '../core/database-target.mjs';
import { isAllowedAimForgeActionOrigin } from '../cora/aimforge-board-action.mjs';

const PROVIDER_KEY_BY_NAME = Object.freeze({
  claude: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  grok: 'GROK_API_KEY',
});

function text(value) {
  return String(value ?? '').trim();
}

function validHttpsUrl(value, { callback = false } = {}) {
  try {
    const url = new URL(text(value));
    return url.protocol === 'https:' && !url.username && !url.password
      && !url.hash && (!callback || (url.pathname === '/admin/auth/callback' && !url.search));
  } catch {
    return false;
  }
}

export function inspectHelmianCloudDeployment(env = process.env) {
  const environment = text(env.HELMION_CLOUD_ENVIRONMENT).toLowerCase();
  const provider = text(env.HELMION_CORA_PROVIDER || 'claude').toLowerCase();
  const missing = [];
  if (!['staging', 'production'].includes(environment)) missing.push('HELMION_CLOUD_ENVIRONMENT');
  if (!PROVIDER_KEY_BY_NAME[provider]) missing.push('HELMION_CORA_PROVIDER');
  if (!text(env.HELMION_DATABASE_URL)) missing.push('HELMION_DATABASE_URL');
  if (!text(env.HELMION_EXPECTED_ENDPOINT_ID)) missing.push('HELMION_EXPECTED_ENDPOINT_ID');
  if (text(env.HELMION_CORA_TOKEN).length < 32) missing.push('HELMION_CORA_TOKEN');
  if (text(env.HELMION_AIMFORGE_BRIDGE_SECRET).length < 32) {
    missing.push('HELMION_AIMFORGE_BRIDGE_SECRET');
  }
  if (text(env.HELMION_AIMFORGE_ACTION_SECRET).length < 32) {
    missing.push('HELMION_AIMFORGE_ACTION_SECRET');
  }
  if (!isAllowedAimForgeActionOrigin(text(env.HELMION_AIMFORGE_API_BASE_URL))) {
    missing.push('HELMION_AIMFORGE_API_BASE_URL');
  }
  if (!validHttpsUrl(env.HELMION_ADMIN_ISSUER)) missing.push('HELMION_ADMIN_ISSUER');
  if (!text(env.HELMION_ADMIN_CLIENT_ID)) missing.push('HELMION_ADMIN_CLIENT_ID');
  if (!validHttpsUrl(env.HELMION_ADMIN_REDIRECT_URI, { callback: true })) {
    missing.push('HELMION_ADMIN_REDIRECT_URI');
  }
  const providerKey = PROVIDER_KEY_BY_NAME[provider];
  if (providerKey && !text(env[providerKey])) missing.push(providerKey);

  let database = null;
  if (!missing.includes('HELMION_DATABASE_URL') && !missing.includes('HELMION_EXPECTED_ENDPOINT_ID')) {
    try {
      database = assertExpectedNeonEndpoint(
        env.HELMION_DATABASE_URL,
        env.HELMION_EXPECTED_ENDPOINT_ID,
      );
    } catch {
      missing.push('HELMION_DATABASE_URL / HELMION_EXPECTED_ENDPOINT_ID (matching Neon SSL target required)');
    }
  }
  return Object.freeze({
    ready: missing.length === 0,
    environment: ['staging', 'production'].includes(environment) ? environment : null,
    provider: PROVIDER_KEY_BY_NAME[provider] ? provider : null,
    database: database ? Object.freeze({ endpointId: database.endpointId, databaseName: database.databaseName }) : null,
    admin: Object.freeze({
      configured: !missing.some((name) => name.startsWith('HELMION_ADMIN_')),
      callbackPath: '/admin/auth/callback',
    }),
    missing: Object.freeze([...new Set(missing)]),
  });
}
