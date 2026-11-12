import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { addRenderKeepsPeek } from '../app/envoy-workspace.js';

// Channels-pane add close (found in the live walk, 2026-11-10
// 21:31): adding agents through the Channels pane closed the pane
// after EVERY add, so each further add cost a reopen. The pane is
// #ew-channels; its add path is the ADD TO THIS CHANNEL pill list
// (#ew-crew-add, rendered by renderAgents), each pill calling
// changeAgent('add-agent', provider).
//
// The close, line by line at the base (HEAD 2613df70 + boot-load):
// renderAgents already carried the 2026-11-10 panel-stays-open
// discipline — capture the focused pill, rebuild the list with
// replaceChildren, focus the successor (the same pill when it
// survives, else the create pill). In the pane's rail-rest state
// that discipline defeats itself: destroying the focused pill
// drops focus to <body> inside replaceChildren; the pane's
// focusout handler (wireChannelsRail: "if (!pane.contains(
// e.relatedTarget)) pane.classList.remove('peeking')") reads the
// drop as a close and removes the peek; and envoy.css hides every
// child of a non-peeking rail-rest pane but the rail tab
// (.rail-rest:not(.peeking) > :not(.ew-channels-rail-tab) is
// display:none), so the successor stands in a display:none
// subtree when its focus() runs — the focus lands nowhere, no
// focusin brings the peek back, and the pane stays shut. The
// composer picker never hits this: renderPicker rebuilds inside
// a panel that stays visible throughout.
//
// The fix: renderAgents remembers the peek before the rebuild
// (addRenderKeepsPeek: rail-rest + peeking + focus inside the add
// list) and puts it back BEFORE focusing the successor, so the
// successor is rendered when its focus() runs. The close was
// never load-bearing: the added agent's state arrives from
// changeAgent's own loadConfig/loadMessages re-reads, not from
// the pane closing.

test('peek decision: only a peeking rail-rest pane whose add list held focus keeps the peek', () => {
  assert.equal(addRenderKeepsPeek({ railRest: true, peeking: true, focusInside: true }), true,
    'the walk case: resting rail, peeking, the clicked pill focused — the peek must be restored');
  assert.equal(addRenderKeepsPeek({ railRest: true, peeking: true, focusInside: false }), false,
    'focus was elsewhere (hover peek): the rebuild destroys no focused node, nothing to restore');
  assert.equal(addRenderKeepsPeek({ railRest: true, peeking: false, focusInside: true }), false,
    'not peeking: nothing was open to lose');
  assert.equal(addRenderKeepsPeek({ railRest: false, peeking: true, focusInside: true }), false,
    'pinned open (not rail-rest): the pane children are never display:none, the plain focus restore already works');
  assert.equal(addRenderKeepsPeek({}), false, 'defaults are all false');
  assert.equal(addRenderKeepsPeek(), false, 'no facts, no restore');
});

test('wiring: the peek is captured before the add rebuild and restored before the successor is focused', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  const renderAgentsAt = js.indexOf('function renderAgents()');
  assert.ok(renderAgentsAt !== -1, 'renderAgents exists');
  const fn = js.slice(renderAgentsAt, js.indexOf('\nasync function changeAgent', renderAgentsAt));
  // The capture reads the pane's two classes and the captured pill.
  assert.ok(fn.includes("const channelsPane = $('ew-channels');"), 'renderAgents reads the channels pane');
  assert.ok(fn.includes('const wasPeeking = addRenderKeepsPeek({'), 'the peek decision is taken in renderAgents');
  assert.ok(fn.includes("railRest: Boolean(channelsPane?.classList.contains('rail-rest'))"), 'rail-rest is one of the decision facts');
  assert.ok(fn.includes("peeking: Boolean(channelsPane?.classList.contains('peeking'))"), 'peeking is one of the decision facts');
  assert.ok(fn.includes('focusInside: Boolean(focusedPill)'), 'the focused pill is the focus fact');
  // Ordering is the fix: capture before the rebuild, restore
  // before the focus() that needs a rendered successor.
  const captureAt = fn.indexOf('const wasPeeking = addRenderKeepsPeek({');
  const rebuildAt = fn.indexOf('addBox.replaceChildren(');
  const restoreAt = fn.indexOf("if (wasPeeking) channelsPane.classList.add('peeking');");
  const focusAt = fn.indexOf('if (next) next.focus({ preventScroll: true });');
  assert.ok(captureAt !== -1 && rebuildAt !== -1 && captureAt < rebuildAt, 'the peek is captured before the rebuild destroys the pill');
  assert.ok(restoreAt !== -1 && rebuildAt < restoreAt, 'the peek is restored after the rebuild');
  assert.ok(focusAt !== -1 && restoreAt < focusAt, 'the peek is back before the successor is focused, so the focus() lands on a rendered node');
  // The pre-existing successor discipline is untouched: the same
  // pill when it survives, else the create pill that always renders.
  assert.ok(fn.includes("const next = (focusedAdd && addBox.querySelector(`[data-provider=\"${focusedAdd}\"]`)) || addBox.querySelector('.create-custom');"),
    'the successor choice is the old one');
  assert.ok(fn.includes("onclick: () => changeAgent('add-agent', p)"), 'the pills still add through changeAgent');
});

test('wiring: the add flow still re-reads its state from the server (the close was not load-bearing)', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  const changeAt = js.indexOf('async function changeAgent');
  assert.ok(changeAt !== -1, 'changeAgent exists');
  const fn = js.slice(changeAt, js.indexOf('\nfunction insertMention', changeAt));
  assert.ok(fn.includes("await ws.ctx.post('/api/admin/envoy/channel-config', { action, channelId: ws.channelId, provider });"),
    'the add still posts the channel-config write');
  assert.ok(fn.includes('await loadConfig(); await loadMessages();'),
    'the post-write state still arrives from the config and message re-reads, not from any pane close');
  // The two close mechanisms the trap ran through are unchanged:
  // the pane still drops its peek when focus genuinely leaves,
  // and the CSS still hides a resting pane's children.
  assert.ok(js.includes("pane.addEventListener('focusout', (e) => { if (!pane.contains(e.relatedTarget)) pane.classList.remove('peeking'); });"),
    'the focusout close still stands for a genuine focus leave');
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.ew-channels.rail-rest:not(.peeking) > :not(.ew-channels-rail-tab) { display:none !important; }'),
    'the resting-pane CSS is unchanged — the fix works with it, not around it');
});
