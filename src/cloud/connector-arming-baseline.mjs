// Arming baselines — the connector library half of the ledger join
// (pipeline map §3, gap G2, direction 2).
//
// THE RECORDING. A connection's tool set is frozen into
// helmion.connector_snapshots at connect time or at first arm (the
// arming dispatch's §4.1(2) backstop) — snapshot rows are immutable
// history, so a connection's FIRST snapshot is its arming baseline:
// the frozen set every later freeze is compared against. No second
// store was needed to record it; what was missing is the naming
// (this module), a read of the first snapshot (the store's
// getFirstSnapshot), and the EXPORT — a document a person's machine
// can carry away and the install pipeline's drift check can consume
// (mcp-install-ledger.mjs: loadArmingBaselineExport +
// checkToolListAgainstArmingBaseline).
//
// ONE DRIFT STORY, TWO TELLINGS. The export carries the baseline
// snapshot AND the connection's current snapshot, with the drift
// verdict between them computed by the library's own diff
// (diffToolSnapshots over the same per-tool inputSchemaHash values
// planToolSnapshot produced). The pipeline side re-plans a live
// tools/list through the very same functions and compares against
// the baseline's snapshotHash — same hash, same diff, so a tool list
// that changed after baselining names its drift identically in both
// tellings.
//
// The export is produced by the existing admin read family
// (connector-library-read-route.mjs, GET …/arming-baseline): member
// auth, the caller's own connection only — the document names tools
// and hashes, never a token reference, never a credential.

import { diffToolSnapshots } from './connector-library.mjs';

export const ARMING_BASELINE_FORMAT = 'helmian-arming-baseline';
export const ARMING_BASELINE_VERSION = 1;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function snapshotPart(snapshot) {
  if (!snapshot) return null;
  return {
    snapshotId: snapshot.id ?? null,
    takenAt: snapshot.takenAt ?? null,
    snapshotHash: snapshot.snapshotHash,
    tools: Array.isArray(snapshot.tools) ? snapshot.tools : [],
  };
}

/** The drift verdict between two frozen tool lists, in the library's own diff. */
export function compareSnapshotTools(baselineTools, currentTools) {
  const diff = diffToolSnapshots(baselineTools ?? [], currentTools ?? []);
  return {
    drifted: diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0,
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
  };
}

/**
 * Build the export document for one entry from its baseline (first)
 * and current snapshots. A current snapshot identical to the
 * baseline (the same row — nothing has been re-frozen since) reads
 * as no drift, with `current` naming that same freeze.
 */
export function buildArmingBaselineExport({ entry, baselineSnapshot, currentSnapshot = null, exportedAt = new Date().toISOString() } = {}) {
  if (!entry) throw badRequest('an arming baseline export needs the library entry');
  if (!baselineSnapshot) throw badRequest('an arming baseline export needs the baseline (first) snapshot');
  const baseline = snapshotPart(baselineSnapshot);
  const current = snapshotPart(currentSnapshot) ?? baseline;
  const comparison = compareSnapshotTools(baseline.tools, current.tools);
  return {
    format: ARMING_BASELINE_FORMAT,
    version: ARMING_BASELINE_VERSION,
    seatId: entry.seatId,
    entryId: entry.id,
    entryName: entry.name,
    kind: entry.kind,
    brokerMode: entry.brokerMode,
    baseline,
    current,
    drift: {
      ...comparison,
      baselineHash: baseline.snapshotHash,
      currentHash: current.snapshotHash,
    },
    exportedAt,
  };
}

/**
 * Validate an export document and return the part a drift check
 * consumes: { seatId, entryId, baselineHash, baselineTools }. The
 * pipeline side loads exports from files a person carried off the
 * read surface — a document that does not carry the format, the
 * version, and a baseline with a hash and a tool list is refused
 * rather than guessed at.
 */
export function parseArmingBaselineExport(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('arming baseline export must be a JSON object');
  }
  if (doc.format !== ARMING_BASELINE_FORMAT) {
    throw new Error(`arming baseline export format must be "${ARMING_BASELINE_FORMAT}"`);
  }
  if (doc.version !== ARMING_BASELINE_VERSION) {
    throw new Error(`arming baseline export version must be ${ARMING_BASELINE_VERSION}`);
  }
  const baseline = doc.baseline;
  if (!baseline || typeof baseline !== 'object'
    || typeof baseline.snapshotHash !== 'string' || !baseline.snapshotHash
    || !Array.isArray(baseline.tools)) {
    throw new Error('arming baseline export carries no baseline snapshot (snapshotHash + tools are required)');
  }
  return {
    seatId: typeof doc.seatId === 'string' ? doc.seatId : null,
    entryId: typeof doc.entryId === 'string' ? doc.entryId : null,
    baselineHash: baseline.snapshotHash,
    baselineTools: baseline.tools,
    baselineTakenAt: baseline.takenAt ?? null,
  };
}
