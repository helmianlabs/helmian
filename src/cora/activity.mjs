// A voice turn lands in the SAME ledger a typed turn lands in.
//
// Helmion already has exactly one activity ledger, and it is owned by the
// desktop: desktop/Helmion.Desktop.Core/ProjectWorkbenchStore.cs:37 pins it at
// `.helmion/audit/project-activity.jsonl`, appends one JSON object per line
// (`AppendActivity`, :283-289), and reads it back with
// `ProjectWorkbenchStore.ReadActivity` (:242-280). Rather than invent a second
// "voice log" that nothing in the product renders, this writes rows the
// existing reader already accepts, so a spoken turn shows up in the Activity
// Centre next to a typed one with no C# change at all.
//
// WHAT THE READER ACTUALLY REQUIRES, verified against that file rather than
// guessed:
//   * The record is `ProjectActivityEntry(Id, AtUtc, Kind, Title, Detail,
//     Status, Source, EvidenceHash?)` at ProjectWorkbenchStore.cs:13-21, and
//     `JsonOptions` is `PropertyNamingPolicy = JsonNamingPolicy.CamelCase`
//     (:39-42) — hence `atUtc`, `evidenceHash`.
//   * `ReadActivity` keeps a row only when `Id` and `Kind` are both non-empty
//     (:264-267) and SKIPS a row that fails to deserialize (:275-278). So a
//     malformed append is dropped silently by the reader — which is precisely
//     why this module validates before it writes rather than after.
//   * `MaxActivityDetailChars = 8_000` (:35) is enforced by the C# writer. A
//     longer detail written from here would not be rejected on read, but it
//     would be a row the C# writer could never have produced, so the same cap
//     is applied here and the truncation is stated in the text.
//
// TWO FIELDS THE C# WRITES THAT THIS DOES NOT, and why that is correct:
//   `kindLabel` and `timeLabel` are GET-ONLY computed properties (:23-24). They
//   are serialised on write and IGNORED on read — a positional record ctor
//   takes only the eight real fields. `kindLabel` is `Kind.ToUpperInvariant()`,
//   so it is reproduced exactly and cheaply. `timeLabel` is
//   `AtUtc.ToLocalTime().ToString("g")`, a .NET current-culture short
//   date/time; reproducing that faithfully from Node is not possible, and
//   writing a plausible-looking WRONG one is worse than omitting a field the
//   reader recomputes anyway.
//
// NEVER THROWS — same discipline as src/core/audit-log.mjs. A ledger write that
// can kill a live voice turn is worse than a missing row, so failures come back
// as `{logged:false, reason}` for the caller to surface. And they must be
// surfaced: this codebase has already shipped the bug where a `skipped` flag
// was returned and dropped on the floor.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const ACTIVITY_RELATIVE_PATH = path.join('.helmion', 'audit', 'project-activity.jsonl');
export const MAX_ACTIVITY_DETAIL_CHARS = 8_000;

/** The `kind` the desktop already uses for agent-workbench rows. */
export const VOICE_ACTIVITY_KIND = 'agent';

/**
 * The `source` string. Deliberately distinct from the C# writer's
 * "Helmian Agent Workbench" (ProjectWorkbenchStore.cs:238) so that a reader can
 * always tell a spoken turn from a typed one, while both stay the same `kind`
 * and therefore render identically.
 */
export const VOICE_ACTIVITY_SOURCE = 'Helmian Cora (voice)';

/** `yyyyMMddHHmmssfff-<32 hex>` — the shape of NewEntry's id (:301). */
export function activityId(at = new Date()) {
  const iso = at.toISOString(); // 2026-08-09T07:21:48.478Z
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`
    + `${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}${iso.slice(20, 23)}`;
  return `${stamp}-${randomBytes(16).toString('hex')}`;
}

/**
 * Build a row without writing it. Separated from the write so a caller (and a
 * test) can inspect the exact object that would land on disk.
 */
export function activityEntry({
  kind = VOICE_ACTIVITY_KIND,
  title,
  detail,
  status,
  source = VOICE_ACTIVITY_SOURCE,
  evidenceHash = null,
  at = new Date(),
} = {}) {
  const cleanTitle = String(title ?? '').trim();
  const cleanStatus = String(status ?? '').trim().toLowerCase();
  let cleanDetail = String(detail ?? '').trim();
  if (!cleanTitle) throw new Error('Activity title is required.');
  if (!cleanStatus) throw new Error('Activity status is required.');
  if (!cleanDetail) throw new Error('Activity detail is required.');
  if (cleanDetail.length > MAX_ACTIVITY_DETAIL_CHARS) {
    const marker = '\n…(truncated to the ledger limit)';
    cleanDetail = cleanDetail.slice(0, MAX_ACTIVITY_DETAIL_CHARS - marker.length) + marker;
  }
  return {
    id: activityId(at),
    atUtc: at.toISOString(),
    kind: String(kind).trim().toLowerCase(),
    title: cleanTitle,
    detail: cleanDetail,
    status: cleanStatus,
    source: String(source),
    evidenceHash: evidenceHash ? String(evidenceHash) : null,
    kindLabel: String(kind).trim().toUpperCase(),
  };
}

/** Absolute path of the ledger for a workspace. */
export function activityPath(workspaceRoot) {
  return path.join(path.resolve(workspaceRoot), ACTIVITY_RELATIVE_PATH);
}

/**
 * Append one row. Never throws.
 * @returns {{logged: true, entry: object, file: string} | {logged: false, reason: string}}
 */
export function recordActivity(workspaceRoot, fields) {
  let entry;
  try {
    if (!workspaceRoot) throw new Error('no workspace root');
    entry = activityEntry(fields);
  } catch (err) {
    return { logged: false, reason: err?.message ?? 'invalid activity row' };
  }
  const file = activityPath(workspaceRoot);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    // One append of one line ending in \n — a torn write costs at most this row
    // and every earlier line stays parseable.
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return { logged: true, entry, file };
  } catch (err) {
    return { logged: false, reason: err?.message ?? 'append failed' };
  }
}

/**
 * A voice turn, phrased for someone reading the Activity Centre later who was
 * not in the room. The heard text and the spoken reply both go in, because
 * "Cora did something" with neither side of the exchange is not evidence.
 */
export function recordVoiceTurn(workspaceRoot, {
  heard,
  spoken,
  status,
  tools = [],
  model = null,
  sessionId = null,
  helmionMode = true,
  at = new Date(),
} = {}) {
  const lines = [
    `Heard: ${quoteForLedger(heard)}`,
    `Said: ${quoteForLedger(spoken)}`,
  ];
  lines.push(tools.length
    ? `Tools run: ${tools.join(', ')}`
    : 'Tools run: none');
  if (model) lines.push(`Answered by: ${model}`);
  lines.push(`Mode: ${helmionMode ? 'Helmion (tools enabled)' : 'chat only (no tools)'}`);
  if (sessionId) lines.push(`Hume custom_session_id: ${sessionId}`);

  return recordActivity(workspaceRoot, {
    kind: VOICE_ACTIVITY_KIND,
    title: 'Voice turn via Cora',
    detail: lines.join('\n'),
    status,
    source: VOICE_ACTIVITY_SOURCE,
    at,
  });
}

function quoteForLedger(value) {
  const text = String(value ?? '').trim();
  return text ? `"${text.replace(/\s+/g, ' ')}"` : '(nothing)';
}

/**
 * Read the ledger back, newest first — the same ordering
 * `ProjectWorkbenchStore.ReadActivity` applies (:274-277). Present so a test can
 * assert what the desktop reader would see; nothing in the server path uses it.
 */
export function readActivity(workspaceRoot, limit = 100) {
  let text;
  try {
    text = readFileSync(activityPath(workspaceRoot), 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      // Mirrors the reader's own acceptance test, so this cannot report a row
      // the desktop would silently drop.
      if (row && typeof row.id === 'string' && row.id && typeof row.kind === 'string' && row.kind) {
        rows.push(row);
      }
    } catch {
      // One partial/corrupt append must not hide the valid history.
    }
  }
  return rows
    .sort((a, b) => (a.atUtc === b.atUtc
      ? String(b.id).localeCompare(String(a.id))
      : String(b.atUtc).localeCompare(String(a.atUtc))))
    .slice(0, Math.max(1, Math.min(500, limit)));
}
