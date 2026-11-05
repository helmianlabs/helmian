// emoji-map.test.mjs — the codepoint -> asset map for Helmian's original
// emoji set. Guards the two promises the product makes about the set:
//   1. every face the pickers offer (custom-agent emoji, channel characters)
//      has Helmian art behind it, and
//   2. every shipped asset is reachable from the map (no orphan art),
//      with both the animated file and its static first frame on disk.
// Unicode stays the data; an unmapped emoji falls back to the platform
// glyph, which these tests also pin down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EMOJI_MAP, EMOJI_ASSET_BASE, emojiAssetSlug, emojiAssetUrl, stripVariationSelectors, AGENT_FACE_DEFAULTS, AGENT_FACE_PROVIDERS, agentFaceDefault, isFaceEmoji } from '../app/emoji-map.mjs';
import { CUSTOM_AGENT_EMOJIS } from '../app/envoy-workspace.js';
import { CHARACTERS } from '../app/avatars.mjs';

const ASSET_DIR = fileURLToPath(new URL('../assets/emoji/', import.meta.url));

test('every custom-agent picker emoji has Helmian art', () => {
  for (const emoji of CUSTOM_AGENT_EMOJIS) {
    assert.ok(emojiAssetSlug(emoji), `custom-agent emoji ${emoji} is not in EMOJI_MAP`);
  }
});

test('every channel character glyph has Helmian art', () => {
  for (const [id, glyph] of CHARACTERS) {
    assert.ok(emojiAssetSlug(glyph), `channel character ${id} glyph ${glyph} is not in EMOJI_MAP`);
  }
});

test('variation-selector forms hit the same asset as the bare codepoint', () => {
  assert.equal(emojiAssetSlug('✌️'), 'victory');
  assert.equal(emojiAssetSlug('✌'), 'victory');
  assert.equal(emojiAssetSlug('❤️'), 'heart-red');
  assert.equal(emojiAssetSlug('⚠️'), 'warning');
  assert.equal(emojiAssetSlug('🛠️'), 'tools');
  assert.equal(stripVariationSelectors('a️b'), 'ab');
});

test('unmapped and complex emoji fall back to the platform glyph', () => {
  assert.equal(emojiAssetSlug('🍕'), null);          // not in the set
  assert.equal(emojiAssetSlug('👨‍👩‍👧'), null);       // ZWJ sequence: never half-substituted
  assert.equal(emojiAssetSlug('1️⃣'), null);          // keycap sequence
  assert.equal(emojiAssetSlug(''), null);
  assert.equal(emojiAssetSlug('A'), null);
  assert.equal(emojiAssetSlug(null), null);
});

test('map keys are bare codepoint sequences (no variation selectors)', () => {
  for (const key of Object.keys(EMOJI_MAP)) assert.ok(!key.includes('\uFE0F'), `key ${JSON.stringify(key)} carries U+FE0F`);
});

test('every mapped slug has its animated asset and static frame on disk', () => {
  for (const slug of Object.values(EMOJI_MAP)) {
    assert.ok(existsSync(`${ASSET_DIR}${slug}.svg`), `missing ${slug}.svg`);
    assert.ok(existsSync(`${ASSET_DIR}${slug}-still.svg`), `missing ${slug}-still.svg`);
  }
});

test('no orphan assets: every shipped emoji file belongs to the map', () => {
  const slugs = new Set(Object.values(EMOJI_MAP));
  for (const name of readdirSync(ASSET_DIR)) {
    if (!name.endsWith('.svg')) continue; // NOTICE and friends are not assets
    const slug = name.replace(/(-still)?\.svg$/, '');
    assert.ok(slugs.has(slug), `asset ${name} is not reachable from EMOJI_MAP`);
  }
});

test('asset urls honor the base path and the still variant', () => {
  assert.equal(EMOJI_ASSET_BASE, '/assets/emoji/');
  assert.equal(emojiAssetUrl('fire'), '/assets/emoji/fire.svg');
  assert.equal(emojiAssetUrl('fire', { still: true }), '/assets/emoji/fire-still.svg');
});

// ---------- seat face defaults (emoji bite 5) ----------

test('every built-in seat ships a default face with Helmian art', () => {
  assert.deepEqual([...AGENT_FACE_PROVIDERS].sort(), ['claude', 'gemini', 'grok', 'mistral', 'openai']);
  assert.deepEqual(Object.keys(AGENT_FACE_DEFAULTS).sort(), [...AGENT_FACE_PROVIDERS].sort());
  for (const provider of AGENT_FACE_PROVIDERS) {
    assert.ok(emojiAssetSlug(AGENT_FACE_DEFAULTS[provider]), `${provider}'s default face is drawn`);
    assert.equal(agentFaceDefault(provider), AGENT_FACE_DEFAULTS[provider]);
  }
  assert.equal(agentFaceDefault('maestro'), null, 'Maestro is the human seat — no agent face');
  assert.equal(agentFaceDefault('qwen'), null, 'custom agents carry their own faces');
  assert.equal(new Set(Object.values(AGENT_FACE_DEFAULTS)).size, 5);
});

test('isFaceEmoji admits exactly the single drawn tokens', () => {
  assert.equal(isFaceEmoji('🦀'), true);
  assert.equal(isFaceEmoji('❤️'), true, 'FE0F forms count, like the renderer');
  assert.equal(isFaceEmoji('🍕'), false);
  assert.equal(isFaceEmoji('🦀🦀'), false);
  assert.equal(isFaceEmoji('fire'), false, 'slugs are not faces');
  assert.equal(isFaceEmoji(''), false);
  assert.equal(isFaceEmoji(null), false);
});
