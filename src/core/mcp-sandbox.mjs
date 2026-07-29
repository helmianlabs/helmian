// Stage 3 of the MCP install security pipeline: RUN IT WHERE IT CAN'T HURT YOU.
//
// Copies the candidate into a throwaway directory, builds a scrubbed
// environment from an ALLOWLIST, injects the observer from
// mcp-sandbox-observer.mjs, runs the server, and reports what it actually
// tried to do.

import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const OBSERVER_PATH = join(here, 'mcp-sandbox-observer.mjs');

/**
 * The ONLY variables allowed through to a candidate, before its own declared
 * configuration is added back as obvious placeholders.
 *
 * This is an allowlist, not a denylist, on purpose: a denylist has to predict
 * every secret-shaped name that will ever exist in Troy's environment, and it
 * only has to miss once. An allowlist fails closed — a new secret added to the
 * machine tomorrow is excluded because it was never named here.
 *
 * USERPROFILE / HOME / APPDATA are deliberately EXCLUDED even though they are
 * not secrets: they are the map to where the secrets live.
 */
export const DEFAULT_ENV_ALLOWLIST = Object.freeze([
  'SystemRoot', 'windir', 'COMSPEC', 'PATHEXT', 'OS',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'TZ',
]);

/**
 * Belt-and-braces check applied to every variable that survives the allowlist.
 * If the allowlist is ever widened carelessly, this still drops secret-shaped
 * names and records that it did.
 */
export const SECRET_NAME_PATTERNS = Object.freeze([
  /API[_-]?KEY/i, /\bTOKEN\b/i, /_TOKEN$/i, /SECRET/i, /PASSWORD/i, /PASSWD/i,
  /DATABASE_URL/i, /CONNECTION_STRING/i, /CREDENTIAL/i, /PRIVATE/i,
  /_KEY$/i, /^AWS_/i, /^AZURE_/i, /^GH_/i, /^GITHUB_/i, /^NPM_/i, /SESSION/i,
]);

export function isSecretShapedName(name) {
  return SECRET_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Build the environment the candidate will actually see.
 *
 * Returns both the env and the AUDIT of what was withheld, so a report can
 * state exactly which real variables were kept out rather than asserting
 * "secrets were removed" with nothing behind it.
 */
export function buildScrubbedEnv({
  declared = {},
  runId,
  eventLogPath,
  canaryToken,
  policy = 'block',
  baseEnv = process.env,
  allowlist = DEFAULT_ENV_ALLOWLIST,
} = {}) {
  const env = Object.create(null);
  const kept = [];
  const droppedSecretShaped = [];

  for (const name of allowlist) {
    const value = baseEnv[name];
    if (value === undefined) continue;
    if (isSecretShapedName(name)) { droppedSecretShaped.push(name); continue; }
    env[name] = value;
    kept.push(name);
  }

  // The candidate's declared configuration is supplied as OBVIOUS PLACEHOLDERS.
  // It gets the shape it asked for and none of Troy's real values.
  const placeholders = [];
  for (const name of declared.allowedEnv ?? []) {
    env[name] = `helmion-sandbox-placeholder-${String(name).toLowerCase()}`;
    placeholders.push(name);
  }

  // Sandbox control channel. HELMION_SANDBOX_RUN_ID doubles as the marker the
  // poisoned test fixture checks before it will do anything at all.
  env.HELMION_SANDBOX_RUN_ID = runId;
  env.HELMION_SANDBOX_EVENT_LOG = eventLogPath;
  env.HELMION_SANDBOX_POLICY = policy;
  if (canaryToken) env.HELMION_SANDBOX_CANARY_TOKEN = canaryToken;

  const withheld = Object.keys(baseEnv).filter((name) => !(name in env));

  return { env, kept, placeholders, droppedSecretShaped, withheld };
}

/**
 * The statement that ships with EVERY sandbox report. It is deliberately blunt
 * about what this does not do, because "sandboxed" is a word that invites
 * people to stop thinking.
 */
export function isolationStatement() {
  return {
    achieved: 'process-level: scrubbed allowlist environment + throwaway working directory + in-process API interception',
    isNot: 'a virtual machine, a container, a Windows AppContainer, a restricted/low-integrity token, a seccomp or AppArmor profile, or any OS-enforced boundary',
    protectsAgainst: [
      'credentials reaching the candidate through the ENVIRONMENT (allowlist; real values never passed)',
      'writes landing anywhere but the throwaway directory (blocked and recorded)',
      'reads of credential-shaped paths through the JS fs API (blocked and recorded)',
      'network calls and subprocess launches through the JS APIs (blocked and recorded)',
    ],
    doesNotProtectAgainst: [
      'the process runs as the INVOKING USER with that user\'s full permissions — everything Troy can read on disk, it can read',
      'native addons (.node), WASM, or any code path that does not go through the patched JavaScript APIs',
      'a Worker thread or child started before the observer is reachable',
      'the candidate re-importing a clean copy of a builtin to escape the patch',
      'a candidate that simply behaves while observed and misbehaves later',
      'resource exhaustion (CPU, memory, disk) beyond the wall-clock timeout',
    ],
    conclusion: 'Treat a clean sandbox run as "did not misbehave in this run", never as "is safe". It is evidence for the human at stage 4, not a substitute for them.',
  };
}

function summarizeEvents(events, declared) {
  const allowedHosts = declared.allowedHosts ?? [];
  const network = events.filter((e) => e.channel === 'network');
  const processEvents = events.filter((e) => e.channel === 'process');
  const filesystem = events.filter((e) => e.channel === 'filesystem');
  const env = events.filter((e) => e.channel === 'env');

  const hosts = new Set();
  for (const event of network) {
    try {
      hosts.add(new URL(event.detail).hostname.toLowerCase());
    } catch {
      hosts.add(String(event.detail));
    }
  }
  const undeclaredHosts = [...hosts].filter((host) => !allowedHosts.some((a) => {
    const allowed = String(a).toLowerCase();
    return host === allowed || host.endsWith(`.${allowed}`);
  }));

  return {
    networkAttempts: network.length,
    contactedHosts: [...hosts],
    undeclaredHosts,
    subprocessAttempts: processEvents.length,
    subprocessCommands: processEvents.map((e) => e.detail),
    writesOutsideSandbox: filesystem.filter((e) => e.outsideSandbox).map((e) => e.detail),
    credentialPathReads: filesystem.filter((e) => e.credentialPath).map((e) => e.detail),
    envEnumerated: env.some((e) => e.action === 'enumerate'),
    envNamesRead: [...new Set(env.filter((e) => e.action === 'read').map((e) => e.detail))],
    canaryLeakAttempts: events.filter((e) => e.canaryLeak).length,
  };
}

/**
 * Stage 3 entry point.
 *
 * `root` is copied — the original candidate directory is never the working
 * copy, so anything the server writes lands in the throwaway and is discarded.
 */
export async function runSandboxedCandidate({
  root,
  entry = 'index.mjs',
  declared = {},
  timeoutMs = 15000,
  policy = 'block',
  baseEnv = process.env,
  keepWorkdir = false,
} = {}) {
  const runId = randomUUID();
  const canaryToken = `HELMION-CANARY-${randomBytes(12).toString('hex')}`;
  const workdir = await mkdtemp(join(tmpdir(), 'helmion-mcp-sandbox-'));
  const candidateDir = join(workdir, 'candidate');
  const eventLogPath = join(workdir, 'events.jsonl');

  try {
    await cp(resolve(root), candidateDir, { recursive: true });
    await writeFile(eventLogPath, '');

    const { env, kept, placeholders, droppedSecretShaped, withheld } = buildScrubbedEnv({
      declared, runId, eventLogPath, canaryToken, policy, baseEnv,
    });

    const entryPath = join(candidateDir, entry);
    if (!existsSync(entryPath)) throw new Error(`Sandbox entry point not found: ${entry}`);

    const child = spawn(
      process.execPath,
      ['--import', pathToFileURL(OBSERVER_PATH).href, entryPath],
      {
        cwd: candidateDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const { code, signal } = await new Promise((resolveExit) => {
      child.on('close', (exitCode, exitSignal) => resolveExit({ code: exitCode, signal: exitSignal }));
      child.on('error', (error) => resolveExit({ code: null, signal: null, error }));
    });
    clearTimeout(timer);

    const logText = await readFile(eventLogPath, 'utf8').catch(() => '');
    const events = logText.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    const observed = summarizeEvents(events, declared);

    // EVIDENCE INTEGRITY. The observer always records an `observer-ready` line;
    // if that line is missing, or it reported a logging failure, then this run
    // produced NO trustworthy record of what the candidate did. That must never
    // be reported as clean — an empty log and a well-behaved server look
    // identical, and one of them is a hostile server whose audit trail failed.
    //
    // This check exists because it actually happened: the observer's own log
    // write was being blocked by the observer's own filesystem guard, and the
    // harness reported the poisoned fixture as "no observed misbehaviour" while
    // every hostile call was in fact firing.
    const loggingFailures = (stderr.match(/HELMION_SANDBOX_LOG_FAILURE: .*/g) ?? []);
    const observerReady = events.some((e) => e.channel === 'sandbox' && e.action === 'observer-ready');
    const evidenceComplete = observerReady && loggingFailures.length === 0;

    // The environment proof: the candidate's own view, as recorded by the
    // observer, must contain no real secret value.
    const canaryLeaked = observed.canaryLeakAttempts > 0;
    const misbehaved = observed.undeclaredHosts.length > 0
      || observed.subprocessAttempts > 0
      || observed.writesOutsideSandbox.length > 0
      || observed.credentialPathReads.length > 0
      || observed.envEnumerated
      || canaryLeaked;

    return {
      stage: 'sandbox',
      runId,
      root: resolve(root),
      entry,
      workdir: keepWorkdir ? workdir : '(discarded)',
      exitCode: code,
      signal,
      timedOut,
      stdout,
      stderr,
      events,
      observed,
      environment: {
        keptNames: kept,
        placeholderNames: placeholders,
        droppedSecretShaped,
        withheldCount: withheld.length,
        withheldNames: withheld,
        canaryToken,
      },
      evidence: {
        complete: evidenceComplete,
        observerReady,
        loggingFailures,
        eventCount: events.length,
      },
      // Order matters: misbehaviour that WAS observed is still the headline,
      // but a run with broken evidence can never be reported as clean.
      verdict: misbehaved
        ? 'misbehaved'
        : evidenceComplete
          ? 'no-observed-misbehaviour'
          : 'evidence-missing',
      isolation: isolationStatement(),
    };
  } finally {
    if (!keepWorkdir) await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

export function formatSandboxReport(report) {
  const o = report.observed;
  const lines = [];
  lines.push(`SANDBOX — run ${report.runId}`);
  lines.push(`  exit=${report.exitCode} signal=${report.signal ?? 'none'} timedOut=${report.timedOut}   verdict: ${report.verdict.toUpperCase()}`);
  lines.push(`  evidence: ${report.evidence.eventCount} events recorded, complete=${report.evidence.complete}`);
  for (const failure of report.evidence.loggingFailures) lines.push(`  EVIDENCE FAILURE: ${failure}`);
  lines.push(`  env: passed ${report.environment.keptNames.length} allowlisted + ${report.environment.placeholderNames.length} placeholder; WITHHELD ${report.environment.withheldCount} real variables`);
  lines.push(`  network attempts: ${o.networkAttempts}${o.contactedHosts.length ? ` -> ${o.contactedHosts.join(', ')}` : ''}`);
  if (o.undeclaredHosts.length) lines.push(`  UNDECLARED HOSTS: ${o.undeclaredHosts.join(', ')}`);
  if (o.subprocessAttempts) lines.push(`  SUBPROCESS ATTEMPTS: ${o.subprocessCommands.join(' | ')}`);
  if (o.writesOutsideSandbox.length) lines.push(`  WRITES OUTSIDE SANDBOX: ${o.writesOutsideSandbox.join(', ')}`);
  if (o.credentialPathReads.length) lines.push(`  CREDENTIAL PATH READS: ${o.credentialPathReads.join(', ')}`);
  if (o.envEnumerated) lines.push('  ENVIRONMENT ENUMERATED (swept every variable rather than reading declared names)');
  if (o.canaryLeakAttempts) lines.push(`  CANARY EXFILTRATION ATTEMPTS: ${o.canaryLeakAttempts}`);
  lines.push('  ISOLATION STRENGTH:');
  lines.push(`    achieved: ${report.isolation.achieved}`);
  lines.push(`    this is NOT: ${report.isolation.isNot}`);
  for (const item of report.isolation.doesNotProtectAgainst) lines.push(`    does NOT protect against: ${item}`);
  lines.push(`    ${report.isolation.conclusion}`);
  return lines.join('\n');
}
