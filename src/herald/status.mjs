// Helmion Herald phone status contract.
//
// The desktop digest contains local paths, process/lease holder ids, command
// text, and review summaries. None of those cross the phone boundary in Phase 1.
// Only bounded posture, freshness, and counts are exposed. Unknown stays unknown.

export const HERALD_STATUS_SCHEMA = 1;
export const HERALD_STALE_AFTER_MS = 90_000;

function finiteCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function sanitizeDigestForPhone(digest, { staleAfterMs = HERALD_STALE_AFTER_MS } = {}) {
  const refusedChanges = finiteCount(
    digest?.advisory?.items?.filter((item) => item?.allowed !== true).length,
  );
  const blockedCommands = finiteCount(digest?.blocks?.items?.length);
  const waiting = finiteCount(digest?.summary?.waiting);
  const sourcesComputed = Boolean(
    digest?.blocks?.computed && digest?.advisory?.computed && digest?.lease?.computed,
  );

  let state = sourcesComputed ? digest?.summary?.state : 'unknown';
  if (!['quiet', 'needs-you', 'unknown'].includes(state)) state = 'unknown';

  const headline = state === 'needs-you'
    ? `${waiting} review item${waiting === 1 ? '' : 's'} waiting`
    : state === 'quiet'
      ? 'No review item is waiting'
      : 'Local status could not be fully computed';
  const detail = state === 'needs-you'
    ? 'Open Helmian Desktop to inspect evidence and decide. The phone cannot approve or act.'
    : state === 'quiet'
      ? 'This reports only the latest readable local guard and lease posture.'
      : 'One or more local evidence sources were unreadable. This is not an all-clear.';

  return {
    schemaVersion: HERALD_STATUS_SCHEMA,
    product: 'Helmian Herald',
    scope: 'status:read',
    generatedAt: digest?.generatedAt ?? null,
    staleAfterMs,
    status: { state, headline, detail, waiting },
    lease: {
      computed: Boolean(digest?.lease?.computed),
      state: ['active', 'stale', 'none', 'unknown'].includes(digest?.lease?.state)
        ? digest.lease.state
        : 'unknown',
    },
    activity: { refusedChanges, blockedCommands },
    sources: {
      blockLedger: Boolean(digest?.blocks?.computed),
      advisoryJournal: Boolean(digest?.advisory?.computed),
      writeLease: Boolean(digest?.lease?.computed),
    },
    capabilities: ['status:read'],
  };
}
