// The remote half of the MCP client: servers Helmion CONNECTS to instead of
// launching — the hands server (helmian-hands-mcp) is the first one.
//
// WHY THIS EXISTS. src/agent/mcp-client.mjs speaks newline-delimited JSON-RPC
// to a subprocess Helmion spawned. A remote MCP server speaks the same
// JSON-RPC over HTTP (the MCP streamable-HTTP transport): one POST per
// request to the endpoint, the answer as a plain JSON body or as an SSE
// stream. This module is that transport, with the same client surface
// (listTools / callTool / textOf / close) so the turn's attachment resolver
// treats a remote server exactly like a launched one.
//
// THE CREDENTIAL IS RESOLVED AT TURN TIME, NEVER STORED. A plugin declares a
// TOKEN SOURCE (see remoteDeclarationDescriptor in src/agent/plugins.mjs) —
// an environment variable name, or a file + dotted field (the shape of a
// token file a door process maintains). resolveMcpTokenSource reads the
// value fresh at the moment a turn connects. The declaration, the baseline
// and this module's state never hold the value beyond the connection.
//
// EVERY SERVER IS UNTRUSTED, here too: every request has a timeout, the
// token goes only to the endpoint the declaration named, and a malformed or
// hostile response rejects the call instead of poisoning the turn.

import { readFile } from 'node:fs/promises';
import { McpClientError, PROTOCOL_VERSION, DEFAULT_TIMEOUT_MS } from './mcp-client.mjs';

export { McpClientError };

/**
 * Resolve a declared token source to its current value.
 *
 * @param {{kind: 'env', name: string} | {kind: 'file', path: string, field?: string|null} | null} tokenSource
 * @returns {Promise<{token: string|null, problem: string|null}>}
 *   token null + problem null means the declaration names no credential at
 *   all (connect unauthenticated). token null + problem set means a source
 *   was declared but did not resolve — the caller must NOT fall back to an
 *   unauthenticated connection and hope.
 */
export async function resolveMcpTokenSource(tokenSource, { env = process.env, readFileImpl = readFile } = {}) {
  if (!tokenSource) return { token: null, problem: null };

  if (tokenSource.kind === 'env') {
    const value = env?.[tokenSource.name];
    if (typeof value === 'string' && value.trim()) return { token: value.trim(), problem: null };
    return {
      token: null,
      problem: `the environment variable ${tokenSource.name} is not set on this host, so no token could be resolved`,
    };
  }

  if (tokenSource.kind === 'file') {
    let raw;
    try {
      raw = await readFileImpl(tokenSource.path, 'utf8');
    } catch (error) {
      return { token: null, problem: `the token file ${tokenSource.path} could not be read (${error.message})` };
    }
    const text = String(raw ?? '').trim();
    if (!tokenSource.field) {
      // No field named: a JSON string, or a plain-text token file.
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed === 'string' && parsed.trim()) return { token: parsed.trim(), problem: null };
        return { token: null, problem: `the token file ${tokenSource.path} holds JSON but names no field to read the token from` };
      } catch {
        if (text) return { token: text, problem: null };
        return { token: null, problem: `the token file ${tokenSource.path} is empty` };
      }
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { token: null, problem: `the token file ${tokenSource.path} is not valid JSON, so field "${tokenSource.field}" could not be read` };
    }
    let node = parsed;
    for (const part of tokenSource.field.split('.')) {
      node = node && typeof node === 'object' ? node[part] : undefined;
    }
    if (typeof node === 'string' && node.trim()) return { token: node.trim(), problem: null };
    return { token: null, problem: `the token file ${tokenSource.path} has no token at field "${tokenSource.field}"` };
  }

  return { token: null, problem: `the token source kind ${JSON.stringify(tokenSource.kind ?? null)} cannot be resolved` };
}

/** One JSON-RPC response out of an SSE body: the event whose id matches. */
function responseFromSseBody(body, id) {
  let fallback = null;
  for (const block of String(body).split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!data) continue;
    let message;
    try { message = JSON.parse(data); } catch { continue; }
    if (message?.id === id) return message;
    if (message && typeof message === 'object' && 'id' in message) fallback = fallback ?? message;
  }
  return fallback;
}

/**
 * Connects to one remote MCP server over streamable HTTP.
 *
 * @param {{url: string, token?: string|null, timeoutMs?: number,
 *          fetchImpl?: Function}} options
 *   fetchImpl is injectable for completeness; the conformance tests use the
 *   real fetch against a real loopback HTTP server.
 */
export async function createRemoteMcpClient({
  url,
  token = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  if (!url || typeof url !== 'string') {
    throw new McpClientError('a remote MCP server needs an endpoint url');
  }
  let endpoint;
  try {
    endpoint = new URL(url);
  } catch {
    throw new McpClientError(`the remote MCP endpoint ${JSON.stringify(url)} is not a valid URL`);
  }

  let nextId = 1;
  let closed = false;
  let sessionId = null;
  let negotiatedProtocol = null;

  function headers(extra = {}) {
    const h = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...extra,
    };
    if (token) h.authorization = `Bearer ${token}`;
    if (sessionId) h['mcp-session-id'] = sessionId;
    if (negotiatedProtocol) h['mcp-protocol-version'] = negotiatedProtocol;
    return h;
  }

  async function post(payload, { expectResponse }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(endpoint.href, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      throw new McpClientError(
        error?.name === 'AbortError'
          ? `${payload.method} did not answer within ${timeoutMs}ms`
          : `could not reach the remote MCP server at ${endpoint.href}: ${error.message}`,
        { method: payload.method },
      );
    } finally {
      clearTimeout(timer);
    }

    const newSession = response.headers?.get?.('mcp-session-id');
    if (newSession) sessionId = newSession;

    if (!expectResponse) return null; // notification: any 2xx is fine, body is not ours to parse

    const bodyText = await response.text().catch(() => '');
    if (!response.ok) {
      throw new McpClientError(
        `the remote MCP server answered HTTP ${response.status} for ${payload.method}: ${bodyText.slice(0, 300)}`,
        { method: payload.method, status: response.status },
      );
    }
    const contentType = String(response.headers?.get?.('content-type') ?? '');
    const message = contentType.includes('text/event-stream')
      ? responseFromSseBody(bodyText, payload.id)
      : (() => { try { return JSON.parse(bodyText); } catch { return null; } })();
    if (!message || typeof message !== 'object') {
      throw new McpClientError(
        `the remote MCP server's answer to ${payload.method} was not a JSON-RPC response`,
        { method: payload.method },
      );
    }
    if (message.error) {
      throw new McpClientError(
        message.error.message || 'the remote MCP server returned an error',
        { code: message.error.code, data: message.error.data, method: payload.method },
      );
    }
    return message.result;
  }

  function request(method, params) {
    if (closed) return Promise.reject(new McpClientError('the remote MCP client is closed'));
    return post({ jsonrpc: '2.0', id: nextId++, method, params }, { expectResponse: true });
  }

  async function notify(method, params) {
    if (closed) return;
    try {
      await post({ jsonrpc: '2.0', method, params }, { expectResponse: false });
    } catch {
      // A notification has no reply and no caller waiting on it — the same
      // contract as the stdio client's notify.
    }
  }

  const initializeResult = await request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    clientInfo: { name: 'helmion', version: '0.1.0' },
  });
  negotiatedProtocol = initializeResult?.protocolVersion ?? PROTOCOL_VERSION;

  // Part of the handshake. Helmion's own servers ignore it; others require it.
  await notify('notifications/initialized', {});

  return {
    serverInfo: initializeResult?.serverInfo ?? null,
    protocolVersion: initializeResult?.protocolVersion ?? null,

    async listTools() {
      const result = await request('tools/list', {});
      return Array.isArray(result?.tools) ? result.tools : [];
    },

    /** Same contract as the stdio client: content blocks returned unchanged. */
    async callTool(name, args = {}) {
      if (!name) throw new McpClientError('callTool needs a tool name');
      return request('tools/call', { name, arguments: args });
    },

    /** Text from a tool result, for the common case. Empty string if there is none. */
    textOf(result) {
      const blocks = Array.isArray(result?.content) ? result.content : [];
      return blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
    },

    get closed() { return closed; },

    async close() {
      if (closed) return;
      closed = true;
      // Best-effort session teardown; a remote close must never hang a turn.
      if (sessionId) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 2_000);
          await fetchImpl(endpoint.href, { method: 'DELETE', headers: headers(), signal: controller.signal });
          clearTimeout(timer);
        } catch { /* the session expires on its own */ }
      }
    },
  };
}
