// Local-first prompt redaction for any future optional verifier/provider path.
//
// This module deliberately has no network, storage, or model dependency. A
// caller must run redactSensitivePrompt() before constructing an outbound
// prompt. The returned telemetry contains counts and type names only; it never
// contains the original value or the redacted text.

const CONNECTION_STRING = /(\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:@/]+:)([^\s@/]+)(?=@)/giu;
const SAID_IS = /(\b(?:pass(?:word|wd|phrase|code)?|pwd|api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret)\s+(?:is|was)\s*:?\s+)(["'`]?)([^\s,;"'`)]{5,}[^\s,;"'`).!?:])\2/giu;
// Prose ("password is X") counts only when X looks like a secret: a digit, a symbol,
// or a capital after the first letter. Same test as content/sanitize.js.
const looksSecret = (v) => /[0-9]/u.test(v) || /[^A-Za-z]/u.test(v) || /[A-Z]/u.test(v.slice(1));

const RULES = Object.freeze([
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu],
  ['bearer_token', /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gu],
  ['api_key', /\b(?:sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprse]-[A-Za-z0-9-]{12,}|AIza[0-9A-Za-z_-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|(?:sk|rk|pk)_live_[0-9A-Za-z]{16,}|(?:sk|rk)_test_[0-9A-Za-z]{16,}|whsec_[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}|glpat-[0-9A-Za-z_-]{20}|xai-[A-Za-z0-9]{20,})\b/gu],
  ['api_key', /(\baws_secret_access_key["']?\s*[:=]\s*)(["']?)([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])\2/giu, (m, prefix, q) => `${prefix}${q}[REDACTED:api_key]${q}`],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}/gu],
  ['connection_string', CONNECTION_STRING, (m, prefix, value) => (value.startsWith('[REDACTED') ? null : `${prefix}[REDACTED:connection_string]`)],
  ['secret_assignment', SAID_IS, (m, prefix, q, value) => (looksSecret(value) && !value.startsWith('[REDACTED') ? `${prefix}${q}[REDACTED:secret_assignment]${q}` : null)],
  ['secret_assignment', /((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|pwd|passcode|passphrase|secret|token)\s*[:=]\s*)[^\s,;]+/giu],
  ['email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu],
  ['ssn', /\b\d{3}-\d{2}-\d{4}\b/gu],
  ['ssn', /(\b(?:SSN|social security(?: number| no\.?)?)\s*[:#]?\s*)\d{3}\s?\d{2}\s?\d{4}\b/giu, (m, prefix) => `${prefix}[REDACTED:ssn]`],
  ['credit_card', /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/gu],
  ['phone', /(?<!\d)(?:\+?\d[\d .()-]{8,}\d)(?!\d)/gu],
  ['ipv4', /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu],
]);

function replacementFor(type, match) {
  if (type === 'secret_assignment') return `${match.slice(0, match.search(/[:=]/u) + 1)}[REDACTED:${type}]`;
  return `[REDACTED:${type}]`;
}

/**
 * Redact sensitive values before a prompt may leave the extension.
 * @returns {{text: string, telemetry: {redactedCount: number, redactedTypes: string[]}}}
 */
export function redactSensitivePrompt(input) {
  let text = String(input ?? '');
  const counts = Object.create(null);
  for (const [type, pattern, custom] of RULES) {
    text = text.replace(pattern, (match, ...groups) => {
      if (type === 'api_key' && /^re_[a-z_]+$/u.test(match)) return match;
      const out = custom ? custom(match, ...groups) : replacementFor(type, match);
      if (out === null) return match;
      counts[type] = (counts[type] ?? 0) + 1;
      return out;
    });
  }
  const redactedTypes = Object.keys(counts).sort();
  return Object.freeze({
    text,
    telemetry: Object.freeze({
      redactedCount: redactedTypes.reduce((sum, type) => sum + counts[type], 0),
      redactedTypes,
    }),
  });
}

export const REDACTION_TYPES = Object.freeze([...new Set(RULES.map(([type]) => type))]);
