// Guard feed motion semantics (desktop parity). Pure, no DOM, no pool: the
// browser UIs keep an inline copy of guardMotionState (their scripts cannot
// import across the /admin and /app static boundaries), and this module is
// the canonical source plus the unit-test target.
//
// Desktop rules (from the EXE Guard panel):
// - Grey never moves (info).
// - A yellow card is solid until it has been seen 3 times or sat unanswered
//   for 2 minutes, then it pulses.
// - At 5 sightings or 5 minutes unanswered it turns red.
// - Red is never solid: it pulses from the first frame.
// - Acknowledge stops motion; a fresh sighting restores it (the server
//   clears the ack on re-sight, so the card simply arrives unacked again).
// - Criticals stay visible even when acknowledged (server rule, kept here
//   as the showAcknowledged filter contract).

export const GUARD_MOTION_DEFAULTS = Object.freeze({
  showAcknowledged: false,
  pulseAnimations: true,
});

const SEEN_PULSE = 3;
const MINUTES_PULSE = 2;
const SEEN_RED = 5;
const MINUTES_RED = 5;

function baseTone(severity) {
  if (severity === 'critical') return 'red';
  if (severity === 'warning') return 'yellow';
  return 'grey';
}

/**
 * Motion state for one finding. `finding` carries { severity,
 * sightingCount, firstSeenAt, acked }. `now` is a millisecond timestamp
 * (defaults to Date.now()) so tests can pin it.
 * Returns { tone: 'grey'|'yellow'|'red', pulse: boolean, acked: boolean }.
 */
export function guardMotionState(finding, now = Date.now()) {
  const severity = String(finding?.severity ?? 'info').toLowerCase();
  const sightingCount = Number(finding?.sightingCount ?? 0) || 0;
  const acked = !!finding?.acked;
  if (acked) return { tone: baseTone(severity), pulse: false, acked: true };
  const firstSeen = finding?.firstSeenAt ? new Date(finding.firstSeenAt).getTime() : NaN;
  const unansweredMin = Number.isNaN(firstSeen) ? 0 : Math.max(0, (now - firstSeen) / 60000);
  if (severity === 'critical') return { tone: 'red', pulse: true, acked: false };
  if (severity === 'warning') {
    const escalated = sightingCount >= SEEN_RED || unansweredMin >= MINUTES_RED;
    const pulsing = sightingCount >= SEEN_PULSE || unansweredMin >= MINUTES_PULSE;
    return { tone: escalated ? 'red' : 'yellow', pulse: escalated || pulsing, acked: false };
  }
  return { tone: 'grey', pulse: false, acked: false };
}

/**
 * Visibility contract for the admin "Show acknowledged" toggle: when the
 * toggle is off, acknowledged info/warning cards hide, but acknowledged
 * criticals always stay visible.
 */
export function guardCardVisible(finding, showAcknowledged) {
  if (showAcknowledged) return true;
  if (!finding?.acked) return true;
  return String(finding?.severity ?? '').toLowerCase() === 'critical';
}
