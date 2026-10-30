// Prompt-injection guard for inbound text, page source and connector responses.
// Verdict: 'block' (score >= 3 or a hard limit hit), 'flag' (score 1-2), 'allow'.

export const BLOCK_SCORE = 3;
export const DEFAULT_MAX_BYTES = 16 * 1024;

export const RULES = Object.freeze([
  { id: 'override-instructions', weight: 3, re: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(instructions?|rules?|polic(?:y|ies)|prompts?|guardrails?)\b/i },
  { id: 'role-override', weight: 3, re: /\byou are now\b/i },
  { id: 'reveal-secrets', weight: 3, re: /\b(reveal|print|show|dump|output)\b[^.\n]{0,30}\b(system prompt|environment variables?|env vars?|api keys?|secrets?|hmac keys?|passwords?|credentials?)\b/i },
  { id: 'exfiltration', weight: 3, re: /\b(send|email|post|forward|upload|leak)\b[^.\n]{0,60}\b(hmac|api[ _-]?keys?|secrets?|passwords?|tokens?|credentials?|audit log)\b/i },
  { id: 'exfiltrate-verb', weight: 3, re: /\bexfiltrate\b/i },
  { id: 'jailbreak', weight: 3, re: /\b(developer mode|jailbreak)\b/i },
  { id: 'dan-persona', weight: 3, re: /\bDAN\b/ },
  { id: 'guard-bypass', weight: 3, re: /\b(disable|bypass|skip)\b[^.\n]{0,30}\b(approvals?|guard|checks?)\b/i },
  { id: 'fake-system-tag', weight: 3, re: /<\/?\s*system\s*>/i },
  { id: 'new-instructions', weight: 2, re: /\bnew instructions?\s*:/i },
]);

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// options: { maxBytes, allowedTools: [], requestedTool, allowedHosts: [] }
export function inspect(text, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const value = typeof text === 'string' ? text : '';
  const bytes = Buffer.byteLength(value, 'utf8');
  const reasons = [];
  const matches = [];

  if (bytes > maxBytes) reasons.push('size_limit');

  if (options.requestedTool !== undefined) {
    const allowedTools = options.allowedTools ?? [];
    if (!allowedTools.includes(options.requestedTool)) reasons.push('tool_not_allowed');
  }

  const allowedHosts = new Set((options.allowedHosts ?? []).map((h) => h.toLowerCase()));
  for (const url of value.match(/https?:\/\/[^\s)"'<>]+/gi) ?? []) {
    const host = hostOf(url);
    if (!host || !allowedHosts.has(host)) {
      reasons.push('url_not_allowed');
      break;
    }
  }

  let score = 0;
  for (const rule of RULES) {
    if (rule.re.test(value)) {
      matches.push(rule.id);
      score += rule.weight;
    }
  }

  let verdict = 'allow';
  if (reasons.length > 0 || score >= BLOCK_SCORE) verdict = 'block';
  else if (score > 0) verdict = 'flag';

  return { verdict, score, bytes, matches, reasons: [...new Set(reasons)] };
}
