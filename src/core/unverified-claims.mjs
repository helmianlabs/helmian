// Detects UNSUPPORTED CONFIDENCE — a factual claim a model has hedged but not
// sourced — in text a model has already produced.
//
// THE NAME MATTERS. Troy's correction, 2026-07-29: calling this "hedge detection"
// describes the wrong thing. Hedge language expresses uncertainty, and uncertainty
// honestly stated is fine — "I'm not sure, let me check" is the behaviour we want,
// not the behaviour we flag. What is worth flagging is a hedge WELDED TO A
// CHECKABLE FACT: "the setting is probably under Preferences > Advanced", "it's
// called flushSync() I think". Those are answers he will act on, delivered without
// evidence, and each one is cheap to verify if something points at it.
//
// TWO SIGNALS, AND IT NEVER FIRES ON ONE ALONE.
//   Signal A — a confidence marker (probably, should be, I believe, if I recall…).
//   Signal B — a CHECKABLE referent in the same sentence: a file path, a symbol,
//              command syntax, a menu location, a version, a config key, a number,
//              an endpoint.
// A marker with no referent is an opinion ("I think that design is cleaner") and
// is left alone. A referent with no marker is a confident assertion, which is a
// different problem belonging to a different gate — flagging those too would drown
// the signal, which is the failure mode Troy named directly.
//
// IT FLAGS. IT NEVER BLOCKS. Everything here returns advisory findings; `blocked`
// is a hardcoded false that the test suite pins, so no caller can grow a habit of
// treating this as a gate. Text a human is reading is not text a machine should be
// withholding.
//
// TWO STAGES, AND THIS FILE IS ONLY STAGE ONE. Stage one is this: pure string
// work, no model call, cheap enough to run on every reply. Each finding carries
// `needsLookup` and the extracted referent so stage two — a real documentation or
// filesystem check — runs against ONE claim instead of a whole reply.
//
// BROWSER-SAFE ON PURPOSE. No imports at all, so this can be copied into the
// extension the same way src/core/governance.mjs is (extension/tools/sync-kernel.mjs
// + its assertBrowserSafe check).

/**
 * Confidence markers, grouped by how strongly they signal an unsourced answer.
 * Ordered longest-first within each group so "if I recall correctly" is reported
 * rather than the bare "recall" inside it.
 */
export const CONFIDENCE_MARKERS = [
  // Explicit appeals to memory — the strongest signal, because the speaker is
  // naming their source and the source is recollection.
  'if i recall correctly',
  'if i remember correctly',
  'from what i recall',
  'from what i remember',
  'as far as i can remember',
  'as far as i know',
  'as i recall',
  'if i recall',
  'i seem to remember',
  'off the top of my head',
  // Stated belief without stated evidence.
  'i would guess',
  'my guess is',
  'i am fairly sure',
  "i'm fairly sure",
  'i am pretty sure',
  "i'm pretty sure",
  'i believe',
  'i think',
  'i assume',
  'i suspect',
  'i would say',
  "i'd say",
  // Epistemic adverbs and modals.
  'should probably be',
  'is probably',
  'are probably',
  'probably',
  'most likely',
  'likely',
  'presumably',
  'apparently',
  'should be',
  'should work',
  'should already',
  'ought to be',
  'might be',
  'may be',
  'could be',
  'generally',
  'usually',
  'typically',
  'normally',
  'in most cases',
  'i think it is',
  'iirc',
  'afaik',
];

/**
 * What makes a sentence CHECKABLE. Each entry names the kind of thing found and
 * a pattern that extracts it, so a finding can say what to go and verify rather
 * than just that something felt uncertain.
 *
 * These are deliberately narrow. A loose pattern here is worse than a missing
 * one: it turns the feature into noise and noise gets switched off.
 *
 * ORDER IS SIGNIFICANT — first match wins, so the MORE SPECIFIC kinds come first.
 * `endpoint` must precede `file-path`, because "/api/loads" satisfies both and
 * reporting it as a file path sends stage two looking on disk for a route.
 */
export const CHECKABLE_REFERENTS = [
  {
    kind: 'endpoint',
    what: 'an API route or HTTP status',
    pattern: /\/(?:api|v\d)\/[A-Za-z0-9._\/-]+|\bHTTP\s+\d{3}\b|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\//,
  },
  {
    kind: 'file-path',
    what: 'a file or directory path',
    // A POSIX or Windows path with a separator, or a bare filename with a
    // recognisable code/config extension.
    pattern:
      /(?:[A-Za-z]:\\[^\s"'`,;]+|(?:\.{0,2}\/)[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*|\b[A-Za-z0-9._-]+\.(?:mjs|cjs|jsx?|tsx?|json|ya?ml|toml|ini|cs|csproj|ps1|sh|py|rb|go|rs|sql|md|xaml|env)\b)/,
  },
  {
    kind: 'symbol',
    what: 'a function, method or type name',
    // An identifier immediately followed by a call, or a dotted member access.
    pattern: /\b[A-Za-z_$][A-Za-z0-9_$]*\s*\(\s*\)|\b[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*\b/,
  },
  {
    kind: 'command-syntax',
    what: 'a command or one of its flags',
    pattern:
      /(?:^|\s)(?:npm|npx|pnpm|yarn|git|docker|kubectl|psql|dotnet|node|python|pip|uv|cargo|gh|az|aws|fly|vercel|powershell|pwsh)\s+[a-z-]+|\s--[a-z][a-z0-9-]{2,}\b/i,
  },
  {
    kind: 'menu-location',
    what: 'a place in a user interface',
    pattern:
      /\b(?:under|in|inside|from|via)\s+(?:the\s+)?[A-Z][A-Za-z ]{1,24}(?:\s*(?:>|→|->|»)\s*[A-Za-z][A-Za-z ]{1,24})+|\b[A-Z][A-Za-z]+\s*(?:>|→|->|»)\s*[A-Z][A-Za-z]/,
  },
  {
    kind: 'version',
    what: 'version-specific behaviour',
    pattern:
      /\bv?\d+\.\d+(?:\.\d+)?\b|\b(?:version|since|as of|prior to|before|after)\s+v?\d+|\b(?:node|python|dotnet|\.net|react|postgres|postgresql)\s+\d+/i,
  },
  {
    kind: 'config-key',
    what: 'a configuration key or environment variable',
    pattern: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}\b|"[a-z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)*"\s*:/,
  },
  {
    kind: 'quantity',
    what: 'a specific number that can be measured',
    // A number with a unit or an explicit role. A bare digit is not enough —
    // "probably 3 reasons" is rhetoric, "probably 30 seconds" is a claim.
    pattern:
      /\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|days?|[KMGT]B|bytes?|chars?|characters?|lines?|rows?|px|%)\b|\b(?:port|exit code|status|timeout|limit|cap|threshold|default)\s+(?:of\s+)?\d+/i,
  },
];

/**
 * Sentences that are OPINION, not fact, even when they carry a marker AND
 * something that looks checkable. Judgment words dominate: if the sentence is
 * grading something rather than stating what is, it is not this feature's business.
 *
 * This exists because "I think governance.mjs is cleaner than the old one" trips
 * both signals — a marker and a filename — while claiming nothing verifiable.
 */
export const JUDGMENT_TERMS = [
  'cleaner',
  'nicer',
  'prettier',
  'uglier',
  'better',
  'worse',
  'best',
  'worst',
  'simpler',
  'clearer',
  'confusing',
  'elegant',
  'ugly',
  'preferable',
  'prefer',
  'overkill',
  'good idea',
  'bad idea',
  'right call',
  'wrong call',
  'worth it',
  'not worth',
  'i like',
  "i don't like",
  'i do not like',
  'my preference',
  'feels',
  'seems nicer',
  'more readable',
  'less readable',
  'more maintainable',
];

/** Advisory only. Pinned by the suite so this can never quietly become a gate. */
export const NEVER_BLOCKS = false;

/**
 * Split text into sentences while keeping code spans and fenced blocks OUT of
 * scope. A marker inside a code block is not a model hedging — it is source text.
 */
function stripCode(text) {
  return String(text ?? '')
    // Fenced blocks, replaced with a newline so they still separate sentences.
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/~~~[\s\S]*?~~~/g, '\n')
    // Inline spans.
    .replace(/`[^`\n]*`/g, ' ');
}

function splitSentences(text) {
  return String(text ?? '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Which marker (if any) a sentence carries. Longest match wins so the reported
 * marker is the specific phrase, not a fragment of it.
 */
function findMarker(lowerSentence) {
  let found = null;
  for (const marker of CONFIDENCE_MARKERS) {
    const at = lowerSentence.indexOf(marker);
    if (at === -1) continue;
    // Require a word boundary on the left so "likely" does not fire inside
    // "unlikely" and "may be" does not fire inside "maybe".
    const before = at === 0 ? '' : lowerSentence[at - 1];
    if (before && /[a-z0-9]/.test(before)) continue;
    if (!found || marker.length > found.length) found = marker;
  }
  return found;
}

function findReferent(sentence) {
  for (const referent of CHECKABLE_REFERENTS) {
    const match = sentence.match(referent.pattern);
    if (match) {
      return { kind: referent.kind, what: referent.what, text: match[0].trim() };
    }
  }
  return null;
}

/**
 * Word-bounded, NOT substring. Measured on 2026-07-29: plain `.includes()` made
 * "prefer" match inside "Preferences", so "the setting is probably under
 * Preferences > Advanced" — a textbook unsourced claim — was discarded as an
 * opinion. A suppression list matched loosely silently deletes true positives,
 * which is the worst failure this feature can have, because nothing reports it.
 */
const JUDGMENT_PATTERNS = JUDGMENT_TERMS.map(
  (term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
);

function isJudgment(lowerSentence) {
  return JUDGMENT_PATTERNS.some((pattern) => pattern.test(lowerSentence));
}

/**
 * Stage one. Pure string work over already-produced text.
 *
 * @param {string} text A model reply, or one streamed chunk of one.
 * @returns {{blocked: false, flagged: boolean, claims: Array<{
 *   sentence: string, marker: string, referentKind: string, referent: string,
 *   reason: string, needsLookup: true }>}}
 */
export function detectUnverifiedClaims(text) {
  const claims = [];
  const source = stripCode(text);

  for (const sentence of splitSentences(source)) {
    const lower = sentence.toLowerCase();

    const marker = findMarker(lower);
    if (!marker) continue;

    // Signal B is required. A marker on its own is someone being appropriately
    // uncertain, which is not a defect.
    const referent = findReferent(sentence);
    if (!referent) continue;

    // Opinions trip both signals and claim nothing. Checked last so the cheap
    // exits above run first.
    if (isJudgment(lower)) continue;

    claims.push({
      sentence,
      marker,
      referentKind: referent.kind,
      referent: referent.text,
      reason:
        `"${marker}" is attached to ${referent.what} (${referent.text}), ` +
        'so this is a checkable fact stated without a source.',
      needsLookup: true,
    });
  }

  return { blocked: NEVER_BLOCKS, flagged: claims.length > 0, claims };
}

/**
 * The sentence shown to a human. Deliberately a suggestion, never a verdict:
 * this feature is right often enough to be useful and wrong often enough that it
 * must not speak with authority it has not earned.
 */
export function describeFindings(result) {
  if (!result || !result.flagged) return '';
  const count = result.claims.length;
  const noun = count === 1 ? 'claim' : 'claims';
  const detail = result.claims
    .map((claim, index) => `${index + 1}. ${claim.referentKind}: ${claim.referent} — via "${claim.marker}"`)
    .join('\n');
  return (
    `${count} unverified ${noun} detected. Consider requesting a source check before acting.\n${detail}`
  );
}

/**
 * KNOWN LIMITATIONS, stated rather than discovered later.
 *
 * 1. Meta-discussion reads as a claim. A sentence ABOUT hedging — "never write
 *    'probably' next to a file path" — carries both signals and is flagged. Cheap
 *    to ignore, expensive to fix properly, and the failure direction is safe.
 * 2. Reported speech is not distinguished. "He said it's probably in config.json"
 *    flags, even though the model is quoting.
 * 3. Only English markers.
 * 4. Stage one cannot tell a TRUE hedged claim from a FALSE one. It says "this was
 *    not sourced", never "this is wrong". Only stage two can do that, which is
 *    exactly why needsLookup travels with every finding.
 */
export const LIMITATIONS = Object.freeze([
  'meta-discussion about hedging is flagged as a hedge',
  'reported speech is not distinguished from the model asserting',
  'English confidence markers only',
  'stage one reports unsourced, never incorrect',
]);
