// Connector MCP prompts — the client half of the MCP-prompts
// mechanism (mirror-design §4, build bite M2).
//
// A Helmian-brokered MCP server publishes two things the mirror
// cares about: its tools (frozen into the library's tool snapshots,
// connector-library.mjs) and its PROMPTS — the protocol's own
// starter-template primitive. Claude.ai renders a connected
// connector's published starters as menu rows; Helmian's equivalent
// lists a brokered server's prompts AT ARM TIME (when the person
// arms the connector for a message) and renders them as rows that
// seed the composer as a draft. Choosing one never sends: a prompt
// with no required arguments is rendered by the server (prompts/get)
// into the draft text; one with required arguments seeds a fill-in
// draft built from its own descriptor (promptDraftText in
// connector-library.mjs).
//
// This module is ONLY the wire: a minimal streamable-HTTP MCP
// client (initialize → notifications/initialized → the one call),
// speaking to the entry's own endpoint with the person's own token —
// resolved by the caller from the credential service, held in
// memory for the call, never logged, never returned. Responses may
// be plain JSON or an SSE stream (the transport allows both); both
// are read. A server that does not implement prompts answers
// method-not-found, which is a SUPPORTED answer, not an error: the
// caller renders no starter rows for it and says so.
//
// tools/list rides the same wire for exactly one caller: the
// dispatch-time first-arm freeze (connector-arming-dispatch.mjs,
// DESIGN §4.1(2)), which needs the server's tool descriptors to
// freeze a snapshot for a connection that has none yet.

const MCP_PROTOCOL_VERSION = '2025-03-26';
const MCP_CLIENT_INFO = Object.freeze({ name: 'Helmian', version: '1' });

function failure(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function parseRpcBody(text, contentType) {
  if (!text) return null;
  if (String(contentType ?? '').includes('text/event-stream')) {
    // SSE: the response to our request is the data payload carrying
    // a `result` or `error` member (notifications carry neither and
    // are not answered to). Take the LAST such payload.
    let found = null;
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && ('result' in parsed || 'error' in parsed)) found = parsed;
      } catch { /* a non-JSON data line is not ours to read */ }
    }
    return found;
  }
  try { return JSON.parse(text); } catch { return null; }
}

export function createMcpPromptsClient({ fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('createMcpPromptsClient needs a fetch implementation');

  async function rpc(endpoint, accessToken, method, params, { sessionId = null, notification = false } = {}) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    };
    const payload = { jsonrpc: '2.0', method, ...(notification ? {} : { id: 1 }), ...(params ? { params } : {}) };
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw failure(502, 'PROMPTS_UNREACHABLE', 'the connector\u2019s server could not be reached to list its starters');
    }
    const nextSession = response?.headers?.get?.('mcp-session-id') ?? sessionId;
    if (notification) return { sessionId: nextSession, body: null };
    if (!response?.ok) {
      throw failure(502, 'PROMPTS_LIST_FAILED', `the connector\u2019s server answered ${response?.status ?? 'no response'} when asked for its starters`);
    }
    const body = parseRpcBody(await response.text(), response?.headers?.get?.('content-type'));
    if (!body || typeof body !== 'object') {
      throw failure(502, 'PROMPTS_LIST_FAILED', 'the connector\u2019s server answered in a shape Helmian cannot read');
    }
    if (body.error) {
      // -32601 is JSON-RPC method-not-found: the server simply has
      // no prompts surface. That is a supported answer.
      if (body.error.code === -32601) return { sessionId: nextSession, unsupported: true, body };
      throw failure(502, 'PROMPTS_LIST_FAILED', 'the connector\u2019s server refused the starters request');
    }
    return { sessionId: nextSession, body };
  }

  async function withSession(endpoint, accessToken, method, params) {
    const init = await rpc(endpoint, accessToken, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: MCP_CLIENT_INFO,
    });
    const sessionId = init.sessionId ?? null;
    await rpc(endpoint, accessToken, 'notifications/initialized', null, { sessionId, notification: true }).catch(() => {});
    return rpc(endpoint, accessToken, method, params, { sessionId });
  }

  return Object.freeze({
    /**
     * prompts/list for one brokered server. Returns
     * { supported: true, prompts: [...] } with the server's raw
     * prompt descriptors (the caller plans them through
     * planPromptSnapshot), or { supported: false, prompts: [] } when
     * the server implements no prompts surface.
     */
    async listPrompts({ endpoint, accessToken = null } = {}) {
      const out = await withSession(endpoint, accessToken, 'prompts/list', {});
      if (out.unsupported) return { supported: false, prompts: [] };
      const prompts = out.body?.result?.prompts;
      if (!Array.isArray(prompts)) throw failure(502, 'PROMPTS_LIST_FAILED', 'the connector\u2019s server answered the starters request in a shape Helmian cannot read');
      return { supported: true, prompts };
    },

    /**
     * tools/list for one brokered server. Returns
     * { supported: true, tools: [...] } with the server's raw tool
     * descriptors (the caller plans them through planToolSnapshot),
     * or { supported: false, tools: [] } when the server implements
     * no tools surface.
     */
    async listTools({ endpoint, accessToken = null } = {}) {
      const out = await withSession(endpoint, accessToken, 'tools/list', {});
      if (out.unsupported) return { supported: false, tools: [] };
      const tools = out.body?.result?.tools;
      if (!Array.isArray(tools)) throw failure(502, 'TOOLS_LIST_FAILED', 'the connector\u2019s server answered the tools request in a shape Helmian cannot read');
      return { supported: true, tools };
    },

    /**
     * prompts/get for one prompt with the given arguments (the
     * caller passes {} — a draft render, never a turn). Returns the
     * raw result ({ description?, messages }); renderPromptText
     * below turns it into composer draft text.
     */
    async getPrompt({ endpoint, accessToken = null, name, args = {} } = {}) {
      const out = await withSession(endpoint, accessToken, 'prompts/get', { name, arguments: args ?? {} });
      if (out.unsupported) throw failure(502, 'PROMPTS_UNSUPPORTED', 'this connector\u2019s server does not render its starters');
      const result = out.body?.result;
      if (!result || !Array.isArray(result.messages)) throw failure(502, 'PROMPTS_LIST_FAILED', 'the connector\u2019s server rendered the starter in a shape Helmian cannot read');
      return result;
    },
  });
}

/**
 * The draft text of a rendered prompt (prompts/get result): the text
 * parts of its messages, in order, joined by blank lines. Non-text
 * parts (images, resources) cannot ride a composer draft and are
 * skipped — the draft says what the text says, nothing more.
 */
export function renderPromptText(result) {
  const parts = [];
  for (const message of Array.isArray(result?.messages) ? result.messages : []) {
    const content = message?.content;
    const blocks = Array.isArray(content) ? content : [content];
    for (const block of blocks) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('\n\n').trim();
}
