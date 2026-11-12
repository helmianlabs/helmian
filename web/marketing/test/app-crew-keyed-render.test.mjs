import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// Optimization bite 3 (2026-11-12): the crew rail is keyed. The
// baseline's ranked #1 cost was renderCrew ending in an
// unconditional replaceChildren on every message poll — every
// face <video> thrown away and rebuilt, its clip fetch and
// decode restarted, ~290 element creations a minute calm and
// ~900 during a round. This is a STRUCTURAL guard in this
// suite's source-assertion idiom (the same shape as
// app-incremental-render.test.mjs for the lockup fix): it pins
// the seams the keyed render stands on so a later revert to the
// wholesale rebuild fails loudly. It does NOT exercise DOM-node
// identity at runtime — renderCrew is not exported and the
// workspace state is module-private; the behavioral claim (kept
// rows and their <video> elements are the same nodes across
// polls, a no-change poll writes nothing) rests on the
// Playwright harness recorded in the bite report.
const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
const sectionAt = js.indexOf('// ---------- CREW rail: keyed rendering');
const sectionEnd = js.indexOf('// The add-render peek decision', sectionAt);
assert.ok(sectionAt !== -1 && sectionEnd > sectionAt, 'the keyed crew section is located');
const section = js.slice(sectionAt, sectionEnd);
const renderAt = section.indexOf('function renderCrew(');
const renderEnd = section.indexOf('// The add-pills under the rail', renderAt);
assert.ok(renderAt !== -1 && renderEnd > renderAt, 'renderCrew is located inside the keyed section');
const renderFn = section.slice(renderAt, renderEnd);
const agentsAt = js.indexOf('function renderAgents()');
const agentsFn = js.slice(agentsAt, js.indexOf('\nasync function changeAgent', agentsAt));

test('crew keyed: rows live in a per-agent cache and the list is reconciled by node identity', () => {
  assert.ok(section.includes('const crewRowCache = new Map()'), 'the per-agent row cache exists');
  assert.ok(renderFn.includes('crewRowCache.get(spec.cacheKey)'), 'a render looks the row up by its agent key');
  assert.ok(renderFn.includes('crewRowSync(entry, spec)'), 'a cache hit patches the kept row in place');
  assert.ok(renderFn.includes('reconcileChildren(list, desired)'), 'the list is reconciled against the desired sequence');
  assert.ok(section.includes('cur[i] !== desired[i]'), 'the reconcile compares the live DOM against the desired sequence by node identity');
  assert.ok(section.includes('box.insertBefore(node, next)'), 'only the delta is inserted or moved');
});

test('crew keyed: no wholesale rebuild remains in the crew render or the add list', () => {
  assert.ok(!renderFn.includes('replaceChildren'), 'renderCrew never replaces the whole list');
  assert.ok(!agentsFn.includes('addBox.replaceChildren('), 'renderAgents no longer rebuilds the add list wholesale');
  assert.ok(agentsFn.includes('reconcileChildren(addBox,'), 'the add list is reconciled by identity too');
});

test('crew keyed: a kept face is re-pointed only through crewClipApply, and rebuilt only when its build changes', () => {
  assert.ok(section.includes('function crewRowSync(entry, spec)'), 'the in-place patch exists');
  assert.ok(section.includes('if (face?.tagName === \'VIDEO\') crewClipApply(face, spec.stage);'), 'a kept clip is applied in place — crewClipApply re-points only on a kind change');
  assert.ok(section.includes('entry.faceStamp !== spec.faceStamp'), 'the face child is rebuilt only when its build stamp (still/clip mode, slug, emoji) changes');
  assert.ok(section.includes("faceStamp: `${still ? 'still' : 'clip'}:${crewFaceSlug(p)}`"), 'a seat face stamp carries the mode and the slug');
});

test('crew keyed: departed rows are disposed, and the add-pills are keyed by seat', () => {
  assert.ok(section.includes('crewRowDispose(entry); crewRowCache.delete(k);'), 'a departed agent\'s row is disposed and dropped from the cache');
  assert.ok(section.includes("face.removeAttribute('src');"), 'disposal unloads the departed face\'s clip so it cannot keep decoding off-DOM');
  assert.ok(section.includes('const crewAddCache = new Map()'), 'the add-pill cache exists');
  assert.ok(agentsFn.includes('crewAddPill(p, desk)'), 'add-pills come from the keyed cache');
});
