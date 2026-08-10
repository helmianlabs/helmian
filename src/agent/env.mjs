import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Keys that the Pilot EXE / agent bridge must take from Helmion's .env even when
 * a parent process already exported a stale or empty value. Without this, a bad
 * XAI_API_KEY inherited from the desktop shell permanently wins over .env and
 * surfaces as Grok/xAI HTTP 401 invalid_api_key in the Console.
 */
const HELMION_ENV_OVERRIDE_KEYS = new Set([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'XAI_API_KEY',
  'GROK_API_KEY',
  'HELMION_DATABASE_URL',
  'HELMION_EXPECTED_ENDPOINT_ID',
  'HELMION_CODEX_MODE',
  'HELMION_CODEX_INSTANCE_ID',
  'HELMION_MAESTRO_COORDINATOR',
  'HELMION_PERMISSION_MODE',
  'HELMION_MAX_TOOL_ROUNDS',
  'WORKSPACE_PATH',
  'HELMION_WORKSPACE_PATH',
  'HELMION_CUSTOM_PROVIDERS',
]);

/**
 * User-defined OpenAI-compatible endpoints, as JSON:
 *   [{"name":"ollama-qwen","baseUrl":"http://localhost:11434/v1","apiKey":"","model":"qwen2.5"}]
 * Written by the desktop AgentBridge; may also be set by hand for the CLI.
 * A malformed value yields an empty list rather than killing the agent.
 *
 * An optional `models` object opts the profile into per-task tier switching:
 *   {"name":"local","baseUrl":"…","models":{"fast":"qwen2.5:3b","deep":"qwen2.5:32b"}}
 * Omit it and the profile's single `model` is used for every tier — a box with
 * one model loaded must not be handed a tier name it cannot serve.
 */
export function parseCustomProviders(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((p) => p && typeof p.name === 'string' && typeof p.baseUrl === 'string')
    .filter((p) => p.name.trim() && p.baseUrl.trim())
    .map((p) => {
      const profile = {
        name: p.name.trim(),
        baseUrl: p.baseUrl.trim(),
        apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
        model: typeof p.model === 'string' && p.model.trim() ? p.model.trim() : p.name.trim(),
      };
      // Added only when the profile actually declares tiers, so a profile
      // without them serializes byte-identically to before this feature.
      const models = parseTierModels(p.models);
      if (models) profile.models = models;
      return profile;
    });
}

/** Accept only the three known tier keys with non-empty string ids; else null. */
function parseTierModels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const tier of ['fast', 'standard', 'deep']) {
    const id = value[tier];
    if (typeof id === 'string' && id.trim()) out[tier] = id.trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Accept every base-URL shape users paste: `http://host:11434`, `…/v1`, or the
 * full `…/v1/chat/completions`. Mirrors CustomChatSession.ResolveChatCompletionsUrl.
 */
export function resolveChatCompletionsUrl(baseUrl) {
  const url = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  if (/\/chat\/completions$/i.test(url)) return url;
  if (/\/v1$/i.test(url)) return `${url}/chat/completions`;
  return `${url}/v1/chat/completions`;
}

/**
 * Load .env from cwd walking up, then process.env. Does not print secrets.
 * Helmion-managed keys from the file always win over inherited process env.
 */
export function loadHelmionEnv(startDir = process.cwd()) {
  const candidate = findHelmionEnvFile(startDir);
  if (candidate) applyEnvFile(candidate);
  return snapshotHelmionEnv(process.env);
}

/** Read the same configuration without changing process.env. */
export function readHelmionEnv(startDir = process.cwd()) {
  const values = { ...process.env };
  const candidate = findHelmionEnvFile(startDir);
  if (candidate) {
    for (const [key, val] of Object.entries(readEnvFile(candidate))) {
      const shouldOverride =
        HELMION_ENV_OVERRIDE_KEYS.has(key)
        || values[key] === undefined
        || values[key] === '';
      if (shouldOverride) values[key] = val;
    }
  }
  return snapshotHelmionEnv(values);
}

function findHelmionEnvFile(startDir) {
  let dir = resolve(startDir);
  for (let i = 0; i < 12; i += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function snapshotHelmionEnv(values) {
  return {
    openai: values.OPENAI_API_KEY || '',
    anthropic: values.ANTHROPIC_API_KEY || '',
    gemini: values.GEMINI_API_KEY || '',
    xai: values.XAI_API_KEY || values.GROK_API_KEY || '',
    maestro: (values.HELMION_MAESTRO_COORDINATOR || 'Gemini').trim(),
    permissionMode: (values.HELMION_PERMISSION_MODE || 'read-only').trim(),
    workspace: values.WORKSPACE_PATH || values.HELMION_WORKSPACE_PATH || process.cwd(),
    databaseUrl: values.HELMION_DATABASE_URL || '',
    customProviders: parseCustomProviders(values.HELMION_CUSTOM_PROVIDERS),
  };
}

function applyEnvFile(path) {
  const values = readEnvFile(path);
  for (const [key, val] of Object.entries(values)) {
    const existing = process.env[key];
    const shouldOverride =
      HELMION_ENV_OVERRIDE_KEYS.has(key)
      || existing === undefined
      || existing === '';
    if (shouldOverride) {
      process.env[key] = val;
    }
  }
}

function readEnvFile(path) {
  const values = {};
  const text = readFileSync(path, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"'))
      || (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    values[key] = val;
  }
  return values;
}

/**
 * Resolve a coordinator name to a provider descriptor.
 * Built-ins win; any other name is matched (case-insensitively) against the
 * user's custom OpenAI-compatible endpoints — `overrides` first, then env.
 */
export function resolveProvider(name, env, overrides = null) {
  const raw = (name || env.maestro || 'Gemini').trim();
  const n = raw.toLowerCase();
  if (n === 'openai' || n === 'gpt') {
    return { id: 'openai', key: env.openai, label: 'OpenAI' };
  }
  if (n === 'claude' || n === 'anthropic') {
    return { id: 'anthropic', key: env.anthropic, label: 'Claude' };
  }
  if (n === 'gemini' || n === 'google') {
    return { id: 'gemini', key: env.gemini, label: 'Gemini' };
  }
  if (n === 'grok' || n === 'xai') {
    return { id: 'xai', key: env.xai, label: 'xAI Grok' };
  }

  const pools = [
    Array.isArray(overrides) ? overrides : [],
    Array.isArray(env.customProviders) ? env.customProviders : [],
  ];
  for (const pool of pools) {
    const hit = pool.find((p) => p && String(p.name).trim().toLowerCase() === n);
    if (hit) {
      return {
        id: 'custom',
        // Local runtimes (Ollama, vLLM, LM Studio) are legitimately keyless.
        // A placeholder keeps the "no API key" guard in chatWithTools from
        // rejecting a provider that never needed one.
        key: hit.apiKey || 'no-key-required',
        apiKey: hit.apiKey || '',
        label: hit.name,
        baseUrl: hit.baseUrl,
        url: resolveChatCompletionsUrl(hit.baseUrl),
        model: hit.model || hit.name,
        // Only present when the profile declared per-tier models; the router
        // falls back to `model` for every tier when this is null.
        models: hit.models || null,
      };
    }
  }

  const known = pools.flat().map((p) => p.name).filter(Boolean);
  throw new Error(
    `Unknown provider "${raw}". Use: openai | claude | gemini | grok`
    + (known.length ? ` | ${known.join(' | ')}` : '')
    + '. Custom endpoints come from HELMION_CUSTOM_PROVIDERS or the desktop Settings page.',
  );
}
