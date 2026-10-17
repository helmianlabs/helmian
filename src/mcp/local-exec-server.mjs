// Helmian local-execution MCP server: governed local hands for any AI.
//
// TRUST DOMAIN — READ THIS FIRST
// This server EXECUTES code on Troy's PC. It is deliberately a separate
// process, a separate approval gate, and a separate audit trail from the
// read-oriented governance MCP servers (src/mcp/server.mjs,
// src/mcp/codex-server.mjs), which only expose blockers and context. No
// shared fate: a bug in the governance reader can never become code
// execution here.
//
// SECURITY POSTURE: FAIL CLOSED.
// - Disabled by default. Opt in with HELMION_LOCAL_MCP=1 or --serve.
// - Mutating tools (run_powershell, write_file) ALWAYS require a human
//   approval via the broker from src/agent/approval.mjs. No approver, no
//   answer, malformed answer, timeout, or thrown approver resolves to DENY.
// - Approval timeout denies (default 5 min, HELMION_ASK_TIMEOUT_MS).
// - write_file refuses paths outside the allowlist roots (default: the
//   working directory the server starts in, plus HELMION_LOCAL_MCP_ROOTS).
// - HTTP transport NEVER binds 0.0.0.0. Non-loopback bind requires a bearer
//   token. Localhost is trusted by binding, not by obscurity.
// - Every call is audit-logged locally (JSONL) with an args SHA-256 hash —
//   never raw secrets.
//
// UNITY ANGLE (no Unity code needed)
// AI-assisted Unity work flows through helmion_run_powershell, e.g.:
//   Unity.exe -batchmode -quit -projectPath "E:\Caldmere"
//     -executeMethod Caldmere.Build.PackPrefabs
// Add the Unity project directory to HELMION_LOCAL_MCP_ROOTS so the file
// tools can stage Meshy-generated FBX files into the project. The human
// approves each step on their phone before anything runs.
//
// TRANSPORTS
// - stdio (default): JSON-RPC 2.0 on stdin/stdout for Claude Code and other
//   desktop MCP clients. Approval decisions return via the
//   helmion/permission_response method. Server-initiated permission requests
//   go out as JSON-RPC notifications.
// - HTTP+SSE (opt-in): POST /mcp (JSON-RPC), GET /mcp/stream (SSE events),
//   GET /v1/approvals/pending, POST /v1/approvals/decide, GET /v1/health.
//   For Tailscale: --bind <tailnet-ip> plus HELMION_LOCAL_MCP_TOKEN.
//
// APPROVAL NOTIFICATIONS
// The broker emits permission_request events. They go to:
//   1. the active transport (stdio notification / SSE stream), and
//   2. the envoy team channel via the bridge's device token (opt-out with
//      HELMION_LOCAL_MCP_ENVOY_NOTIFY=0), so the /app on Troy's phone shows
//      the request and he can reply "approve <id>" / "deny <id>".
// v2 will add a first-class cloud approval kind; the cloud inbox today only
// understands artifact_execution_request, so v1 uses the channel it has.

import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, sep, dirname, isAbsolute } from 'node:path';
import { readFile, writeFile, mkdir, readdir, stat, appendFile } from 'node:fs/promises';
import {
  createApprovalBroker,
  isAllowed,
  summarizeToolCall,
  resolveAskTimeoutMs,
} from '../agent/approval.mjs';
import { redactSecrets } from '../agent/redact.mjs';

export const SERVER_NAME = 'mcp-helmion-local-exec';
export const SERVER_VERSION = '0.1.0';
export const DEFAULT_HTTP_PORT = 7430;
export const MAX_READ_BYTES = 256 * 1024;
export const MAX_WRITE_BYTES = 1024 * 1024;
export const MAX_COMMAND_CHARS = 8000;
export const MAX_OUTPUT_BYTES = 32 * 1024;
export const DEFAULT_PS_TIMEOUT_MS = 120_000;
export const MAX_PS_TIMEOUT_MS = 600_000;
export const MAX_LIST_ENTRIES = 200;
export const CLOUD_URL = process.env.HELMION_CLOUD_URL || 'https://helmian.cloud';

export const TOOL_DEFINITIONS = [
  {
    name: 'helmion_run_powershell',
    description:
      'Run a PowerShell command on the local PC. APPROVAL-GATED: a human must '
      + 'approve every call. Non-interactive, hard timeout, output truncated. '
      + 'Use for Unity CLI work, e.g. Unity.exe -batchmode -executeMethod.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command (-Command).', maxLength: MAX_COMMAND_CHARS },
        workingDirectory: { type: 'string', description: 'Absolute path within the allowlist roots. Defaults to the first root.' },
        timeoutMs: { type: 'integer', description: 'Hard timeout 1000-600000 ms. Default 120000.', minimum: 1000, maximum: MAX_PS_TIMEOUT_MS },
      },
      required: ['command'],
    },
  },
  {
    name: 'helmion_read_file',
    description: 'Read a text file within the allowlist roots. Size-capped, never gated.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path within the allowlist roots.' } },
      required: ['path'],
    },
  },
  {
    name: 'helmion_list_dir',
    description: 'List a directory within the allowlist roots. Non-recursive, entry-capped, never gated.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path within the allowlist roots.' } },
      required: ['path'],
    },
  },
  {
    name: 'helmion_write_file',
    description:
      'Write a text file within the allowlist roots. APPROVAL-GATED: a human '
      + 'must approve every call. Refuses paths outside the roots.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path within the allowlist roots.' },
        content: { type: 'string', description: 'UTF-8 text content.', maxLength: MAX_WRITE_BYTES },
      },
      required: ['path', 'content'],
    },
  },
];

// ---------------------------------------------------------------------------
// Paths and allowlist
// ---------------------------------------------------------------------------

function normCase(value) {
  return process.platform === 'win32' ? String(value).toLowerCase() : String(value);
}

/** Allowlist roots: the startup working directory plus HELMION_LOCAL_MCP_ROOTS. */
export function resolveRoots({ cwd = process.cwd(), extra = process.env.HELMION_LOCAL_MCP_ROOTS } = {}) {
  const roots = [resolve(cwd)];
  for (const part of String(extra ?? '').split(',')) {
    const trimmed = part.trim();
    if (trimmed) roots.push(resolve(trimmed));
  }
  return [...new Set(roots)];
}

/** True when the path resolves inside one of the roots. Fail closed. */
export function isPathAllowed(candidate, roots) {
  if (typeof candidate !== 'string' || !candidate) return false;
  let absolute;
  try {
    absolute = resolve(candidate);
  } catch {
    return false;
  }
  const normAbs = normCase(absolute);
  return (roots ?? []).some((root) => {
    const normRoot = normCase(resolve(root));
    return normAbs === normRoot || normAbs.startsWith(normRoot + normCase(sep));
  });
}

function defaultAuditPath() {
  return join(homedir(), 'AppData', 'Roaming', 'Helmian', 'mcp-local-audit.jsonl');
}

function defaultTokenPath() {
  return process.env.HELMION_BRIDGE_TOKEN_PATH
    || join(homedir(), 'AppData', 'Roaming', 'Helmian', 'pc-bridge-token.json');
}

// ---------------------------------------------------------------------------
// Audit (local JSONL, args hashed, never raw secrets)
// ---------------------------------------------------------------------------

export function argsHash(args) {
  const clean = redactSecrets(JSON.stringify(args ?? {}));
  return createHash('sha256').update(clean).digest('hex');
}

export function createAuditLog(filePath = defaultAuditPath()) {
  async function append(entry) {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
    } catch {
      // Audit is best-effort locally; a failed write must not break the gate.
    }
  }
  return { append, filePath };
}

function summarizeResult(result) {
  if (!result || typeof result !== 'object') return String(result ?? '');
  if (result.refused) return `refused: ${result.reason ?? 'denied'}`;
  if (result.dryRun) return `dry-run: ${result.wouldRun ?? ''}`;
  if (typeof result.exitCode === 'number') return `exit=${result.exitCode} timedOut=${!!result.timedOut} truncated=${!!result.truncated}`;
  if (typeof result.bytes === 'number') return `bytes=${result.bytes} truncated=${!!result.truncated}`;
  if (Array.isArray(result.entries)) return `entries=${result.entries.length} truncated=${!!result.truncated}`;
  if (result.error) return `error: ${String(result.error).slice(0, 160)}`;
  return 'ok';
}

// ---------------------------------------------------------------------------
// PowerShell execution (injectable for tests)
// ---------------------------------------------------------------------------

function capOutput(text, max = MAX_OUTPUT_BYTES) {
  const str = String(text ?? '');
  if (Buffer.byteLength(str, 'utf8') <= max) return { text: str, truncated: false };
  let cut = str.slice(0, max);
  while (Buffer.byteLength(cut, 'utf8') > max) cut = cut.slice(0, -10);
  return { text: `${cut}\n…[truncated]`, truncated: true };
}

/**
 * Run powershell.exe -Command. Non-interactive, hard timeout, output capped.
 * The command is a single string passed as one argv element — no shell
 * word-splitting, no interpolation by us. Documented as such.
 */
export async function defaultExecPowershell(
  { command, workingDirectory, timeoutMs = DEFAULT_PS_TIMEOUT_MS },
  { powershellBin = process.env.HELMION_POWERSHELL_BIN || 'powershell.exe' } = {},
) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      powershellBin,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { cwd: workingDirectory, windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const onData = (store) => (chunk) => {
      // Stop accumulating past 4x the cap; the cap marker flags the rest.
      if (store.text.length < MAX_OUTPUT_BYTES * 4) store.text += chunk.toString('utf8');
      else store.overflow = true;
    };
    const outStore = { text: '', overflow: false };
    const errStore = { text: '', overflow: false };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']);
        } else {
          child.kill('SIGKILL');
        }
      } catch { /* already gone */ }
    }, timeoutMs);
    child.stdout.on('data', onData(outStore));
    child.stderr.on('data', onData(errStore));
    child.on('error', (err) => finish({
      exitCode: -1, timedOut: false,
      stdout: '', stderr: String(err?.message ?? err),
      truncated: false, spawnError: true,
    }));
    child.on('close', (code) => {
      const out = capOutput(outStore.text);
      const err = capOutput(errStore.text);
      finish({
        exitCode: code ?? -1,
        timedOut,
        stdout: redactSecrets(out.text),
        stderr: redactSecrets(err.text),
        truncated: out.truncated || err.truncated || outStore.overflow || errStore.overflow,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Input validation (strict, fail closed)
// ---------------------------------------------------------------------------

function cleanText(value, name, max) {
  const result = String(value ?? '');
  if (!result || result.length > max || result.includes('\0')) throw new Error(`${name} is invalid`);
  return result;
}

function validatePowershellArgs(args, roots) {
  const a = args && typeof args === 'object' ? args : {};
  const command = cleanText(a.command, 'command', MAX_COMMAND_CHARS);
  let timeoutMs = Number(a.timeoutMs ?? DEFAULT_PS_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs)) timeoutMs = DEFAULT_PS_TIMEOUT_MS;
  timeoutMs = Math.min(Math.max(Math.floor(timeoutMs), 1000), MAX_PS_TIMEOUT_MS);
  let workingDirectory = roots[0];
  if (a.workingDirectory !== undefined && a.workingDirectory !== null && String(a.workingDirectory) !== '') {
    const dir = String(a.workingDirectory);
    if (!isAbsolute(dir) || !isPathAllowed(dir, roots)) {
      throw new Error('workingDirectory must be an absolute path inside the allowlist roots');
    }
    workingDirectory = resolve(dir);
  }
  return { command, workingDirectory, timeoutMs };
}

function validatePathArg(args, name, roots) {
  const a = args && typeof args === 'object' ? args : {};
  const raw = String(a[name] ?? '');
  if (!raw || !isAbsolute(raw) || !isPathAllowed(raw, roots)) {
    throw new Error(`${name} must be an absolute path inside the allowlist roots`);
  }
  return resolve(raw);
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createLocalExecServer({
  roots = resolveRoots(),
  audit = createAuditLog(),
  execPowershell = defaultExecPowershell,
  approvalTimeoutMs = resolveAskTimeoutMs(),
  dryRun = false,
  subject = process.env.HELMION_LOCAL_MCP_SUBJECT || 'mcp-client',
  onPermissionEvent = () => {},
  envoyNotifier = null,
  clock = Date.now,
} = {}) {
  const brokerState = { envoyNotifier };
  const broker = createApprovalBroker({
    timeoutMs: approvalTimeoutMs,
    emit: (event) => {
      try { onPermissionEvent(event); } catch { /* notifier failure never breaks the gate */ }
      const notifier = brokerState.envoyNotifier;
      if (notifier && event.event === 'permission_request') {
        notifier.notify(event).catch(() => {});
      }
    },
  });

  async function auditCall(tool, args, decision, result, durationMs, ok) {
    await audit.append({
      subject,
      tool,
      argsHash: argsHash(args),
      decision,
      durationMs,
      ok: !!ok,
      resultSummary: summarizeResult(result),
    });
  }

  async function gated(tool, args, execute) {
    const started = clock();
    if (dryRun) {
      const result = { dryRun: true, wouldRun: summarizeToolCall(tool, args) };
      await auditCall(tool, args, 'dry-run', result, clock() - started, true);
      return result;
    }
    const decision = await broker.approver({ tool, args, workspace: roots[0], permissionMode: 'ask' });
    if (!isAllowed(decision)) {
      const result = {
        refused: true,
        reason: 'The human denied this action (or approval timed out). Nothing was executed.',
      };
      await auditCall(tool, args, decision, result, clock() - started, false);
      return result;
    }
    try {
      const result = await execute();
      await auditCall(tool, args, decision, result, clock() - started, true);
      return result;
    } catch (error) {
      const result = { error: error?.message ?? String(error) };
      await auditCall(tool, args, decision, result, clock() - started, false);
      return result;
    }
  }

  async function toolRunPowershell(args) {
    const validated = validatePowershellArgs(args, roots);
    try {
      await stat(validated.workingDirectory);
    } catch {
      throw new Error('workingDirectory does not exist');
    }
    return gated('helmion_run_powershell', validated, async () => {
      const out = await execPowershell(validated);
      if (out.spawnError) return { error: `PowerShell failed to start: ${out.stderr}` };
      return {
        exitCode: out.exitCode,
        timedOut: out.timedOut,
        truncated: out.truncated,
        stdout: out.stdout,
        stderr: out.stderr,
      };
    });
  }

  async function toolReadFile(args) {
    const started = clock();
    const filePath = validatePathArg(args, 'path', roots);
    let result;
    try {
      const st = await stat(filePath);
      if (!st.isFile()) throw new Error('path is not a file');
      if (st.size > MAX_READ_BYTES * 4) throw new Error('file is too large to read');
      const raw = await readFile(filePath, 'utf8');
      const capped = capOutput(raw, MAX_READ_BYTES);
      result = { path: filePath, bytes: st.size, truncated: capped.truncated, content: redactSecrets(capped.text) };
      await auditCall('helmion_read_file', { path: filePath }, 'n/a', result, clock() - started, true);
    } catch (error) {
      result = { error: error?.message ?? String(error) };
      await auditCall('helmion_read_file', { path: filePath }, 'n/a', result, clock() - started, false);
    }
    return result;
  }

  async function toolListDir(args) {
    const started = clock();
    const dirPath = validatePathArg(args, 'path', roots);
    let result;
    try {
      const st = await stat(dirPath);
      if (!st.isDirectory()) throw new Error('path is not a directory');
      const names = await readdir(dirPath);
      const truncated = names.length > MAX_LIST_ENTRIES;
      const entries = [];
      for (const name of names.slice(0, MAX_LIST_ENTRIES)) {
        let kind = 'other';
        try {
          const s = await stat(join(dirPath, name));
          kind = s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
        } catch { /* entry vanished; keep as other */ }
        entries.push({ name, kind });
      }
      result = { path: dirPath, truncated, entries };
      await auditCall('helmion_list_dir', { path: dirPath }, 'n/a', result, clock() - started, true);
    } catch (error) {
      result = { error: error?.message ?? String(error) };
      await auditCall('helmion_list_dir', { path: dirPath }, 'n/a', result, clock() - started, false);
    }
    return result;
  }

  async function toolWriteFile(args) {
    const a = args && typeof args === 'object' ? args : {};
    const filePath = validatePathArg(a, 'path', roots);
    const content = String(a.content ?? '');
    if (!content || Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES || content.includes('\0')) {
      throw new Error('content is invalid (empty, too large, or contains NUL)');
    }
    const validated = { path: filePath, content };
    return gated('helmion_write_file', { path: filePath, bytes: Buffer.byteLength(content, 'utf8') }, async () => {
      await mkdir(dirname(filePath), { recursive: true });
      // Re-check containment after resolving (TOCTOU note: a hostile local
      // process racing mkdir is out of scope; the check blocks confused-AI paths).
      if (!isPathAllowed(filePath, roots)) throw new Error('path escaped the allowlist roots');
      await writeFile(filePath, content, 'utf8');
      return { path: filePath, bytes: Buffer.byteLength(content, 'utf8'), written: true };
    });
  }

  async function callTool(name, args = {}, ctx = {}) {
    try {
      switch (name) {
        case 'helmion_run_powershell': return await toolRunPowershell(args);
        case 'helmion_read_file': return await toolReadFile(args);
        case 'helmion_list_dir': return await toolListDir(args);
        case 'helmion_write_file': return await toolWriteFile(args);
        default: throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      // Uniform shape: validation and execution failures come back as a
      // result the model can read, never an unhandled rejection.
      return { error: error?.message ?? String(error) };
    }
  }

  return {
    broker,
    roots,
    callTool,
    dryRun,
    approve: (message) => broker.handleResponse(message),
    pendingApprovals: () => broker.pendingCount,
    denyAllPending: (source) => broker.denyAllPending(source),
    setEnvoyNotifier: (notifier) => { brokerState.envoyNotifier = notifier; },
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing (shared by both transports)
// ---------------------------------------------------------------------------

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, message) {
  return { jsonrpc: '2.0', id, error: { code: -32000, message: String(message ?? 'error') } };
}

export function createJsonRpcHandler(server) {
  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
  return async function handle(message) {
    const id = message?.id ?? null;
    const method = message?.method;
    try {
      if (method === 'initialize') {
        return rpcResult(id, {
          protocolVersion: message?.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo,
        });
      }
      if (method === 'tools/list') {
        return rpcResult(id, { tools: TOOL_DEFINITIONS });
      }
      if (method === 'tools/call') {
        const result = await server.callTool(message?.params?.name, message?.params?.arguments ?? {});
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      }
      if (method === 'helmion/permission_response') {
        const ok = server.approve(message?.params ?? {});
        return id == null ? null : rpcResult(id, { ok });
      }
      if (method === 'notifications/initialized' || method?.startsWith?.('notifications/')) return null;
      if (id != null) return rpcError(id, `Unsupported method: ${method}`);
      return null;
    } catch (error) {
      return id == null ? null : rpcError(id, error?.message ?? String(error));
    }
  };
}

// ---------------------------------------------------------------------------
// stdio transport (Claude Code, desktop MCP clients)
// ---------------------------------------------------------------------------

export async function runStdioServer(options = {}) {
  const server = createLocalExecServer({
    ...options,
    onPermissionEvent: (event) => {
      if (options.onPermissionEvent) {
        try { options.onPermissionEvent(event); } catch { /* never break the gate */ }
      }
      if (event.event === 'permission_request' || event.event === 'permission_decision') {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'helmion/permission_request', params: event })}\n`);
      }
    },
  });
  if (options.envoyNotifier !== null) {
    attachEnvoyNotifier(server, options);
  }
  const handle = createJsonRpcHandler(server);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', async (line) => {
    if (!line.trim()) return;
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const res = await handle(message);
    if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
  });
  const shutdown = () => {
    server.denyAllPending('shutdown');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

// ---------------------------------------------------------------------------
// HTTP+SSE transport (localhost; Tailscale via explicit --bind + token)
// ---------------------------------------------------------------------------

/** Refuse public binds. Returns the address when acceptable. */
export function validateBindAddress(addr) {
  const a = String(addr ?? '').trim();
  const lowered = a.toLowerCase();
  if (!a || lowered === '0.0.0.0' || lowered === '::' || lowered === '::0' || lowered === '*') {
    throw new Error('refusing to bind a public address; use 127.0.0.1 or an explicit interface IP');
  }
  return a;
}

function isLoopback(addr) {
  const a = String(addr).toLowerCase();
  return a === '127.0.0.1' || a === '::1' || a === 'localhost';
}

export async function runHttpServer({
  port = Number(process.env.HELMION_LOCAL_MCP_PORT) || DEFAULT_HTTP_PORT,
  bind = process.env.HELMION_LOCAL_MCP_BIND || '127.0.0.1',
  token = process.env.HELMION_LOCAL_MCP_TOKEN || '',
  ...options
} = {}) {
  const bindAddr = validateBindAddress(bind);
  if (!isLoopback(bindAddr) && !token) {
    throw new Error('non-loopback bind requires HELMION_LOCAL_MCP_TOKEN (bearer)');
  }
  const sseClients = new Set();
  const server = createLocalExecServer({
    ...options,
    onPermissionEvent: (event) => {
      if (options.onPermissionEvent) {
        try { options.onPermissionEvent(event); } catch { /* never break the gate */ }
      }
      if (event.event !== 'permission_request' && event.event !== 'permission_decision') return;
      const data = `event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const res of [...sseClients]) {
        try { res.write(data); } catch { sseClients.delete(res); }
      }
    },
  });
  if (options.envoyNotifier !== null) {
    attachEnvoyNotifier(server, options);
  }
  const handle = createJsonRpcHandler(server);

  const readBody = (req, max = 4 * 1024 * 1024) => new Promise((resolvePromise, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > max) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  const authorized = (req) => {
    if (isLoopback(bindAddr)) return true;
    const header = String(req.headers.authorization ?? '');
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!presented || !token) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      if (!authorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, server: SERVER_NAME, version: SERVER_VERSION }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/mcp/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/approvals/pending') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pending: server.pendingApprovals() }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/approvals/decide') {
        const body = JSON.parse(await readBody(req, 16 * 1024));
        const ok = server.approve(body ?? {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok }));
        return;
      }
      if (req.method === 'POST' && (url.pathname === '/mcp' || url.pathname === '/')) {
        const body = JSON.parse(await readBody(req));
        const response = await handle(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response ?? { jsonrpc: '2.0', id: body?.id ?? null, result: { acknowledged: true } }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error?.message ?? String(error) }));
    }
  });

  await new Promise((resolvePromise, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(port, bindAddr, resolvePromise);
  });
  const boundPort = httpServer.address()?.port ?? port;
  const shutdown = () => {
    server.denyAllPending('shutdown');
    httpServer.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { server, httpServer, port: boundPort, bind: bindAddr };
}

// ---------------------------------------------------------------------------
// Envoy approval notifier: approvals reach Troy's phone via the /app channel.
//
// The cloud approvals inbox only understands artifact_execution_request, so
// v1 posts a human-readable approval request to the envoy team channel using
// the same device token the PC bridge uses. Troy replies
// "approve <id>" / "deny <id>" from /app on his phone; the notifier settles
// the broker. The notifier never breaks the approval flow: if the token file
// is missing or the cloud is unreachable, approvals still work over the
// active transport (stdio host dialog / HTTP localhost API).
// ---------------------------------------------------------------------------

/**
 * Parse "approve perm-1-abc" / "deny perm-1-abc" from a chat reply.
 * Returns { id, decision } or null. Exported for tests.
 */
export function parseApprovalReply(text) {
  const match = /^\s*(approve|allow|yes|deny|reject|no)\s+(perm-[A-Za-z0-9_-]+)\s*$/i.exec(String(text ?? ''));
  if (!match) return null;
  const word = match[1].toLowerCase();
  return {
    id: match[2],
    decision: word === 'approve' || word === 'allow' || word === 'yes' ? 'approve' : 'deny',
  };
}

export function createEnvoyApprovalNotifier({
  broker,
  cloudUrl = CLOUD_URL,
  tokenPath = defaultTokenPath(),
  channelSlug = process.env.HELMION_LOCAL_MCP_APPROVAL_CHANNEL || 'team',
  fetchFn = fetch,
  pollMs = 5000,
  log = () => {},
} = {}) {
  if (!broker) throw new TypeError('createEnvoyApprovalNotifier requires a broker');
  let creds = null;
  let channelId = null;
  let polling = false;
  const seen = new Set();

  async function loadCreds() {
    const raw = await readFile(tokenPath, 'utf8');
    const data = JSON.parse(raw);
    if (!data?.token) throw new Error('no token in bridge token file');
    return { token: String(data.token), tenantId: data.tenantId ?? null };
  }

  async function api(pathname, { method = 'GET', body = null } = {}) {
    const res = await fetchFn(`${cloudUrl}${pathname}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creds.token}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`cloud ${method} ${pathname} -> ${res.status}`);
    return res.json();
  }

  async function resolveChannel() {
    const data = await api('/api/admin/envoy/channels');
    const channel = (data?.channels ?? []).find((c) => c.slug === channelSlug);
    if (!channel?.id) throw new Error(`envoy channel "${channelSlug}" not found`);
    return channel.id;
  }

  function trimSeen() {
    if (seen.size > 200) {
      const keep = [...seen].slice(-200);
      seen.clear();
      for (const id of keep) seen.add(id);
    }
  }

  async function pollLoop() {
    while (broker.pendingCount > 0) {
      try {
        const data = await api(`/api/admin/envoy/messages?channel_id=${encodeURIComponent(channelId)}`);
        for (const message of data?.messages ?? []) {
          if (typeof message?.id !== 'string' || seen.has(message.id)) continue;
          seen.add(message.id);
          if (message.authorKind !== 'human') continue; // our own posts are agent-kind
          const parsed = parseApprovalReply(message.body);
          if (parsed) broker.handleResponse(parsed);
        }
        trimSeen();
      } catch (error) {
        log(`envoy approval poll failed: ${error?.message ?? error}`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    polling = false;
  }

  function startPolling() {
    if (polling) return;
    polling = true;
    void pollLoop();
  }

  /** Post the approval request to the channel. Never throws. */
  async function notify(permissionRequest) {
    try {
      if (!creds) creds = await loadCreds();
      if (!channelId) channelId = await resolveChannel();
      const summary = permissionRequest.summary ?? permissionRequest.tool ?? 'local tool call';
      await api('/api/admin/envoy/messages', {
        method: 'POST',
        body: {
          channelId,
          body: `MCP approval needed (${permissionRequest.id}): ${summary}\nReply "approve ${permissionRequest.id}" or "deny ${permissionRequest.id}".`,
          idempotencyKey: `mcp-approval:${permissionRequest.id}`,
        },
      });
      startPolling();
    } catch (error) {
      log(`envoy approval notify failed (approvals still work locally): ${error?.message ?? error}`);
    }
  }

  return { notify, parseApprovalReply };
}

/**
 * Attach the envoy notifier unless explicitly disabled. Silent when the
 * bridge token file is absent (approvals still work over the transport).
 */
export function attachEnvoyNotifier(server, { enabled = process.env.HELMION_LOCAL_MCP_ENVOY_NOTIFY !== '0', log = () => {} } = {}) {
  if (!enabled) {
    log('envoy approval notifications disabled');
    return null;
  }
  const notifier = createEnvoyApprovalNotifier({ broker: server.broker, log });
  server.setEnvoyNotifier(notifier);
  return notifier;
}
