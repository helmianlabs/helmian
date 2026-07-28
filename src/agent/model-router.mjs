/**
 * Per-task model auto-switcher.
 *
 * Pure and deterministic: same inputs → same tier, every time. No I/O, no clock,
 * no process.env reads (the caller resolves env and passes it in), so the whole
 * thing is unit-testable without a network or a provider key.
 *
 * Three tiers, one job each:
 *   fast     — trivial conversational turns, acknowledgements, status checks
 *   standard — ordinary coding work: read a file, edit it, run a check
 *   deep     — hard reasoning: root-cause hunts, architecture, long specs,
 *              or a turn that has already burned a lot of tool rounds
 *
 * Model IDs below were verified against vendor documentation on 2026-07-28.
 * Every table entry cites the page it came from. When a provider has no
 * verifiable distinct model for a tier, the tier reuses a neighbouring model
 * rather than inventing an ID that would 404 at runtime.
 */

/** Ordered cheapest → most capable. Index doubles as the escalation rank. */
export const TIERS = ['fast', 'standard', 'deep'];

const TIER_RANK = { fast: 0, standard: 1, deep: 2 };

/**
 * Tier tables — the single source of truth for which model serves which tier.
 *
 * openai — https://developers.openai.com/api/docs/models and .../docs/pricing
 *   The GPT-5.6 family covers all three tiers on its own:
 *   luna  "cost-sensitive, high-volume workloads"      ($1.00 in)
 *   terra "balance intelligence and cost"              ($1.25 in / $7.50 out)
 *   sol   "frontier model for complex professional work" ($5.00 in / $30.00 out)
 *
 * anthropic — https://platform.claude.com/docs/en/about-claude/models/overview
 *   claude-haiku-4-5  $1 in / $5 out   (200K context)
 *   claude-sonnet-5   $3 in / $15 out  (1M context)
 *   claude-opus-5     $5 in / $25 out  (1M context)
 *   claude-fable-5 ($10/$50) is deliberately NOT wired to a tier: the vendor
 *   docs class it as above Opus-tier and not the default upgrade path, so it is
 *   opt-in via --model only, never auto-selected.
 *   Aliases are used, not dated snapshots — the docs state the alias strings are
 *   complete as-is and warn against appending date suffixes.
 *
 * gemini — https://ai.google.dev/gemini-api/docs/models and .../docs/pricing
 *   gemini-2.5-flash-lite  cheapest of the stable 2.5 line
 *   gemini-2.5-flash       $0.30 in / $2.50 out
 *   gemini-2.5-pro         $1.25 in / $10 out
 *   The 3.x line exists, but its only Pro-tier entry (gemini-3.1-pro-preview)
 *   is marked Preview. Pinning a preview ID into a default path is how you get
 *   a 404 the week it graduates, so the stable 2.5 family is used throughout.
 *
 * xai — https://docs.x.ai/docs/models
 *   grok-4.3  1M context, the cheaper current model  ($1.25 in / $2.50 out)
 *   grok-4.5  500K context, "the most intelligent and fastest model we've
 *             built"                                  ($2.00 in / $6.00 out)
 *   xAI publishes no mini/fast SKU, so fast and standard share grok-4.3. The
 *   dated grok-4.20-0309-* snapshots are priced identically to grok-4.3 and are
 *   not pinned here — a dated snapshot is a retirement waiting to happen.
 */
export const PROVIDER_TIER_MODELS = {
  openai: {
    fast: 'gpt-5.6-luna',
    standard: 'gpt-5.6-terra',
    deep: 'gpt-5.6-sol',
  },
  anthropic: {
    fast: 'claude-haiku-4-5',
    standard: 'claude-sonnet-5',
    deep: 'claude-opus-5',
  },
  gemini: {
    fast: 'gemini-2.5-flash-lite',
    standard: 'gemini-2.5-flash',
    deep: 'gemini-2.5-pro',
  },
  xai: {
    fast: 'grok-4.3',
    standard: 'grok-4.3',
    deep: 'grok-4.5',
  },
};

/** Prompt length (characters) at or above which a turn is treated as deep. */
const DEEP_LENGTH = 600;
/** Prompt length at or above which a turn is at least standard. */
const STANDARD_LENGTH = 160;
/** Tool rounds burned this turn before the turn is escalated to deep. */
const DEEP_ROUNDS = 8;
/** Same, when the runtime is read-only — those rounds are cheap reads. */
const DEEP_ROUNDS_READ_ONLY = 12;
/** Conversation length (messages) at or above which a turn is at least standard. */
const STANDARD_HISTORY = 12;

/** Hard-reasoning language: root-cause hunts, design work, explicit "think". */
const DEEP_LANGUAGE = new RegExp(
  '\\b('
  + 'root cause|why (?:does|do|is|are|did|would)|'
  + 'race condition|deadlock|memory leak|livelock|heisenbug|'
  + 'architect|architecture|design the|system design|trade-?offs?|'
  + 'think (?:hard|harder|deeply|carefully|through)|ultrathink|reason through|'
  + 'debug|diagnose|investigate|troubleshoot|'
  + 'performance regression|security (?:audit|review)|threat model|'
  + 'prove|derive|from first principles'
  + ')\\b',
  'i',
);

/** Ordinary coding work: files, tests, builds, edits. */
const STANDARD_LANGUAGE = new RegExp(
  '\\b('
  + 'refactor|implement|rewrite|migrate|port|scaffold|'
  + 'fix|bug|patch|repair|'
  + 'add|create|write|update|edit|delete|remove|rename|'
  + 'test|tests|spec|typecheck|lint|build|compile|'
  + 'function|method|class|module|component|endpoint|route|schema|'
  + 'file|files|directory|folder|repo|repository|'
  + 'npm|yarn|pnpm|node|git|commit|branch|merge|'
  + 'stack trace|exception|error|traceback|'
  + 'install|dependency|package'
  + ')\\b',
  'i',
);

/** A fenced code block or an inline path/extension is coding work by itself. */
const CODE_SHAPE = /```|\b[\w.-]+\/[\w.-]+|\.(?:m?[jt]sx?|py|cs|go|rs|rb|java|json|ya?ml|md|sql|ps1|sh|toml|ini|xml|html|css)\b/i;

/** Pure acknowledgements and status pings — nothing to reason about. */
const FAST_LANGUAGE = new RegExp(
  '^\\s*('
  + 'hi|hey|hello|yo|sup|'
  + 'thanks|thank you|ty|cheers|'
  + 'ok|okay|k|got it|gotcha|understood|makes sense|'
  + 'cool|nice|great|perfect|awesome|'
  + 'yes|yeah|yep|yup|no|nope|nah|sure|'
  + 'status|ping|are you there'
  + ')\\b[\\s.!?]*$',
  'i',
);

/**
 * "Keep going" resumes work already in flight. These must never fall to fast
 * just because the words are short — the work behind them is not.
 */
const CONTINUATION = /^\s*(continue|carry on|keep going|go on|resume|proceed|next|and\?|go ahead)\b[\s.!?]*$/i;

/** Normalize an arbitrary value to a known tier, or null. */
export function normalizeTier(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim().toLowerCase();
  return TIERS.includes(t) ? t : null;
}

/**
 * Read the HELMION_MODEL_TIER env override.
 * 'auto' (or unset, or anything unrecognized) means "let the router decide".
 */
export function readEnvTier(env = process.env) {
  const raw = (env?.HELMION_MODEL_TIER || '').trim().toLowerCase();
  if (!raw || raw === 'auto') return null;
  return normalizeTier(raw);
}

/** The more capable of two tiers. Used to enforce escalate-only. */
export function maxTier(a, b) {
  const left = normalizeTier(a);
  const right = normalizeTier(b);
  if (!left) return right;
  if (!right) return left;
  return TIER_RANK[left] >= TIER_RANK[right] ? left : right;
}

/**
 * Classify a single model call.
 *
 * @param {object} input
 * @param {string}  input.userText            the user's message for this turn
 * @param {string}  [input.permissionMode]    'read-only' | 'full' | …
 * @param {number}  [input.roundsUsedThisTurn] tool rounds already spent
 * @param {number}  [input.historyLength]     messages in the conversation
 * @param {string}  [input.explicitTier]      CLI/bridge tier override
 * @param {string}  [input.envTier]           HELMION_MODEL_TIER, already parsed
 * @param {string}  [input.floorTier]         tier already used this turn
 * @returns {{tier: string, reason: string}}
 */
export function classifyTier({
  userText = '',
  permissionMode = 'full',
  roundsUsedThisTurn = 0,
  historyLength = 0,
  explicitTier = null,
  envTier = null,
  floorTier = null,
} = {}) {
  // Override chain. An explicit tier is a decision the user already made, so it
  // wins outright — including over the escalate-only floor, which exists to stop
  // the ROUTER from flip-flopping, not to overrule a human.
  const explicit = normalizeTier(explicitTier);
  if (explicit) {
    return { tier: explicit, reason: `explicit --tier ${explicit}` };
  }
  const fromEnv = normalizeTier(envTier);
  if (fromEnv) {
    return { tier: fromEnv, reason: `HELMION_MODEL_TIER=${fromEnv}` };
  }

  const { tier, reason } = classifyFromHeuristics({
    userText,
    permissionMode,
    roundsUsedThisTurn,
    historyLength,
  });

  // Escalate-only: once a turn has been answered by a deeper model, every later
  // round in that same turn stays at least that deep. Dropping mid-turn would
  // hand a half-finished reasoning chain to a weaker model.
  const floor = normalizeTier(floorTier);
  if (floor && TIER_RANK[floor] > TIER_RANK[tier]) {
    return { tier: floor, reason: `held at ${floor} (escalate-only; would have been ${tier})` };
  }
  return { tier, reason };
}

function classifyFromHeuristics({ userText, permissionMode, roundsUsedThisTurn, historyLength }) {
  const text = typeof userText === 'string' ? userText : '';
  const trimmed = text.trim();
  const readOnly = String(permissionMode || '').toLowerCase() === 'read-only';
  const roundCap = readOnly ? DEEP_ROUNDS_READ_ONLY : DEEP_ROUNDS;
  const rounds = Number.isFinite(roundsUsedThisTurn) ? roundsUsedThisTurn : 0;
  const history = Number.isFinite(historyLength) ? historyLength : 0;

  // --- deep ---------------------------------------------------------------
  if (rounds >= roundCap) {
    return {
      tier: 'deep',
      reason: `${rounds} tool rounds spent this turn (cap ${roundCap})`,
    };
  }
  if (DEEP_LANGUAGE.test(trimmed)) {
    return { tier: 'deep', reason: 'prompt asks for root-cause or design reasoning' };
  }
  if (trimmed.length >= DEEP_LENGTH) {
    return { tier: 'deep', reason: `long prompt (${trimmed.length} chars)` };
  }

  // --- standard -----------------------------------------------------------
  if (CONTINUATION.test(trimmed)) {
    return { tier: 'standard', reason: 'continuation of work already in flight' };
  }
  if (STANDARD_LANGUAGE.test(trimmed) || CODE_SHAPE.test(trimmed)) {
    return { tier: 'standard', reason: 'prompt describes code or tool work' };
  }
  if (trimmed.length >= STANDARD_LENGTH) {
    return { tier: 'standard', reason: `prompt length ${trimmed.length} chars` };
  }
  if (history >= STANDARD_HISTORY) {
    return { tier: 'standard', reason: `conversation has ${history} messages` };
  }

  // --- fast ---------------------------------------------------------------
  if (FAST_LANGUAGE.test(trimmed)) {
    return { tier: 'fast', reason: 'short conversational turn' };
  }
  if (!trimmed) {
    return { tier: 'fast', reason: 'empty prompt' };
  }
  return { tier: 'fast', reason: `short prompt (${trimmed.length} chars), no code signals` };
}

/**
 * Map a provider + tier to a concrete model id.
 *
 * Custom OpenAI-compatible profiles: if the profile declares `models`, the tier
 * table applies (falling back to the profile's single Model for any tier it
 * left out). A profile with one model keeps that model on every tier — a local
 * Ollama box that only has qwen loaded must never be handed "gpt-5.6-sol".
 *
 * @returns {{model: string|null, source: string}}
 */
export function modelForTier(provider, tier) {
  const wanted = normalizeTier(tier) || 'standard';

  if (provider?.id === 'custom') {
    const declared = provider.models && typeof provider.models === 'object'
      ? provider.models[wanted]
      : null;
    if (typeof declared === 'string' && declared.trim()) {
      return { model: declared.trim(), source: `custom profile models.${wanted}` };
    }
    const single = typeof provider.model === 'string' ? provider.model.trim() : '';
    return {
      model: single || null,
      source: single ? 'custom profile model (no tiers declared)' : 'custom profile (no model)',
    };
  }

  const table = PROVIDER_TIER_MODELS[provider?.id];
  if (!table) {
    // Unknown provider: hand back nothing and let chatWithTools apply its own
    // default rather than guessing an id that will 404.
    return { model: null, source: `no tier table for provider ${provider?.id}` };
  }
  return { model: table[wanted], source: `${provider.id} ${wanted} tier` };
}

/**
 * One call per model request: classify, then resolve to a model id.
 *
 * `modelOverride` (CLI --model) pins an exact model string and skips the router
 * entirely — it is the top of the override chain.
 *
 * @returns {{model: string|null, tier: string, reason: string, source: string}}
 */
export function resolveTurnModel({
  provider,
  userText = '',
  permissionMode = 'full',
  roundsUsedThisTurn = 0,
  historyLength = 0,
  explicitTier = null,
  envTier = null,
  floorTier = null,
  modelOverride = null,
} = {}) {
  const pinned = typeof modelOverride === 'string' ? modelOverride.trim() : '';
  if (pinned) {
    // A pinned model still reports a tier so the UI has something to show, but
    // the tier is descriptive here, not the thing that chose the model.
    const tier = normalizeTier(explicitTier) || normalizeTier(floorTier) || 'standard';
    return {
      model: pinned,
      tier,
      reason: `explicit --model ${pinned}`,
      source: 'explicit --model',
    };
  }

  const { tier, reason } = classifyTier({
    userText,
    permissionMode,
    roundsUsedThisTurn,
    historyLength,
    explicitTier,
    envTier,
    floorTier,
  });
  const { model, source } = modelForTier(provider, tier);
  return { model, tier, reason, source };
}
