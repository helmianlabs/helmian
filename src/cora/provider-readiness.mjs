// Local-only provider configuration posture for Cora.
//
// This validates shape and presence only. It never contacts a provider and
// never returns a credential, URL, model name, provider label, or error text.

import { resolveProvider } from '../agent/env.mjs';

export const CORA_PROVIDER_READINESS_SCHEMA_VERSION = 1;
export const CORA_PROVIDER_READINESS_STATES = Object.freeze([
  'ready',
  'missing-credential',
  'invalid-configuration',
]);
/** Stable machine-readable result for malformed live-provider selection/config. */
export const CORA_PROVIDER_READINESS_INVALID_CONFIGURATION = Object.freeze({
  schemaVersion: CORA_PROVIDER_READINESS_SCHEMA_VERSION,
  mode: 'live-provider',
  state: 'invalid-configuration',
  ready: false,
  providerRequired: true,
});

const BUILTIN_PROVIDER_IDS = new Set(['openai', 'anthropic', 'gemini', 'xai']);
const MAX_PROVIDER_LABEL_CHARS = 80;
const MAX_PROVIDER_MODEL_CHARS = 160;
const MAX_PROVIDER_SELECTION_CHARS = 80;

function status(mode, state) {
  if (mode === 'live-provider' && state === 'invalid-configuration') {
    return CORA_PROVIDER_READINESS_INVALID_CONFIGURATION;
  }
  return Object.freeze({
    schemaVersion: CORA_PROVIDER_READINESS_SCHEMA_VERSION,
    mode,
    state,
    ready: state === 'ready',
    providerRequired: mode === 'live-provider',
  });
}

function boundedText(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function validProviderSelection(value) {
  return boundedText(value, MAX_PROVIDER_SELECTION_CHARS)
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && !parsed.username
      && !parsed.password
      && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function validateProvider(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    return 'invalid-configuration';
  }
  if (!BUILTIN_PROVIDER_IDS.has(provider.id) && provider.id !== 'custom') {
    return 'invalid-configuration';
  }
  if (!boundedText(provider.label, MAX_PROVIDER_LABEL_CHARS)) return 'invalid-configuration';

  if (provider.id === 'custom') {
    // Keyless local runtimes are supported; the resolved provider uses the
    // private sentinel "no-key-required", which is never returned here.
    if (!validHttpUrl(provider.baseUrl ?? provider.url)) return 'invalid-configuration';
    if (!boundedText(provider.model, MAX_PROVIDER_MODEL_CHARS)) return 'invalid-configuration';
    return 'ready';
  }
  return boundedText(provider.key, 4_096) ? 'ready' : 'missing-credential';
}

/**
 * Return a bounded, secret-free readiness projection.
 *
 * `env` is supplied by the caller so this pure inspection seam can be tested
 * with fixtures and does not need to read a file or contact a provider.
 */
export function inspectCoraProviderReadiness({
  providerName = 'claude',
  provider = null,
  runTurn = null,
  env = null,
} = {}) {
  if (typeof runTurn === 'function') return status('local-mock', 'ready');
  if (!validProviderSelection(providerName)) {
    return status('live-provider', 'invalid-configuration');
  }

  let resolved = provider;
  if (!resolved && env) {
    try {
      resolved = resolveProvider(providerName, env);
    } catch {
      return status('live-provider', 'invalid-configuration');
    }
  }
  if (!resolved) return status('live-provider', 'missing-credential');
  return status('live-provider', validateProvider(resolved));
}
