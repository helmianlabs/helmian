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
  // GitHub tokens (ghp_, gho_, ghs_, ghu_, ghr_)
  {
    pattern: /gh[pousr]_[A-Za-z0-9_]+/g,
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
  // Slack tokens (bot/user/app/legacy/refresh)
  {
    pattern: /\bxox[baprse]-[A-Za-z0-9-]{10,}/g,
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
  // Added 2026-11-16 after the full source audit (letter 719) measured this set
  // against the credential formats the rest of the codebase already handles and
  // found these passing through untouched. The GitHub fine-grained PAT, the
  // webhook secret, the GitLab and Resend shapes, and the Google OAuth shape
  // are the exact patterns the Guard extension scanners
  // (extension/background/redact.js, extension/content/sanitize.js), the hands
  // protocol (hands-mcp/src/shared/protocol.mjs), and the audit log
  // (src/core/audit-log.mjs) already carry; this module had fallen behind them.
  // GitHub fine-grained personal access tokens
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    replace: '[REDACTED]',
  },
  // Webhook signing secrets (Stripe whsec_ and compatible issuers)
  {
    pattern: /\bwhsec_[A-Za-z0-9]{20,}/g,
    replace: '[REDACTED]',
  },
  // NVIDIA API keys (the nvapi- prefix; the key slot is NVIDIA_API_KEY in
  // src/runner/vault.mjs)
  {
    pattern: /\bnvapi-[A-Za-z0-9_-]{20,}/g,
    replace: '[REDACTED]',
  },
  // Slack app-level tokens (xapp-; the bridge's SLACK_APP_TOKEN, see
  // slack-bridge/README.md)
  {
    pattern: /\bxapp-[A-Za-z0-9-]{10,}/g,
    replace: '[REDACTED]',
  },
  // Discord bot tokens: three dot-separated segments, the first encoding the
  // bot's numeric user id (the bridge's DISCORD_BOT_TOKEN, see
  // discord-bridge/README.md). Segment lengths keep this off ordinary dotted
  // text; JWTs are caught by their own pattern above and never start a
  // Discord-shaped first segment.
  {
    pattern: /\b[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g,
    replace: '[REDACTED]',
  },
  // GitLab personal access tokens
  {
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g,
    replace: '[REDACTED]',
  },
  // Resend API keys (re_ plus a segment, an underscore, and the secret body)
  {
    pattern: /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/g,
    replace: '[REDACTED]',
  },
  // Google OAuth access tokens (ya29. prefix; the shape src/core/audit-log.mjs
  // already masks)
  {
    pattern: /\bya29\.[A-Za-z0-9._-]{10,}/g,
    replace: '[REDACTED]',
  },
  // Mistral and Cloudflare keys carry no fixed prefix: a bare shape rule
  // strong enough to catch them would also eat ordinary hashes and ids, which
  // this module must never do. They are covered where they actually leak,
  // under the exact credential names the runner vault registers for them
  // (src/runner/vault.mjs: MISTRAL_API_KEY, CLOUDFLARE_API_TOKEN), in
  // assignment or JSON form. A bare pasted key with no name still passes;
  // that limit is deliberate and recorded in the bite report.
  {
    pattern: /\b(MISTRAL_API_KEY|CLOUDFLARE_API_TOKEN)(["']?\s*[:=]\s*["']?)[^\s"']+/g,
    replace: '$1$2[REDACTED]',
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
