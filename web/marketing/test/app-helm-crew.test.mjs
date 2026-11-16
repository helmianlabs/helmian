import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { helmCrewPresence, mentions } from '../app/envoy-workspace.js';

// Helm identity (bite H1): Helm is present in every channel's crew
// as a display rule, not a config member. The cloud registry
// (src/cloud/envoy-agents.mjs) makes 'helm' a reserved role
// handle: @helm resolves, 'agent:helm' describes as Helm, and no
// config, team, or due set ever carries it as a vendor seat. This
// file pins the workspace half: the crew row renderCrew seats in
// every channel, the mention mirror that resolves @helm here, and
// the voice tables that already carry Helm's voice, bm_george.

test('helm crew presence: the pinned row shape', () => {
  const row = helmCrewPresence();
  assert.equal(row.key, 'helm');
  assert.equal(row.cacheKey, 'helm');
  assert.equal(row.name, 'Helm');
  assert.deepEqual(row.status, { kind: 'live', line: 'Always here' });
  assert.equal(row.faceStamp, 'clip:helm');
  assert.equal(helmCrewPresence(true).faceStamp, 'still:helm');
});

test('helm crew presence: @helm resolves in the workspace mention mirror', () => {
  assert.deepEqual(mentions('hey @helm, state?').providers, ['helm']);
  assert.deepEqual(mentions('@Helm ping').providers, ['helm']);
  assert.deepEqual(mentions('Helm: state of this workspace').providers, [], 'a bare vocative is not an @mention');
});

test('helm crew presence: renderCrew seats the row in every channel, ahead of the seats, uncounted', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  const at = js.indexOf('function renderCrew(');
  assert.ok(at !== -1, 'renderCrew exists');
  const fn = js.slice(at, js.indexOf('\nfunction syncCrewWatchIcons', at));
  assert.ok(fn.includes('const helmSpec = { ...helmCrewPresence(still), stage: null,'), 'renderCrew builds the Helm row from the pinned presence');
  assert.ok(fn.includes("buildFace: () => crewSeatFaceClip('helm', null)"), 'the row wears the helm crew face');
  assert.ok(fn.includes("title: desk ? 'Dispatch to Helm"), 'the row title follows the desk wording rule');
  assert.ok(fn.includes('for (const spec of [ownerSpec, helmSpec, ...specs])'), 'the row renders beside the whole-crew row, ahead of the seats');
  assert.ok(fn.includes('const total = roster.length + customList.length;'), 'the crew total still counts seats only: Helm is present, not counted');
  assert.ok(js.includes("const NAMES = { maestro: 'Maestro', helm: 'Helm',"), 'the workspace name map names Helm');
  assert.ok(js.includes("manager: 'maestro', helm: 'helm',"), 'the workspace alias mirror resolves helm');
});

test('helm voice: both voice tables carry bm_george for helm', async () => {
  const shared = await readFile(new URL('../../shared/voice-dictation.mjs', import.meta.url), 'utf8');
  assert.ok(shared.includes("helm: 'bm_george'"), 'the shared voice table gives Helm bm_george');
  const app = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');
  assert.ok(app.includes("helm: 'bm_george'"), 'the app voice table gives Helm bm_george');
});
