import { assertExpectedNeonEndpoint } from '../core/database-target.mjs';

const PROVIDER_KEY_BY_NAME = Object.freeze({
  claude: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  grok: 'GROK_API_KEY',
});

function text(value) {
  return String(value ?? '').trim();
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
    missing: Object.freeze([...new Set(missing)]),
  });
}
