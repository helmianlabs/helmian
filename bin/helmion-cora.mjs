#!/usr/bin/env node
/**
 * Run the local Cora CLM backend — Hume EVI's voice, Helmion's agent.
 *
 *   node bin/helmion-cora.mjs
 *   node bin/helmion-cora.mjs --workspace E:\Helmion --permission full
 *   node bin/helmion-cora.mjs --port 7421 --provider claude --tier standard
 *
 * OFF BY DEFAULT and FOREGROUND ONLY. Nothing autostarts this: no service, no
 * login hook, no detach. It runs while you watch it and stops with Ctrl-C —
 * which is the correct posture for a socket that can run tools by voice.
 *
 * IT BINDS 127.0.0.1. A non-loopback bind without --token is refused at
 * startup, not warned about (src/cora/clm-server.mjs resolveAccess).
 *
 * Phase 1 is LOCAL ONLY. Pointing a live Hume EVI config at this needs a Hume
 * account and a publicly reachable URL; neither is in scope here, and this
 * command does not pretend otherwise. `--self-test` proves the server against a
 * simulated Hume client on this machine, with no Hume account involved.
 */

import { startCoraClm, DEFAULT_CORA_PORT, DEFAULT_CORA_PATH } from '../src/cora/clm-server.mjs';

function parseFlags(argv) {
  const out = {
    workspace: process.cwd(),
    host: '127.0.0.1',
    port: DEFAULT_CORA_PORT,
    path: DEFAULT_CORA_PATH,
    provider: 'claude',
    tier: 'standard',
    permission: 'read-tools',
    token: process.env.HELMION_CORA_TOKEN || null,
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--workspace') out.workspace = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--path') out.path = argv[++i];
    else if (a === '--provider') out.provider = argv[++i];
    else if (a === '--tier') out.tier = argv[++i];
    else if (a === '--permission' || a === '--permissions') out.permission = argv[++i];
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function usage() {
  return `Cora CLM — Hume EVI's voice on Helmion's agent, locally

  node bin/helmion-cora.mjs [flags]

  --workspace <path>   folder the agent works in        (default: cwd)
  --host <addr>        bind address                     (default: 127.0.0.1)
  --port <n>           bind port                        (default: ${DEFAULT_CORA_PORT})
  --path <path>        WebSocket path                   (default: ${DEFAULT_CORA_PATH})
  --provider <name>    openai | claude | gemini | grok  (default: claude)
  --tier <t>           fast | standard | deep           (default: standard = claude-sonnet-5)
  --permission <mode>  read-only | read-tools | ask | full   (default: read-tools)
  --token <secret>     required for any non-loopback bind; also HELMION_CORA_TOKEN
  --quiet              only errors on stdout

  A chat is "Helmion mode" — tools enabled — when its Hume custom_session_id
  starts with "helmion". Any other session, including one with no id, runs
  read-only. That is a fail-closed default and it is deliberate.
`;
}

const flags = parseFlags(process.argv.slice(2));
if (flags.help) {
  process.stdout.write(usage());
  process.exit(0);
}

const logger = ({ level, event, ...rest }) => {
  if (flags.quiet && level !== 'error') return;
  const detail = Object.entries(rest)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  process.stdout.write(`[cora ${level}] ${event}${detail ? ` ${detail}` : ''}\n`);
};

let server;
try {
  server = await startCoraClm({
    workspace: flags.workspace,
    host: flags.host,
    port: flags.port,
    path: flags.path,
    token: flags.token,
    providerName: flags.provider,
    permissionMode: flags.permission,
    tier: flags.tier,
    logger,
  });
} catch (err) {
  process.stderr.write(`Cora CLM did not start: ${err.message}\n`);
  process.exit(1);
}

process.stdout.write(
  `Cora CLM listening\n`
  + `  socket:     ${server.url}\n`
  + `  workspace:  ${flags.workspace}\n`
  + `  provider:   ${server.provider?.label ?? flags.provider} (tier ${flags.tier})\n`
  + `  permission: ${flags.permission} — only for sessions marked helmion:*\n`
  + `  token:      ${server.requiresToken ? 'required' : 'not required (loopback)'}\n`
  + `  stop:       Ctrl-C\n`,
);

const shutdown = async (signal) => {
  process.stdout.write(`\n${signal} — closing Cora CLM.\n`);
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
