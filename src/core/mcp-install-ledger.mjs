// Stage 5 of the MCP install security pipeline: PERMANENT RECORD + DRIFT.
//
// Two jobs:
//   1. Every decision — discovered, flagged, sandboxed, approved, rejected,
//      installed — is written somewhere it survives the session.
//   2. Every installed server gets a BASELINE FINGERPRINT. A later version that
//      asks for more access, or whose code changed, is flagged against that
//      baseline instead of quietly being trusted because it was approved once.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHICH NEON LANE, AND WHY — the two are DIFFERENT DATABASES, not two tables.
//
//   bigsister.*  lives on Troy's personal endpoint (ep-dry-fog-aku9i5gq) and is
//                reached by ~/.claude/scripts/neon/bigsister_neon_log.mjs. Its
//                own header defines agent_logs and advisory_outputs as LOW
//                TRUST — "anything may write". It is a cross-project learning
//                lane for advisory models.
//
//   helmion.*    lives on the endpoint in HELMION_DATABASE_URL, is migrated by
//                sql/*.sql, and is guarded at connect time by
//                HELMION_EXPECTED_ENDPOINT_ID (adapters/neon.mjs:262).
//
// This ledger writes to HELMION, and deliberately not to bigsister:
//
//   - A security audit trail must not live in a lane whose contract says
//     anything may write to it. Tamper-resistance is the entire value of the
//     record; a lane defined as untrusted cannot provide it.
//   - This is Helmion PRODUCT state (what this installation has approved and
//     what its baselines are), not a lesson for advisory models to read.
//   - The helmion lane already has the endpoint guard, so a misconfigured URL
//     fails loudly instead of silently writing the audit trail to the wrong
//     database.
//
// A one-line summary may still be pushed to bigsister by the session for
// learning purposes; that is a separate, low-trust copy and is never the
// record of record.
//
// DURABILITY ORDER: local append-only JSONL FIRST, Neon second and best-effort.
// A security decision must not be lost because a network was down, and every
// entry records whether its Neon write actually landed rather than assuming it.
//
// TABLE: helmion.telemetry_events (sql/002_maestro_phase_one.sql:98-106), via
// the adapter's recordTelemetry (src/adapters/neon.mjs:1076). No new DDL is
// introduced — event_type carries "mcp-install.<decision>" and the whole entry
// goes in the jsonb payload, so this needs no migration and cannot drift from
// a schema file.
//
// TRAP, DECLARED ONLY IN THE DATABASE: telemetry_events.project_slug is a
// FOREIGN KEY to helmion.projects(slug) (sql/002_maestro_phase_one.sql:100).
// NULL is accepted, but a slug that has never been registered raises a foreign
// key violation. That failure is REPORTED on the entry (neon.error) and mirrored
// into the local ledger as a `neon-write-failed` row — it is never swallowed,
// because a security decision that silently failed to persist is the same as
// one that never happened.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep, extname } from 'node:path';

export const LEDGER_DECISIONS = Object.freeze([
  'discovered', 'flagged', 'sandboxed', 'approved', 'rejected', 'installed', 'drift-detected', 'blocked',
]);

const FINGERPRINT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.json', '.node', '.wasm',
]);

const SKIPPED = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.cache']);

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function defaultLedgerDirectory(workspace = process.cwd()) {
  return join(workspace, '.helmion', 'mcp-security');
}

/**
 * Hash every source file plus the declared permission surface.
 *
 * The permission surface is fingerprinted SEPARATELY from the file hashes so a
 * later comparison can say "it now wants a host it did not ask for before"
 * rather than only "some bytes changed".
 */
export async function computeCandidateFingerprint({ root, declared = {} }) {
  const files = {};
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!FINGERPRINT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      const rel = relative(root, full).split(sep).join('/');
      const content = await readFile(full).catch(() => null);
      if (content === null) continue;
      files[rel] = sha256(content);
    }
  }
  await walk(root);

  const permissions = {
    allowedHosts: [...(declared.allowedHosts ?? [])].sort(),
    allowedEnv: [...(declared.allowedEnv ?? [])].sort(),
    tools: [...(declared.tools ?? [])].sort(),
    purpose: declared.purpose ?? null,
  };

  const sortedFiles = Object.keys(files).sort().map((k) => `${k}:${files[k]}`).join('\n');
  return {
    algorithm: 'sha256',
    computedAt: new Date().toISOString(),
    files,
    fileCount: Object.keys(files).length,
    permissions,
    filesHash: sha256(sortedFiles),
    permissionsHash: sha256(JSON.stringify(permissions)),
    fingerprint: sha256(`${sha256(sortedFiles)}:${sha256(JSON.stringify(permissions))}`),
  };
}

/**
 * Compare a current fingerprint against the approved baseline.
 *
 * Expansions of access are separated from ordinary code changes, because they
 * are the ones that must force re-approval: a server approved to reach one host
 * and read one variable does NOT get to quietly start reaching three.
 */
export function compareFingerprints(baseline, current) {
  const changes = [];
  const baseFiles = baseline.files ?? {};
  const currFiles = current.files ?? {};

  for (const path of Object.keys(currFiles)) {
    if (!(path in baseFiles)) {
      changes.push({ kind: 'file-added', detail: path, severity: 'high' });
    } else if (baseFiles[path] !== currFiles[path]) {
      changes.push({
        kind: 'file-modified',
        detail: path,
        severity: 'high',
        was: baseFiles[path].slice(0, 12),
        now: currFiles[path].slice(0, 12),
      });
    }
  }
  for (const path of Object.keys(baseFiles)) {
    if (!(path in currFiles)) changes.push({ kind: 'file-removed', detail: path, severity: 'medium' });
  }

  const basePerms = baseline.permissions ?? {};
  const currPerms = current.permissions ?? {};
  const expansions = [];
  for (const [field, label] of [['allowedHosts', 'network host'], ['allowedEnv', 'environment variable'], ['tools', 'tool']]) {
    const before = new Set(basePerms[field] ?? []);
    for (const value of currPerms[field] ?? []) {
      if (!before.has(value)) {
        const change = {
          kind: 'permission-expanded',
          field,
          detail: `${label} "${value}" was NOT in the approved baseline`,
          severity: 'critical',
        };
        changes.push(change);
        expansions.push(change);
      }
    }
  }
  if ((basePerms.purpose ?? null) !== (currPerms.purpose ?? null)) {
    changes.push({
      kind: 'purpose-changed',
      detail: `purpose changed from ${JSON.stringify(basePerms.purpose ?? null)} to ${JSON.stringify(currPerms.purpose ?? null)}`,
      severity: 'high',
    });
  }

  return {
    drifted: changes.length > 0,
    requiresReapproval: expansions.length > 0 || changes.some((c) => c.severity === 'high'),
    expansions,
    changes,
    baselineFingerprint: baseline.fingerprint,
    currentFingerprint: current.fingerprint,
  };
}

/** Where a server's approved baseline is stored on disk. */
function baselinePath(ledgerDir, serverName) {
  const safe = String(serverName).replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(ledgerDir, 'baselines', `${safe}.json`);
}

export async function loadBaseline({ ledgerDir, serverName }) {
  const text = await readFile(baselinePath(ledgerDir, serverName), 'utf8').catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function saveBaseline({ ledgerDir, serverName, fingerprint, approvalRecord }) {
  await mkdir(join(ledgerDir, 'baselines'), { recursive: true });
  const record = {
    serverName,
    approvedAt: approvalRecord?.respondedAt ?? new Date().toISOString(),
    approvalChallenge: approvalRecord?.challenge ?? null,
    ...fingerprint,
  };
  await writeFile(baselinePath(ledgerDir, serverName), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/**
 * The gate that stops a previously-approved server from quietly growing.
 * Returns a decision; never silently passes an expansion.
 */
export async function checkForDrift({ ledgerDir, serverName, root, declared }) {
  const baseline = await loadBaseline({ ledgerDir, serverName });
  const current = await computeCandidateFingerprint({ root, declared });
  if (!baseline) {
    return {
      status: 'no-baseline',
      message: `No approved baseline exists for "${serverName}". It has never been through this pipeline; treat it as a first install.`,
      current,
    };
  }
  const comparison = compareFingerprints(baseline, current);
  return {
    status: comparison.drifted ? 'drift-detected' : 'unchanged',
    message: comparison.drifted
      ? `"${serverName}" differs from the version that was approved on ${baseline.approvedAt}. `
        + `${comparison.expansions.length} permission expansion(s), ${comparison.changes.length} total change(s). `
        + `${comparison.requiresReapproval ? 'RE-APPROVAL REQUIRED — the pipeline must run again from stage 2.' : 'Review recommended.'}`
      : `"${serverName}" matches the fingerprint approved on ${baseline.approvedAt}.`,
    baseline,
    current,
    comparison,
  };
}

/**
 * Append one decision to the permanent record.
 *
 * Local write happens FIRST and is the record of record. The Neon write is
 * attempted after and its outcome is reported honestly — a caller is told
 * `neon: { attempted, written, error }` rather than being allowed to assume
 * the row landed.
 */
export async function recordDecision({
  ledgerDir,
  decision,
  serverName,
  projectSlug = null,
  detail = {},
  store = null,
  connectionString = process.env.HELMION_DATABASE_URL,
  expectedEndpointId = process.env.HELMION_EXPECTED_ENDPOINT_ID,
}) {
  if (!LEDGER_DECISIONS.includes(decision)) {
    throw new Error(`Unknown ledger decision "${decision}". Expected one of: ${LEDGER_DECISIONS.join(', ')}`);
  }

  const entry = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    decision,
    serverName,
    projectSlug,
    detail,
  };

  await mkdir(ledgerDir, { recursive: true });
  await appendFile(join(ledgerDir, 'ledger.jsonl'), `${JSON.stringify(entry)}\n`);

  const neon = { attempted: false, written: false, error: null, id: null };
  const canUseNeon = Boolean(store) || Boolean(connectionString);
  if (canUseNeon) {
    neon.attempted = true;
    let ownedStore = null;
    try {
      const active = store ?? (ownedStore = await (await import('../adapters/neon.mjs'))
        .createNeonStore(connectionString, expectedEndpointId ? { expectedEndpointId } : {}));
      const result = await active.recordTelemetry({
        projectSlug,
        eventType: `mcp-install.${decision}`,
        payload: { ...entry },
      });
      neon.written = Boolean(result?.recorded);
      neon.id = result?.id ?? null;
    } catch (error) {
      // Best-effort by design, but NEVER silent: the local entry records that
      // the durable copy failed, so nobody later mistakes a local-only record
      // for a replicated one.
      neon.error = error.message;
    } finally {
      if (ownedStore) await ownedStore.close().catch(() => {});
    }
  }

  const finalEntry = { ...entry, neon };
  if (neon.attempted && !neon.written) {
    await appendFile(
      join(ledgerDir, 'ledger.jsonl'),
      `${JSON.stringify({ ...entry, id: randomUUID(), decision: 'neon-write-failed', detail: { of: entry.id, error: neon.error } })}\n`,
    );
  }
  return finalEntry;
}

export async function readLedger({ ledgerDir }) {
  const text = await readFile(join(ledgerDir, 'ledger.jsonl'), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}
