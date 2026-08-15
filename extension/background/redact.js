// Local-first prompt redaction for any future optional verifier/provider path.
//
// This module deliberately has no network, storage, or model dependency. A
// caller must run redactSensitivePrompt() before constructing an outbound
// prompt. The returned telemetry contains counts and type names only; it never
// contains the original value or the redacted text.

const RULES = Object.freeze([
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu],
  ['bearer_token', /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gu],
  ['api_key', /\b(?:sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[0-9A-Za-z_-]{20,})\b/gu],
  ['secret_assignment', /((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passcode|secret|token)\s*[:=]\s*)[^\s,;]+/giu],
  ['email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu],
  ['ssn', /\b\d{3}-\d{2}-\d{4}\b/gu],
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
  for (const [type, pattern] of RULES) {
    text = text.replace(pattern, (match) => {
      counts[type] = (counts[type] ?? 0) + 1;
      return replacementFor(type, match);
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

export const REDACTION_TYPES = Object.freeze(RULES.map(([type]) => type));
