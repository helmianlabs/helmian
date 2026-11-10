// face-library.test.mjs — The Maestro Library in the room (face-library
// bite): the Change-face picker serves the library's glossy avatar
// pieces, and message reactions gain the library's glossy reaction
// pieces beside the emoji set.
//
// What is pinned here:
//   1. the pure vocabulary (face-library.mjs): the glossy sets, the
//      stored token/slug shapes, strict refusal of unknown pieces, and
//      the asset URLs the desk will request;
//   2. every asset the vocabulary names exists in the staged tree at
//      exactly the path its URL implies, non-empty and far under the
//      25 MB web-upload cap (the binary road these files ship by);
//   3. the chip model folds library summary entries in beside emoji
//      entries without disturbing the emoji shape, and the pure toggle
//      fold treats a library slug like any other slug;
//   4. the wiring: both face pickers and the reaction picker actually
//      consume the module (source pins, in the envoy-workspace.test
//      style), and app.js watches the new module for deploys;
//   5. THE GAP, closed: the reaction store accepts a library slug
//      (and still refuses unknown ones) and the profile store carries
//      the library-token path, accepting a face token whole. These
//      two tests pinned the named server gap (FACE-LIBRARY-REPORT.md)
//      while it was open; when the proposed server files landed
//      (burst 6) they were flipped to assert acceptance instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  LIBRARY_ASSET_BASE, LIBRARY_FACE_PREFIX, LIBRARY_PACK, LIBRARY_REACTION_PACK, LIBRARY_REACTION_PREFIX,
  LIBRARY_FACES, LIBRARY_REACTIONS,
  libraryFace, libraryFaceToken, parseLibraryFaceToken, isLibraryFaceToken,
  libraryFaceStillUrl, libraryFaceClipUrl,
  libraryReaction, libraryReactionSlug, libraryReactionName, isLibraryReactionSlug,
  libraryReactionForSlug, libraryReactionStillUrl,
} from '../web/marketing/app/face-library.mjs';
import { mergeReactionPost, reactionChipModel } from '../web/marketing/app/envoy-workspace.js';
import { normalizeReactionEmoji } from '../src/cloud/envoy-reactions.mjs';

const APP_DIR = fileURLToPath(new URL('../web/marketing/app/', import.meta.url));
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('the face set is the glossy avatar pack: 14 pieces, owner first', () => {
  assert.equal(LIBRARY_PACK, 'glossy');
  assert.equal(LIBRARY_FACES.length, 14);
  assert.equal(LIBRARY_FACES[0].slug, 'owner');
  assert.deepEqual(
    LIBRARY_FACES.map((f) => f.slug).sort(),
    ['chatgpt', 'claude', 'cloudflare', 'gemini', 'grok', 'groq', 'helm', 'maestro', 'mistral', 'muse', 'nvidia', 'openrouter', 'owner', 'qwen'],
  );
  for (const f of LIBRARY_FACES) {
    assert.ok(f.label && f.use, `${f.slug} carries its manifest label and use`);
    assert.equal(libraryFace(f.slug), f);
  }
});

test('face tokens round-trip and refuse anything that is not a real piece', () => {
  assert.equal(LIBRARY_FACE_PREFIX, 'lib:glossy:');
  assert.equal(libraryFaceToken('owner'), 'lib:glossy:owner');
  assert.equal(parseLibraryFaceToken('lib:glossy:owner'), 'owner');
  assert.equal(isLibraryFaceToken('lib:glossy:maestro'), true);
  // an unknown piece, another pack, a bare slug, an emoji, junk: refused
  for (const bad of ['lib:glossy:nope', 'lib:realistic:owner', 'owner', '🦊', '', null, undefined, 'lib:glossy:', 'lib:glossy:owner ']) {
    assert.equal(parseLibraryFaceToken(bad), null, `${JSON.stringify(bad)} is not a library face`);
    assert.equal(isLibraryFaceToken(bad), false);
  }
  assert.equal(libraryFaceToken('nope'), null);
  assert.equal(libraryFace('nope'), null);
});

test('face asset URLs point at the staged library road', () => {
  assert.equal(LIBRARY_ASSET_BASE, '/app/assets/library/');
  assert.equal(libraryFaceStillUrl('owner'), '/app/assets/library/faces/owner-128.png');
  assert.equal(libraryFaceStillUrl('helm', 256), '/app/assets/library/faces/helm-256.png');
  assert.equal(libraryFaceStillUrl('helm', 512), '/app/assets/library/faces/helm-128.png', 'only 128/256 ship; other sizes fall to 128');
  assert.equal(libraryFaceClipUrl('owner'), '/app/assets/library/faces/owner-idle.webm');
  assert.equal(libraryFaceStillUrl('nope'), null);
  assert.equal(libraryFaceClipUrl('nope'), null);
});

test('the reaction set is the glossy reaction pack: 79 pieces, flip-charge among them', () => {
  // 75 pieces from batches 1 + 2, plus batch 3 (faces-batch-2):
  // concerned, listening, qwen-thinking, working — four state pieces
  // the earlier batches had no piece for.
  assert.equal(LIBRARY_REACTIONS.length, 79);
  assert.equal(new Set(LIBRARY_REACTIONS.map((r) => r.name)).size, 79, 'names are unique');
  // The library's middle finger — the Guard-refusal signature piece.
  const flip = libraryReaction('flip-charge');
  assert.ok(flip, 'flip-charge exists');
  assert.match(flip.use, /Guard refuses/);
  // batch 3 (faces-batch-2): the state pieces batches 1 + 2 lacked
  for (const name of ['concerned', 'listening', 'qwen-thinking', 'working']) {
    assert.ok(libraryReaction(name), `${name} exists`);
    assert.equal(libraryReactionForSlug(`lib-${name}`)?.name, name);
  }
  for (const r of LIBRARY_REACTIONS) assert.ok(r.label && r.use, `${r.name} carries its manifest label and use`);
});

test('reaction slugs round-trip under the lib- prefix and refuse non-pieces', () => {
  assert.equal(LIBRARY_REACTION_PREFIX, 'lib-');
  assert.equal(LIBRARY_REACTION_PACK, 'maestro-library');
  assert.equal(libraryReactionSlug('flip-charge'), 'lib-flip-charge');
  assert.equal(libraryReactionName('lib-flip-charge'), 'flip-charge');
  assert.equal(isLibraryReactionSlug('lib-flip-charge'), true);
  assert.equal(libraryReactionForSlug('lib-flip-charge')?.name, 'flip-charge');
  // the emoji set's own 'fire' slug is NOT a library slug, and vice versa
  assert.equal(libraryReactionName('fire'), null);
  assert.equal(isLibraryReactionSlug('fire'), false);
  for (const bad of ['lib-nope', 'lib-', '', null, undefined, 'flip-charge']) {
    assert.equal(libraryReactionName(bad), null, `${JSON.stringify(bad)} is not a library reaction slug`);
  }
  assert.equal(libraryReactionSlug('nope'), null);
  assert.equal(libraryReactionStillUrl('lib-flip-charge'), '/app/assets/library/reactions/flip-charge-128.png');
  assert.equal(libraryReactionStillUrl('flip-charge'), '/app/assets/library/reactions/flip-charge-128.png', 'a bare piece name resolves too');
  assert.equal(libraryReactionStillUrl('nope'), null);
});

test('every asset the vocabulary names is staged at its URL path, non-empty, under the upload cap', () => {
  const paths = [];
  for (const f of LIBRARY_FACES) {
    paths.push(`assets/library/faces/${f.slug}-128.png`, `assets/library/faces/${f.slug}-256.png`, `assets/library/faces/${f.slug}-idle.webm`);
  }
  for (const r of LIBRARY_REACTIONS) paths.push(`assets/library/reactions/${r.name}-128.png`);
  assert.equal(paths.length, 14 * 3 + 79);
  for (const rel of paths) {
    const full = `${APP_DIR}${rel}`;
    assert.ok(existsSync(full), `missing staged asset ${rel}`);
    const size = statSync(full).size;
    assert.ok(size > 0, `${rel} is empty`);
    assert.ok(size < 25_000_000, `${rel} exceeds the 25 MB web-upload cap`);
  }
});

test('the chip model folds library entries in beside emoji entries, shapes intact', () => {
  const summary = [
    { emoji: 'fire', count: 2, actors: [{ name: 'Ana' }] },
    { emoji: 'lib-flip-charge', count: 3, actors: [{ name: 'Ben' }] },
    { emoji: 'not-a-real-slug', count: 9, actors: [] },
    { emoji: 'lib-flip-charge', count: 0, actors: [] },
  ];
  const model = reactionChipModel(summary, ['lib-flip-charge']);
  assert.equal(model.length, 2, 'unknown slugs and empty counts drop, as before');
  assert.deepEqual(model[0], { slug: 'fire', char: '🔥', count: 2, mine: false, actors: 'Ana' }, 'the emoji entry shape is byte-identical to the pre-library model');
  assert.equal(model[1].slug, 'lib-flip-charge');
  assert.equal(model[1].library, true);
  assert.equal(model[1].name, 'flip-charge');
  assert.equal(model[1].label, 'Flip');
  assert.equal(model[1].char, null, 'a library piece never pretends to be an emoji character');
  assert.equal(model[1].count, 3);
  assert.equal(model[1].mine, true);
  assert.equal(model[1].actors, 'Ben');
});

test('the pure toggle fold treats a library slug like any other slug', () => {
  const state = { byId: { m1: [] }, mine: { m1: [] } };
  const added = mergeReactionPost(state, { messageId: 'm1', emoji: 'lib-flip-charge', reacted: true, reactions: [{ emoji: 'lib-flip-charge', count: 1, actors: [] }] });
  assert.deepEqual(added.mine.m1, ['lib-flip-charge']);
  assert.deepEqual(added.byId.m1, [{ emoji: 'lib-flip-charge', count: 1, actors: [] }]);
  const removed = mergeReactionPost(added, { messageId: 'm1', emoji: 'lib-flip-charge', reacted: false, reactions: [] });
  assert.deepEqual(removed.mine.m1, []);
  assert.deepEqual(state.mine.m1, [], 'the input state is not mutated');
});

test('wiring: the Change-face modal serves the library grid and keeps its save path', () => {
  const js = read('../web/marketing/app/envoy-workspace.js');
  // The import specifier carries the shell stamp (?v=…, 2026-11-09
  // speed fix); the wiring law is the import itself.
  assert.match(js, /from '\.\/face-library\.mjs(\?v=[0-9a-f]{16})?'/, 'envoy-workspace imports the library vocabulary');
  assert.ok(js.includes('function libraryFaceGrid('), 'the library face grid exists');
  assert.ok(js.includes("libraryFaceGrid('Pick a Maestro Library face'"), 'the member modal opens with the library grid');
  assert.ok(js.includes("h('p', { class: 'muted sm ew-lib-sec' }, 'Maestro Library')"), 'the library section is headed in the modal');
  assert.ok(js.includes("h('p', { class: 'muted sm ew-lib-sec' }, 'Emoji faces')"), 'the emoji grid stays, under its own heading');
  assert.ok(js.includes("ws.ctx.post('/api/admin/profile', { avatarEmoji: emoji ?? '' })"), 'the save path is the existing profile road, unchanged');
  assert.ok(js.includes('function libraryFaceImg('), 'library stills render with the crew fallback discipline');
  assert.ok(js.includes('libraryFaceClipUrl(slug)'), "the pick preview plays the piece's idle clip");
});

test('wiring: member faces render library tokens everywhere the emoji face renders', () => {
  const js = read('../web/marketing/app/envoy-workspace.js');
  assert.ok(js.includes("h('div', { class: 'ew-avatar lib-ava' }, libraryFaceImg(face))"), 'the channels-foot identity row renders a library face');
  assert.ok(js.includes("h('div', { class: 'ew-avatar lib-ava' }, libraryFaceImg(who.authorEmoji))"), 'message rows render a library author face');
  assert.ok(js.includes('function ownerFaceFallback()'), 'the crew rail owner fallback knows the token');
});

test('wiring: the reaction picker gains a Maestro Library section on the same toggle road', () => {
  const js = read('../web/marketing/app/envoy-workspace.js');
  assert.ok(js.includes("'aria-label': 'Maestro Library reactions'"), 'the picker has the library grid');
  assert.ok(js.includes("h('span', {}, 'Maestro Library')"), 'the library section is headed in the picker');
  assert.ok(js.includes('toggleReaction(messageId, slug)'), 'library picks ride the existing toggle road');
  assert.ok(js.includes("libraryReactionName(slug)"), 'chips render library slugs from the vocabulary');
});

test('wiring: the Settings avatar picker leads with the library and app.js watches the module', () => {
  const app = read('../web/marketing/app/app.js');
  // The import specifier carries the shell stamp (?v=…, 2026-11-09
  // speed fix); the wiring law is the import itself.
  assert.match(app, /from '\.\/face-library\.mjs(\?v=[0-9a-f]{16})?'/, 'app.js imports the library vocabulary');
  assert.ok(app.includes("'avatar-option avatar-option-lib'"), 'library faces render as picker options');
  assert.ok(app.includes('selectedAvatar = token'), 'a library pick stores the token in the same field');
  // The watch law, restated for the stamp (2026-11-09): DEPLOY_WATCH
  // no longer lists files — stamped files' ETags can never move.
  // It watches the document alone, and the document names the shell
  // stamp this module feeds, so a change to the module still moves
  // the watch (the 2026-11-05 lesson, carried by the stamp now).
  assert.ok(app.includes("const DEPLOY_WATCH = ['/app'];"), 'DEPLOY_WATCH watches the document, which names the shell stamp');
  assert.match(app, /from '\.\/face-library\.mjs\?v=[0-9a-f]{16}'/, 'the module rides the shell stamp, so its changes move the document watch');
});

test('the reaction store accepts a library slug and still refuses unknown ones', () => {
  // The read half of the named server gap is closed: the landed
  // envoy-reactions.mjs accepts the Maestro Library vocabulary from
  // the same pure module the desk renders by, so a library slug
  // normalizes to itself. An unknown library-shaped slug is still
  // refused — a reaction must never point at a piece that does not
  // exist.
  assert.equal(normalizeReactionEmoji('lib-flip-charge'), 'lib-flip-charge');
  assert.throws(
    () => normalizeReactionEmoji('lib-nope'),
    (e) => e?.code === 'ENVOY_REACTION_EMOJI_UNSUPPORTED',
  );
  assert.equal(normalizeReactionEmoji('fire'), 'fire', 'the emoji vocabulary is untouched');
});

test('the profile store carries the library-token path, not the bare 10-char trim', () => {
  // The write half of the named server gap is closed: the landed
  // user-profile.mjs validates a 'lib:' value against the library
  // vocabulary (parseLibraryFaceToken) and stores it whole, because
  // 'lib:glossy:owner' (16 chars) cannot survive a 10-char trim.
  // Emoji values keep the old trim on the rawAvatar path.
  const src = read('../src/cloud/user-profile.mjs');
  assert.ok(src.includes('parseLibraryFaceToken'), 'the store validates library tokens against the vocabulary');
  assert.ok(src.includes("rawAvatar.startsWith('lib:')"), 'lib: values take the library-token path');
  assert.ok(!src.includes('data.avatarEmoji.trim().slice(0, 10)'), 'the bare trim that cut tokens in half is gone');
  assert.ok('lib:glossy:owner'.length > 10, 'the token could not survive a 10-char trim');
});
