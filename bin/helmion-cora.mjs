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

import {
  startCoraClm,
  DEFAULT_CORA_HEALTH_PATH,
  DEFAULT_CORA_PORT,
  DEFAULT_CORA_PATH,
} from '../src/cora/clm-server.mjs';
import { readHelmionEnv } from '../src/agent/env.mjs';
import {
  CORA_PROVIDER_READINESS_INVALID_CONFIGURATION,
  inspectCoraProviderReadiness,
} from '../src/cora/provider-readiness.mjs';
import { runCoraSelfTest } from '../src/cora/self-test.mjs';
import { createLiveHelmianCloudAdminHandler, shouldMountLiveAdmin } from '../src/cloud/live-admin.mjs';

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
    // Browser origins allowed to open the socket. Empty = every browser
    // refused; a peer that sends no Origin at all is not a browser and is
    // judged on its token instead. See src/cora/ws-server.mjs.
    allowOrigin: [],
    agentNotify: true,
    providerStatus: false,
    selfTest: false,
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--workspace') out.workspace = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--path') out.path = argv[++i];
    else if (a === '--provider') out.provider = argv[++i] ?? '';
    else if (a === '--tier') out.tier = argv[++i];
    else if (a === '--permission' || a === '--permissions') out.permission = argv[++i];
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--allow-origin') out.allowOrigin.push(argv[++i]);
    else if (a === '--no-agent-notify') out.agentNotify = false;
    else if (a === '--provider-status') out.providerStatus = true;
    else if (a === '--self-test') out.selfTest = true;
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
  health: GET ${DEFAULT_CORA_HEALTH_PATH} (add ?detail=1 for bounded redacted diagnostics)
          Bearer token required when the socket bind requires one
  --provider <name>    openai | claude | gemini | grok  (default: claude)
  --tier <t>           fast | standard | deep           (default: standard = claude-sonnet-5)
  --permission <mode>  read-only | read-tools | ask | full   (default: read-tools)
  --token <secret>     required for any non-loopback bind; also HELMION_CORA_TOKEN
  HELMION_AIMFORGE_BRIDGE_SECRET
                       required for any non-loopback bind (minimum 32 bytes).
                       Must exactly match AimForge's server-side secret.
  --allow-origin <o>   let a BROWSER at this origin open the socket (repeatable).
                       Default: none. A peer sending no Origin header is not a
                       browser and is unaffected — that is how a server-side
                       client such as Hume's cloud connects.
  --no-agent-notify    do not announce background agents finishing
  --provider-status     print secret-free provider readiness and exit; never starts Cora
  --self-test           run a provider-free local WebSocket/policy smoke test and exit
  --quiet              only errors on stdout

  Cloud sessions are "Helmion mode" only after the HMAC-signed AimForge
  custom_session_id is verified. Loopback development keeps the legacy
  helmion:* marker; any other local session runs read-only.
`;
}

const flags = parseFlags(process.argv.slice(2));
if (flags.help) {
  process.stdout.write(usage());
  process.exit(0);
}

if (flags.providerStatus) {
  let readiness;
  try {
    readiness = inspectCoraProviderReadiness({
      providerName: flags.provider,
      env: readHelmionEnv(flags.workspace),
    });
  } catch {
    readiness = CORA_PROVIDER_READINESS_INVALID_CONFIGURATION;
  }
  process.stdout.write(`${JSON.stringify(readiness)}\n`);
  process.exitCode = readiness.ready ? 0 : 1;
} else if (flags.selfTest) {
  try {
    const result = await runCoraSelfTest({ workspace: flags.workspace });
    process.stdout.write(
      `Cora self-test passed (${result.turns} turns: ${result.policyModes.join(', ')}).\n`,
    );
    process.exitCode = 0;
  } catch (err) {
    process.stderr.write(`Cora self-test failed: ${err.message}\n`);
    process.exitCode = 1;
  }
}

if (!flags.providerStatus && !flags.selfTest) {
const logger = ({ level, event, ...rest }) => {
  if (flags.quiet && level !== 'error') return;
  const detail = Object.entries(rest)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  process.stdout.write(`[cora ${level}] ${event}${detail ? ` ${detail}` : ''}\n`);
};

let server;
let liveAdmin;
try {
  if (shouldMountLiveAdmin(process.env)) {
    liveAdmin = await createLiveHelmianCloudAdminHandler({ logger });
  }
  server = await startCoraClm({
    workspace: flags.workspace,
    host: flags.host,
    port: flags.port,
    path: flags.path,
    token: flags.token,
    providerName: flags.provider,
    permissionMode: flags.permission,
    tier: flags.tier,
    allowedOrigins: flags.allowOrigin,
    notifyBackgroundAgents: flags.agentNotify,
    httpRequestHandler: liveAdmin?.handler,
    globalActionPolicyResolver: liveAdmin?.resolveActionPolicy,
    logger,
  });
} catch (err) {
  await liveAdmin?.close?.().catch(() => {});
  process.stderr.write(`Cora CLM did not start: ${err.message}\n`);
  process.exit(1);
}

process.stdout.write(
  `Cora CLM listening\n`
  + `  socket:     ${server.url}\n`
  + `  health:     ${server.healthUrl}\n`
  + `  workspace:  ${flags.workspace}\n`
  + `  provider:   ${server.provider?.label ?? flags.provider} (tier ${flags.tier})\n`
  + `  permission: ${flags.permission} — only for sessions marked helmion:*\n`
  + `  token:      ${server.requiresToken ? 'required' : 'not required (loopback)'}\n`
  + `  sessions:   ${server.requiresSignedSessions ? 'signed AimForge context required' : 'local development policy'}\n`
  + `  origins:    ${flags.allowOrigin.length ? flags.allowOrigin.join(', ') : 'no browser origin allowed (non-browser peers unaffected)'}\n`
  + `  agents:     ${flags.agentNotify ? 'background completions announced' : 'notifications off'}\n`
  + `  stop:       Ctrl-C\n`,
);

const shutdown = async (signal) => {
  process.stdout.write(`\n${signal} — closing Cora CLM.\n`);
  await server.close();
  await liveAdmin?.close?.();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
