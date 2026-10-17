#!/usr/bin/env node
// Helmian local-execution MCP server entry point.
//
// Governed local hands for any AI: PowerShell + file tools on this PC behind
// a human approval gate. Disabled by default; opt in per run.
//
//   HELMION_LOCAL_MCP=1 node bin/mcp-helmion-local.mjs                 # stdio (Claude Code)
//   HELMION_LOCAL_MCP=1 node bin/mcp-helmion-local.mjs --http          # localhost HTTP+SSE
//   node bin/mcp-helmion-local.mjs --serve --dry-run                   # describe, never execute
//   node bin/mcp-helmion-local.mjs --serve --http --port 7430 --bind 127.0.0.1
//
// Env:
//   HELMION_LOCAL_MCP=1            enable (or --serve)
//   HELMION_LOCAL_MCP_HTTP=1       HTTP transport (or --http)
//   HELMION_LOCAL_MCP_PORT         HTTP port (default 7430)
//   HELMION_LOCAL_MCP_BIND         HTTP bind IP (default 127.0.0.1; never 0.0.0.0)
//   HELMION_LOCAL_MCP_TOKEN        bearer token, required for non-loopback bind
//   HELMION_LOCAL_MCP_ROOTS        comma-separated extra allowlist roots, e.g. E:\Caldmere
//   HELMION_LOCAL_MCP_DRY_RUN=1    describe what would run, never execute
//   HELMION_LOCAL_MCP_ENVOY_NOTIFY=0  disable phone approval notifications
//   HELMION_LOCAL_MCP_APPROVAL_CHANNEL  envoy channel slug for approvals (default team)
//   HELMION_ASK_TIMEOUT_MS         approval wait before deny (default 300000)
//   HELMION_POWERSHELL_BIN         powershell binary override (for testing)
//   HELMION_LOCAL_MCP_SUBJECT      audit subject label (default mcp-client)

import { runStdioServer, runHttpServer } from '../src/mcp/local-exec-server.mjs';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, def = null) => {
  const idx = argv.indexOf(flag);
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : def;
};

const serve = has('--serve') || process.env.HELMION_LOCAL_MCP === '1';
if (!serve) {
  console.error('Helmian local-exec MCP server is disabled by default.');
  console.error('');
  console.error('This server executes code on your PC. Enable it explicitly:');
  console.error('  HELMION_LOCAL_MCP=1 node bin/mcp-helmion-local.mjs        # stdio');
  console.error('  node bin/mcp-helmion-local.mjs --serve --http              # localhost HTTP');
  console.error('  node bin/mcp-helmion-local.mjs --serve --dry-run           # describe only');
  process.exit(2);
}

const dryRun = has('--dry-run') || process.env.HELMION_LOCAL_MCP_DRY_RUN === '1';
const http = has('--http') || process.env.HELMION_LOCAL_MCP_HTTP === '1';
const log = (...args) => console.error('[mcp-local]', ...args);

if (http) {
  const port = Number(valueOf('--port', process.env.HELMION_LOCAL_MCP_PORT)) || 7430;
  const bind = valueOf('--bind', process.env.HELMION_LOCAL_MCP_BIND) || '127.0.0.1';
  const { port: bound, bind: boundAddr } = await runHttpServer({ port, bind, dryRun, log });
  log(`listening on ${boundAddr}:${bound}${dryRun ? ' (dry-run: nothing will execute)' : ''}`);
} else {
  await runStdioServer({ dryRun, log });
  log(`stdio ready${dryRun ? ' (dry-run: nothing will execute)' : ''}`);
}
