// The MCP install security pipeline: the five stages, in order, each with its
// own recorded verdict.
//
//   1. DISCOVERY  — mcp-discovery.mjs      find a candidate, record provenance
//   2. CODE READ  — mcp-code-audit.mjs     read every source file, never the README
//   3. SANDBOX    — mcp-sandbox.mjs        run it with no credentials and watch
//   4. APPROVAL   — mcp-approval.mjs       a human types a challenge phrase
//   5. LEDGER     — mcp-install-ledger.mjs permanent record + baseline fingerprint
//
// The ordering is a security property, not a style choice: nothing is executed
// before it has been read, nothing is offered to a human before it has been
// run where it cannot do harm, and nothing is installed before a human says so.
//
// INSTALL DELIBERATELY DOES NOT EDIT GLOBAL CONFIG. It materializes the server
// into a managed directory, stores its approved baseline, and PRINTS the config
// snippet for the human to paste. Writing ~/.claude.json from an automated
// pipeline would mean an agent could arrange for a server to become active
// without the human ever seeing it — which is the exact failure this whole
// system exists to prevent.

import { cp, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { auditCandidate, AUDIT_SEVERITY } from './mcp-code-audit.mjs';
import { runSandboxedCandidate } from './mcp-sandbox.mjs';
import { requestInstallApproval, ApprovalRefusedError } from './mcp-approval.mjs';
import {
  computeCandidateFingerprint,
  defaultLedgerDirectory,
  checkForDrift,
  recordDecision,
  saveBaseline,
} from './mcp-install-ledger.mjs';
import { buildApprovalBriefing } from './mcp-approval.mjs';

export const MANIFEST_FILENAME = 'helmion-candidate.json';

/**
 * Read the candidate's declared purpose/hosts/env. A candidate with NO manifest
 * is not rejected — it is recorded as having declared nothing, which makes
 * every host it contacts and every variable it reads undeclared, and therefore
 * flagged. Silence is not the same as innocence.
 */
export async function loadDeclaredManifest(root) {
  const path = join(root, MANIFEST_FILENAME);
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) {
    return {
      purpose: null, allowedHosts: [], allowedEnv: [], tools: [],
      manifestPresent: false,
      manifestNote: `No ${MANIFEST_FILENAME} found. The candidate declared nothing, so every network host and every environment variable it touches is treated as undeclared.`,
    };
  }
  try {
    const parsed = JSON.parse(text);
    return {
      purpose: parsed.purpose ?? null,
      allowedHosts: parsed.allowedHosts ?? [],
      allowedEnv: parsed.allowedEnv ?? [],
      tools: parsed.tools ?? [],
      name: parsed.name ?? null,
      manifestPresent: true,
    };
  } catch (error) {
    return {
      purpose: null, allowedHosts: [], allowedEnv: [], tools: [],
      manifestPresent: false,
      manifestNote: `${MANIFEST_FILENAME} is present but is not valid JSON (${error.message}). Treated as declaring nothing.`,
    };
  }
}

function configSnippet(serverName, installedPath) {
  return {
    mcpServers: {
      [serverName]: {
        command: 'node',
        args: [join(installedPath, 'index.mjs')],
      },
    },
  };
}

/**
 * Run the full pipeline against a LOCAL candidate directory.
 *
 * `approve` is injectable so the test suite can drive both branches of the
 * gate. The default is the real interactive prompt against the real process
 * streams; the CLI never overrides it.
 */
export async function runInstallPipeline({
  root,
  serverName = null,
  ledgerDir = defaultLedgerDirectory(),
  installRoot = join(defaultLedgerDirectory(), '..', 'mcp-servers'),
  approve = requestInstallApproval,
  haltOnCritical = true,
  sandboxOptions = {},
  projectSlug = null,
  store = null,
  discovery = null,
  runSandbox = true,
  // Explicit so a caller (notably the test suite) can guarantee no database is
  // touched. Passing null keeps the ledger purely local.
  connectionString = process.env.HELMION_DATABASE_URL,
} = {}) {
  const candidateRoot = resolve(root);
  const declared = await loadDeclaredManifest(candidateRoot);
  const name = serverName ?? declared.name ?? candidateRoot.split(/[\\/]/).filter(Boolean).pop();

  const report = {
    serverName: name,
    root: candidateRoot,
    declared,
    ledgerDir,
    stages: {},
    finalDecision: null,
    installedPath: null,
    configSnippet: null,
  };

  const log = (decision, detail) => recordDecision({
    ledgerDir, decision, serverName: name, projectSlug, detail, store, connectionString,
  });

  // ── Stage 1: discovery provenance (may be supplied from a prior search) ────
  report.stages.discovery = discovery ?? {
    stage: 'discovery',
    source: 'local-path',
    root: candidateRoot,
    note: 'Pipeline was run against a local directory; no GitHub search was performed for this run.',
  };
  await log('discovered', {
    source: report.stages.discovery.source ?? 'github',
    root: candidateRoot,
    declared,
  });

  // ── Stage 5a: drift check BEFORE anything else ────────────────────────────
  // A server that was already approved does not get to skip review because it
  // has a familiar name. If it changed, it re-enters the pipeline.
  const drift = await checkForDrift({ ledgerDir, serverName: name, root: candidateRoot, declared });
  report.stages.drift = drift;
  if (drift.status === 'drift-detected') {
    await log('drift-detected', {
      message: drift.message,
      expansions: drift.comparison.expansions,
      changes: drift.comparison.changes,
    });
  }

  // ── Stage 2: code read ────────────────────────────────────────────────────
  const audit = await auditCandidate({ root: candidateRoot, declared });
  report.stages.codeRead = audit;
  await log(audit.blocking ? 'flagged' : 'discovered', {
    verdict: audit.verdict,
    summary: audit.summary,
    criticalFindings: audit.findings
      .filter((f) => f.severity === AUDIT_SEVERITY.CRITICAL)
      .map((f) => ({ rule: f.rule, citation: f.citation, message: f.message })),
  });

  if (audit.blocking && haltOnCritical) {
    report.finalDecision = 'blocked-by-code-read';
    await log('blocked', {
      reason: 'critical findings in static analysis',
      count: audit.summary.critical,
      note: 'Pipeline halted before the sandbox and before any human was asked. Nothing was installed.',
    });
    return report;
  }

  // ── Stage 3: sandbox ──────────────────────────────────────────────────────
  if (runSandbox) {
    const sandbox = await runSandboxedCandidate({ root: candidateRoot, declared, ...sandboxOptions });
    report.stages.sandbox = sandbox;
    await log('sandboxed', {
      verdict: sandbox.verdict,
      observed: sandbox.observed,
      evidence: sandbox.evidence,
      isolationAchieved: sandbox.isolation.achieved,
    });
  }

  // ── Stage 4: human approval ───────────────────────────────────────────────
  const briefing = buildApprovalBriefing({
    discovery: { ...report.stages.discovery, declared, name },
    audit,
    sandbox: report.stages.sandbox ?? {},
  });
  report.stages.briefing = briefing;

  let approval;
  try {
    approval = await approve({ briefing });
  } catch (error) {
    if (error instanceof ApprovalRefusedError) {
      report.stages.approval = { stage: 'approval', approved: false, refused: true, reason: error.message, details: error.details };
      report.finalDecision = error.details?.reason === 'not-a-tty' ? 'refused-not-a-tty' : 'refused';
      await log('rejected', { reason: error.message, details: error.details, installed: false });
      return report;
    }
    throw error;
  }

  report.stages.approval = approval;
  if (!approval.approved) {
    report.finalDecision = 'rejected-by-human';
    await log('rejected', { reason: approval.reason, installed: false });
    return report;
  }

  // ── Install (only reachable with an explicit human yes) ───────────────────
  const installedPath = join(installRoot, String(name).replace(/[^a-zA-Z0-9._-]/g, '_'));
  await mkdir(installRoot, { recursive: true });
  if (existsSync(installedPath)) {
    await cp(candidateRoot, installedPath, { recursive: true, force: true });
  } else {
    await cp(candidateRoot, installedPath, { recursive: true });
  }

  const fingerprint = await computeCandidateFingerprint({ root: candidateRoot, declared });
  const baseline = await saveBaseline({ ledgerDir, serverName: name, fingerprint, approvalRecord: approval });

  report.installedPath = installedPath;
  report.configSnippet = configSnippet(name, installedPath);
  report.stages.baseline = baseline;
  report.finalDecision = 'installed';

  await log('installed', {
    installedPath,
    fingerprint: fingerprint.fingerprint,
    permissionsHash: fingerprint.permissionsHash,
    approvalChallenge: approval.challenge,
    note: 'Global MCP config was NOT modified. The config snippet must be added by the human.',
  });

  return report;
}

export function formatPipelineOutcome(report) {
  const lines = [];
  lines.push(`PIPELINE OUTCOME — ${report.serverName}: ${String(report.finalDecision).toUpperCase()}`);
  if (report.stages.codeRead) {
    const s = report.stages.codeRead.summary;
    lines.push(`  code read: ${report.stages.codeRead.verdict} (critical ${s.critical}, high ${s.high}, medium ${s.medium})`);
  }
  if (report.stages.sandbox) lines.push(`  sandbox:   ${report.stages.sandbox.verdict}`);
  if (report.stages.approval) lines.push(`  approval:  ${report.stages.approval.approved ? 'GRANTED' : 'NOT GRANTED'} — ${report.stages.approval.reason}`);
  if (report.stages.drift?.status === 'drift-detected') lines.push(`  DRIFT:     ${report.stages.drift.message}`);
  if (report.finalDecision === 'installed') {
    lines.push(`  installed to: ${report.installedPath}`);
    lines.push('  Global MCP config was NOT modified. Add this yourself:');
    lines.push(JSON.stringify(report.configSnippet, null, 2).split('\n').map((l) => `    ${l}`).join('\n'));
  } else {
    lines.push('  NOTHING WAS INSTALLED.');
  }
  return lines.join('\n');
}
