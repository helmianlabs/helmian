// The tool-connection probe: the ONLY path by which a tool connection
// becomes 'verified' (sql/061, src/cloud/tool-connections.mjs, research
// note helmian-connectors-2026-10-25 §4).
//
// A probe is a real check, not a flag flip: it connects to the registered
// MCP server with the repo's own clients (stdio: src/agent/mcp-client.mjs;
// remote HTTP: src/agent/mcp-remote-client.mjs, reused byte-for-byte from
// the hands-attachment work), runs tools/list, and writes the RECEIPT —
// verified + how many tools answered + the database timestamp — through
// the store's recordProbeReceipt. Every failure writes a failure receipt
// instead: state 'failed', the error kept, the old verified freshness
// cleared by the store.
//
// THE CREDENTIAL IS RESOLVED AT PROBE TIME, NEVER STORED. The row holds
// only a credential_reference; the token is read fresh here (token source
// via resolveMcpTokenSource; vault references via an injected resolver),
// handed to the client for this one connection, and never written back —
// and it is scrubbed out of any error text before that text is recorded.

import { createMcpClient, DEFAULT_TIMEOUT_MS } from './mcp-client.mjs';
import { createRemoteMcpClient, resolveMcpTokenSource } from './mcp-remote-client.mjs';
import { PROBE_METHOD_TOOLS_LIST } from '../cloud/tool-connections.mjs';

export const TOOL_PROBE_SUBJECT = 'system:tool-probe';

function scrubSecret(text, secret) {
  const out = String(text ?? '');
  if (!secret) return out;
  return out.split(secret).join('•••');
}

/**
 * A stdio server_ref may be a JSON config target naming the launch spec
 * ({"command": "...", "args": [...]}). A plugin reference
 * ("plugin:<id>:<name>") is NOT launchable by itself — the plugin layer
 * resolves it, injected as resolveStdioLaunch by the caller.
 */
export function parseStdioLaunchRef(serverRef) {
  if (typeof serverRef !== 'string') return null;
  let parsed;
  try { parsed = JSON.parse(serverRef); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.command !== 'string' || !parsed.command.trim()) return null;
  const args = parsed.args ?? [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) return null;
  return { command: parsed.command.trim(), args };
}

/**
 * Probe one registered tool connection.
 *
 * @param {{store: object, tenantId: string,
 *          key: {scopeKind: string, scopeId: string, serviceId: string},
 *          subject?: string, timeoutMs?: number,
 *          env?: object, readFileImpl?: Function, fetchImpl?: Function,
 *          spawnFn?: Function,
 *          resolveVaultToken?: (ref: string, row: object) => Promise<string>,
 *          resolveStdioLaunch?: (row: object) => Promise<object|null>}} options
 * @returns {Promise<{probed: boolean, state: string, toolsCount?: number, error?: string, row: object|null}>}
 */
export async function probeToolConnection({
  store,
  tenantId,
  key,
  subject = TOOL_PROBE_SUBJECT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env,
  readFileImpl,
  fetchImpl,
  spawnFn,
  resolveVaultToken,
  resolveStdioLaunch,
} = {}) {
  if (!store || typeof store.get !== 'function') throw new Error('probeToolConnection needs a tool connections store');
  const row = await store.get(tenantId, key);
  if (!row) {
    throw Object.assign(new Error('tool connection not found'), { status: 404 });
  }
  if (row.state === 'revoked') {
    return { probed: false, state: 'revoked', row };
  }

  await store.beginProbe(tenantId, key, subject);

  let token = null;
  let client = null;
  const fail = async (error, method = PROBE_METHOD_TOOLS_LIST) => {
    const clean = scrubSecret(error?.message ?? String(error), token).slice(0, 2000);
    const failed = await store.recordProbeFailure(tenantId, key, { method, error: clean }, subject);
    return { probed: true, state: 'failed', error: clean, row: failed };
  };

  try {
    // Resolve the credential fresh, from the reference only.
    const reference = row.credentialReference ?? null;
    if (reference?.type === 'token-source') {
      const resolved = await resolveMcpTokenSource(reference.source, { env, readFileImpl });
      if (resolved.problem) return await fail(new Error(resolved.problem));
      token = resolved.token;
    } else if (reference?.type === 'vault') {
      if (typeof resolveVaultToken !== 'function') {
        return await fail(new Error('this host cannot resolve vault credential references yet, so the probe cannot run'));
      }
      try {
        token = await resolveVaultToken(reference.ref, row);
      } catch (error) {
        return await fail(new Error(`the vault credential could not be resolved: ${error?.message ?? error}`));
      }
    }

    // Connect with the repo's existing clients — no new transport code.
    if (row.kind === 'mcp-http') {
      client = await createRemoteMcpClient({ url: row.serverRef, token, timeoutMs, ...(fetchImpl ? { fetchImpl } : {}) });
    } else if (row.kind === 'mcp-stdio') {
      const launch = (typeof resolveStdioLaunch === 'function' ? await resolveStdioLaunch(row) : null)
        ?? parseStdioLaunchRef(row.serverRef);
      if (!launch) {
        return await fail(new Error('server_ref does not resolve to a launchable stdio server on this host'));
      }
      client = await createMcpClient({
        command: launch.command,
        args: launch.args ?? [],
        ...(launch.env ? { env: launch.env } : {}),
        timeoutMs,
        ...(spawnFn ? { spawnFn } : {}),
      });
    } else if (row.kind === 'native') {
      return await fail(
        new Error('a native connection has no MCP tools/list surface — its truth is sign-in presence, not a tool probe'),
        'none:native',
      );
    } else {
      return await fail(new Error(`unknown tool connection kind ${JSON.stringify(row.kind)}`));
    }

    const tools = await client.listTools();
    const verified = await store.recordProbeReceipt(
      tenantId, key, { method: PROBE_METHOD_TOOLS_LIST, toolsCount: tools.length }, subject,
    );
    return { probed: true, state: 'verified', toolsCount: tools.length, row: verified };
  } catch (error) {
    return await fail(error);
  } finally {
    if (client) {
      try { await client.close(); } catch { /* a probe never hangs on teardown */ }
    }
  }
}
