/**
 * Provider adapters for the Helmion coding agent.
 * OpenAI + xAI: OpenAI-compatible chat.completions + tools.
 * Anthropic: Messages API + tools.
 * Gemini: generateContent + function calling.
 */

import { redactSecrets } from './redact.mjs';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

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

export async function chatWithTools({
  providerId,
  apiKey,
  model,
  messages,
  toolDefs,
  signal,
  url,
}) {
  if (!apiKey) {
    throw new Error(`No API key configured for provider ${providerId}`);
  }

  // User-defined OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, DeepSeek, …).
  // Same wire format as OpenAI; only the base URL and model differ.
  if (providerId === 'custom') {
    if (!url) {
      throw new Error('Custom provider is missing its endpoint URL');
    }
    return openAiCompatibleTurn({
      url,
      apiKey,
      model: model || 'default',
      messages,
      toolDefs,
      signal,
    });
  }

  if (providerId === 'openai' || providerId === 'xai') {
    return openAiCompatibleTurn({
      url: providerId === 'xai' ? XAI_URL : OPENAI_URL,
      apiKey,
      // Fallback fires only when no model was routed (unrecognized caller path).
      // Keep in sync with the standard tier in model-router.mjs.
      model: model || (providerId === 'xai' ? 'grok-4.3' : 'gpt-5.6-terra'),
      messages,
      toolDefs,
      signal,
      providerId,
    });
  }

  if (providerId === 'anthropic') {
    return anthropicTurn({
      apiKey,
      model: model || 'claude-sonnet-5',
      messages,
      toolDefs,
      signal,
    });
  }

  if (providerId === 'gemini') {
    return geminiTurn({
      apiKey,
      model: model || 'gemini-2.5-flash',
      messages,
      toolDefs,
      signal,
    });
  }

  throw new Error(`Unsupported provider: ${providerId}`);
}

async function openAiCompatibleTurn({
  url,
  apiKey,
  model,
  messages,
  toolDefs,
  signal,
  providerId,
}) {
  const body = {
    model,
    messages,
  };
  // Empty tools arrays break some providers (xAI/OpenAI). Omit when permission is read-only.
  if (Array.isArray(toolDefs) && toolDefs.length > 0) {
    body.tools = toolDefs;
    body.tool_choice = 'auto';

    // The gpt-5.6 family defaults to a reasoning effort that chat.completions
    // refuses to combine with function tools. Verified from OpenAI's own 400:
    // "Function tools with reasoning_effort are not supported for gpt-5.6-terra
    //  in /v1/chat/completions. To use function tools, use /v1/responses or set
    //  reasoning_effort to 'none'." Every tool-bearing OpenAI turn 400s without
    // this. Scoped to providerId 'openai' — xAI and user-supplied
    // OpenAI-compatible endpoints (Ollama, vLLM, LM Studio) reject the unknown
    // field, so it must not be sent to them.
    if (providerId === 'openai') {
      body.reasoning_effort = 'none';
    }
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
