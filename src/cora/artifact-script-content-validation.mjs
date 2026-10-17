// Deterministic content-level validation for Artifact Studio script text.
// Scripts live in the cloud (cora_artifact_script_revisions.text, <=12k chars;
// kinds narration / training_script / orientation_script — prose, not code).
// Runs inside the execution-request append() gauntlet before anything is
// recorded. Every check is pure, time-bounded, and side-effect-free: simple
// regexes over a length-capped string, no I/O, no clocks, no randomness.
// A failure marks the request blocked (with the reason in the audit receipt),
// never silently dropped.
export const ARTIFACT_SCRIPT_CONTENT_FORMAT = 'helmian.artifact-script-content.v1';

const LENGTH_BOUNDS = {
  narration: { min: 40, max: 12000 },
  training_script: { min: 200, max: 12000 },
  orientation_script: { min: 200, max: 12000 },
};

// Prompt-injection markers and credential-shaped strings. Patterns are kept
// deliberately simple (no nested quantifiers) so they cannot backtrack
// pathologically on the 12k-char cap.
const FORBIDDEN_PATTERNS = [
  { id: 'prompt-injection.ignore-instructions', pattern: /ignore\s+(all\s+)?(previous|prior)\s+instructions/i },
  { id: 'prompt-injection.disregard', pattern: /disregard\s+(all\s+)?(previous|prior)\s+(instructions|directives)/i },
  { id: 'prompt-injection.role-marker', pattern: /^\s*(system|assistant)\s*:/im },
  { id: 'prompt-injection.jailbreak', pattern: /jailbreak/i },
  { id: 'prompt-injection.dan', pattern: /do\s+anything\s+now/i },
  { id: 'credential.openai-key', pattern: /\bsk-[A-Za-z0-9]{8,}\b/ },
  { id: 'credential.aws-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'credential.slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/ },
  { id: 'credential.assignment', pattern: /\b(password|passwd|api[_-]?key|secret[_-]?key|client[_-]?secret)\s*[:=]\s*["']?[\w\-.~+/=]{8,}["']?/i },
];

const PII_PATTERNS = [
  { id: 'pii.email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { id: 'pii.phone', pattern: /\b(?:\+?1[-.\s]?)?\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/ },
];

function structureProblem(kind, body) {
  if (kind === 'training_script') {
    return /^\s*(#{1,3}\s+|\d{1,2}[.)]\s+|step\s+\d+\b)/im.test(body)
      ? null
      : 'training_script expects numbered steps or headings';
  }
  if (kind === 'orientation_script') {
    return /^\s*(#{1,3}\s+|[-*]\s+|\d{1,2}[.)]\s+)/m.test(body)
      ? null
      : 'orientation_script expects headings or list sections';
  }
  return null; // narration is free prose; length bounds suffice.
}

export function validateArtifactScriptContent({ scriptKind, text } = {}) {
  const kind = String(scriptKind ?? '').toLowerCase();
  const body = String(text ?? '');
  const checks = [];
  const fail = (id, detail) => checks.push({ id, passed: false, detail });
  const pass = (id) => checks.push({ id, passed: true });

  const bounds = LENGTH_BOUNDS[kind];
  if (!bounds) {
    fail('kind.unknown', `unknown script kind '${kind}'`);
  } else {
    if (body.length < bounds.min) fail('length.min', `script is ${body.length} chars, below the ${bounds.min}-char minimum for ${kind}`);
    else pass('length.min');
    if (body.length > bounds.max) fail('length.max', `script is ${body.length} chars, above the ${bounds.max}-char maximum for ${kind}`);
    else pass('length.max');
    const problem = structureProblem(kind, body);
    if (problem) fail('structure.kind', problem);
    else pass('structure.kind');
  }
  for (const { id, pattern } of FORBIDDEN_PATTERNS) {
    if (pattern.test(body)) fail(id, `forbidden pattern matched: ${id}`);
    else pass(id);
  }
  for (const { id, pattern } of PII_PATTERNS) {
    if (pattern.test(body)) fail(id, `possible PII matched: ${id}`);
    else pass(id);
  }

  const failed = checks.filter((check) => !check.passed);
  const summary = failed.length === 0
    ? `passed ${checks.length}/${checks.length} content checks`
    : `failed ${failed.length} content check(s): ${failed.map((check) => check.id).join(', ')}`;
  return Object.freeze({
    format: ARTIFACT_SCRIPT_CONTENT_FORMAT,
    valid: failed.length === 0,
    summary,
    failedCheckIds: Object.freeze(failed.map((check) => check.id)),
    checks: Object.freeze(checks.map((check) => Object.freeze({ ...check }))),
  });
}
