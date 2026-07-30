/**
 * Provider adapters for the Helmion coding agent.
 * OpenAI + xAI: OpenAI-compatible chat.completions + tools.
 * Anthropic: Messages API + tools.
 * Gemini: generateContent + function calling.
 */

import { redactSecrets } from './redact.mjs';
import { recordCompletion } from '../core/provenance-log.mjs';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GEMINI_URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Second redaction layer at the outbound request boundary — the last point
 * before bytes leave for the provider. Covers any route into the request body
 * the tool-layer redaction does not (history, prompts, model-generated args).
 * The provider auth credential travels ONLY in headers / URL auth params,
 * never in the body, so exact-matching the live key here cannot break auth.
 */
export function redactOutboundBody(json, apiKey) {
  let s = redactSecrets(json);
  if (apiKey) {
    s = s.split(apiKey).join('[REDACTED]');
  }
  return s;
}

export function systemPrompt(workspaceRoot) {
  return `You are Helmion, a real coding agent running in the user's terminal (like Claude Code / Cursor agent).
Workspace root: ${workspaceRoot}

Rules:
- Use tools to inspect and change the workspace. Do not claim you edited a file unless write_file succeeded.
- Prefer small, verified steps. Cite paths you touch.
- For multi-step work: read first, then edit, then run a check command when useful.
- run_command is real shell on the user's machine — avoid destructive commands unless asked.
- Be concise in final answers. When done, answer without more tool calls.
- You are not a fake UI stub. Tools execute for real.`;
}

/**
 * THE PROVENANCE WRITE SITE.
 *
 * This runs after a provider's response has been received and parsed, using the
 * URL that was actually fetched and the model id that was actually sent — both
 * read back off the reply, not off the request that was planned.
 *
 * IT IS HERE, AND NOT IN THE ROUTER, ON PURPOSE. model-router.mjs decides which
 * model SHOULD answer; loop.mjs then calls, and on a local failure calls again
 * against a different provider (loop.mjs:133-143). A record written where the
 * decision was made is therefore wrong precisely when a fallback fires, and a
 * fallback is the case this ledger exists for: the turn Troy saw was answered by
 * a model nobody announced. Written here, a local attempt that throws produces
 * NO row (nothing answered) and the frontier retry produces its own row naming
 * itself, with no bookkeeping in between that could disagree.
 *
 * Never throws and never changes the reply. recordCompletion returns its failure
 * rather than raising, and the outcome is attached to the reply as
 * `reply.provenance` so the caller can put "answered but not recorded" on
 * screen. A caller that ignores it is the bug this codebase already made once,
 * where a `skipped` flag was returned and dropped on the floor.
 */
function recordTurnProvenance(reply, {
  providerId, model, url, isLocal, provenance, startedAt,
}) {
  const context = provenance || {};
  const written = recordCompletion(
    // A turn runs against a workspace; the bridge changes it per turn
    // (bridge.mjs:322-325) and the node process's cwd is not it. The caller
    // passes the workspace the turn actually ran in; cwd is the last resort so
    // that a completion is never unrecorded merely because nobody threaded a
    // path — this ledger's whole failure mode is a silent absence.
    context.workspace || process.cwd(),
    {
      providerId,
      model,
      url,
      isLocal,
      sessionId: context.sessionId,
      providerLabel: context.providerLabel,
      tier: context.tier,
      reason: context.reason,
      round: context.round,
      // The ROUTER's claim, kept next to the endpoint-derived truth above so a
      // reader can tell "Helmion chose to go local" from "the bytes came from
      // this machine". They are normally the same; when they are not, that
      // difference is the finding.
      routedLocal: context.routedLocal,
      latencyMs: Number.isFinite(startedAt) ? Date.now() - startedAt : undefined,
      toolCalls: Array.isArray(reply?.toolCalls) ? reply.toolCalls.length : undefined,
      contentChars: typeof reply?.content === 'string' ? reply.content.length : undefined,
    },
  );
  return { ...reply, provenance: written };
}

/**
 * @param {boolean} [reasoningEffortNone]
 *   Opt-in: send `reasoning_effort: 'none'` on a tool-bearing turn. Set ONLY by
 *   callers that have verified their endpoint supports the field. Measured on
 *   this box 2026-07-28 with Ollama v0.32.5 + qwen3.5:4b, which is a reasoning
 *   model: a short conversational turn burned 2,603 tokens over ~40 s without
 *   the field and 30 tokens in 0.9 s with it. Every cheaper workaround failed —
 *   `PARAMETER think false`, a `/no_think` system message, a `/no_think` user
 *   suffix, and `enable_thinking=False` (which returned an EMPTY answer after
 *   4,068 tokens). This flag is the only lever that works.
 *   It is deliberately NOT inferred from providerId 'custom': LM Studio, vLLM
 *   and DeepSeek were never tested and may reject the unknown field.
 */
/**
 * @param {object} [provenance]
 *   Context for the provenance ledger: `{workspace, sessionId, providerLabel,
 *   tier, reason, round}`. Every field is optional — a completion is recorded
 *   whether or not a caller supplies any of it, because the one thing this
 *   ledger must never do is go quiet when somebody forgets to pass something.
 *   `isLocal` is deliberately NOT taken from here: it is derived below from the
 *   endpoint that was actually called.
 */
export async function chatWithTools({
  providerId,
  apiKey,
  model,
  messages,
  toolDefs,
  signal,
  url,
  reasoningEffortNone = false,
  provenance = null,
}) {
  if (!apiKey) {
    throw new Error(`No API key configured for provider ${providerId}`);
  }

  const startedAt = Date.now();

  // User-defined OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, DeepSeek, …).
  // Same wire format as OpenAI; only the base URL and model differ.
  if (providerId === 'custom') {
    if (!url) {
      throw new Error('Custom provider is missing its endpoint URL');
    }
    const resolvedModel = model || 'default';
    const reply = await openAiCompatibleTurn({
      url,
      apiKey,
      model: resolvedModel,
      messages,
      toolDefs,
      signal,
      reasoningEffortNone,
    });
    return recordTurnProvenance(reply, {
      providerId,
      model: resolvedModel,
      url,
      // PRIMARILY DERIVED FROM THE ENDPOINT, NOT DECLARED BY THE CALLER. Every
      // local runtime reaches this branch as providerId 'custom'
      // (local-provider.mjs:162), so a caller that simply omitted a flag would
      // file a qwen answer as an ordinary remote one — the exact confusion this
      // ledger was built to end. The host is what was dialled; it cannot lie.
      //
      // The router's own verdict is OR-ed in rather than trusted alone, so that
      // an Ollama box reachable at a LAN address still reports LOCAL. The two
      // inputs fail in opposite directions and the row records both plus the
      // host, so a disagreement is visible instead of silently resolved.
      isLocal: isLoopbackEndpoint(url) || provenance?.routedLocal === true,
      provenance,
      startedAt,
    });
  }

  if (providerId === 'openai' || providerId === 'xai') {
    const resolvedUrl = providerId === 'xai' ? XAI_URL : OPENAI_URL;
    // Fallback fires only when no model was routed (unrecognized caller path).
    // Keep in sync with the standard tier in model-router.mjs.
    const resolvedModel = model || (providerId === 'xai' ? 'grok-4.3' : 'gpt-5.6-terra');
    const reply = await openAiCompatibleTurn({
      url: resolvedUrl,
      apiKey,
      model: resolvedModel,
      messages,
      toolDefs,
      signal,
      providerId,
    });
    return recordTurnProvenance(reply, {
      providerId, model: resolvedModel, url: resolvedUrl, isLocal: false, provenance, startedAt,
    });
  }

  if (providerId === 'anthropic') {
    const resolvedModel = model || 'claude-sonnet-5';
    const reply = await anthropicTurn({
      apiKey,
      model: resolvedModel,
      messages,
      toolDefs,
      signal,
    });
    return recordTurnProvenance(reply, {
      providerId, model: resolvedModel, url: ANTHROPIC_URL, isLocal: false, provenance, startedAt,
    });
  }

  if (providerId === 'gemini') {
    const resolvedModel = model || 'gemini-2.5-flash';
    const reply = await geminiTurn({
      apiKey,
      model: resolvedModel,
      messages,
      toolDefs,
      signal,
    });
    return recordTurnProvenance(reply, {
      providerId,
      model: resolvedModel,
      // The key-bearing query string is NOT passed to the ledger. geminiTurn
      // authenticates with `?key=…`; endpointParts drops any query it is given,
      // but not handing it over in the first place means no future change to
      // that helper can leak the credential.
      url: geminiEndpoint(resolvedModel),
      isLocal: false,
      provenance,
      startedAt,
    });
  }

  throw new Error(`Unsupported provider: ${providerId}`);
}

/** The Gemini endpoint for a model, without the `?key=` the request adds. */
function geminiEndpoint(model) {
  return `${GEMINI_URL_BASE}/${model}:generateContent`;
}

/**
 * Is this endpoint a model running on this machine?
 *
 * Loopback is the honest test. src/agent/local-provider.mjs binds only to
 * loopback and says so ("Loopback only — never bind this off-box",
 * local-provider.mjs:34), and no remote vendor is ever reachable at 127.0.0.1.
 * A user-configured LM Studio or vLLM on this box therefore reports LOCAL too,
 * which is correct: Troy's question is whether the answer came from his own
 * machine, not whether Helmion's own local-routing feature was the thing that
 * sent it there.
 *
 * A LAN endpoint (192.168.x.x) is NOT counted as local. It is somebody else's
 * machine, and calling it local would overstate what the row proves.
 */
export function isLoopbackEndpoint(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost'
      || host === '::1'
      || host === '0.0.0.0'
      || /^127\./.test(host);
  } catch {
    return false;
  }
}

async function openAiCompatibleTurn({
  url,
  apiKey,
  model,
  messages,
  toolDefs,
  signal,
  providerId,
  reasoningEffortNone = false,
}) {
  const body = {
    model,
    messages,
  };
  const hasTools = Array.isArray(toolDefs) && toolDefs.length > 0;

  // Empty tools arrays break some providers (xAI/OpenAI). Omit when permission is read-only.
  if (hasTools) {
    body.tools = toolDefs;
    body.tool_choice = 'auto';
  }

  // Two different reasons to pin reasoning effort, with different scopes:
  //
  // 1. OpenAI, TOOL TURNS ONLY. The gpt-5.6 family refuses function tools at its
  //    default effort. From OpenAI's own 400: "Function tools with
  //    reasoning_effort are not supported for gpt-5.6-terra in
  //    /v1/chat/completions. To use function tools, use /v1/responses or set
  //    reasoning_effort to 'none'."
  // 2. A caller that explicitly opted in (today: the local Ollama provider), on
  //    EVERY turn. Ollama documents the field as supported, and qwen3.5:4b is a
  //    reasoning model whose runaway thinking hits CONVERSATIONAL turns hardest —
  //    measured 2,603 tokens / ~40 s without it vs 30 tokens / 0.9 s with it.
  //    Tool turns were fine either way, so gating this on hasTools would have
  //    left the exact case the router sends local still broken.
  //
  // Never inferred from providerId 'custom': LM Studio, vLLM and DeepSeek are
  // untested and may reject the unknown field.
  if (reasoningEffortNone || (providerId === 'openai' && hasTools)) {
    body.reasoning_effort = 'none';
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: redactOutboundBody(JSON.stringify(body), apiKey),
    signal,
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`${url} HTTP ${res.status}: ${raw.slice(0, 400)}`);
  }
  const data = JSON.parse(raw);
  const choice = data.choices?.[0]?.message;
  if (!choice) throw new Error('Provider returned no message');

  const toolCalls = (choice.tool_calls || []).map((tc) => ({
    id: tc.id,
    name: tc.function?.name,
    arguments: safeJson(tc.function?.arguments),
  }));

  return {
    role: 'assistant',
    content: choice.content || '',
    toolCalls,
    raw: choice,
  };
}

async function anthropicTurn({ apiKey, model, messages, toolDefs, signal }) {
  // Convert OpenAI-style messages to Anthropic
  let system = '';
  const anthMessages = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system += (system ? '\n' : '') + m.content;
      continue;
    }
    if (m.role === 'tool') {
      anthMessages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: m.content || '',
          },
        ],
      });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: safeJson(tc.function.arguments),
        });
      }
      anthMessages.push({ role: 'assistant', content: blocks });
      continue;
    }
    anthMessages.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content || '',
    });
  }

  const tools = (toolDefs || []).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  const payload = {
    model,
    max_tokens: 8192,
    system: system || undefined,
    messages: anthMessages,
  };
  if (tools.length > 0) {
    payload.tools = tools;
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: redactOutboundBody(JSON.stringify(payload), apiKey),
    signal,
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Anthropic HTTP ${res.status}: ${raw.slice(0, 400)}`);
  }
  const data = JSON.parse(raw);
  const blocks = data.content || [];
  let content = '';
  const toolCalls = [];
  for (const b of blocks) {
    if (b.type === 'text') content += b.text;
    if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id,
        name: b.name,
        arguments: b.input || {},
      });
    }
  }
  return { role: 'assistant', content, toolCalls, raw: data };
}

async function geminiTurn({ apiKey, model, messages, toolDefs, signal }) {
  // Flatten to Gemini contents; put system in systemInstruction
  let system = '';
  const contents = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system += (system ? '\n' : '') + m.content;
      continue;
    }
    if (m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.name || 'tool',
              response: { result: m.content },
            },
          },
        ],
      });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.tool_calls) {
        parts.push({
          functionCall: {
            name: tc.function?.name || tc.name,
            args: safeJson(tc.function?.arguments ?? tc.arguments),
          },
        });
      }
      contents.push({ role: 'model', parts });
      continue;
    }
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content || '' }],
    });
  }

  const functionDeclarations = (toolDefs || []).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
    + `?key=${encodeURIComponent(apiKey)}`;

  const payload = {
    system_instruction: system ? { parts: [{ text: system }] } : undefined,
    contents,
  };
  if (functionDeclarations.length > 0) {
    payload.tools = [{ function_declarations: functionDeclarations }];
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: redactOutboundBody(JSON.stringify(payload), apiKey),
    signal,
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Gemini HTTP ${res.status}: ${raw.slice(0, 400)}`);
  }
  const data = JSON.parse(raw);
  const parts = data.candidates?.[0]?.content?.parts || [];
  let content = '';
  const toolCalls = [];
  for (const p of parts) {
    if (p.text) content += p.text;
    if (p.functionCall) {
      toolCalls.push({
        id: `gemini_${toolCalls.length}_${p.functionCall.name}`,
        name: p.functionCall.name,
        arguments: p.functionCall.args || {},
      });
    }
  }
  return { role: 'assistant', content, toolCalls, raw: data };
}

function safeJson(value) {
  if (value == null) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return { raw: String(value) };
  }
}

/** Normalize provider reply into OpenAI-ish message for history. */
export function toHistoryAssistant(reply) {
  if (!reply.toolCalls?.length) {
    return { role: 'assistant', content: reply.content || '' };
  }
  return {
    role: 'assistant',
    content: reply.content || null,
    tool_calls: reply.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: typeof tc.arguments === 'string'
          ? tc.arguments
          : JSON.stringify(tc.arguments || {}),
      },
    })),
  };
}

export function toHistoryToolResults(toolCalls, results) {
  return toolCalls.map((tc, i) => ({
    role: 'tool',
    tool_call_id: tc.id,
    name: tc.name,
    content: results[i] ?? '',
  }));
}
