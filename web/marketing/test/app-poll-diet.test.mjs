import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { CALM_POLL_MS, IDLE_POLL_MS, POLL_IDLE_AFTER, POLL_RESYNC_MIN_MS, pollDelay } from '../app/envoy-workspace.js';

// Optimization bite 5 (2026-11-12): the polling diet. The calm
// workspace tick used to pull the full message window every
// 2.5 s forever — including in tabs left open for hours and in
// hidden tabs nobody was looking at. The diet: a hidden tab
// parks the tick outright and the return to visible runs ONE
// full re-sync; a visible room where nothing has changed for a
// sustained stretch stretches the calm cadence and snaps back
// on any movement. STRUCTURAL guard in this suite's idiom, plus
// the pure delay decision driven for real. The behavioral claim
// (request counts per phase) rests on the Playwright harness
// recorded in the bite report — mountWorkspace is not driven
// here (it needs the live DOM), and no earlier pin named the
// always-on tick, so no existing pin changed.
const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
const mountAt = js.indexOf('export async function mountWorkspace');
assert.ok(mountAt !== -1, 'mountWorkspace is located');
const mount = js.slice(mountAt);
const tickAt = mount.indexOf('const gen = (ws.pollGen');
const slowAt = mount.indexOf('ws.slowTimer = setInterval');
assert.ok(tickAt !== -1 && slowAt > tickAt, 'the poll block is located');
const poll = mount.slice(tickAt, slowAt);

test('diet constants: the stretch, the streak, and the re-sync floor are the planned values', () => {
  assert.equal(CALM_POLL_MS, 2500, 'the calm cadence itself is unchanged');
  assert.equal(IDLE_POLL_MS, 10_000, 'the idle stretch target');
  assert.equal(POLL_IDLE_AFTER, 12, 'unchanged calm passes before the stretch (≈30 s)');
  assert.equal(POLL_RESYNC_MIN_MS, 5_000, 'a hidden spell this long earns the full return re-sync');
});

test('pollDelay: live rounds keep the fast cadence, speech never stretches, idle stretches', () => {
  assert.equal(pollDelay({ live: true, unchanged: 999 }), 800, 'live activity is always the 800 ms cadence');
  assert.equal(pollDelay({ live: true, speaking: true, unchanged: 999 }), 800, 'live wins over speaking');
  assert.equal(pollDelay({ speaking: true, unchanged: 999 }), CALM_POLL_MS, 'a reply playing never stretches');
  assert.equal(pollDelay({ unchanged: 0 }), CALM_POLL_MS, 'a fresh room polls calm');
  assert.equal(pollDelay({ unchanged: POLL_IDLE_AFTER - 1 }), CALM_POLL_MS, 'one pass short of the streak is still calm');
  assert.equal(pollDelay({ unchanged: POLL_IDLE_AFTER }), IDLE_POLL_MS, 'the streak reached: stretched');
  assert.equal(pollDelay({ unchanged: 999 }), IDLE_POLL_MS, 'the stretch holds while nothing changes');
  assert.equal(pollDelay(), CALM_POLL_MS, 'no news is the calm cadence');
});

test('hidden diet: the tick parks on hidden and leaves no timer standing', () => {
  assert.ok(poll.includes("document.visibilityState === 'hidden'"), 'hidden is read from the Page Visibility state');
  assert.ok(poll.includes('const speaking = () => speakingNow != null;'),
    'voice playing is read from speakingNow — the controller’s playback report, in this module');
  assert.ok(poll.includes('if (!tabHidden() || speaking()) return false;'),
    'park stands down while a reply is playing: an audible tab keeps its rhythm');
  assert.ok(poll.includes('if (!hiddenSince) hiddenSince = Date.now();'), 'parking stamps the spell’s start');
  const parks = poll.split('if (parkIfHidden()) return;').length - 1;
  assert.equal(parks, 2, 'the park is checked at both ends of a pass, so a mid-flight hide still parks');
  assert.ok(poll.includes("if (document.visibilityState === 'hidden') {"), 'the visibility listener takes the hide event itself');
  assert.ok(poll.includes('clearTimeout(ws.timer); ws.timer = null;'), 'the hide clears the standing timer at once');
});

test('return: one full re-sync for a real absence, one ordinary pass for a short spell', () => {
  assert.ok(poll.includes('const awayMs = Date.now() - hiddenSince;'), 'the spell’s length is measured, never a count of missed ticks');
  assert.ok(poll.includes('if (awayMs < POLL_RESYNC_MIN_MS) { void tick(); return; }'),
    'a short spell earns one immediate ordinary pass');
  assert.ok(poll.includes('await Promise.allSettled([loadMessages(), loadPresence(), loadAgentState(), loadConfig(), loadFaces()]);'),
    'the re-sync is the message window plus the slow timer’s set, as one batch');
  assert.ok(poll.includes("if (document.visibilityState !== 'visible' || !hiddenSince) return;"),
    'a return that never parked (speech kept the chain alive) has nothing to repair');
  assert.ok(poll.includes('if (!visible()) { ws.timer = setTimeout(tick, CALM_POLL_MS); return; }'),
    'another view up: the chain re-arms fetch-free; entering Desktop re-mounts and loads the room');
});

test('idle stretch: movement resets the streak, and the delay is decided by pollDelay', () => {
  assert.ok(poll.includes('const sigBefore = ws.sig;'), 'the pass records the message signature before its load');
  assert.ok(poll.includes('if (ws.sig !== sigBefore || live || speaking()) unchangedTicks = 0;'),
    'a landed message, live activity, or playing voice resets the streak');
  assert.ok(poll.includes('else unchangedTicks += 1;'), 'a pass that changed nothing grows the streak');
  assert.ok(poll.includes('ws.timer = setTimeout(tick, pollDelay({ live, speaking: speaking(), unchanged: unchangedTicks }));'),
    'the chain reschedules through the pure decision');
});

test('wake: a send and a channel switch reset the stretch on the spot', () => {
  assert.ok(poll.includes('ws.pollWake = () => {'), 'mount wires the wake onto the shared state');
  assert.ok(poll.includes('if (gen !== ws.pollGen || hiddenSince) return;'),
    'the wake retires with its mount and stands down while hidden-parked');
  const sendAt = js.indexOf('async function send(e)');
  const send = js.slice(sendAt, js.indexOf('// ---------- agent chat pane', sendAt));
  assert.ok(send.includes('await loadMessages(); loadPresence().catch(() => {}); ws.pollWake?.();'),
    'a successful send wakes the poll after its own loads');
  const selAt = js.indexOf('async function selectChannel(id)');
  const sel = js.slice(selAt, js.indexOf('\n}', selAt));
  assert.ok(sel.includes('await Promise.allSettled([loadConfig(), loadMessages()]);\n  ws.pollWake?.();'),
    'a channel switch wakes the poll after its own batch');
});

test('the listener never stacks across remounts, and the slow timer is untouched', () => {
  assert.ok(poll.includes('if (ws.pollVisHandler) document.removeEventListener(\'visibilitychange\', ws.pollVisHandler);'),
    'the previous mount’s listener is removed before the new one is added');
  assert.ok(poll.includes('document.addEventListener(\'visibilitychange\', onVisibility);'), 'the listener is registered at mount');
  assert.ok(mount.includes('ws.slowTimer = setInterval(() => { if (visible()) { loadPresence(); loadAgentState(); loadConfig(); loadFaces(); } }, 15000);'),
    'the 15 s slow timer stands exactly as it was — already visibility-gated, and the re-sync complements it');
});
