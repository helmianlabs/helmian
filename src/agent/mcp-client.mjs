// The MCP client Helmion did not have.
//
// WHAT THIS CLOSES. src/agent/plugins.mjs:34 has carried this admission since it
// was written:
//
//     HONEST SEAM: Helmion's agent has no MCP client today — `mcpServers`
//     appears nowhere in src/agent/ and nothing in the turn loop spawns an
//     external server. So an `approved` verdict here produces a vetted
//     registration RECORD, not a running server.
//
// That one gap costs three things at once: the ~2,100-line MCP vetting pipeline
// ends in a filing cabinet, Helmion cannot reach Grok/Gemini/OpenAI, and the
// advisory loop has no way to ask anyone for a review. This is the missing half.
//
// WIRE FORMAT, TAKEN FROM HELMION'S OWN SERVER, NOT FROM MEMORY.
// src/mcp/server.mjs uses `input.on('line', ...)` and writes
// `process.stdout.write(`${json}\n`)` — newline-delimited JSON-RPC 2.0 over
// stdio, one message per line. This client speaks exactly that, and the repo's
// own four servers are the conformance test.
//
// NO DEPENDENCY. package.json has one runtime dependency (pg) and this does not
// add a second. An MCP client is a subprocess, two pipes and a request map.
//
// EVERY SERVER IS UNTRUSTED. A server is somebody else's code running on this
// machine. So: it never inherits the full environment, every request has a
// timeout, a server that dies mid-flight rejects its pending calls instead of
// hanging the caller forever, and a malformed line is dropped rather than
// crashing the turn.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** MCP revision this client announces. Servers may answer with their own. */
export const PROTOCOL_VERSION = '2024-11-05';

/** A call that has not answered by now is not going to. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Environment variables a server may see.
 *
 * AN ALLOW-LIST, NOT A DENY-LIST. `spawn` inherits process.env by default, which
 * would hand every candidate server ANTHROPIC_API_KEY, HELMION_DATABASE_URL and
 * every other secret in .env. The same reasoning as
 * src/core/mcp-sandbox.mjs, which scrubs the environment for exactly this
 * reason: a deny-list is one variable behind forever, and the failure direction
 * is a credential leaving the machine.
 */
export const INHERITED_ENV = Object.freeze([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
  'LANG', 'LC_ALL', 'TZ', 'NODE_OPTIONS',
]);

export class McpClientError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'McpClientError';
    Object.assign(this, details);
  }
}

/**
 * Builds the environment a server is launched with.
 *
 * @param {Record<string,string>} extra Explicitly granted variables. These are
 *   what an approved server declared it needs — passing them is a decision, not
 *   an accident, and it is why this is a parameter rather than a lookup.
 */
export function buildEnv(extra = {}, base = process.env) {
  const env = {};
  for (const name of INHERITED_ENV) {
    if (base[name] !== undefined) env[name] = base[name];
  }
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (value !== undefined && value !== null) env[name] = String(value);
  }
  return env;
}

/**
 * Connects to one MCP server over stdio.
 *
 * @param {{command: string, args?: string[], env?: object, cwd?: string,
 *          timeoutMs?: number, spawnFn?: Function}} options
 *   spawnFn is injectable so the whole client can be proven against a fake
 *   process in Node, with no real server and no network.
 */
export async function createMcpClient({
  command,
  args = [],
  env = {},
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnFn = spawn,
} = {}) {
  if (!command || typeof command !== 'string') {
    throw new McpClientError('an MCP server needs a command to run');
  }

  const child = spawnFn(command, args, {
    cwd,
    env: buildEnv(env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const pending = new Map();
  let nextId = 1;
  let closed = false;
  let exitReason = null;
  const stderr = [];

  /** Every in-flight call fails when the server dies. Never leave a caller hanging. */
  const failAll = (reason) => {
    exitReason = reason;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new McpClientError(reason, { stderr: stderr.join('').slice(-2000) }));
    }
    pending.clear();
  };

  child.on('error', (error) => {
    closed = true;
    failAll(`the MCP server could not be started: ${error.message}`);
  });

  child.on('exit', (code, signal) => {
    closed = true;
    failAll(`the MCP server exited (code ${code}, signal ${signal ?? 'none'})`);
  });

  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    // Kept, capped, and only surfaced on failure. A chatty server must not be
    // able to grow this without bound.
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk);
      if (stderr.length > 200) stderr.splice(0, stderr.length - 200);
    });
  }

  const reader = createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    const text = line.trim();
    if (!text) return;

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      // A server writing noise to stdout is common and is not fatal. Dropping
      // the line is correct; crashing the turn over it is not.
      return;
    }

    if (message.id === undefined || message.id === null) return; // notification
    const entry = pending.get(message.id);
    if (!entry) return;

    pending.delete(message.id);
    clearTimeout(entry.timer);

    if (message.error) {
      entry.reject(new McpClientError(
        message.error.message || 'the MCP server returned an error',
        { code: message.error.code, data: message.error.data },
      ));
      return;
    }
    entry.resolve(message.result);
  });

  function request(method, params) {
    if (closed) {
      return Promise.reject(new McpClientError(exitReason ?? 'the MCP server is not running'));
    }

    const id = nextId++;
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new McpClientError(
          `${method} did not answer within ${timeoutMs}ms`,
          { method, stderr: stderr.join('').slice(-2000) },
        ));
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer });

      try {
        child.stdin.write(payload);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(new McpClientError(`could not write to the MCP server: ${error.message}`));
      }
    });
  }

  function notify(method, params) {
    if (closed) return;
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {
      // A notification has no reply and no caller waiting on it.
    }
  }

  const initializeResult = await request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    clientInfo: { name: 'helmion', version: '0.1.0' },
  });

  // Part of the handshake. Helmion's own servers ignore it; others require it.
  notify('notifications/initialized', {});

  return {
    serverInfo: initializeResult?.serverInfo ?? null,
    protocolVersion: initializeResult?.protocolVersion ?? null,

    async listTools() {
      const result = await request('tools/list', {});
      return Array.isArray(result?.tools) ? result.tools : [];
    },

    /**
     * Calls one tool and returns its content blocks unchanged.
     *
     * The result is NOT unwrapped or coerced. An MCP tool answers with a content
     * array, and flattening it here would quietly discard anything that is not
     * the first text block — including a server's own error text.
     */
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
    get stderr() { return stderr.join(''); },

    async close() {
      if (closed) return;
      closed = true;
      failAll('the MCP client was closed');
      try { reader.close(); } catch { /* already gone */ }
      try { child.stdin.end(); } catch { /* already gone */ }
      try { child.kill(); } catch { /* already gone */ }
    },
  };
}
