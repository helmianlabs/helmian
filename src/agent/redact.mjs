/**
 * Centralized secret redaction for all tool output (read_file, run_command, etc.).
 * Applied before returning results to the model or console to prevent credential leaks.
 */

const REDACT_PATTERNS = [
  // PostgreSQL/Neon connection strings - redact password portion
  {
    pattern: /(postgresql?:\/\/[^:]+:)([^@]+)(@[^\s]+)/gi,
    replace: '$1[REDACTED]$3',
  },
  // Neon passwords (npg_ prefix)
  {
    pattern: /npg_[A-Za-z0-9]+/g,
    replace: '[REDACTED]',
  },
  // OpenAI keys
  {
    pattern: /sk-proj-[A-Za-z0-9_-]+/g,
    replace: '[REDACTED]',
  },
  {
    pattern: /sk-[A-Za-z0-9_-]{32,}/g,
    replace: '[REDACTED]',
  },
  // xAI keys
  {
    pattern: /xai-[A-Za-z0-9_-]+/g,
    replace: '[REDACTED]',
  },
  // Anthropic keys
  {
    pattern: /sk-ant-api\d+-[A-Za-z0-9_-]+/g,
    replace: '[REDACTED]',
  },
  // Groq keys
  {
    pattern: /gsk_[A-Za-z0-9_-]+/g,
    replace: '[REDACTED]',
  },
  // GitHub tokens (ghp_, gho_, ghs_)
  {
    pattern: /gh[pos]_[A-Za-z0-9_]+/g,
    replace: '[REDACTED]',
  },
  // Google API keys
  {
    pattern: /AIza[A-Za-z0-9_-]+/g,
    replace: '[REDACTED]',
  },
  // Gemini API keys (AQ. prefix format)
  {
    pattern: /AQ\.[A-Za-z0-9_-]+/g,
    replace: '[REDACTED]',
  },
  // Authorization Bearer tokens
  {
    pattern: /(Authorization:\s*Bearer\s+)[^\s\n]+/gi,
    replace: '$1[REDACTED]',
  },
];

/**
 * Redact all known secret patterns from text.
 * Applied to every tool output before it reaches the model or console.
 * @param {string} text - Raw tool output
 * @returns {string} - Redacted output safe for display
 */
export function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  
  let result = text;
  for (const { pattern, replace } of REDACT_PATTERNS) {
    result = result.replace(pattern, replace);
  }
  return result;
}
