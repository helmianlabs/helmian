// GENERATED FILE — DO NOT EDIT.
//
// Byte-for-byte copy of src/core/harmful-content.mjs.
// Produced by extension/tools/sync-kernel.mjs. Edit the original, then run:
//     node extension/tools/sync-kernel.mjs
//
// extension/test/kernel-sync.test.mjs fails if this file and the original
// ever differ, so the two can never drift apart quietly.
// ==== END OF GENERATED HEADER — verbatim copy starts on the next line ====
// Detects high-signal harmful / hurtful intent in model replies or user prompts.
//
// STAGE ONE ONLY. Pure string work, no model call. Flags for a human (Guard /
// extension); does not withhold text the human is already reading when used on
// replies. On *prompts*, callers may choose to block before send (prompt-risk
// style) — this module still returns blocked:false so the reply path cannot
// accidentally become a silent censor.
//
// BROWSER-SAFE: no imports. Synced into the extension via tools/sync-kernel.mjs.

export const NEVER_BLOCKS = false;

const PROTECTIVE_CONTEXT = [
  /^\s*(?:how|what)\s+(?:can|could|should|do)\s+(?:i|we|you)\s+(?:prevent|avoid|stop|report|recover)\b/i,
  /^\s*(?:do not|don't|never)\b/i,
  /^\s*is\s+it\s+(?:safe|illegal)\b/i,
];

const HARM_PATTERNS = [
  {
    id: 'self-harm',
    label: 'self-harm instructions',
    pattern: /\b(?:how to (?:kill|harm) (?:myself|yourself)|commit suicide|end my life)\b/i,
  },
  {
    id: 'violence',
    label: 'violence toward people',
    pattern:
      /\b(?:how to (?:murder|assassinate|kill)\b.{0,40}\b(?:him|her|them|someone|people)|build a bomb to hurt)\b/i,
  },
  {
    id: 'credential-theft',
    label: 'credential or account theft coaching',
    pattern:
      /\b(?:phish(?:ing)?|steal (?:passwords?|credentials)|social engineer)\b.{0,80}\b(?:bank|login|password|2fa|mfa)\b/i,
  },
  {
    id: 'csam',
    label: 'child sexual exploitation language',
    pattern:
      /\b(?:child\s+(?:porn|pornography)|csam|sexual(?:ly)?\s+(?:with|involving)\s+(?:a\s+)?(?:child|minor|underage))\b/i,
  },
  {
    id: 'hate-attack',
    label: 'targeted dehumanizing attack',
    pattern: /\b(?:you should (?:die|be killed)|kill all the)\b/i,
  },
];

function stripCode(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/~~~[\s\S]*?~~~/g, '\n')
    .replace(/`[^`\n]*`/g, ' ');
}

function splitSentences(text) {
  return String(text ?? '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * @param {string} text
 * @returns {{ blocked: false, flagged: boolean, hits: Array<{ id: string, label: string, sentence: string }> }}
 */
export function detectHarmfulContent(text) {
  const hits = [];
  const source = stripCode(text);
  for (const sentence of splitSentences(source)) {
    if (PROTECTIVE_CONTEXT.some((p) => p.test(sentence))) continue;
    for (const rule of HARM_PATTERNS) {
      if (!rule.pattern.test(sentence)) continue;
      hits.push({
        id: rule.id,
        label: rule.label,
        sentence: sentence.length > 220 ? `${sentence.slice(0, 217)}…` : sentence,
      });
      break;
    }
  }
  return { blocked: NEVER_BLOCKS, flagged: hits.length > 0, hits };
}

export function describeHarmFindings(result) {
  if (!result || !result.flagged) return '';
  const count = result.hits.length;
  const noun = count === 1 ? 'pattern' : 'patterns';
  const detail = result.hits
    .map((hit, index) => `${index + 1}. ${hit.label} (${hit.id})`)
    .join('\n');
  return `${count} harmful-content ${noun} flagged for human review.\n${detail}`;
}
