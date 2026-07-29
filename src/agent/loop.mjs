import {
  chatWithTools,
  systemPrompt,
  toHistoryAssistant,
  toHistoryToolResults,
} from './providers.mjs';
import { createToolRuntime } from './tools.mjs';
import { redactSecrets } from './redact.mjs';
import { readEnvTier, resolveTurnModel } from './model-router.mjs';

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
  envTier = readEnvTier(),
}) {
  const toolDefs = runtime.definitionsForOpenAi();
  const limit = resolveMaxToolRounds(maxToolRounds);
  messages.push({ role: 'user', content: userText });

  // Escalate-only within this turn: never hand a partially-reasoned turn back
  // to a weaker model than one that has already worked on it.
  let floorTier = null;

  const pickModel = (roundsUsedThisTurn) => {
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
    });
    floorTier = choice.tier;
    return choice;
  };

  for (let round = 0; round < limit; round += 1) {
    const choice = pickModel(round);
    onEvent({
      type: 'model',
      provider: provider.label,
      providerId: provider.id,
      model: choice.model,
      tier: choice.tier,
      reason: choice.reason,
      round,
    });
    onEvent({
      type: 'status',
      message: round === 0
        ? `${provider.label} thinking… (${choice.tier} · ${choice.model || 'provider default'})`
        : `${provider.label} tool round ${round}/${limit}… (${choice.tier} · ${choice.model || 'provider default'})`,
    });

    const reply = await chatWithTools({
      providerId: provider.id,
      apiKey: provider.key,
      // Custom OpenAI-compatible endpoints carry their own URL + model id.
      url: provider.url,
      model: choice.model,
      messages,
      toolDefs,
    });

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
    for (const tc of reply.toolCalls) {
      onEvent({
        type: 'tool',
        name: tc.name,
        args: tc.arguments || {},
      });
      const result = await runtime.execute(tc.name, tc.arguments);
      const clipped = result.length > 12_000
        ? `${result.slice(0, 12_000)}\n…(truncated)`
        : result;
      onEvent({
        type: 'tool_result',
        name: tc.name,
        preview: clipped.split('\n')[0].slice(0, 200),
        bytes: clipped.length,
      });
      results.push(clipped);
    }
    messages.push(...toHistoryToolResults(reply.toolCalls, results));
  }

  // Hit the cap — one final no-tools call so the user gets a real wrap-up,
  // not only a dead "stopped" line. History is kept; "continue" still works.
  // The wrap-up runs through the router too, so it inherits this turn's floor
  // rather than silently dropping to a cheaper model for the summary.
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
    const wrap = await chatWithTools({
      providerId: provider.id,
      apiKey: provider.key,
      url: provider.url,
      model: wrapChoice.model,
      messages,
      toolDefs: [], // force text-only wrap-up
    });
    // Redact secrets from wrap-up response
    wrapText = redactSecrets((wrap.content || '').trim());
    if (wrapText) {
      messages.push({ role: 'assistant', content: wrapText });
      onEvent({ type: 'assistant', text: wrapText });
    }
  } catch (err) {
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
    { role: 'system', content: systemPrompt(runtime.root) },
  ];
  return { runtime, messages, permissionMode: runtime.permissionMode };
}

export function resetSessionState(state, workspaceRoot, options = {}) {
  const permissionMode = options.permissionMode ?? state.permissionMode ?? 'full';
  // Forward the whole option bag exactly like createSessionState does. Dropping
  // it here silently detached the ask-mode approver on every reconfigure, which
  // fails closed (every tool denied) rather than loudly.
  state.runtime = createToolRuntime(workspaceRoot, { ...options, permissionMode });
  state.permissionMode = state.runtime.permissionMode;
  state.messages = [
    { role: 'system', content: systemPrompt(state.runtime.root) },
  ];
}
