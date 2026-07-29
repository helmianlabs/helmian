/**
 * Centralized secret redaction for all tool output (read_file, run_command, etc.).
 * Applied before returning results to the model or console to prevent credential leaks.
 */

const REDACT_PATTERNS = [
  // Database connection strings - redact the password portion.
  // WAS `postgresql?:` — the `?` binds to the `l`, so this matched "postgresql://"
  // and "postgresq://" but NEVER the extremely common "postgres://". Verified by
  // audit 2026-07-28 against 18 inputs. Now an explicit optional group, and the
  // other drivers Troy actually uses are covered too.
  {
    pattern: /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^:/\s]+:)([^@\s]+)(@[^\s]+)/gi,
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
  // Added 2026-07-28 after an audit measured the set above against 18 inputs and
  // found these live credential shapes passing through unredacted.
  // Stripe (live keys are the dangerous ones, but test keys leak customer data too)
  {
    pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
    replace: '[REDACTED]',
  },
  // AWS access key IDs
  {
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replace: '[REDACTED]',
  },
  // Slack tokens (bot/user/app/legacy)
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    replace: '[REDACTED]',
  },
  // Hugging Face access tokens
  {
    pattern: /\bhf_[A-Za-z0-9]{16,}/g,
    replace: '[REDACTED]',
  },
  // JSON Web Tokens — three base64url segments; often carry identity claims
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: '[REDACTED]',
  },
  // Private key blocks (RSA/EC/OPENSSH/PGP) — redact the whole body, not the header
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g,
    replace: '[REDACTED PRIVATE KEY]',
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
