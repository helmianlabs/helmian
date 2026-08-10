// The Hume EVI "Custom Language Model" wire contract, as pure functions.
//
// PRIMARY SOURCES, READ 2026-08-09, NOT REMEMBERED
//
//   1. https://dev.hume.ai/docs/speech-to-speech-evi/guides/custom-language-model
//      — the incoming envelope, and: "You can send multiple `assistant_input`
//        payloads consecutively to stream text to the assistant. Once you are
//        done sending inputs, you must send an `assistant_end` payload to
//        indicate the end of your turn." It also states `custom_session_id` "is
//        included as a top-level property on the incoming message", can be set
//        on outgoing `assistant_input` messages, and "only needs to be set once
//        per chat."
//   2. Hume's own runnable example, fetched verbatim rather than summarised:
//      https://raw.githubusercontent.com/HumeAI/hume-api-examples/main/evi/
//      evi-python-clm-wss/main.py — `@app.websocket("/llm")`, and the two
//      outgoing payloads it builds:
//          {"type": "assistant_input", "text": response}
//          {"type": "assistant_end"}
//      Note what the example does NOT put on `assistant_end`: a session id.
//      This file matches that byte-for-byte rather than "improving" it.
//
// The incoming envelope, from source (2)'s TypedDicts and source (1)'s schema:
//
//   {
//     "messages": [
//       { "type": "...",
//         "message": { "role": "user"|"assistant", "content": "..." },
//         "models": { "prosody": { "scores": { "<emotion>": number } } },
//         "time":   { "begin": n, "end": n } }
//     ],
//     "custom_session_id": "..."
//   }
//
// EVERYTHING HERE IS A PURE FUNCTION ON PURPOSE. Parsing and shaping is the
// half of this feature that can be proven without a socket, a key, or a model,
// so it is kept where a test can reach it directly.

/** The two outgoing message types EVI understands from a CLM socket. */
export const ASSISTANT_INPUT = 'assistant_input';
export const ASSISTANT_END = 'assistant_end';

/**
 * How much Cora is allowed to say in ONE turn before she is cut off.
 *
 * This is a product decision, not a protocol one. A voice assistant that reads
 * a 900-word answer aloud cannot be interrupted usefully and is the single
 * most-hated failure mode of every voice stack Troy has used. The agent's full
 * answer is never lost — it is written to the activity ledger — so the spoken
 * form is deliberately the summary and the ledger is the record.
 */
export const DEFAULT_MAX_SPOKEN_CHARS = 900;

/** Per-chunk cap. EVI starts speaking on the first chunk, so smaller = snappier. */
export const DEFAULT_SPEECH_CHUNK_CHARS = 240;

/**
 * Parse one incoming CLM frame.
 *
 * Never throws: this runs on bytes from a socket, and a parse failure has to
 * become a spoken apology plus an `assistant_end`, not an exception that leaves
 * EVI holding the turn forever.
 *
 * @returns {{
 *   ok: boolean, error: string|null, customSessionId: string|null,
 *   lastUser: {content: string, prosody: Record<string, number>}|null,
 *   history: Array<{role: string, content: string, prosody: Record<string, number>}>,
 *   messageCount: number
 * }}
 */
export function parseHumePayload(raw) {
  const empty = {
    ok: false, error: null, customSessionId: null, lastUser: null, history: [], messageCount: 0,
  };

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    return { ...empty, error: `not JSON: ${err.message}` };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ...empty, error: 'payload is not an object' };
  }

  const customSessionId = typeof payload.custom_session_id === 'string' && payload.custom_session_id.trim()
    ? payload.custom_session_id.trim()
    : null;

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (messages.length === 0) {
    return { ...empty, ok: true, customSessionId };
  }

  const normalized = [];
  for (const entry of messages) {
    if (!entry || typeof entry !== 'object') continue;
    const message = entry.message;
    if (!message || typeof message !== 'object') continue;
    const content = typeof message.content === 'string' ? message.content : '';
    normalized.push({
      role: typeof message.role === 'string' ? message.role : 'unknown',
      content,
      prosody: extractProsody(entry),
    });
  }

  // The turn EVI is waiting on is the LAST USER utterance. Hume's own example
  // takes `messages[-1]` unconditionally; this looks for the last user message
  // instead, because a trailing assistant/system entry would otherwise make us
  // answer our own last sentence.
  let lastUser = null;
  for (let i = normalized.length - 1; i >= 0; i -= 1) {
    if (normalized[i].role === 'user' && normalized[i].content.trim()) {
      lastUser = { content: normalized[i].content, prosody: normalized[i].prosody };
      break;
    }
  }

  return {
    ok: true,
    error: null,
    customSessionId,
    lastUser,
    history: normalized,
    messageCount: normalized.length,
  };
}

/** `models.prosody.scores` off one incoming entry, or {}. */
export function extractProsody(entry) {
  const scores = entry?.models?.prosody?.scores;
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) return {};
  const out = {};
  for (const [emotion, score] of Object.entries(scores)) {
    if (typeof score === 'number' && Number.isFinite(score)) out[emotion] = score;
  }
  return out;
}

/** The `count` highest-scoring emotions, highest first. */
export function topProsody(scores, count = 3) {
  return Object.entries(scores ?? {})
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, count))
    .reduce((acc, [emotion, value]) => { acc[emotion] = value; return acc; }, {});
}

/** "a lot of Joy and Interest" — the two strongest, or '' when there is nothing. */
export function prosodyReport(scores) {
  const ranked = Object.entries(topProsody(scores, 2));
  if (ranked.length === 0) return '';
  if (ranked.length === 1) return `a lot of ${ranked[0][0]}`;
  return `a lot of ${ranked[0][0]} and ${ranked[1][0]}`;
}

/**
 * Fold the emotional reading into the utterance the model sees, in the same
 * bracketed shape Hume's example uses. This is the ONLY thing a CLM gets from
 * EVI that a text chat cannot give it, so dropping it would make the whole
 * detour through Hume pointless.
 */
export function annotateWithProsody(content, scores) {
  const report = prosodyReport(scores);
  return report ? `${content} [Prosody: ${report}]` : String(content ?? '');
}

/**
 * Turn an agent's markdown answer into something a TTS voice can read without
 * pronouncing punctuation.
 *
 * A coding agent answers in markdown with fenced code, backticks and paths. Fed
 * straight to a speech synthesiser that becomes "backtick src slash agent slash
 * loop dot m j s backtick", and a fenced diff becomes a minute of unlistenable
 * symbols. Code is REPLACED BY A SPOKEN PLACEHOLDER rather than deleted, so the
 * listener is told that code exists and is not left with a silently gutted
 * answer.
 */
export function speakableText(raw) {
  let text = String(raw ?? '');
  if (!text.trim()) return '';

  // Fenced blocks first, before any line-level rule can chew on their contents.
  text = text.replace(/```[\s\S]*?```/g, ' (code omitted — it is in the activity log) ');
  text = text.replace(/~~~[\s\S]*?~~~/g, ' (code omitted — it is in the activity log) ');
  // Inline code and emphasis: keep the words, drop the marks.
  text = text.replace(/`([^`]*)`/g, '$1');
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$)/g, '$1$2');
  // Markdown links: say the label, not the URL.
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Headings and list bullets become plain sentences.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+\.\s+/gm, '');
  text = text.replace(/^\s*>\s?/gm, '');
  // A bare table row reads as noise; keep the cell text, drop the pipes.
  text = text.replace(/\|/g, ' ');
  return text.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

/**
 * Split spoken text into chunks EVI can start voicing before the whole answer
 * exists. Sentence-aware, because a chunk boundary mid-sentence audibly clips
 * the prosody of the synthesised speech.
 */
export function splitForSpeech(text, { maxChars = DEFAULT_SPEECH_CHUNK_CHARS } = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) return [];
  // The caller's number is the caller's number. An earlier version floored this
  // at 40, which meant a caller asking for 12 silently got 40 and every chunk
  // came back over the cap it had just specified — a parameter accepted and
  // ignored. The only clamp left is the one that stops the word-splitting loop
  // below from failing to make progress.
  const requested = Math.floor(Number(maxChars));
  const limit = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_SPEECH_CHUNK_CHARS;

  // Split after sentence-ending punctuation followed by whitespace, and after
  // hard line breaks, keeping the punctuation with its sentence.
  const sentences = clean
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';
  const flush = () => { if (current.trim()) chunks.push(current.trim()); current = ''; };

  for (const sentence of sentences) {
    if (sentence.length > limit) {
      flush();
      // A single sentence longer than the limit is broken on word boundaries;
      // breaking mid-word would make the synthesiser mispronounce it.
      let rest = sentence;
      while (rest.length > limit) {
        let cut = rest.lastIndexOf(' ', limit);
        if (cut <= 0) cut = limit;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) current = rest;
      continue;
    }
    if (current && `${current} ${sentence}`.length > limit) flush();
    current = current ? `${current} ${sentence}` : sentence;
  }
  flush();
  return chunks;
}

/**
 * Apply the per-turn spoken budget. Returns the text to speak and whether it
 * was cut, so the caller can say so out loud instead of just going quiet
 * mid-thought — a truncation the listener is not told about reads as a bug.
 */
export function applySpokenBudget(text, remaining) {
  const clean = String(text ?? '');
  if (remaining <= 0) return { text: '', truncated: true, used: 0 };
  if (clean.length <= remaining) return { text: clean, truncated: false, used: clean.length };
  let cut = clean.lastIndexOf(' ', remaining);
  if (cut < remaining * 0.5) cut = remaining;
  return { text: clean.slice(0, cut).trim(), truncated: true, used: remaining };
}

// ── STOP INTENT ────────────────────────────────────────────────────────────
//
// WHY THIS IS A WHOLE-UTTERANCE MATCH AND NOT A KEYWORD SEARCH.
//
// The obvious implementation — `text.includes('stop')` — is wrong in the most
// expensive possible direction. "Stop the docker container", "cancel the order
// in the staging database" and "wait for the build to finish" are all REAL
// INSTRUCTIONS that contain a stop word, and treating them as an interrupt
// would silently refuse to do the work while telling the user it had stopped.
//
// So the rule is: the utterance must be ESSENTIALLY NOTHING BUT the stop
// phrase. Politeness, the wake word and trailing filler are stripped; anything
// with a real object attached to the verb is a command and runs as one.
//
// The asymmetry is deliberate. A missed cancel costs one more press of the
// stop button. A false cancel silently drops work the user asked for and is
// indistinguishable from a bug — so this fails toward "run it".

/** Filler that carries no instruction, stripped from either end. */
const STOP_FILLER = new Set([
  'hey', 'ok', 'okay', 'yo', 'um', 'uh', 'er', 'cora', 'please', 'just',
  'now', 'it', 'that', 'already', 'thanks', 'thank', 'you', 'dude', 'man',
  'right', 'no', 'actually',
]);

/**
 * Utterances that mean "abandon what you are doing", as whole sentences.
 * Multi-word entries are matched BEFORE filler stripping, so "forget it" is
 * recognised even though stripping "it" would leave the meaningless "forget".
 */
export const STOP_PHRASES = new Set([
  'stop', 'stop it', 'stop that', 'stop talking', 'stop please', 'please stop',
  'cancel', 'cancel it', 'cancel that',
  'abort', 'halt', 'wait', 'hold on', 'hang on',
  'never mind', 'nevermind', 'forget it', 'forget that',
  'scratch that', 'belay that', 'knock it off', 'cut it out',
  'enough', 'thats enough', 'that is enough',
  'shut up', 'be quiet', 'quiet', 'shush', 'silence',
  'stop stop', 'stop stop stop',
]);

/** Lowercase, punctuation-free, single-spaced. Apostrophes are dropped so
 *  "that's enough" and "thats enough" are the same utterance. */
export function normalizeUtterance(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Did the speaker ask to be let go of, rather than ask for something?
 *
 * Only ever consulted when a turn is ALREADY RUNNING — see clm-server.mjs. A
 * bare "stop" with nothing in flight is just a word, and is answered as one.
 */
export function isStopIntent(text) {
  const clean = normalizeUtterance(text);
  if (!clean) return false;
  // Whole utterance first: catches the multi-word phrases intact.
  if (STOP_PHRASES.has(clean)) return true;

  // Then again with filler peeled off both ends, so "hey Cora, stop it now
  // please" reduces to "stop". A word with any real content survives this and
  // therefore fails the set lookup, which is the entire safety property.
  const words = clean.split(' ');
  let start = 0;
  let end = words.length;
  while (start < end && STOP_FILLER.has(words[start])) start += 1;
  while (end > start && STOP_FILLER.has(words[end - 1])) end -= 1;
  const core = words.slice(start, end).join(' ');
  if (!core) return false;
  return STOP_PHRASES.has(core);
}

/**
 * `{"type":"assistant_input","text":…}` — plus `custom_session_id` when the
 * chat has one, which the docs permit on this message specifically.
 */
export function assistantInput(text, customSessionId = null) {
  const message = { type: ASSISTANT_INPUT, text: String(text ?? '') };
  if (customSessionId) message.custom_session_id = customSessionId;
  return message;
}

/**
 * `{"type":"assistant_end"}` — exactly what Hume's example emits, with nothing
 * added. This is the message that hands the conversational turn back; if it
 * never arrives, the user's microphone stays dead and the chat is hung.
 */
export function assistantEnd() {
  return { type: ASSISTANT_END };
}
