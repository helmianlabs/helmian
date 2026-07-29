/**
 * JOB 4 — DICTATION SUMMARIZER.
 *
 * Condenses a long voice transcript into a short note BEFORE it is saved or
 * passed upstream, so a frontier model never pays to read the raw thing.
 *
 * WHY THIS ONE IS THE VALUABLE ONE. Real measured input from this machine's own
 * transcripts: single dictated messages of 1,065 / 1,379 / 1,631 / 1,841 /
 * 1,883 characters, each containing several unrelated asks separated by filler
 * ("OK so", "let's see", "oh forgot about that"). That is the exact shape a
 * small model is good at — extraction and compression, no reasoning.
 *
 * THE SUMMARY IS A POINTER, NOT A REPLACEMENT. `summarizeDictation` returns the
 * summary AND the original, and the runner writes both. Nothing in this
 * codebase deletes a raw transcript. Speech-to-text mangles words (a mic once
 * turned a word into "Invoice" mid-sentence), so a compressed note must always
 * be re-checkable against what was actually said.
 *
 * SPEECH IS NOT PROSE. The prompt is told to expect no punctuation and no
 * sentence boundaries, because dictation arrives as one unbroken run. Without
 * that instruction a small model tries to summarize the first "sentence" —
 * which is the whole message.
 */

import { runLocalJob, JSON_ONLY } from './local-job.mjs';

export const NAME = 'dictation-summary';

export const SCHEMA = Object.freeze({
  summary: { string: { min: 1, max: 600 } },
  actions: { array: { of: { string: { min: 1, max: 200 } }, max: 10 } },
  questions: { array: { of: { string: { min: 1, max: 200 } }, max: 5 } },
});

export const SYSTEM = [
  'You compress raw voice dictation into a short note.',
  '',
  'The input is speech-to-text: no punctuation, no paragraphs, filler words',
  '("OK so", "let me see", "anyway"), false starts, and several unrelated',
  'subjects run together in one block. Read all of it, not just the start.',
  '',
  'summary: under 600 characters, plain sentences, covering every distinct',
  'subject raised. Drop filler and repetition. Keep names, numbers, paths and',
  'product names EXACTLY as spoken — never correct or normalise them.',
  'actions: the concrete things the speaker asked for, one short line each.',
  'questions: anything the speaker asked that was left unanswered.',
  'Use an empty array when there are none. Invent nothing.',
  JSON_ONLY,
  'Shape: {"summary":"...","actions":["..."],"questions":["..."]}',
].join('\n');

/**
 * Summarize one dictation block.
 *
 * On any failure this returns ok:false and NO summary. It deliberately does not
 * fall back to "first 300 characters" — a truncation that looks like a summary
 * is worse than no summary, because the reader cannot tell which one they got.
 */
export async function summarizeDictation(text, opts = {}) {
  const original = String(text ?? '');
  const res = await runLocalJob({
    name: NAME,
    system: SYSTEM,
    input: original,
    schema: SCHEMA,
    ...opts,
  });
  return {
    ...res,
    originalChars: original.length,
    summaryChars: res.ok ? res.data.summary.length : 0,
  };
}
