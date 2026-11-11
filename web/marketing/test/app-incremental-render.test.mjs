import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// Page-lockup fix (2026-11-11): renderMessages is keyed and
// incremental. This is a STRUCTURAL guard in this suite's source-
// assertion idiom: it pins the seams the fix stands on so a later
// revert to the wholesale rebuild fails loudly. It does NOT exercise
// DOM-node identity at runtime — renderMessages is not exported and
// the workspace state is module-private, so the harness cannot drive
// it honestly; the behavioral claim (kept rows are the same nodes,
// a no-change call writes nothing) rests on the code read recorded
// in the bite report, not on this test.
const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
const start = js.indexOf('function renderMessages()');
const end = js.indexOf('// ---------- message reactions', start);
assert.ok(start !== -1 && end > start, 'renderMessages located');
const renderFn = js.slice(start, end);

test('lockup fix: the message render is keyed by message id with a signature cache', () => {
  assert.ok(js.includes('const msgRenderCache = { channelId: undefined, entries: new Map() }'), 'the per-channel row cache exists');
  assert.ok(renderFn.includes('keep(`msg:${m.id}`, sig,'), 'message rows go through the keyed keep() with a signature');
  assert.ok(renderFn.includes('hit.sig === sig ? hit.node : build()'), 'a signature hit reuses the cached node, a miss rebuilds');
  assert.ok(renderFn.includes('msgRenderCache.channelId !== ws.channelId'), 'the cache resets when the channel changes');
});

test('lockup fix: no wholesale container swap remains in the message render', () => {
  assert.ok(!renderFn.includes('replaceChildren'), 'renderMessages never replaces the whole list');
  assert.ok(renderFn.includes('cur[i] !== desired[i]'), 'the desired sequence is compared against the live DOM by node identity');
  assert.ok(renderFn.includes('box.insertBefore(node, next)'), 'only the delta is inserted or moved');
});

test('lockup fix: the signature covers the drawing inputs and the speaking path survives', () => {
  for (const needle of ['m._pending ? 1 : 0', 'cont ? 1 : 0', 'showNew ? 1 : 0', 'motionCls', 'speakingSig', 'reactionsSig']) {
    assert.ok(renderFn.includes(needle), `the row signature covers ${needle}`);
  }
  assert.ok(renderFn.includes('speakingNow.ref === m.id'), 'the speaking icon is still drawn from the standing signal');
  assert.ok(renderFn.includes('keep(`day:${day}`'), 'day dividers are keyed in the same cache');
  assert.ok(renderFn.includes('keep(`act:${cue.provider}`'), 'activity rows are keyed in the same cache');
});
