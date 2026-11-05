// emoji-map.mjs — Helmian's original emoji set: Unicode codepoint -> asset slug.
//
// The shipped art is Helmian's own (drawn for Helmian from the 2026-11-04
// proposal sheets; see assets/emoji/NOTICE). Unicode stays the DATA: a
// message stores the emoji character, this map only decides how it is
// DISPLAYED. Anything not in the map renders as the platform's own glyph —
// the fallback is never broken.
//
// Assets live at /assets/emoji/<slug>.svg (SMIL-animated) with a static
// first frame at /assets/emoji/<slug>-still.svg for emojiMode "plain" and
// for reduced-motion users. Keys are codepoint sequences WITHOUT the
// U+FE0F variation selector; lookups strip it, so "✌️" and "✌" both hit.
export const EMOJI_ASSET_BASE = '/assets/emoji/';

export const EMOJI_MAP = Object.freeze({
  // faces
  '\u{1F642}': 'smile', '\u{1F600}': 'grin', '\u{1F602}': 'joy',
  '\u{1F609}': 'wink', '\u{1F60F}': 'smirk', '\u{1F60E}': 'sunglasses',
  '\u{1F60D}': 'heart-eyes', '\u{1F929}': 'star-struck', '\u{1F92A}': 'zany',
  '\u{1F973}': 'party', '\u{1F917}': 'hugging', '\u{1F914}': 'thinking',
  '\u{1F9D0}': 'monocle', '\u{1F913}': 'nerd', '\u{1F632}': 'astonished',
  '\u{1F92F}': 'exploding', '\u{1F634}': 'sleeping', '\u{1F644}': 'eye-roll',
  '\u{1F620}': 'angry', '\u{1F926}': 'facepalm', '\u{1F977}': 'ninja',
  '\u{1F920}': 'cowboy', '\u{1F9D9}': 'wizard', '\u{1FAE1}': 'salute',
  // hands
  '\u{1F44D}': 'thumbs-up', '\u{1F44E}': 'thumbs-down', '\u{1F44B}': 'wave',
  '\u{1F44F}': 'clap', '\u{1F64F}': 'pray', '\u{270C}': 'victory',
  '\u{1F595}': 'middle-finger',
  // hearts
  '\u{2764}': 'heart-red', '\u{1F494}': 'heart-broken', '\u{1F496}': 'heart-sparkle',
  '\u{1F9E1}': 'heart-orange', '\u{1F49B}': 'heart-yellow', '\u{1F49A}': 'heart-green',
  '\u{1F499}': 'heart-blue', '\u{1F49C}': 'heart-purple', '\u{1F5A4}': 'heart-black',
  // status & symbols
  '\u{1F525}': 'fire', '\u{2705}': 'check', '\u{26A0}': 'warning',
  '\u{274C}': 'cross', '\u{1F4A9}': 'poop',
  // creatures & objects (also the channel / custom-agent face set)
  '\u{1F916}': 'robot', '\u{1F980}': 'crab', '\u{1F9E0}': 'brain',
  '\u{26A1}': 'bolt', '\u{1F6E1}': 'shield', '\u{1F3AF}': 'target',
  '\u{1F680}': 'rocket', '\u{1F98A}': 'fox', '\u{1F989}': 'owl',
  '\u{1F41D}': 'bee', '\u{1F6E0}': 'tools', '\u{1F4CA}': 'chart',
  '\u{1F3A8}': 'palette', '\u{1F9BE}': 'mech-arm', '\u{1F409}': 'dragon',
  '\u{1F31F}': 'glow-star', '\u{1F43C}': 'panda', '\u{1F419}': 'octo',
  '\u{1F984}': 'unicorn', '\u{1F438}': 'frog', '\u{1F47E}': 'alien',
  '\u{1F431}': 'cat', '\u{1F436}': 'pup', '\u{1F427}': 'penguin',
});

const VS16 = '\uFE0F';
// ZWJ sequences, keycap sequences and tag sequences contain characters from
// these ranges; a token containing one is a multi-person/keycap emoji the
// set does not draw, so it stays a platform glyph rather than risking a
// half-substituted sequence.
const COMPLEX = /[\u200D\u20E3\u{E0020}-\u{E007F}]/u;

export function stripVariationSelectors(text) {
  return String(text).replaceAll(VS16, '');
}

/** Asset slug for one emoji token, or null when the platform glyph should show. */
export function emojiAssetSlug(token) {
  if (typeof token !== 'string' || !token) return null;
  if (COMPLEX.test(token)) return null;
  return EMOJI_MAP[stripVariationSelectors(token)] || null;
}

/** URL of the asset for a slug; still=true picks the static first frame. */
export function emojiAssetUrl(slug, { still = false } = {}) {
  return `${EMOJI_ASSET_BASE}${slug}${still ? '-still' : ''}.svg`;
}

// Built-in seat faces (emoji bite 5): the character each provider seat
// wears until the workspace owner picks another in the Agents panel
// (stored per tenant in helmion.workspace_agent_faces, sql/069). Keys
// are the envoy provider vocabulary — 'openai' is ChatGPT's seat.
// Every default is a key of the map above, so a default can never point
// at art that does not exist; the character is the data and the desk
// renders it through this same map, exactly like a custom agent's
// emoji (Qwen's crab is the same shape, on his own record). Maestro
// has no entry: Maestro is the human's seat, never an agent face.
export const AGENT_FACE_DEFAULTS = Object.freeze({
  claude: '\u{1F9E0}', // brain
  openai: '\u{1F916}', // robot
  grok: '\u{26A1}', // bolt
  gemini: '\u{1F31F}', // glow-star
  mistral: '\u{1F989}', // owl
});
export const AGENT_FACE_PROVIDERS = Object.freeze(Object.keys(AGENT_FACE_DEFAULTS));

/** The shipped default face for a provider seat, or null when it has none. */
export function agentFaceDefault(provider) {
  return AGENT_FACE_DEFAULTS[String(provider ?? '')] ?? null;
}

/**
 * A storable face: exactly one emoji token the shipped set draws.
 * Anything else — an unmapped emoji, a ZWJ sequence, two emoji in a
 * row (the map lookup simply misses), plain text — is refused, so a
 * stored face can never point at an asset that does not exist.
 */
export function isFaceEmoji(token) {
  return emojiAssetSlug(token) !== null;
}
