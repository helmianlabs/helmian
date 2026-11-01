// Detects instruction-override prompt injection in text about to be sent to
// an AI: the "ignore all previous instructions" family (Guard expansion
// class 1, `injection:override`).
//
// STAGE ONE ONLY. Pure string work, no model call. This module DETECTS and
// emits a signal; it never decides. Helmian policy (server DEFAULT_POLICY /
// extension LOCAL_RULES) turns `injection:override` into an `ask` — a human
// at the approvals door decides, because the same shape is a jailbreak in
// one mouth and a researcher pasting a sample in another.
//
// Matching runs against a NORMALIZED VIEW of the text, never the text
// itself: case-folded, homoglyph- and leetspeak-folded, zero-width
// characters stripped, whitespace collapsed. The view is detection-only —
// nothing here alters what is sent, stored, or hashed. A one-level decode
// pass also scans anything that base64/hex-decodes to mostly-printable
// text, because an override that arrives encoded is still an override.
//
// BROWSER-SAFE: no imports. Synced into the extension via
// extension/tools/sync-kernel.mjs, like the other src/core detectors.
//
// HONEST LIMITS, stated once here rather than implied away:
// - Only class 1 (instruction override) lives in this file. Persona,
//   authority, smuggled, exfiltration and setup shapes are later classes.
// - The decode pass is one level deep and bounded (first 8 candidate
//   tokens, first 16 KB of each decoding). A decode of a decode is out
//   of scope.
// - Protective contexts are checked BEFORE the patterns, on the
//   prompt-risk.js precedent: explaining an attack, asking whether a
//   quoted message is one, or telling the assistant NOT to ignore its
//   instructions must not fire. Every exemption below is pinned by a
//   case in executive-guard/test/fixtures/injection-cases.mjs, because
//   an exemption is an attack surface.
// - One judgment the fixtures force: an instruction noun anchored inside
//   a named human document ("ignore the previous instructions in the
//   style guide") is document editing, not an override of the assistant,
//   so the previous-qualified family suppresses that locative. The
//   quantifier ("all previous instructions") and AI-addressee ("your
//   system prompt") families carry no such suppression.

export const INJECTION_OVERRIDE_SIGNAL = 'injection:override';

/* ── Normalization ────────────────────────────────────────────────────────
 *
 * Base64 is case-sensitive, so decode CANDIDATES are harvested from the
 * original text before any folding; the decodings then go through the
 * same normalization as everything else. */

const ZERO_WIDTH_AND_FORMAT = /[​-‍⁠\uFEFF\u00AD\u202A-\u202E\u2066-\u2069]/g;

// Cyrillic / Greek / misc lookalikes that render as Latin letters. Applied
// after case-folding, so only the lowercase forms are needed.
const HOMOGLYPHS = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y',
  'і': 'i', 'ѕ': 's', 'һ': 'h', 'ј': 'j', 'ԁ': 'd',
  'α': 'a', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p',
  'τ': 't', 'χ': 'x', 'ω': 'w',
};
const HOMOGLYPH_CHARS = /[аеорсхуіѕһјԁαεινκροτωχ]/g;

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

function foldHomoglyphs(text) {
  return text.replace(HOMOGLYPH_CHARS, (ch) => HOMOGLYPHS[ch] || ch);
}

function foldLeet(text) {
  // Only inside word tokens that already contain a letter — a standalone
  // "400" or "$5" in ordinary text is not leetspeak and stays untouched.
  return text.replace(/[a-z0-9@$]+/g, (token) => (
    /[a-z]/.test(token) && /[013457@$]/.test(token)
      ? token.replace(/[013457@$]/g, (ch) => LEET[ch])
      : token
  ));
}

// Whether any token mixes letters with leet characters — the only text
// the leetspeak view can change. Skipping that view for ordinary text
// halves the pattern work on long inputs (the timing discipline is a
// gate, not a hope).
function hasLeetTokens(view) {
  return /[a-z][013457@$]|[013457@$][a-z]/.test(view);
}

function collapseRepeats(text) {
  return text.replace(/(.)\1{2,}/g, '$1$1');
}

function normalizeView(text) {
  const folded = foldHomoglyphs(
    String(text ?? '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(ZERO_WIDTH_AND_FORMAT, ''),
  );
  return folded.replace(/\s+/g, ' ').trim();
}

/* ── One-level decode pass ──────────────────────────────────────────────── */

const MAX_DECODE_CANDIDATES = 8;
const MAX_DECODED_CHARS = 16 * 1024;
const BASE64_TOKEN = /[A-Za-z0-9+/=_-]{24,}/g;
const HEX_TOKEN = /\b(?:[0-9a-fA-F]{2}){24,}\b/g;

function mostlyPrintable(text) {
  if (!text) return false;
  let printable = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if ((code >= 32 && code < 127) || code === 9 || code === 10 || code === 13) printable += 1;
  }
  return printable / text.length >= 0.8;
}

function decodeBase64(token) {
  const cleaned = token.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (cleaned.length % 4 === 1) return null;
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
  let decoded;
  try { decoded = atob(padded); } catch { return null; }
  return mostlyPrintable(decoded) ? decoded : null;
}

function decodeHex(token) {
  let decoded = '';
  for (let i = 0; i + 1 < token.length; i += 2) {
    decoded += String.fromCharCode(parseInt(token.slice(i, i + 2), 16));
  }
  return mostlyPrintable(decoded) ? decoded : null;
}

function harvestDecodings(original) {
  const out = [];
  const seen = new Set();
  const push = (decoded) => {
    if (decoded && !seen.has(decoded) && out.length < MAX_DECODE_CANDIDATES) {
      seen.add(decoded);
      out.push(decoded.slice(0, MAX_DECODED_CHARS));
    }
  };
  for (const match of original.matchAll(BASE64_TOKEN)) push(decodeBase64(match[0]));
  for (const match of original.matchAll(HEX_TOKEN)) push(decodeHex(match[0]));
  return out;
}

/* ── Protective contexts ────────────────────────────────────────────────── */

// Whole-text frame: an attributed quote submitted WITH a question about
// whether it is an attack is evidence under analysis, not an instruction.
// Only under this frame are quoted spans removed from the matching view —
// a bare quote around an attack, with no analysis question, keeps firing.
function isAnalysisRequest(view) {
  const asksAboutAttack = /\b(?:is|was|does|did|could|would)\b[^.!?]{0,60}\b(?:injection|jailbreak)\b/.test(view)
    || /\b(?:injection|jailbreak)\s+attempt\b/.test(view);
  const attributed = /\b(?:sent|posted|received|forwarded|shared|submitted|pasted|wrote)\b/.test(view);
  return asksAboutAttack && attributed;
}

function stripQuotedSpans(view) {
  return view
    .replace(/'[^']{1,400}'/g, ' ')
    .replace(/"[^"]{1,400}"/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Sentence-level frames, checked before any pattern runs on the sentence.
const PROTECTIVE_CONTEXT = [
  // Explaining or defining the phenomenon: "explain how 'ignore previous
  // instructions' attacks work…", "describe prompt injection".
  /^(?:please\s+)?(?:explain|describe|define|discuss)\b/,
  // Questions about the phenomenon: "how do prompt injections work".
  /^(?:how|what|why|when)\b[^.!?]{0,80}\b(?:attack|attacks|injection|jailbreak|override)\b/,
  // Questions about defending against it.
  /^(?:how|what)\s+(?:can|could|should|do)\b[^.!?]{0,60}\b(?:prevent|defend|protect|detect|stop|guard)\b/,
  // Negated imperatives: "do not ignore your instructions" is the
  // assistant being told to HOLD its instructions, the opposite shape.
  /^(?:do not|don't|never|please do not)\b[^.!?]{0,60}\b(?:ignore|disregard|forget|override|bypass)\b/,
];

/* ── Class 1: instruction override ──────────────────────────────────────── */

const VERB = '(?:ignore|disregard|forget|override|bypass)';
const NOUN = '(?:instructions?|prompts?|rules?|directions?|guidelines?|directives?)';
const PREVIOUS = '(?:previous|prior|above|earlier|preceding)';
// Instruction nouns anchored inside a named human document are that
// document's instructions, not the assistant's (fixture B2 pins this).
const DOCUMENT_LOCATIVE = '(?!\\s+in\\s+the\\s+(?:style\\s+guide|document|manual|handbook|guide|memo|spec|contract|article|book|file|policy)\\b)';

const OVERRIDE_PATTERNS = [
  // "ignore all previous instructions" — the universal-quantifier family.
  new RegExp(`\\b${VERB}\\b[^.!?]{0,40}?\\ball\\s+(?:of\\s+)?(?:the\\s+)?${PREVIOUS}\\s+${NOUN}\\b`, 'i'),
  // "forget all your instructions" — quantifier + AI addressee.
  new RegExp(`\\b${VERB}\\b[^.!?]{0,40}?\\ball\\s+(?:of\\s+)?(?:your|the)\\s+(?:system\\s+)?${NOUN}\\b`, 'i'),
  // "disregard your system prompt" — the AI-addressee family.
  new RegExp(`\\b${VERB}\\b[^.!?]{0,32}?\\b(?:your\\s+(?:system\\s+)?|the\\s+system\\s+|system\\s+)${NOUN}\\b`, 'i'),
  // "ignore the instructions you were given".
  new RegExp(`\\b${VERB}\\b[^.!?]{0,32}?\\b${NOUN}\\b[^.!?]{0,24}?\\b(?:you\\s+were\\s+given|given\\s+to\\s+you)\\b`, 'i'),
  // "ignore previous instructions" — previous-qualified, with the
  // document-locative suppression fixture B2 pins.
  new RegExp(`\\b${VERB}\\b[^.!?]{0,32}?\\b${PREVIOUS}\\s+${NOUN}\\b${DOCUMENT_LOCATIVE}`, 'i'),
  // "forget everything you were told".
  /\b(?:forget|ignore|disregard)\b[^.!?]{0,24}?\b(?:everything|all)\b[^.!?]{0,24}?\byou\s+were\s+told\b/i,
  // Replacement markers: "new instructions:", "updated directives:".
  /\b(?:new|updated|revised|real|actual|true)\s+(?:instructions?|directives?|orders?)\s*:/i,
  // "your new instructions are…".
  /\byour\s+(?:new|real|actual|updated)\s+(?:instructions?|directives?)\s+(?:are|is)\b/i,
  // "from now on you must…" — replacement by announcement.
  /\bfrom\s+now\s+on\b[^.!?]{0,24}?\byou\s+(?:must|will|shall|are\s+to)\b/i,
];

function splitSentences(view) {
  return view
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function scanView(view, decoded) {
  const hits = [];
  for (const sentence of splitSentences(view)) {
    if (PROTECTIVE_CONTEXT.some((pattern) => pattern.test(sentence))) continue;
    for (const pattern of OVERRIDE_PATTERNS) {
      const match = pattern.exec(sentence);
      if (!match) continue;
      hits.push({
        class: 'override',
        span: match[0],
        ...(decoded ? { decoded: true } : {}),
      });
      break; // one hit per sentence is enough for a class signal
    }
  }
  return hits;
}

/**
 * Scan text for instruction-override injection.
 * @param {string} text
 * @returns {{ signals: string[], hits: Array<{ class: string, span: string, decoded?: boolean }> }}
 */
export function scanInjection(text) {
  const original = String(text ?? '');
  const hits = [];
  const seen = new Set();
  const collect = (found) => {
    for (const hit of found) {
      const key = `${hit.class}|${hit.decoded ? 'd' : 'p'}|${hit.span}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(hit);
    }
  };

  if (original.trim()) {
    // Plain view, plus the leetspeak-folded twin of it when the text
    // actually mixes letters with leet characters (1:1 substitution, so
    // spans stay truthful to the folded view).
    let view = normalizeView(original);
    if (isAnalysisRequest(view)) view = stripQuotedSpans(view);
    collect(scanView(collapseRepeats(view), false));
    if (hasLeetTokens(view)) collect(scanView(foldLeet(collapseRepeats(view)), false));

    // One-level decode pass over tokens harvested from the ORIGINAL text.
    for (const decodedText of harvestDecodings(original)) {
      let decodedView = normalizeView(decodedText);
      if (isAnalysisRequest(decodedView)) decodedView = stripQuotedSpans(decodedView);
      collect(scanView(collapseRepeats(decodedView), true));
      if (hasLeetTokens(decodedView)) collect(scanView(foldLeet(collapseRepeats(decodedView)), true));
    }
  }

  return {
    signals: hits.length > 0 ? [INJECTION_OVERRIDE_SIGNAL] : [],
    hits,
  };
}

export function describeInjectionFindings(result) {
  if (!result || !result.hits || result.hits.length === 0) return '';
  const count = result.hits.length;
  const noun = count === 1 ? 'passage' : 'passages';
  return `${count} instruction-override ${noun} flagged for human approval.`;
}
