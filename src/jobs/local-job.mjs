/**
 * The shared runner every local background job goes through.
 *
 * WHAT THIS IS. `src/agent/local-provider.mjs` defines LOCAL_JOB_CONTRACT
 * (local-provider.mjs:336-342) as a seam for four always-on jobs — triage,
 * commit-message, log-monitor, dictation-summary. This file is the single
 * implementation of that contract; the four job modules are thin wrappers that
 * supply a system prompt, a schema, and a way to build input.
 *
 * THE ONE IDEA THAT MATTERS. A 4B model is not smart. Nothing here trusts its
 * prose. Every job declares a SCHEMA, the reply is parsed and validated against
 * it, and anything that does not fit is DISCARDED — silently, with the job
 * reporting "no result" rather than a half-understood one. A job that cannot
 * produce a valid structured answer produces nothing. That is the whole design:
 * it is always safe to ignore these jobs' output, because the only two states
 * are "a valid object" and "nothing".
 *
 * WHAT IT REFUSES TO DO, EVER:
 *   - throw at the caller (every path returns a result object);
 *   - block (an AbortSignal from provider.timeoutMs caps every call);
 *   - run when there is no local provider (returns skipped, never crashes);
 *   - send input matching LOCAL_SAFETY_DENY (money/credentials/deletion/
 *     deploys/schema/governance) to any model, local or not;
 *   - use tools (LOCAL_JOB_CONTRACT.toolsAllowed is false).
 */

import {
  resolveLocalProvider,
  LOCAL_JOB_CONTRACT,
  LOCAL_SAFETY_DENY,
} from '../agent/local-provider.mjs';

/** Skip codes. Stable strings — the runner logs them and tests assert on them. */
export const SKIP = Object.freeze({
  NO_PROVIDER: 'local provider not configured',
  EMPTY_INPUT: 'empty input',
  DENIED: 'input matched the safety deny-list',
  UNREACHABLE: 'local model unreachable',
  TIMEOUT: 'local model timed out',
  MALFORMED: 'local model returned unusable output',
});

/**
 * Cut oversized input down to the contract's cap.
 *
 * HEAD AND TAIL, not head alone. For a dictation transcript the last sentences
 * are usually the ask ("so do all that and thank you" — and before it, the item
 * he actually wants). Truncating to the first N characters throws that away.
 * A marker is left in the middle so the model is not told a lie about what it
 * is reading.
 */
export function clampInput(text, max = LOCAL_JOB_CONTRACT.maxInputChars) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  const keep = Math.floor((max - 24) / 2);
  return `${s.slice(0, keep)}\n…[trimmed]…\n${s.slice(-keep)}`;
}

/**
 * Pull the first JSON object out of a model reply.
 *
 * A 4B model wraps JSON in ``` fences, prefaces it with "Here is the JSON:",
 * and sometimes emits a reasoning paragraph first. Rather than regex-guessing,
 * this scans for the first `{` and walks forward counting braces OUTSIDE string
 * literals until the object closes. Returns null when there is no complete
 * object — never throws, never returns a partial one.
 */
export function extractJson(raw) {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Validate a parsed object against a job's schema.
 *
 * STRICT ON WHAT WE CONSUME, TOLERANT OF NOISE AROUND IT. Every declared field
 * must be present and of the declared shape or the whole object is rejected —
 * there is no coercion, no default-filling, no "close enough". Fields the
 * schema does not declare are DROPPED rather than rejected, because a small
 * model reliably decorates its answer with extra keys and refusing those would
 * throw away otherwise-perfect results. The returned object contains exactly
 * the declared fields and nothing else, so a caller can never accidentally read
 * a model-invented key.
 *
 * Field specs:
 *   {enum: [...]}                     — string, must be one of
 *   {string: {min, max}}              — trimmed string within length bounds
 *   {boolean: true}                   — real boolean, not 'true'
 *   {array: {of, max}}                — array of `of`-spec items, length <= max
 *
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function validateAgainstSchema(obj, schema) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'not an object' };
  }
  const out = {};
  for (const [key, spec] of Object.entries(schema)) {
    const res = validateField(obj[key], spec, key);
    if (!res.ok) return res;
    out[key] = res.value;
  }
  return { ok: true, value: out };
}

function validateField(value, spec, path) {
  if (spec.enum) {
    if (typeof value !== 'string') return { ok: false, error: `${path}: not a string` };
    const v = value.trim().toLowerCase();
    const hit = spec.enum.find((e) => e.toLowerCase() === v);
    if (!hit) return { ok: false, error: `${path}: "${value}" not in enum` };
    return { ok: true, value: hit };
  }
  if (spec.string) {
    if (typeof value !== 'string') return { ok: false, error: `${path}: not a string` };
    const v = value.trim();
    const { min = 1, max = 400 } = spec.string;
    if (v.length < min) return { ok: false, error: `${path}: shorter than ${min}` };
    // Over-long is TRUNCATED, not rejected: an otherwise-valid verdict should
    // not be thrown away because the model was chatty in one free-text field.
    return { ok: true, value: v.length > max ? `${v.slice(0, max - 1)}…` : v };
  }
  if (spec.boolean) {
    if (typeof value !== 'boolean') return { ok: false, error: `${path}: not a boolean` };
    return { ok: true, value };
  }
  if (spec.array) {
    if (!Array.isArray(value)) return { ok: false, error: `${path}: not an array` };
    const { of, max = 20 } = spec.array;
    const items = [];
    for (let i = 0; i < value.length && items.length < max; i += 1) {
      const res = validateField(value[i], of, `${path}[${i}]`);
      // One bad element does not sink the list — it is dropped. The list is a
      // convenience field (actions, questions); the verdict fields above are
      // the load-bearing ones and those are still all-or-nothing.
      if (res.ok) items.push(res.value);
    }
    return { ok: true, value: items };
  }
  return { ok: false, error: `${path}: unknown spec` };
}

/**
 * Run one local job.
 *
 * @param {object} req
 * @param {string} req.name    stable job id, used in logs
 * @param {string} req.system  task-specific system prompt
 * @param {string} req.input   the text to process
 * @param {object} req.schema  the structured shape the reply must satisfy
 * @param {object} [req.provider]  injected provider (tests); else resolved from env
 * @param {function} [req.fetchImpl]  injected fetch (tests); else global fetch
 * @param {object} [req.env]
 * @returns {Promise<{ok: boolean, name: string, data?: object, skippedReason?: string, ms: number}>}
 */
export async function runLocalJob({
  name,
  system,
  input,
  schema,
  provider = null,
  fetchImpl = null,
  env = process.env,
}) {
  const started = Date.now();
  const done = (extra) => ({ name, ms: Date.now() - started, ...extra });

  const active = provider || resolveLocalProvider(env);
  if (!active) return done({ ok: false, skippedReason: SKIP.NO_PROVIDER });

  const text = clampInput(input);
  if (!text) return done({ ok: false, skippedReason: SKIP.EMPTY_INPUT });

  // The deny-list is the SAME regex the interactive router uses
  // (local-provider.mjs:93-113) — imported, never re-typed. A log line carrying
  // a credential must not reach a model just because that model is local.
  if (LOCAL_SAFETY_DENY.test(text)) {
    return done({ ok: false, skippedReason: SKIP.DENIED });
  }

  const doFetch = fetchImpl || globalThis.fetch;
  let raw;
  try {
    const res = await doFetch(active.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${active.apiKey || 'no-key-required'}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: active.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text },
        ],
        // qwen3.5:4b is a reasoning model: without this a trivial turn burns
        // ~2,603 tokens (providers.mjs:44-51). No tools, ever — the contract
        // forbids them and unattended tool reliability was never measured.
        reasoning_effort: 'none',
        // Deterministic-ish: these are classification jobs, not creative ones.
        temperature: 0,
      }),
      signal: AbortSignal.timeout(active.timeoutMs),
    });
    if (!res.ok) return done({ ok: false, skippedReason: SKIP.UNREACHABLE });
    const body = await res.json();
    raw = body?.choices?.[0]?.message?.content;
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return done({ ok: false, skippedReason: timedOut ? SKIP.TIMEOUT : SKIP.UNREACHABLE });
  }

  const parsed = extractJson(raw);
  if (!parsed) return done({ ok: false, skippedReason: SKIP.MALFORMED });
  const valid = validateAgainstSchema(parsed, schema);
  if (!valid.ok) return done({ ok: false, skippedReason: SKIP.MALFORMED });

  return done({ ok: true, data: valid.value });
}

/**
 * Shared tail for every job's system prompt.
 *
 * Repeated in each prompt rather than assembled once, because a small model
 * follows an instruction that sits next to the schema far better than one
 * buried three paragraphs up.
 */
export const JSON_ONLY = [
  'Reply with a single JSON object and nothing else.',
  'No markdown fences, no explanation before or after.',
].join(' ');
