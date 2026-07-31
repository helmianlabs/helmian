/**
 * Local-model selection helpers retained for the schema-validated micro-task
 * runner and for regression tests of the former interactive-routing design.
 *
 * CURRENT PRODUCTION BOUNDARY
 * ---------------------------
 * The interactive agent loop does not call `resolveLocalProvider()` and its
 * local-provider dependency defaults to null. Qwen/Ollama may run narrowly
 * scoped, no-tools local jobs, but it must never answer an interactive turn or
 * become an automatic fallback for a selected cloud provider.
 *
 * WHY THIS IS NOT A FOURTH ENTRY IN `TIERS`
 * ----------------------------------------
 * `model-router.mjs` ranks fast < standard < deep — three models from the SAME
 * vendor, chosen per turn. "local" is not a cheaper vendor model, it is a
 * different endpoint on a different machine with a different failure mode (the
 * box can be off). So it is modelled as a pre-empt that runs BEFORE the tier
 * ladder: if a turn is trivial enough and safe enough, the local box answers it;
 * otherwise the existing ladder decides exactly as it always has. Adding it to
 * TIERS would also have broken the tier tables, which are keyed by vendor.
 *
 * ESCALATE-ONLY STILL HOLDS
 * ------------------------
 * Local is eligible on round 0 ONLY. If the local model answers, the turn is
 * done. If it emits a tool call, round 1 re-resolves and lands on the frontier
 * ladder — so a turn can leave local but can never come back to it mid-turn.
 * A local failure or timeout falls back to the frontier model; it never fails
 * the turn (see loop.mjs).
 *
 * MEASURED ON THIS BOX 2026-07-28 (GTX 1660 Ti, 6 GiB, driver 566.36)
 * -------------------------------------------------------------------
 * qwen3.5:4b Q4_K_M, 100% GPU (no CPU spill), 57.9 tok/s at 4096 ctx.
 * Tool behaviour over 12 adversarial trials through this very code path:
 *   5/5 valid single-hop tool calls, 0/4 spurious calls on turns needing none,
 *   3/3 sane first actions on conditional multi-step prompts.
 * NOT measured: whether it completes a multi-round chain correctly. That is
 * why local is round-0-only rather than trusted for a whole tool chain.
 * Full write-up + citations: docs/LOCAL_MODEL_ROUTING.md
 */

/** Ollama's OpenAI-compatible base. Loopback only — never bind this off-box. */
export const LOCAL_DEFAULT_URL = 'http://127.0.0.1:11434/v1';
/** Verified present on this machine 2026-07-28 (`ollama ps` → 100% GPU). */
export const LOCAL_DEFAULT_MODEL = 'qwen3.5:4b';
/**
 * A local box that has gone away must not stall a turn.
 *
 * 45s, not the 20s this started at — and it STAYS 45s now that
 * `reasoning_effort:'none'` is wired through (loop.mjs sets it for local turns
 * only). That flag roughly halves the token count, but it did NOT shorten the
 * tail: measured end to end through the real router, warm trivial turns ran
 * 2.2s–33s (median ~5s), and a cold start after the keep-alive expiry cost
 * 9–18s. A 20s timeout would abort the slow tail and force a pointless double
 * wait — 20s burned locally, then the frontier call anyway.
 *
 * The brevity instruction below has since landed and been measured, and it did
 * NOT change this: it compresses the TAIL (p90 8.1s -> 4.8s over 20 paired
 * turns) but leaves the median at ~3.1s, because a warm turn's cost is
 * dominated by PROMPT evaluation, not generation. Measured via Ollama's native
 * /api/chat, which reports the split the OpenAI-compatible endpoint hides:
 * 678 prompt tokens cost 1.86s (~364 tok/s) while a 4-token answer cost 0.05s.
 * A 3-character answer still took 2.23s end to end. So ~2.2s is a FLOOR that no
 * instruction can remove, and 45s remains the right timeout for the tail above
 * it.
 */
export const LOCAL_DEFAULT_TIMEOUT_MS = 45000;
/** Reported tier label. Deliberately NOT a member of TIERS. */
export const LOCAL_TIER = 'local';

/**
 * Longest prompt we hand to the local model.
 *
 * The server is configured for an 8192-token context, and a long prompt is
 * itself evidence the turn is not trivial. 2000 characters is roughly 500
 * tokens — comfortably inside the window even after the system prompt and
 * tool definitions are added.
 */
export const LOCAL_MAX_PROMPT_CHARS = 2000;

/**
 * HARD SAFETY CARVE-OUTS. A turn matching any of these NEVER routes local,
 * regardless of how trivial it looks.
 *
 * The reasoning is not "a 4B model would get this wrong" — it is that the cost
 * of being wrong is unbounded and unrecoverable. A mis-summarised paragraph is
 * a nuisance; a mis-executed `DROP TABLE` is not. When the blast radius is
 * irreversible, the cheaper model is never worth the saving.
 *
 * Ordered by the categories Troy named: money, credentials, deletion, deploys,
 * schema changes, and Tier-B governance.
 */
/**
 * NOTE ON `.env`: it is matched OUTSIDE the `\b(...)\b` wrapper on purpose.
 * Inside it, the leading `\b` can never match — in "read the .env" the
 * character before `.` is a space, and space→`.` is not a word boundary
 * (neither is a word character), so the alternative was dead and a request to
 * read the .env file routed to the local model. Caught by the deny-list test
 * in test/local-routing.test.mjs, not by inspection.
 */
export const LOCAL_SAFETY_DENY = new RegExp(
  '(?:\\.env\\b|\\b('
  // money
  + 'payment|invoice|billing|refund|charge(?:d|s)?|payout|stripe|paypal|'
  + 'credit ?card|bank|wire transfer|purchase|subscription|price|pricing|'
  // credentials / secrets
  + 'password|passphrase|api[ _-]?key|secret|token|credential|private key|'
  + 'ssh key|auth|oauth|login|signin|sign-in|rotate the key|'
  // deletion / destruction
  + 'delete|deleting|drop|truncate|purge|wipe|destroy|erase|rm -rf|'
  + 'force[ -]?push|hard reset|revert|rollback|'
  // deploys / release
  + 'deploy|deployment|publish|release|ship it|production|prod\\b|'
  + 'fly deploy|vercel|go live|cutover|'
  // schema / migrations
  + 'migration|migrate|alter table|create table|schema change|ddl|'
  // governance
  + 'tier[ -]?b|governance|consensus|advisory|approval|authorize|authorise'
  + ')\\b)',
  'i',
);

/**
 * Turns that look trivial but are load-bearing, so they stay on the frontier.
 * "Continue" resumes work already in flight — the words are short, the work is
 * not. This mirrors CONTINUATION in model-router.mjs, which routes these to
 * standard rather than fast for the same reason.
 */
export const LOCAL_CONTINUATION_DENY =
  /^\s*(continue|carry on|keep going|go on|resume|proceed|next|and\?|go ahead)\b/i;

/** Truthy env flags, tolerant of the shapes people actually type. */
function envFlag(value, whenMissing) {
  if (value === undefined || value === null || String(value).trim() === '') return whenMissing;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

/**
 * Build the local provider descriptor from env, or null when local is off.
 *
 * Shape matches what `resolveProvider` returns for a custom endpoint, so it
 * flows through the EXISTING custom path: providers.mjs routes providerId
 * 'custom' to openAiCompatibleTurn (providers.mjs:57-69). No parallel path.
 *
 * `key` is the same 'no-key-required' placeholder env.mjs uses, so the
 * "no API key configured" guard in chatWithTools does not reject a local
 * runtime that legitimately has no key.
 */
/**
 * OPT-IN, NOT OPT-OUT. This defaults to OFF deliberately.
 *
 * The first cut defaulted to ON, and three existing bridge tests started
 * failing: Ollama was listening on this machine, so their trivial turns were
 * silently answered by the local box instead of the endpoint under test. That
 * is the whole problem in miniature — with a default of ON, ANY machine that
 * happens to have something on port 11434 quietly gets its turns rerouted to
 * whatever model is loaded there, with no one having asked for it. Cost is a
 * good reason to route local; it is not a good enough reason to change where
 * someone's prompts go without them saying so.
 *
 * Turn it on with HELMION_LOCAL_ENABLED=1.
 */
export function resolveLocalProvider(env = process.env) {
  if (!envFlag(env.HELMION_LOCAL_ENABLED, false)) return null;
  const url = String(env.HELMION_LOCAL_URL || LOCAL_DEFAULT_URL).trim();
  const model = String(env.HELMION_LOCAL_MODEL || LOCAL_DEFAULT_MODEL).trim();
  if (!url || !model) return null;
  const timeoutRaw = Number(env.HELMION_LOCAL_TIMEOUT_MS);
  return {
    id: 'custom',
    key: 'no-key-required',
    apiKey: '',
    label: `local:${model}`,
    baseUrl: url,
    url: /\/chat\/completions$/i.test(url) ? url : `${url.replace(/\/+$/, '')}/chat/completions`,
    model,
    models: null,
    isLocal: true,
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.floor(timeoutRaw)
      : LOCAL_DEFAULT_TIMEOUT_MS,
  };
}

/**
 * THE CRITERIA. Pure — same inputs, same answer, no I/O and no clock, so every
 * boundary below is unit-testable.
 *
 * A turn routes local when ALL of these hold:
 *   1. a local provider is configured;
 *   2. it is round 0 (never mid-chain — escalate-only);
 *   3. the frontier ladder classified the turn 'fast' (its own trivial signal:
 *      no code shapes, no root-cause language, short, few messages);
 *   4. the user did not pin a tier or a model — an explicit human choice wins;
 *   5. the prompt is under LOCAL_MAX_PROMPT_CHARS;
 *   6. it does not match LOCAL_SAFETY_DENY;
 *   7. it does not match LOCAL_CONTINUATION_DENY.
 *
 * Condition 3 is what makes this defensible rather than a guess: 'fast' is
 * already the router's measured "nothing to reason about" bucket, and the
 * research on 4B-class models says exactly that bucket — classification,
 * summarization, extraction, formatting, short Q&A — is where they are
 * reliable, while multi-step reasoning and long-horizon tool chains are not.
 *
 * @returns {{local: boolean, reason: string}}
 */
export function classifyLocalEligibility({
  tier,
  userText = '',
  roundsUsedThisTurn = 0,
  localProvider = null,
  explicitTier = null,
  modelOverride = null,
} = {}) {
  if (!localProvider) {
    return { local: false, reason: 'no local provider configured' };
  }
  if (roundsUsedThisTurn > 0) {
    return { local: false, reason: `round ${roundsUsedThisTurn} — local is round-0 only` };
  }
  if (typeof modelOverride === 'string' && modelOverride.trim()) {
    return { local: false, reason: 'explicit --model pins the frontier model' };
  }
  if (typeof explicitTier === 'string' && explicitTier.trim()) {
    return { local: false, reason: 'explicit --tier overrides local routing' };
  }
  if (tier !== 'fast') {
    return { local: false, reason: `tier ${tier} is above the local ceiling` };
  }

  const text = typeof userText === 'string' ? userText : '';
  const trimmed = text.trim();
  if (trimmed.length > LOCAL_MAX_PROMPT_CHARS) {
    return { local: false, reason: `prompt ${trimmed.length} chars exceeds local cap` };
  }
  if (LOCAL_CONTINUATION_DENY.test(trimmed)) {
    return { local: false, reason: 'continuation of work already in flight' };
  }
  if (LOCAL_SAFETY_DENY.test(trimmed)) {
    return { local: false, reason: 'safety carve-out (money/credentials/deletion/deploy/schema/governance)' };
  }
  return { local: true, reason: 'trivial turn, no safety signals — local model' };
}

/**
 * Brevity instruction applied to LOCAL turns only.
 *
 * WHY THIS EXISTS. Once `reasoning_effort:'none'` removed the hidden reasoning
 * trace, the remaining latency turned out to be plain output length: at ~57
 * tok/s a 2,908-character answer takes 33 s to emit, and under Helmion's agent
 * system prompt qwen3.5:4b writes long — note the existing prompt already says
 * "Be concise in final answers" (providers.mjs:38) and that is not enough.
 *
 * WHAT IT ACTUALLY BOUGHT, MEASURED — not what it was predicted to buy. Over 20
 * paired turns through the real router (each prompt run both ways, arm order
 * alternated so neither side wins on prompt-cache): median 3.27s -> 3.12s, p90
 * 8.14s -> 4.82s, max 9.79s -> 7.70s, mean answer 680 -> 460 chars. So this is
 * a TAIL fix, not a median fix. The median barely moves because ~2.2s of a warm
 * turn is prompt evaluation (see LOCAL_DEFAULT_TIMEOUT_MS above) and this text
 * is itself ~83 prompt tokens, costing ~0.23s of that floor on every local turn.
 * It earns its place on the tail alone.
 *
 * THE WORDING WAS A/B-TESTED, not guessed. A terser 87-char variant was measured
 * against this 385-char one on the same 10 prompts: the terser one had a
 * marginally better median (3.13s vs 3.24s, inside the noise) but a WORSE tail
 * (max 4.41s vs 3.75s) and longer answers (mean 349 vs 294 chars). Since the
 * tail is the entire reason this exists, the longer wording stayed.
 *
 * WHY AN INSTRUCTION AND NOT A TOKEN CAP. A `max_tokens` backstop that severs
 * an answer mid-sentence is worse than a slow complete one — a reader cannot
 * tell a truncated answer from a wrong one. So no token cap is set anywhere on
 * this path: the model is asked to be brief and is always allowed to finish.
 * The only backstop is LOCAL_DEFAULT_TIMEOUT_MS, and when that trips the turn
 * falls back to the frontier and is answered in full — never truncated.
 *
 * Local only ever serves turns the router already classified trivial, so
 * "answer briefly" is the right register for this bucket, not a degradation.
 */
export const LOCAL_BREVITY_INSTRUCTION = [
  'BREVITY (local model): answer in at most three sentences.',
  'Give the answer directly. No preamble, no restating the question, no',
  'background, no caveats, and no examples unless asked. Do not use headings or',
  'bullet lists unless the user explicitly asks for a list.',
  'If a question cannot be answered well in three sentences, say so in one',
  'sentence and stop rather than writing a long answer.',
].join(' ');

/**
 * The message list to send for a local turn: the same conversation with the
 * brevity instruction folded into the system prompt.
 *
 * PURE. Returns a NEW array and never mutates the input or any message object
 * inside it. That matters more than it looks — `messages` is the live
 * conversation history loop.mjs keeps appending to across rounds, and it is
 * handed to the FRONTIER model on every later round. Mutating it here would
 * leak "be brief" into frontier turns permanently, which is exactly the
 * byte-identical guarantee this feature must not break.
 *
 * Folded into the FIRST system message rather than appended as a trailing one,
 * because a chat template is only guaranteed to honour the system slot; an
 * extra system message at the tail is template-dependent. When a conversation
 * has no system message at all, one is prepended.
 */
export function withLocalBrevity(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const idx = list.findIndex((m) => m && m.role === 'system');
  if (idx === -1) {
    return [{ role: 'system', content: LOCAL_BREVITY_INSTRUCTION }, ...list];
  }
  const copy = list.slice();
  const original = copy[idx];
  copy[idx] = {
    ...original,
    content: `${original.content || ''}\n\n${LOCAL_BREVITY_INSTRUCTION}`,
  };
  return copy;
}

/**
 * SEAM for the four always-on local jobs (triage, commit-message generation,
 * log monitoring, dictation summarization). DEFINED HERE, BUILT ELSEWHERE —
 * a follow-up agent implements the jobs against this contract.
 *
 * These jobs do NOT go through classifyLocalEligibility. That function decides
 * whether an INTERACTIVE turn may be downgraded; a background job has already
 * decided it wants the local model, and has no frontier turn to protect. What
 * they share is the endpoint and the safety deny-list.
 *
 * Contract a job implementation must honour:
 *   - name:      stable id, used in logs.
 *   - input:     a string. Callers truncate to LOCAL_MAX_PROMPT_CHARS or chunk.
 *   - system:    a task-specific system prompt.
 *   - It MUST call resolveLocalProvider() and no-op (not throw) when it is null,
 *     so a machine without Ollama degrades to "feature off", never to a crash.
 *   - It MUST pass an AbortSignal built from provider.timeoutMs.
 *   - It MUST NOT be given tools. These are text-in/text-out jobs; the measured
 *     tool reliability above was for interactive turns, not unattended ones.
 *   - It MUST refuse input matching LOCAL_SAFETY_DENY — a log line containing a
 *     credential must not be shipped to a model just because it is local.
 *
 * @typedef {{name: string, system: string, input: string}} LocalJobRequest
 * @typedef {{ok: boolean, text: string, skippedReason?: string}} LocalJobResult
 */
export const LOCAL_JOB_CONTRACT = Object.freeze({
  version: 1,
  jobs: Object.freeze(['triage', 'commit-message', 'log-monitor', 'dictation-summary']),
  maxInputChars: LOCAL_MAX_PROMPT_CHARS,
  toolsAllowed: false,
  denyPattern: LOCAL_SAFETY_DENY,
});
