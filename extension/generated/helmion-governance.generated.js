// GENERATED FILE — DO NOT EDIT.
//
// Byte-for-byte copy of E:\Helmion\src\core\governance.mjs.
// Produced by extension/tools/sync-kernel.mjs. Edit the original, then run:
//     node extension/tools/sync-kernel.mjs
//
// extension/test/kernel-sync.test.mjs fails if this file and the original
// ever differ, so the two can never drift apart quietly.
// ==== END OF GENERATED HEADER — verbatim copy starts on the next line ====
const ADVISORS = Object.freeze(['claude', 'gemini', 'grok', 'openai']);

const DESTRUCTIVE_PATTERNS = [
  ['recursive/forced rm', /(?:^|[;&|`(\s])rm\s+[^;&|]*(?:-[A-Za-z]*[rRf][A-Za-z]*|--(?:recursive|force|dir))\b/i],
  ['rm of a glob', /(?:^|[;&|`(\s])rm\s+[^;&|]*\*/i],
  ['Remove-Item -Recurse/-Force', /\bRemove-Item\b[^;&|]*\s-(?:Rec|Forc)[a-z]*\b/i],
  ['rmdir /S', /\b(?:rmdir|rd)\b[^;&|]*\s\/s\b/i],
  ['cmd del /F, /Q, or /S', /(?:^|[;&|`(\s])del\s+[^;&|]*\/[fqs]\b/i],
  ['git reset discard', /\bgit\b[^;&|]*\breset\b[^;&|]*--(?:hard|merge|keep)\b/i],
  ['git clean', /\bgit\b[^;&|]*\bclean\b[^;&|]*\s-[A-Za-z]*[fdx]/i],
  ['git force push', /\bgit\b[^;&|]*\bpush\b[^;&|]*(?:--force(?:-with-lease)?|\s-f\b)/i],
  ['git branch force delete', /\bgit\b[^;&|]*\bbranch\b[^;&|]*\s-D\b/i],
  ['git checkout/restore discard', /\bgit\b[^;&|]*\b(?:checkout|restore)\b[^;&|]*\s--\s/i],
  ['git worktree remove', /\bgit\b[^;&|]*\bworktree\b[^;&|]*\bremove\b/i],
  ['Clear-Content', /\bClear-Content\b/i],
  ['direct SQL DDL', /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i],
  ['dd device write', /\bdd\b[^;&|]*\bof=/i],
  ['filesystem format', /\bmkfs(?:\.|\s)/i],
];

const SQL_DDL = /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|ALTER\s+TABLE\b[^;]*\bDROP\b)\b/i;
const SQL_EXECUTION_CONTEXT = /\b(?:query|execute|exec|raw|psql|sqlcmd)\b|(?:\bnode\b[^;&|]*\s-e\b)|(?:\bpython(?:\d+(?:\.\d+)?)?\b[^;&|]*\s-c\b)/i;

export { ADVISORS };

export function collectStrings(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectStrings(item, output));
  }
  return output;
}

export function quotedStrings(command) {
  const values = [];
  const matcher = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
  for (const match of command.matchAll(matcher)) values.push(match[1] ?? match[2] ?? '');
  return values;
}

export function commandSkeleton(command) {
  return String(command)
    .replace(/<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\r?\n[\s\S]*?^\s*\1\s*$/gm, ' <<HEREDOC> ')
    .replace(/@'[\s\S]*?'@/g, ' <PSHERE> ')
    .replace(/@"[\s\S]*?"@/g, ' <PSHERE> ')
    .replace(/"[^"]*"|'[^']*'/g, ' <STR> ');
}

export function detectDestructiveOperation(payload) {
  const toolInput = payload?.tool_input ?? payload ?? {};
  const command = String(toolInput.command ?? '');
  if (!command) return { blocked: false, hits: [], approved: false, reason: '' };

  const skeleton = commandSkeleton(command);
  const hits = DESTRUCTIVE_PATTERNS
    .filter(([, pattern]) => pattern.test(skeleton))
    .map(([label]) => label);

  // Quoted strings are normally stripped to prevent prose false positives.
  // Inspect them separately only when the command has an execution sink capable
  // of issuing SQL. This catches node -e "db.query('DROP TABLE ...')" without
  // blocking a log message that merely discusses DROP TABLE.
  if (SQL_EXECUTION_CONTEXT.test(command)) {
    const quotedDdl = quotedStrings(command).some((value) => SQL_DDL.test(value));
    if (quotedDdl) hits.push('indirect SQL DDL');
  }

  const uniqueHits = [...new Set(hits)];
  return {
    blocked: uniqueHits.length > 0,
    hits: uniqueHits,
    approved: false,
    reason: '',
  };
}

function exactIdentifiers(text) {
  return [...new Set(String(text).toLowerCase()
    .replace(/[^a-z0-9_./\\-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 4))];
}

function isPathLike(token) {
  return /[/\\.]/.test(token) && !/^\d/.test(token);
}

export function matchActiveBlockers(context, blockers) {
  const text = collectStrings(context).join(' ').toLowerCase();
  const contextPaths = exactIdentifiers(text).filter(isPathLike);
  const projectSlug = context?.projectSlug ?? context?.project_slug ?? null;
  const matches = [];

  for (const blocker of blockers ?? []) {
    const status = String(blocker.status ?? 'OPEN').toUpperCase();
    if (!['OPEN', 'BLOCKED', 'ACTIVE'].includes(status)) continue;
    if (blocker.project_slug && blocker.project_slug !== projectSlug) continue;

    const signature = String(blocker.error_signature ?? '').trim().toLowerCase();
    if (signature && text.includes(signature)) {
      matches.push({ blocker, why: `error signature: ${signature}` });
      continue;
    }

    const blockerPaths = exactIdentifiers([
      blocker.file_path,
      blocker.description,
    ].filter(Boolean).join(' ')).filter(isPathLike);
    const sharedPath = contextPaths.find((token) => blockerPaths.includes(token));
    if (sharedPath) {
      matches.push({ blocker, why: `shared path: ${sharedPath}` });
      continue;
    }

    const moduleName = String(blocker.module_name ?? '').trim().toLowerCase();
    if (moduleName && exactIdentifiers(text).includes(moduleName)) {
      matches.push({ blocker, why: `exact module: ${moduleName}` });
    }
  }
  return matches;
}

export function validateResolutionEvidence(evidence) {
  const errors = [];
  const outcome = String(evidence?.outcome ?? '').trim();
  const citation = String(evidence?.citation ?? '').trim();
  const rootCause = String(evidence?.root_cause ?? '').trim();
  const snippet = String(evidence?.snippet ?? '').trim();

  if (!outcome) errors.push('outcome is required');
  else if (!/(?:\d|pass|fail|green|red|success|error|ms\b|%)/i.test(outcome)) {
    errors.push('outcome must contain an exact metric delta or test result');
  }
  if (!citation) errors.push('citation is required');
  else if (!/^.+:\d+(?::\d+)?$/.test(citation)) {
    errors.push('citation must use exact file:line or file:line:column form');
  }
  if (!rootCause) errors.push('root_cause is required');
  else if (/^(?:fix(?:ed)?|add(?:ed)?|chang(?:e|ed)|updat(?:e|ed)|implement(?:ed)?)\b/i.test(rootCause)) {
    errors.push('root_cause must identify the mistake signature, not describe the fix');
  }
  if (!snippet) errors.push('snippet is required');

  return { valid: errors.length === 0, errors };
}

export function assertResolutionEvidence(evidence) {
  const result = validateResolutionEvidence(evidence);
  if (!result.valid) throw new Error(`Resolution proof rejected: ${result.errors.join('; ')}`);
  return evidence;
}

export function classifyOperation(operation = {}) {
  const tierBReasons = [];
  if (operation.schemaChange || operation.migration) tierBReasons.push('schema/migration change');
  if (operation.productionDataAccess) tierBReasons.push('production data access');
  if (operation.authenticationChange) tierBReasons.push('authentication change');
  if (operation.crossProjectContract) tierBReasons.push('cross-project contract change');
  return tierBReasons.length
    ? { tier: 'B', reasons: tierBReasons }
    : { tier: 'A', reasons: ['scoped code change without a protected boundary'] };
}

export function consensusStatus({ operation, actionHash, reviews = [] }) {
  const classification = classifyOperation(operation);
  if (classification.tier === 'A') {
    return {
      approved: true,
      advisory_complete: true,
      requires_human_approval: false,
      tier: 'A',
      reasons: classification.reasons,
      missing: [],
    };
  }

  const valid = new Map();
  for (const review of reviews) {
    const advisor = String(review.advisor ?? '').toLowerCase();
    if (!ADVISORS.includes(advisor)) continue;
    if (review.action_hash !== actionHash) continue;
    if (String(review.decision ?? '').toUpperCase() !== 'APPROVED') continue;
    if (review.read_only !== true) continue;
    valid.set(advisor, review);
  }
  const missing = ADVISORS.filter((advisor) => !valid.has(advisor));
  return {
    approved: false,
    advisory_complete: missing.length === 0,
    requires_human_approval: true,
    tier: 'B',
    reasons: classification.reasons,
    missing,
  };
}

export function evaluateRules(payload, rules = []) {
  const inputText = collectStrings(payload?.tool_input ?? payload).join('\n');
  const projectSlug = payload?.project_slug ?? payload?.projectSlug ?? null;
  const flags = [];
  const blocks = [];

  for (const rule of rules) {
    if (!rule?.pattern) continue;
    if (rule.project_slug && projectSlug && rule.project_slug !== projectSlug) continue;
    let pattern;
    try { pattern = new RegExp(rule.pattern, rule.flags ?? 'i'); }
    catch {
      flags.push({ ...rule, invalid: true, reason: 'invalid regular expression' });
      continue;
    }
    if (!pattern.test(inputText)) continue;
    if (String(rule.severity).toLowerCase() === 'block') blocks.push(rule);
    else flags.push(rule);
  }

  return {
    blocked: blocks.length > 0,
    blocks,
    flags,
    approved: false,
    approvalReason: '',
  };
}

export function promoteRuleToBlock() {
  throw new Error(
    'Rule promotion is disabled; identity-backed, action-bound confirmations '
    + 'authorize only exact handoff actions and do not authorize rule promotion',
  );
}
