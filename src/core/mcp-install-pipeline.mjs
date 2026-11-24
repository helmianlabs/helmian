// The MCP install security pipeline: the five stages, in order, each with its
// own recorded verdict.
//
//   1. DISCOVERY  — mcp-discovery.mjs      find a candidate, record provenance
//   2. CODE READ  — mcp-code-audit.mjs     read every source file, never the README
//   3. SANDBOX    — mcp-sandbox.mjs        run it with no credentials and watch
//                   + mcp-vet.mjs          when vet mode is on, the candidate is
//                                          FIRST submitted to the cloud vet
//                                          service (disposable container); the
//                                          local observer run stays as the
//                                          second, independent layer
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
import { submitCandidateToVet } from './mcp-vet.mjs';
import { requestInstallApproval, ApprovalRefusedError } from './mcp-approval.mjs';
import {
  computeCandidateFingerprint,
  defaultLedgerDirectory,
  checkForDrift,
  recordDecision,
  saveBaseline,
} from './mcp-install-ledger.mjs';
import { buildInstallLibraryReport } from './mcp-library-report.mjs';
import { buildApprovalBriefing } from './mcp-approval.mjs';
import { evaluatePackageProvenance, PACKAGE_DECISION } from './package-provenance.mjs';
import { readdir } from 'node:fs/promises';

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
      pkg: parsed.package ?? null,
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

/**
 * Build the package descriptor the provenance gate checks, from the
 * candidate itself: an explicit `package` declaration in the manifest
 * wins; otherwise an npm candidate's own package.json supplies name,
 * version, and install scripts. The lockfile text and any .pth files are
 * read from the candidate root. Returns null when the candidate is not a
 * registry package at all (a plain local server), in which case the gate
 * does not apply and says nothing.
 */
async function loadPackageDescriptor(candidateRoot, declared) {
  let pkg = declared?.pkg ?? null;
  const declaredPackage = pkg != null;
  let scripts = null;
  if (!pkg) {
    const packageJsonText = await readFile(join(candidateRoot, 'package.json'), 'utf8').catch(() => null);
    if (packageJsonText) {
      try {
        const parsed = JSON.parse(packageJsonText);
        if (parsed.name && parsed.version) {
          pkg = { ecosystem: 'npm', name: parsed.name, version: parsed.version };
          scripts = parsed.scripts ?? null;
        }
      } catch { /* an unreadable package.json declares no package */ }
    }
  }
  if (!pkg) return null;
  const ecosystem = pkg.ecosystem ?? 'npm';
  const lockfileName = ecosystem === 'npm' ? 'package-lock.json' : 'requirements-lock.txt';
  const lockfileText = await readFile(join(candidateRoot, lockfileName), 'utf8').catch(() => null);
  const files = [];
  const walk = async (dir, depth) => {
    if (depth > 4 || files.length > 50) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== '.git') await walk(full, depth + 1); }
      else if (/\.pth$/i.test(entry.name)) {
        files.push({ path: full.slice(candidateRoot.length + 1), content: await readFile(full, 'utf8').catch(() => null) });
      }
    }
  };
  await walk(candidateRoot, 0);
  return {
    ecosystem,
    name: pkg.name,
    version: pkg.version,
    lockfileText: pkg.lockfileText ?? lockfileText,
    scripts: pkg.scripts ?? scripts,
    files,
    declaredPackage,
  };
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
  // Vet mode: `{ vetUrl, vetToken, deadlineMs?, fetchImpl? }` submits the
  // candidate to the cloud vet service as stage 3's first layer. Default
  // null = the pipeline exactly as before; vet mode is always opt-in,
  // because the service holds an execution authority (a standing token)
  // that a caller must name deliberately. In vet mode a blocked, flagged,
  // or missing vet verdict halts the pipeline before the local sandbox and
  // before any human is asked — the same halt a local critical audit gets.
  vet = null,
  // Explicit so a caller (notably the test suite) can guarantee no database is
  // touched. Passing null keeps the ledger purely local.
  connectionString = process.env.HELMION_DATABASE_URL,
  // Injectable lookups for the package provenance gate (tests drive the
  // advisory and attestation branches offline through these).
  packageGateOptions = {},
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
    libraryReport: null,
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

  // ── Stage 2b: package provenance gate ─────────────────────────────────────
  // When the candidate is (or declares) a registry package, the package
  // itself is checked before anything runs: advisories (OSV + GHSA),
  // lockfile integrity, provenance attestations, typosquat screen, and
  // startup hooks. The gate's decision is written to the ledger either
  // way — the receipt is the record that the check ran and what it found.
  const pkgDescriptor = await loadPackageDescriptor(candidateRoot, declared);
  if (pkgDescriptor) {
    const gate = await evaluatePackageProvenance({
      pkg: pkgDescriptor,
      requireLockfile: pkgDescriptor.declaredPackage === true,
      ...packageGateOptions,
    });
    report.stages.packageProvenance = { stage: 'package-provenance', ...gate };
    await log('package-provenance', {
      ecosystem: pkgDescriptor.ecosystem,
      name: pkgDescriptor.name,
      version: pkgDescriptor.version,
      decision: gate.decision,
      findings: gate.findings,
      attestation: gate.attestation ? { status: gate.attestation.status, detail: gate.attestation.detail } : null,
      lockfile: gate.lockfile ? { present: gate.lockfile.present, verified: gate.lockfile.verified, detail: gate.lockfile.detail } : null,
    });
    if (gate.decision === PACKAGE_DECISION.BLOCK) {
      report.finalDecision = 'blocked-by-package-provenance';
      await log('blocked', {
        reason: 'package provenance gate',
        findings: gate.findings.filter((f) => f.severity === 'block'),
        note: 'Pipeline halted before the sandbox and before any human was asked. Nothing was installed.',
      });
      return report;
    }
  }

  // ── Stage 3: sandbox ──────────────────────────────────────────────────────
  // In vet mode the candidate goes to the cloud vet service FIRST: it runs
  // the same stages in a disposable container with an OS boundary the local
  // run does not have. A blocked or flagged vet verdict halts here — the
  // candidate is not then run locally, and no human is asked. A missing
  // verdict (service unreachable, refused, busy past the deadline) halts
  // too: vet mode was asked for, so its absence is evidence-missing, and
  // evidence-missing is never a clean run. Only a clean vet verdict lets
  // the pipeline continue to the local observer run, which stays as the
  // second, independent layer.
  if (vet) {
    // Guard-gated submissions (wiring bite 4b) bind the Guard decision to
    // the candidate fingerprint, so it is computed before the submission
    // when a Guard is configured. (Stage 5 computes it again for the
    // baseline; the two computations are the same function over the same
    // tree, and bite 3's binding compares the service's own fingerprint
    // against the baseline's.)
    let guardFingerprint = null;
    if (vet.guard) {
      guardFingerprint = (await computeCandidateFingerprint({ root: candidateRoot, declared })).fingerprint;
    }
    const vetStage = await submitCandidateToVet({
      root: candidateRoot,
      vetUrl: vet.vetUrl,
      vetToken: vet.vetToken,
      fetchImpl: vet.fetchImpl,
      deadlineMs: vet.deadlineMs,
      guard: vet.guard ?? null,
      fingerprint: guardFingerprint,
      candidateName: name,
    });
    report.stages.vet = vetStage;
    if (vetStage.verdict === 'blocked') {
      report.finalDecision = 'blocked-by-vet';
      await log('blocked', {
        reason: 'cloud vet service blocked the candidate at its code read',
        layer: 'cloud-vet',
        vetRunId: vetStage.runId,
        vetFinalDecision: vetStage.finalDecision,
        note: 'Pipeline halted before the local sandbox and before any human was asked. Nothing was installed.',
      });
      return report;
    }
    if (vetStage.verdict === 'flagged') {
      report.finalDecision = 'flagged-by-vet';
      await log('flagged', {
        reason: 'cloud vet service flagged the candidate in its sandbox run',
        layer: 'cloud-vet',
        vetRunId: vetStage.runId,
        vetFinalDecision: vetStage.finalDecision,
        fingerprint: vetStage.fingerprint,
        note: 'Pipeline halted before the local sandbox and before any human was asked. Nothing was installed.',
      });
      return report;
    }
    if (vetStage.verdict !== 'clean') {
      report.finalDecision = 'vet-evidence-missing';
      await log('flagged', {
        reason: 'cloud vet service produced no verdict; failing closed',
        layer: 'cloud-vet',
        vetError: vetStage.error ?? null,
        note: 'Vet mode was requested and no vet evidence exists. Missing evidence is never a clean run, so the pipeline halted before the local sandbox and before any human was asked. Nothing was installed.',
      });
      return report;
    }
    await log('sandboxed', {
      layer: 'cloud-vet',
      verdict: vetStage.finalDecision,
      vetRunId: vetStage.runId,
      fingerprint: vetStage.fingerprint,
      runContainerDestroyed: vetStage.runContainerDestroyed,
    });
  }

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
    vet: report.stages.vet ?? null,
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
  // Bind the vet verdict to the install (wiring bite 3). In vet mode only a
  // clean verdict can reach this line — blocked, flagged, and missing
  // verdicts all halted in stage 3 — so the baseline records which vet run
  // cleared THIS candidate and the fingerprint the service computed over
  // the copy it received. The plugins gate later refuses registration if
  // the candidate no longer matches that vet fingerprint.
  const vetBinding = report.stages.vet
    ? {
      runId: report.stages.vet.runId,
      verdict: report.stages.vet.verdict,
      finalDecision: report.stages.vet.finalDecision,
      fingerprint: report.stages.vet.fingerprint,
    }
    : null;
  const baseline = await saveBaseline({ ledgerDir, serverName: name, fingerprint, approvalRecord: approval, vet: vetBinding });

  report.installedPath = installedPath;
  report.configSnippet = configSnippet(name, installedPath);
  report.stages.baseline = baseline;
  report.finalDecision = 'installed';
  // The ledger join (pipeline map G2): the installed server also
  // produces its library-entry report — the facts the connector
  // library's install-report road records on the other side of the
  // two-machine line. Built only here, where finalDecision is
  // 'installed': a server that was never installed has no report,
  // exactly as it has no baseline.
  report.libraryReport = buildInstallLibraryReport(report);

  await log('installed', {
    installedPath,
    fingerprint: fingerprint.fingerprint,
    permissionsHash: fingerprint.permissionsHash,
    approvalChallenge: approval.challenge,
    vetRunId: vetBinding?.runId ?? null,
    vetFingerprint: vetBinding?.fingerprint ?? null,
    libraryEntryId: report.libraryReport?.entryId ?? null,
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
  if (report.stages.packageProvenance) {
    lines.push(`  package provenance: ${report.stages.packageProvenance.decision.toUpperCase()}`);
    for (const f of report.stages.packageProvenance.findings) lines.push(`      ${f.severity}: ${f.detail}`);
  }
  if (report.stages.sandbox) lines.push(`  sandbox:   ${report.stages.sandbox.verdict}`);
  if (report.stages.vet) {
    const v = report.stages.vet;
    lines.push(v.runId
      ? `  vet:       ${v.finalDecision} (cloud vet run ${v.runId})`
      : `  vet:       NO VERDICT — ${v.error ?? 'evidence missing'}`);
  }
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
