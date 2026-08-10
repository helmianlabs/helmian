import {
  chatWithTools,
  systemPrompt,
  toHistoryAssistant,
  toHistoryToolResults,
} from './providers.mjs';
import { createToolRuntime, CANCELLED_TOOL_MESSAGE } from './tools.mjs';
import { redactSecrets } from './redact.mjs';
import { readEnvTier, resolveTurnModel } from './model-router.mjs';
import { withLocalBrevity } from './local-provider.mjs';
import { processSessionId } from '../core/provenance-log.mjs';

/** Default cap for tool↔model rounds per user message (was 12; too low for real coding). */
export const MAX_TOOL_ROUNDS_DEFAULT = 48;

/**
 * Resolve max tool rounds: explicit option → HELMION_MAX_TOOL_ROUNDS env → default.
 * Clamped to a sane range so a bad env cannot hang forever.
 */
export function resolveMaxToolRounds(override) {
  const raw = override
    ?? process.env.HELMION_MAX_TOOL_ROUNDS
    ?? MAX_TOOL_ROUNDS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return MAX_TOOL_ROUNDS_DEFAULT;
  return Math.min(Math.floor(n), 200);
}

/** @deprecated use resolveMaxToolRounds() — kept for importers that expect a number. */
export const MAX_TOOL_ROUNDS = MAX_TOOL_ROUNDS_DEFAULT;

/**
 * The error a cancelled turn throws.
 *
 * `name === 'AbortError'` on purpose: that is what `fetch` throws when its own
 * signal fires, so a caller that wants to know "was this cancelled, or did it
 * genuinely fail" gets ONE answer for both the model call dying and the loop
 * refusing to continue. Two different shapes would mean every caller has to
 * remember both, and the one that forgets reports a user-requested stop as a
 * crash.
 */
export function abortError(message = 'The turn was cancelled.') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/** True for our own cancels AND for the DOMException fetch raises on abort. */
export function isAbortError(err) {
  return err?.name === 'AbortError';
}

/**
 * One signal from several, so a local-model timeout and a user cancel can both
 * kill the same request.
 *
 * `AbortSignal.any` landed in Node 20.3; this falls back rather than assuming
 * it, because a missing static would throw at call time — inside the turn, on
 * the machine where it is least welcome.
 */
export function combineSignals(...signals) {
  const live = signals.filter(Boolean);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(live);
  const controller = new AbortController();
  for (const s of live) {
    if (s.aborted) { controller.abort(s.reason); break; }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

/**
 * Shared multi-round tool loop used by CLI REPL and the Windows EXE bridge.
 * onEvent({ type, ... }) receives progress for the UI.
 */
export async function runAgentTurn({
  userText,
  messages,
  provider,
  runtime,
  onEvent = () => {},
  maxToolRounds,
  // Override chain, highest first: modelOverride (--model) > tier (--tier) >
  // HELMION_MODEL_TIER > the router's own classification.
  tier: explicitTier = null,
  modelOverride = null,
  images = [],
  envTier = readEnvTier(),
  // Interactive replies fail closed to the selected provider. Local Qwen is
  // reserved for the schema-validated, no-tools micro-task runner under
  // src/jobs/local-job.mjs; HELMION_LOCAL_ENABLED must never make it speak as
  // a selected cloud provider merely because an Ollama process is available.
  //
  // Tests may still inject a localProvider to exercise the legacy routing and
  // provenance machinery, but no production caller supplies one.
  localProvider = null,
  // Groups this turn's provenance rows with the rest of its conversation. The
  // default identifies the running agent process, which IS the session for both
  // callers: the bridge is one process per app run (bridge.mjs) and the CLI REPL
  // is one process per sitting. Passed explicitly by anything that knows better.
  sessionId = processSessionId(),
  // A REAL kill switch for this turn. Default `null` is byte-for-byte today's
  // behaviour: no signal reaches fetch, no abort check ever fires true, and the
  // loop runs exactly as it did before. When a caller does pass one, aborting it
  // stops the in-flight model call, stops any running child process, and stops
  // the loop from starting anything new — see the three checks below.
  signal = null,
}) {
  const toolDefs = runtime.definitionsForOpenAi();
  const limit = resolveMaxToolRounds(maxToolRounds);
  // Before the prompt is even recorded. A turn cancelled while it sat queued
  // never happened, and appending its user message would leave the history
  // carrying a question nothing ever answered.
  if (signal?.aborted) throw abortError('Cancelled before the turn started.');
  messages.push({ role: 'user', content: userText });

  // Escalate-only within this turn: never hand a partially-reasoned turn back
  // to a weaker model than one that has already worked on it.
  let floorTier = null;

  const pickModel = (roundsUsedThisTurn, { allowLocal = true } = {}) => {
    const choice = resolveTurnModel({
      provider,
      userText,
      permissionMode: runtime.permissionMode,
      roundsUsedThisTurn,
      historyLength: messages.length,
      explicitTier,
      envTier,
      floorTier,
      modelOverride,
      localProvider: allowLocal ? localProvider : null,
    });
    // 'local' must never become the escalate-only floor. The floor exists to
    // stop a turn dropping to a WEAKER model, and local is the weakest thing
    // here — recording it would pin the rest of the turn at the bottom.
    if (!choice.isLocal) floorTier = choice.tier;
    return choice;
  };

  // One call against whichever provider the router chose for this round. Local
  // calls carry a timeout so an Ollama box that has wedged cannot hang the turn.
  const callProvider = (choice, round) => {
    const active = choice.provider || provider;
    return chatWithTools({
      providerId: active.id,
      apiKey: active.key,
      // Context for the provenance ledger. NOT the record itself — the record is
      // written inside chatWithTools once the response has arrived, so that a
      // fallback cannot leave a row naming the model that failed. What travels
      // here is only what that write site cannot see for itself: which workspace
      // the turn belongs to, and what the router was thinking.
      provenance: {
        // The workspace the turn actually ran against. The bridge changes this
        // per turn (bridge.mjs:322-325) while the node process's cwd never
        // moves, so the evidence has to follow the runtime, not the process.
        workspace: runtime?.root,
        sessionId,
        providerLabel: active.label,
        tier: choice.tier,
        reason: choice.reason,
        round,
        routedLocal: Boolean(choice.isLocal),
      },
      // Custom OpenAI-compatible endpoints carry their own URL + model id.
      url: active.url,
      model: choice.model,
      // Local turns get a brevity instruction folded into a COPY of the
      // history; a frontier turn is handed the exact same array it always was.
      // withLocalBrevity never mutates, so nothing leaks back into `messages`.
      messages: choice.isLocal ? withLocalBrevity(messages) : messages,
      toolDefs,
      // ONLY the local endpoint. qwen3.5:4b is a reasoning model; without this a
      // short conversational turn burns ~2,603 tokens over ~40 s to say one
      // sentence, and 30 tokens in 0.9 s with it. Deliberately keyed off the
      // routing decision, NOT providerId 'custom' — a user-supplied LM Studio /
      // vLLM / DeepSeek endpoint is also 'custom' and was never tested here.
      reasoningEffortNone: Boolean(choice.isLocal),
      images: round === 0 ? images : [],
      // BOTH reasons a request should die: the local box wedged, or the user
      // said stop. Previously only the first existed, so a cancel could not
      // reach the HTTP request that was actually burning the time.
      signal: combineSignals(
        signal,
        choice.isLocal && active.timeoutMs ? AbortSignal.timeout(active.timeoutMs) : null,
      ),
    });
  };

  /**
   * What the ledger RECORDED, announced after the fact.
   *
   * `announce` below fires BEFORE the request goes out, so it can only ever
   * report an intention — and on 2026-07-30 an intention is exactly what was on
   * screen while a different model did the answering. This event carries the row
   * that was actually written, so a UI showing it is showing evidence.
   *
   * A recording failure is announced too. "The model answered but nothing
   * recorded which one" has to be visible; it is the state this whole feature
   * exists to make impossible to reach silently.
   */
  const announceProvenance = (reply, round) => {
    const written = reply?.provenance;
    if (!written) return;
    if (!written.logged) {
      onEvent({
        type: 'status',
        message: `answer received but its provenance was NOT recorded — ${written.reason}`,
      });
      return;
    }
    const entry = written.entry;
    onEvent({
      type: 'provenance',
      provider: entry.provider,
      providerId: entry.providerId,
      providerLabel: entry.providerLabel ?? null,
      model: entry.model,
      endpointHost: entry.endpointHost,
      isLocal: entry.isLocal,
      tier: entry.tier ?? null,
      timestamp: entry.timestamp,
      sessionId: entry.sessionId,
      round,
      file: written.file,
    });
  };

  const announce = (choice, round) => {
    const active = choice.provider || provider;
    onEvent({
      type: 'model',
      provider: active.label,
      providerId: active.id,
      model: choice.model,
      tier: choice.tier,
      reason: choice.reason,
      round,
      isLocal: Boolean(choice.isLocal),
    });
    onEvent({
      type: 'status',
      message: round === 0
        ? `${active.label} thinking… (${choice.tier} · ${choice.model || 'provider default'})`
        : `${active.label} tool round ${round}/${limit}… (${choice.tier} · ${choice.model || 'provider default'})`,
    });
  };

  for (let round = 0; round < limit; round += 1) {
    // Checked at the top of EVERY round, not once before the loop. A cancel
    // that lands while round 3 is running has to stop round 4 from starting.
    if (signal?.aborted) {
      onEvent({ type: 'cancelled', reason: 'before the model call', round });
      throw abortError('Cancelled before the model call.');
    }
    let choice = pickModel(round);
    announce(choice, round);

    let reply;
    try {
      reply = await callProvider(choice, round);
    } catch (err) {
      // A CANCEL IS NOT A LOCAL FAILURE. Without this line, aborting during a
      // local call lands in the fallback below and immediately fires a fresh
      // request at the frontier provider — the user says "stop" and Helmion
      // answers by starting a second, more expensive call.
      if (isAbortError(err)) {
        onEvent({ type: 'cancelled', reason: 'the model call was aborted', round });
        throw err;
      }
      // A local failure must never fail the turn. Anything else propagates.
      // Nothing was recorded for the failed attempt, and that is correct: no
      // completion arrived, so no model answered.
      if (!choice.isLocal) throw err;
      onEvent({
        type: 'status',
        message: `local model unavailable (${err.message}) — falling back to ${provider.label}`,
      });
      choice = pickModel(round, { allowLocal: false });
      announce(choice, round);
      reply = await callProvider(choice, round);
    }
    // After the reply, never before: this reports the row on disk.
    announceProvenance(reply, round);

    if (!reply.toolCalls?.length) {
      // Redact secrets from final assistant response before showing to user
      const text = redactSecrets((reply.content || '').trim()) || '(empty response)';
      messages.push({ role: 'assistant', content: text });
      onEvent({ type: 'assistant', text });
      onEvent({ type: 'done' });
      return { text, messages };
    }

    if (reply.content?.trim()) {
      // Redact secrets from partial assistant responses
      const redactedPartial = redactSecrets(reply.content.trim());
      onEvent({ type: 'assistant_partial', text: redactedPartial });
    }

    messages.push(toHistoryAssistant(reply));
    const results = [];
    let cancelledInTools = false;
    for (const tc of reply.toolCalls) {
      if (signal?.aborted) {
        // Every remaining call STILL NEEDS A RESULT ROW. An assistant message
        // carrying tool_calls with no matching tool results is a malformed
        // history that Anthropic and OpenAI both reject outright on the next
        // request — so bailing out of this loop early would leave the
        // conversation unusable, and a cancel would break the very session it
        // was supposed to leave resumable.
        cancelledInTools = true;
        results.push(CANCELLED_TOOL_MESSAGE);
        continue;
      }
      onEvent({
        type: 'tool',
        name: tc.name,
        args: tc.arguments || {},
      });
      // The signal goes INTO the tool. This is the line that makes a cancel
      // reach a running child process rather than merely preventing the next one.
      const result = await runtime.execute(tc.name, tc.arguments, { signal });
      const workbenchResult = parseWorkbenchResult(result);
      const clipped = result.length > 12_000
        ? `${result.slice(0, 12_000)}\n…(truncated)`
        : result;
      onEvent({
        type: 'tool_result',
        name: tc.name,
        preview: clipped.split('\n')[0].slice(0, 200),
        bytes: clipped.length,
        result: workbenchResult,
      });
      results.push(clipped);
    }
    // Written BEFORE the throw, deliberately: the history has to be well-formed
    // even on the cancelled path, so the next turn on this session can continue
    // from it instead of erroring on a dangling tool_call.
    messages.push(...toHistoryToolResults(reply.toolCalls, results));
    if (cancelledInTools || signal?.aborted) {
      onEvent({ type: 'cancelled', reason: 'during tool execution', round });
      throw abortError('Cancelled during tool execution.');
    }
  }

  // Hit the cap — one final no-tools call so the user gets a real wrap-up,
  // not only a dead "stopped" line. History is kept; "continue" still works.
  // The wrap-up runs through the router too, so it inherits this turn's floor
  // rather than silently dropping to a cheaper model for the summary.
  // The tool-round cap was reached. If the user cancelled on the way here, do
  // NOT spend one more model call on a wrap-up nobody is waiting to hear.
  if (signal?.aborted) {
    onEvent({ type: 'cancelled', reason: 'before the wrap-up call', round: limit });
    throw abortError('Cancelled before the wrap-up.');
  }

  const wrapChoice = pickModel(limit);
  onEvent({
    type: 'model',
    provider: provider.label,
    providerId: provider.id,
    model: wrapChoice.model,
    tier: wrapChoice.tier,
    reason: wrapChoice.reason,
    round: limit,
  });
  onEvent({
    type: 'status',
    message: `${provider.label} wrapping up after ${limit} tool rounds… `
      + `(${wrapChoice.tier} · ${wrapChoice.model || 'provider default'})`,
  });

  let wrapText = '';
  try {
    messages.push({
      role: 'user',
      content:
        `You used the maximum of ${limit} tool rounds for this turn. `
        + 'Do NOT call any more tools. Briefly report: (1) what you finished, '
        + '(2) what is still open, (3) the single next step. '
        + 'The user can reply "continue" to keep going with a fresh tool budget.',
    });
    // The wrap-up is a completion like any other and is recorded like any
    // other. It is the LAST thing the user reads at the end of a capped turn,
    // so an unrecorded one would leave the most visible answer of the turn
    // unattributed.
    const wrap = await chatWithTools({
      providerId: provider.id,
      apiKey: provider.key,
      url: provider.url,
      model: wrapChoice.model,
      messages,
      toolDefs: [], // force text-only wrap-up
      provenance: {
        workspace: runtime?.root,
        sessionId,
        providerLabel: provider.label,
        tier: wrapChoice.tier,
        reason: `${wrapChoice.reason} (wrap-up after ${limit} tool rounds)`,
        round: limit,
        routedLocal: false,
      },
      signal: combineSignals(signal, null),
    });
    announceProvenance(wrap, limit);
    // Redact secrets from wrap-up response
    wrapText = redactSecrets((wrap.content || '').trim());
    if (wrapText) {
      messages.push({ role: 'assistant', content: wrapText });
      onEvent({ type: 'assistant', text: wrapText });
    }
  } catch (err) {
    // A cancel must NOT be swallowed here. This catch exists so a failed
    // wrap-up still returns the "paused after N rounds" text; letting an abort
    // fall through to that would report a user-requested stop as a normal pause
    // and hand back a turn the caller believes completed.
    if (isAbortError(err)) {
      onEvent({ type: 'cancelled', reason: 'the wrap-up call was aborted', round: limit });
      throw err;
    }
    wrapText = '';
    onEvent({
      type: 'status',
      message: `Wrap-up failed: ${err.message || String(err)}`,
    });
  }

  if (!wrapText) {
    const stop =
      `Paused after ${limit} tool rounds — history is kept. `
      + 'Send "continue" (or any follow-up) to keep working with a new tool budget. '
      + 'Optional: set HELMION_MAX_TOOL_ROUNDS higher (default 48, max 200).';
    messages.push({ role: 'assistant', content: stop });
    onEvent({ type: 'assistant', text: stop });
    onEvent({ type: 'done' });
    return { text: stop, messages };
  }

  const footer =
    `\n\n_(Paused after ${limit} tool rounds — reply "continue" to keep going.)_`;
  onEvent({ type: 'assistant', text: footer });
  // Append footer into history so the model sees the pause next turn.
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant' && typeof last.content === 'string') {
    last.content = `${last.content}${footer}`;
  }
  onEvent({ type: 'done' });
  return { text: `${wrapText}${footer}`, messages };
}

function parseWorkbenchResult(value) {
  try {
    const parsed = JSON.parse(value);
    if (parsed?.contract !== 'helmion.workbench.v1' || typeof parsed?.kind !== 'string') return null;
    // The structured host/UI event is status, not an alternate transcript.
    // Bound task output here even though provider tool output has its own cap.
    if (typeof parsed.output === 'string' && parsed.output.length > 4_000) {
      parsed.output = `${parsed.output.slice(0, 4_000)}\n…(workbench status truncated)`;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Create agent session state for CLI agent.
 * Defaults to full tools (read + write + run_command) unless overridden.
 */
export function createSessionState(workspaceRoot, options = {}) {
  // CLI agent should have full tools by default, not read-only zero tools.
  // Desktop EXE and agent-bridge explicitly pass permissionMode; CLI needs sane default.
  const permissionMode = options.permissionMode ?? 'full';
  const runtime = createToolRuntime(workspaceRoot, { ...options, permissionMode });
  const messages = [
    { role: 'system', content: systemPrompt(runtime.root, Object.keys(runtime.tools)) },
  ];
  return { runtime, messages, permissionMode: runtime.permissionMode };
}

export function resetSessionState(state, workspaceRoot, options = {}) {
  const permissionMode = options.permissionMode ?? state.permissionMode ?? 'full';
  // Forward the whole option bag exactly like createSessionState does. Dropping
  // it here silently detached the ask-mode approver on every reconfigure, which
  // fails closed (every tool denied) rather than loudly.
  void state.runtime?.dispose?.();
  state.runtime = createToolRuntime(workspaceRoot, { ...options, permissionMode });
  state.permissionMode = state.runtime.permissionMode;
  state.messages = [
    { role: 'system', content: systemPrompt(state.runtime.root, Object.keys(state.runtime.tools)) },
  ];
}
