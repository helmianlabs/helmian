// Provider registry: ONE row per provider Helmian ships a seat for,
// in the shape of ~/workspace/provider-catalog/DESIGN.md §1. The row is
// data, not architecture: it names the provider, the seat road it rides,
// what the person hands over to plug it in, and what its "you're out"
// signal looks like. Every vocabulary that used to be hand-copied per
// provider — the vault slot map (src/runner/vault.mjs), the channel
// agent vocabulary (src/cloud/envoy-agents.mjs), the credential connect
// gate (src/cloud/credential-connect.mjs), the presence check list
// (src/cloud/runner-presence.mjs) and the web surfaces — reads these
// providers from here, so a provider added to the registry appears on
// every door at once or the door is not compiled yet (DESIGN.md §5).
//
// Rows are compiled from the catalog sweep (CATALOG.md, checked
// 2026-11-05 against each provider's own pages). checked_at +
// source_url are mandatory by the design: a free road can vanish
// between sweeps, and an entry without a check date is not shippable.
// pinned_model holds exactly one slug — a seat is one model, with
// cross-model fallback OFF (the standing identity rule).
//
// No row ever holds a credential: the plugged-in keys are the tenant's
// own, stored through the credential connect road under the row's
// vault slot name, never in this file.

const row = (r) => Object.freeze({
  ...r,
  auth: Object.freeze({ ...r.auth, fields: Object.freeze([...r.auth.fields]) }),
  runner: Object.freeze({ ...r.runner }),
  quota: Object.freeze({ ...r.quota }),
});

export const PROVIDER_REGISTRY = Object.freeze([
  row({
    id: 'groq',
    display_name: 'Groq',
    kind: 'api-key',
    status: 'live',
    free_kind: 'standing_tier',
    free_summary: 'Free plan, no card: 30 requests a minute, 1,000 requests a day on the pinned model.',
    card_required: false,
    free_ends_or_expires: null,
    data_training_caveat: null,
    source_url: 'https://console.groq.com/docs/rate-limits',
    checked_at: '2026-11-05',
    signup_url: 'https://console.groq.com',
    signup_line: 'Sign up at console.groq.com, then create a key under API Keys.',
    auth: { fields: ['api_key'], vault_slot: 'groq', vault_refs: null },
    runner: { type: 'api-runner', file: 'run-groq.mjs', base_url: 'https://api.groq.com/openai/v1', pinned_model: 'openai/gpt-oss-120b', model_env: 'RUN_GROQ_MODEL' },
    seat_flag: 'GROQ_SEAT_PROVIDERS',
    multi_account: true,
    quota: { signal: 'http_429', exhaustion_code: null, reset: 'retry-after header', bench_class: 'pause' },
  }),
  row({
    id: 'nvidia',
    display_name: 'NVIDIA',
    kind: 'api-key',
    status: 'live',
    free_kind: 'standing_tier',
    free_summary: 'Free to prototype, no per-token billing: up to 40 requests a minute across the model catalog.',
    card_required: false,
    free_ends_or_expires: null,
    data_training_caveat: null,
    source_url: 'https://build.nvidia.com',
    checked_at: '2026-11-05',
    signup_url: 'https://build.nvidia.com',
    signup_line: 'Create a free NVIDIA Developer account at build.nvidia.com, then generate an API key.',
    auth: { fields: ['api_key'], vault_slot: 'nvidia', vault_refs: null },
    runner: { type: 'api-runner', file: 'run-nvidia.mjs', base_url: 'https://integrate.api.nvidia.com/v1', pinned_model: 'nvidia/nemotron-3-super-120b-a12b', model_env: 'RUN_NVIDIA_MODEL' },
    seat_flag: 'NVIDIA_SEAT_PROVIDERS',
    multi_account: true,
    quota: { signal: 'http_429', exhaustion_code: null, reset: 'retry-after header', bench_class: 'pause' },
  }),
  row({
    id: 'cloudflare',
    display_name: 'Cloudflare',
    kind: 'api-key',
    status: 'live',
    free_kind: 'daily_allocation',
    free_summary: 'Workers AI: 10,000 Neurons free every day, resetting at midnight UTC.',
    card_required: false,
    free_ends_or_expires: null,
    data_training_caveat: null,
    source_url: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
    checked_at: '2026-11-05',
    signup_url: 'https://dash.cloudflare.com',
    signup_line: 'Create a free account at dash.cloudflare.com, open Workers AI, copy your Account ID, then create an API token with the Workers AI permission.',
    // The catalog's first multi-field auth row: the two fields compose
    // at store time into the one bundle record the runner reads —
    // {"account_id":"...","api_token":"..."} — under this one slot, so
    // no phantom 'cloudflare_account' provider ever exists downstream.
    auth: { fields: ['account_id', 'api_token'], vault_slot: 'cloudflare', vault_refs: null },
    runner: { type: 'api-runner', file: 'run-cloudflare.mjs', base_url: 'https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/v1', pinned_model: '@cf/qwen/qwen3-30b-a3b-fp8', model_env: 'RUN_CLOUDFLARE_MODEL' },
    seat_flag: 'CLOUDFLARE_SEAT_PROVIDERS',
    multi_account: true,
    quota: { signal: 'daily_window', exhaustion_code: '3036', reset: 'daily 00:00 UTC', bench_class: 'pause' },
  }),
  row({
    id: 'openrouter',
    display_name: 'OpenRouter',
    kind: 'api-key',
    status: 'live',
    free_kind: 'free_models',
    free_summary: 'Models ending in :free cost $0 per token: 20 requests a minute, 50 requests a day (1,000 a day once the account has bought $10 of credits all-time).',
    card_required: false,
    free_ends_or_expires: null,
    data_training_caveat: null,
    source_url: 'https://openrouter.ai/docs',
    checked_at: '2026-11-05',
    signup_url: 'https://openrouter.ai',
    signup_line: 'Sign up at openrouter.ai, then create a key under Keys — set a credit limit on the key.',
    auth: { fields: ['api_key'], vault_slot: 'openrouter', vault_refs: null },
    // The seat Helmian already runs pins one paid slug with cross-model
    // fallback OFF (OR-1). The catalog's `openrouter/free` router slug
    // is a seat-creation choice, never a silent default (CATALOG A4).
    runner: { type: 'api-runner', file: 'run-openrouter.mjs', base_url: 'https://openrouter.ai/api/v1', pinned_model: 'openai/gpt-4o-mini', model_env: 'RUN_OPENROUTER_MODEL' },
    seat_flag: 'OPENROUTER_SEAT_PROVIDERS',
    multi_account: true,
    quota: { signal: 'http_402', exhaustion_code: 'credit_balance_exhausted', reset: 'top up', bench_class: 'exhausted' },
  }),
  row({
    id: 'muse',
    display_name: 'Muse',
    kind: 'api-key',
    status: 'live',
    free_kind: 'paid_only',
    free_summary: 'No free tier: a Model API key is billed per token (Muse Wonder at $4 per million input tokens and $20 per million output, standard rates), or Muse runs through Muse Code, Meta\u2019s terminal agent, on its own plans from $5 a month.',
    card_required: true,
    free_ends_or_expires: null,
    data_training_caveat: null,
    source_url: 'https://dev.meta.ai/docs',
    checked_at: '2026-11-06',
    signup_url: 'https://dev.meta.ai',
    signup_line: 'Create a Meta Model API account at dev.meta.ai, then create a key under API keys.',
    auth: { fields: ['api_key'], vault_slot: 'muse', vault_refs: null },
    // The seat is wired dark (2026-11-06): the runner pins Muse Wonder
    // with cross-model fallback OFF, like every other seat but
    // OpenRouter. It lights when an owner brings a key.
    runner: { type: 'api-runner', file: 'run-muse.mjs', base_url: 'https://api.meta.ai/v1', pinned_model: 'muse-wonder-1.0', model_env: 'RUN_MUSE_MODEL' },
    seat_flag: 'MUSE_SEAT_PROVIDERS',
    multi_account: true,
    quota: { signal: 'http_402', exhaustion_code: 'credit_balance_exhausted', reset: 'top up', bench_class: 'exhausted' },
  }),
]);

const BY_ID = new Map(PROVIDER_REGISTRY.map((r) => [r.id, r]));

/** The registry row for a provider id, or null when Helmian ships no seat for it. */
export function providerRegistryRow(id) {
  return BY_ID.get(String(id ?? '').trim().toLowerCase()) ?? null;
}

/** Every registered provider id, in registry order. */
export const PROVIDER_REGISTRY_IDS = Object.freeze(PROVIDER_REGISTRY.map((r) => r.id));

/**
 * The value stored under a multi-field row's one vault slot: the two
 * (or more) intake fields composed into the single bundle record the
 * runner reads. Single-field rows store their one field's value
 * verbatim — this composition exists only where the row's auth.fields
 * names more than one field (today: cloudflare alone). Returns null
 * when any named field is missing or empty, so a half-credential can
 * never be stored.
 */
export function composeRegistryCredential(rowOrId, values = {}) {
  const r = rowOrId && typeof rowOrId === 'object' ? rowOrId : providerRegistryRow(rowOrId);
  if (!r) return null;
  const fields = r.auth?.fields ?? [];
  if (fields.length === 1) {
    const v = values?.[fields[0]];
    return typeof v === 'string' && v.length > 0 ? v : null;
  }
  const bundle = {};
  for (const f of fields) {
    const v = values?.[f];
    if (typeof v !== 'string' || v.length === 0) return null;
    bundle[f] = v;
  }
  return JSON.stringify(bundle);
}
