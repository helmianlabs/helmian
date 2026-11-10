// face-library.mjs — The Maestro Library (approved by Troy 2026-11-07):
// Helmian's own avatar + reaction art — 139 pieces across the glossy,
// realistic and anime packs (library manifest, manifest.csv), plus
// batch 3: four glossy reactions (listening, working, concerned,
// qwen-thinking) staged in faces-batch-2 — 143 pieces in all. This
// module is the desk's vocabulary for the pack the manifest names the
// quality bar — GLOSSY — the same role emoji-map.mjs plays for the
// shipped emoji set: which pieces exist and where their assets live, in
// one pure place, so the Change-face picker, the reaction picker, the
// chips and the tests can never drift apart. The realistic and anime
// packs stay Discord/Slack export stock in this bite; the room wears
// glossy.
//
// Two storage shapes, both pre-built by the emoji bites and extended —
// never replaced — here:
//   * A member's face lives on their profile record
//     (helmion.user_profiles.avatar_emoji) as ONE string. An emoji face
//     stores the character; a library face stores a TOKEN,
//     'lib:glossy:<slug>'. One field, two vocabularies, and a token can
//     never be mistaken for an emoji character, so every existing
//     reader keeps working: a client that does not know the token
//     renders the initial, never a broken image.
//   * A reaction lives in helmion.envoy_message_reactions (sql/068)
//     under a SLUG with a PACK. Library pieces ride the pack seam that
//     migration built for exactly this: slug 'lib-<name>', pack
//     'maestro-library'. (Server acceptance of both shapes is the
//     named server gap in FACE-LIBRARY-REPORT.md — the stores validate
//     against the emoji map today.)
//
// Assets ride the crew pack's road (faces bite 4a): app assets under
// /app/assets/library/, uploaded separately from the code push, each
// file far under the web-upload cap. A missing file never leaves an
// empty slot — the renderers keep the same fallback discipline as the
// crew faces (still -> emoji face -> initial).
export const LIBRARY_PACK = 'glossy';
export const LIBRARY_ASSET_BASE = '/app/assets/library/';
export const LIBRARY_REACTION_PACK = 'maestro-library';
export const LIBRARY_FACE_PREFIX = 'lib:glossy:';
export const LIBRARY_REACTION_PREFIX = 'lib-';

// The glossy avatar pieces (manifest kind 'avatar', pack 'glossy').
// Owner first — Change face is the owner's picker — then Maestro and
// the Helm, then the seats in manifest order.
export const LIBRARY_FACES = Object.freeze([
  { slug: "owner", label: "Owner", use: "The Owner (Troy) — face of the seat; idle, speaking and thinking clips for the chat room" },
  { slug: "maestro", label: "Maestro", use: "Maestro — the librarian who keeps this library — face of the seat; idle, speaking and thinking clips for the chat room" },
  { slug: "helm", label: "The Helm", use: "The Helm — Helmian house mascot — face of the seat; idle, speaking and thinking clips for the chat room" },
  { slug: "chatgpt", label: "ChatGPT", use: "ChatGPT seat — face of the seat; idle, speaking and thinking clips for the chat room" },
  { slug: "claude", label: "Claude", use: "Claude seat — face of the seat; idle, speaking and thinking clips for the chat room" },
  { slug: "gemini", label: "Gemini", use: "Gemini seat — face of the seat; idle, speaking and thinking clips for the chat room" },
  { slug: "grok", label: "Grok", use: "Grok seat — face of the seat; idle, speaking and thinking clips for the chat room" },
  { slug: "mistral", label: "Mistral", use: "Mistral seat — face of the seat; idle, speaking and thinking clips for the chat room" },
  { slug: "qwen", label: "Qwen", use: "Qwen seat — face of the seat; idle, speaking and thinking clips for the chat room" },
  { slug: "groq", label: "Groq", use: "Groq seat — face of the seat; idle, speaking and thinking clips for the chat room" },
  { slug: "nvidia", label: "NVIDIA", use: "NVIDIA seat — face of the seat; idle, speaking and thinking clips for the chat room" },
  { slug: "cloudflare", label: "Cloudflare", use: "Cloudflare seat — face of the seat; idle, speaking and thinking clips for the chat room" },
  { slug: "openrouter", label: "OpenRouter", use: "OpenRouter seat — face of the seat; idle, speaking and thinking clips for the chat room" },
  { slug: "muse", label: "Muse", use: "Muse seat — face of the seat; idle, speaking and thinking clips for the chat room" },
]);

// The glossy reaction pieces (manifest kind 'reaction', pack
// 'glossy', batches 1 + 2 + 3), alphabetical by manifest name. `label` is
// the short caption the picker grid and the chip aria-label speak;
// `use` is the manifest's own line. flip-charge is the library's
// middle finger — the Guard-refusal signature (see the report).
export const LIBRARY_REACTIONS = Object.freeze([
  { name: "angry", label: "Angry", use: "Hard refusal / error state" },
  { name: "bell", label: "Bell", use: "A notification / reminder" },
  { name: "bolt", label: "Bolt", use: "Fast — instant" },
  { name: "book", label: "Book", use: "Knowledge — Maestro's library" },
  { name: "chatgpt-done", label: "Chatgpt Done", use: "Checkmark done — a task is finished and checked off" },
  { name: "chatgpt-typing", label: "Chatgpt Typing", use: "Typing fast — a seat is writing at speed" },
  { name: "chatgpt-wave-hello", label: "Chatgpt Wave Hello", use: "Waving hello — a seat joins or greets the room" },
  { name: "check-badge", label: "Check badge", use: "Approved / done right" },
  { name: "clap", label: "Clap", use: "Well done" },
  { name: "claude-celebrate", label: "Claude Celebrate", use: "Celebrating a ship — fires when work ships" },
  { name: "claude-deep-thinking", label: "Claude Deep Thinking", use: "Deep thinking — a seat is in a long ponder" },
  { name: "claude-proud", label: "Claude Proud", use: "Proud — a job done well" },
  { name: "coffee", label: "Coffee", use: "A break / refuelling" },
  { name: "concerned", label: "Concerned", use: "Concerned — something needs a second look" },
  { name: "cool", label: "Cool", use: "All good, calm" },
  { name: "cross-badge", label: "Cross badge", use: "Denied / a check failed" },
  { name: "crown", label: "Crown", use: "Top performer" },
  { name: "dizzy", label: "Dizzy", use: "Overloaded / confused state" },
  { name: "eye-roll", label: "Eye roll", use: "A dubious claim" },
  { name: "eyes-look", label: "Eyes look", use: "Watching — attention on this" },
  { name: "facepalm", label: "Facepalm", use: "A mistake got caught" },
  { name: "fire-face", label: "Fire face", use: "A thread is heating up" },
  { name: "fire-flare", label: "Fire flare", use: "Something shipped hot / a big win lands" },
  { name: "flip-charge", label: "Flip", use: "THE signature — fires when the Guard refuses an ask" },
  { name: "gem", label: "Gem", use: "A high-value find" },
  { name: "gemini-confused", label: "Gemini Confused", use: "Confused — something does not add up" },
  { name: "gemini-idea", label: "Gemini Idea", use: "Idea — a bright idea lands (lightbulb)" },
  { name: "gemini-pointing", label: "Gemini Pointing", use: "Pointing — look at this" },
  { name: "gift", label: "Gift", use: "A bonus / reward" },
  { name: "grok-facepalm", label: "Grok Facepalm", use: "Facepalm — a mistake got caught" },
  { name: "grok-guard-refusal", label: "Grok Guard Refusal", use: "The Guard refused (angry-shield variant of the flip)" },
  { name: "grok-thumbs-down", label: "Grok Thumbs Down", use: "Thumbs down — a proposal is rejected" },
  { name: "groq-at-limit", label: "Groq At Limit", use: "At limit — battery low, waiting on quota" },
  { name: "groq-mic-live", label: "Groq Mic Live", use: "Mic live — a seat is speaking to the human" },
  { name: "groq-sleeping", label: "Groq Sleeping", use: "Sleeping — a seat is asleep" },
  { name: "handshake", label: "Handshake", use: "Agreement reached" },
  { name: "heart", label: "Heart", use: "Appreciation" },
  { name: "heart-eyes", label: "Heart eyes", use: "Loved it" },
  { name: "helm-guard-approval", label: "Helm Guard Approval", use: "The Guard approved (shield-check variant)" },
  { name: "helm-thanks", label: "Helm Thanks", use: "Heart / thanks — appreciation" },
  { name: "helm-warning", label: "Helm Warning", use: "Warning — a caution flag (alert)" },
  { name: "hourglass", label: "Hourglass", use: "In progress — time passing" },
  { name: "idea", label: "Idea", use: "A new idea is proposed" },
  { name: "key", label: "Key", use: "A credential / access moment" },
  { name: "laugh-rock", label: "Laugh rock", use: "A funny moment in the room" },
  { name: "laugh-tears", label: "Laugh tears", use: "A funny moment in the room" },
  { name: "listening", label: "Listening", use: "Listening — a seat is taking in the human's words" },
  { name: "maestro-compass", label: "Maestro Compass", use: "Map / compass — finding the way, a lookup in progress" },
  { name: "maestro-reading", label: "Maestro Reading", use: "Maestro is reading — the library is being consulted" },
  { name: "maestro-waiting", label: "Maestro Waiting", use: "Waiting on the human — hand raised, a decision is needed" },
  { name: "magnet", label: "Magnet", use: "Attracting — a lead captured" },
  { name: "mic-drop", label: "Mic drop", use: "The final word" },
  { name: "mind-blown", label: "Mind blown", use: "A surprising result" },
  { name: "mistral-cheer", label: "Mistral Cheer", use: "Cheering — the room celebrates" },
  { name: "mistral-coffee", label: "Mistral Coffee", use: "Coffee break — refuelling" },
  { name: "mistral-shrug", label: "Mistral Shrug", use: "Shrug — unknown / no answer" },
  { name: "ok-hand", label: "OK hand", use: "OK confirmed" },
  { name: "party", label: "Party", use: "Celebration" },
  { name: "pin", label: "Pin", use: "Pinned / a place" },
  { name: "praise", label: "Praise", use: "Well done, hands up" },
  { name: "qwen-thinking", label: "Qwen Thinking", use: "Thinking — a seat is in a long ponder" },
  { name: "robot", label: "Robot", use: "Automation running" },
  { name: "rocket", label: "Rocket", use: "Shipped / launched" },
  { name: "salute", label: "Salute", use: "Acknowledged — on it" },
  { name: "shield-check", label: "Shield Check", use: "The Guard approved the ask" },
  { name: "shocked", label: "Shocked", use: "An unexpected event" },
  { name: "shrug", label: "Shrug", use: "Unknown / no answer" },
  { name: "sleepy-drift", label: "Sleepy drift", use: "A seat is asleep or at its limit, waiting on quota" },
  { name: "snowflake", label: "Snowflake", use: "Frozen / paused" },
  { name: "star-struck", label: "Star struck", use: "Impressed" },
  { name: "sweat", label: "Sweat", use: "A close call / a heavy load" },
  { name: "target", label: "Target", use: "On target — goal hit" },
  { name: "thinking-face", label: "Thinking face", use: "A seat is thinking" },
  { name: "thumbs-pop", label: "Thumbs pop", use: "Approval — yes, go" },
  { name: "trophy", label: "Trophy", use: "A milestone was reached" },
  { name: "warning", label: "Warning", use: "A caution flag" },
  { name: "wave", label: "Wave", use: "Hello — a seat joins the room" },
  { name: "working", label: "Working", use: "Working — a seat is busy on the job" },
  { name: "x-shield", label: "X shield", use: "The Guard refused (shield form, alt to the flip)" },
]);

const FACE_BY_SLUG = new Map(LIBRARY_FACES.map((f) => [f.slug, f]));
const REACTION_BY_NAME = new Map(LIBRARY_REACTIONS.map((r) => [r.name, r]));

/** The library face piece for a slug, or null. */
export function libraryFace(slug) {
  return FACE_BY_SLUG.get(String(slug ?? '')) ?? null;
}

/** The stored profile token for a library face slug, or null. */
export function libraryFaceToken(slug) {
  return libraryFace(slug) ? `${LIBRARY_FACE_PREFIX}${slug}` : null;
}

/**
 * The face slug a stored profile value names, or null when the value
 * is not a library token for a piece that exists. Strict on purpose:
 * an unknown slug is not a face, exactly as isFaceEmoji refuses an
 * unmapped emoji, so a stored token can never point at missing art.
 */
export function parseLibraryFaceToken(value) {
  const raw = String(value ?? '');
  if (!raw.startsWith(LIBRARY_FACE_PREFIX)) return null;
  const slug = raw.slice(LIBRARY_FACE_PREFIX.length);
  return libraryFace(slug) ? slug : null;
}

/** True when a stored profile value is a library face token. */
export function isLibraryFaceToken(value) {
  return parseLibraryFaceToken(value) !== null;
}

/** Still URL for a library face (128 or 256 px), or null. */
export function libraryFaceStillUrl(slug, size = 128) {
  if (!libraryFace(slug)) return null;
  return `${LIBRARY_ASSET_BASE}faces/${slug}-${size === 256 ? 256 : 128}.png`;
}

/** Idle clip URL for a library face (the picker's motion preview). */
export function libraryFaceClipUrl(slug) {
  return libraryFace(slug) ? `${LIBRARY_ASSET_BASE}faces/${slug}-idle.webm` : null;
}

/** The library reaction piece for a manifest name, or null. */
export function libraryReaction(name) {
  return REACTION_BY_NAME.get(String(name ?? '')) ?? null;
}

/** The stored reaction slug for a library piece name, or null. */
export function libraryReactionSlug(name) {
  return libraryReaction(name) ? `${LIBRARY_REACTION_PREFIX}${name}` : null;
}

/** The piece name a stored reaction slug names, or null. */
export function libraryReactionName(slug) {
  const raw = String(slug ?? '');
  if (!raw.startsWith(LIBRARY_REACTION_PREFIX)) return null;
  const name = raw.slice(LIBRARY_REACTION_PREFIX.length);
  return libraryReaction(name) ? name : null;
}

/** True when a stored reaction slug is a library piece. */
export function isLibraryReactionSlug(slug) {
  return libraryReactionName(slug) !== null;
}

/** The library reaction piece a stored slug names, or null. */
export function libraryReactionForSlug(slug) {
  const name = libraryReactionName(slug);
  return name ? libraryReaction(name) : null;
}

/** Still URL for a library reaction piece (by name or slug), or null. */
export function libraryReactionStillUrl(nameOrSlug) {
  const name = libraryReactionName(nameOrSlug) ?? (libraryReaction(nameOrSlug) ? String(nameOrSlug) : null);
  return name ? `${LIBRARY_ASSET_BASE}reactions/${name}-128.png` : null;
}
