const ADVISORS = Object.freeze(['claude', 'gemini', 'grok', 'openai']);

const DESTRUCTIVE_PATTERNS = [
  ['recursive/forced rm', /(?:^|[;&|`(\s])rm\s+[^;&|]*(?:-[A-Za-z]*[rRf][A-Za-z]*|--(?:recursive|force|dir))\b/i],
  ['rm of a glob', /(?:^|[;&|`(\s])rm\s+[^;&|]*\*/i],
  ['Remove-Item -Recurse/-Force', /\bRemove-Item\b[^;&|]*\s-(?:Rec|Forc)[a-z]*\b/i],
  ['rmdir /S', /\b(?:rmdir|rd)\b[^;&|]*\s\/s\b/i],
  ['cmd del /F, /Q, or /S', /(?:^|[;&|`(\s])del\s+[^;&|]*\/[fqs]\b/i],
  // The git patterns carry TWO `[^;&|]` spans around a literal, and an unbounded
  // `*` on both sides of a literal backtracks quadratically. Measured 2026-08-03
  // on `'git ' + 'clean '.repeat(n) + 'X'`: 18 KB → 35 ms, 36 KB → 135 ms,
  // 72 KB → 530 ms, 144 KB → 2,099 ms — a clean 4× per doubling. Against
  // background/scan.js's line cap that is roughly a minute and a half of frozen
  // service worker for ONE line, and the guard resubmits a timed-out block, so
  // the stall is permanent rather than transient. The spans are bounded to 200
  // characters, which is far longer than any real `git clean -fdx` and no longer
  // enough runway for the blowup to matter.
  ['git reset discard', /\bgit\b[^;&|]{0,200}\breset\b[^;&|]{0,200}--(?:hard|merge|keep)\b/i],
  ['git clean', /\bgit\b[^;&|]{0,200}\bclean\b[^;&|]{0,200}\s-[A-Za-z]*[fdx]/i],
  ['git force push', /\bgit\b[^;&|]{0,200}\bpush\b[^;&|]{0,200}(?:--force(?:-with-lease)?|\s-f\b)/i],
  ['git branch force delete', /\bgit\b[^;&|]{0,200}\bbranch\b[^;&|]{0,200}\s-D\b/i],
  ['git checkout/restore discard', /\bgit\b[^;&|]{0,200}\b(?:checkout|restore)\b[^;&|]{0,200}\s--\s/i],
  ['git worktree remove', /\bgit\b[^;&|]{0,200}\bworktree\b[^;&|]{0,200}\bremove\b/i],
  ['Clear-Content', /\bClear-Content\b/i],
  ['direct SQL DDL', /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i],
  ['SQL TRUNCATE', /\bTRUNCATE\s+(?:TABLE\b|(?:ONLY\s+)?[A-Za-z_"`[])/i],
  ['dd device write', /\bdd\b[^;&|]*\bof=/i],
  ['filesystem format', /\bmkfs(?:\.|\s)/i],

  // ── Destruction expressed through a LANGUAGE API, not shell syntax ─────────
  //
  // Added 2026-07-29 on Troy's instruction after live testing. Every pattern
  // above this block describes a SHELL command, so a reply that hands you
  // `shutil.rmtree('/data')` or `fs.rmSync(dir, {recursive:true})` passed
  // straight through — the same delete, one language away from being seen.
  //
  // These are deliberately call-shaped (`name.method(`) rather than bare words,
  // so prose naming the function does not fire and neither does an import line.
  ['Python recursive tree delete', /\bshutil\s*\.\s*rmtree\s*\(/i],
  ['Python file or directory delete', /\bos\s*\.\s*(?:remove|unlink|rmdir|removedirs)\s*\(/i],
  ['Python pathlib delete', /\.\s*(?:unlink|rmdir)\s*\(\s*(?:missing_ok\s*=|\))/i],
  ['.NET directory delete', /\bDirectory\s*\.\s*Delete\s*\(/i],
  // Case-insensitive, so this covers C# File.Delete and Ruby File.delete both.
  ['File.delete call', /\bFile\s*\.\s*delete\s*\(/i],
  ['Ruby forced recursive rm', /\bFileUtils\s*\.\s*rm_(?:rf|r|f)\b/i],
  ['Node filesystem delete', /\bfs(?:\s*\.\s*promises)?\s*\.\s*(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(/i],
  ['recursive delete option', /\brm(?:Sync)?\s*\([^)]*\brecursive\s*:\s*true/i],
];

// Line and block comments. Stripped from the skeleton BEFORE matching, on
// Troy's instruction 2026-07-29: a code block that merely MENTIONS a dangerous
// command in a comment was firing, and that was the confirmed false positive.
//
// Two things are deliberately NOT here, and both would be security holes:
//
//   `--` SQL comments. `--force`, `--recursive` and `--no-preserve-root` are
//   CLI flags, and `git checkout -- src/` is itself a destructive pattern above
//   (`git checkout/restore discard` matches on `\s--\s`). Stripping `--` would
//   disarm those. SQL comment handling needs the block's declared language,
//   which this function does not receive.
//
//   `//` after a colon. `curl https://host && rm -rf /` must not lose everything
//   after `https:`. The lookbehind below refuses a `//` preceded by `:`.
const COMMENT_PATTERNS = [
  [/\/\*[\s\S]*?\*\//g, ' '],        // /* block */
  [/<!--[\s\S]*?-->/g, ' '],         // <!-- html -->
  [/(?:^|[ \t])#[^\n]*/g, ' '],      // # shell, python, ruby, powershell
  [/(?<!:)\/\/[^\n]*/g, ' '],        // // js, c#, but never inside a URL
];

const SQL_DDL = /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|ALTER\s+TABLE\b[^;]*\bDROP\b)\b/i;
const SQL_EXECUTION_CONTEXT = /\b(?:query|execute|exec|raw|psql|sqlcmd)\b|(?:\bnode\b[^;&|]{0,200}\s-e\b)|(?:\bpython(?:\d+(?:\.\d+)?)?\b[^;&|]{0,200}\s-c\b)/i;

// A command that hands a quoted string to ANOTHER shell to run.
//
// commandSkeleton replaces every quoted string with <STR> before the patterns
// run, which is right for prose — it is what stops a log message that merely
// mentions `rm -rf` from firing. But when the quoted string is not prose, it is
// the payload. Measured 2026-08-03, all four returning blocked:false:
//
//     bash -c "rm -rf /data"            skeleton: `bash -c  <STR> `
//     sh -c 'rm -rf ~'                  skeleton: `sh -c  <STR> `
//     ssh host "rm -rf /var/www"        skeleton: `ssh host  <STR> `
//     docker run img sh -c "rm -rf /app"  skeleton: `docker run img sh -c  <STR> `
//
// while the bare `rm -rf /data` was blocked. The quotes alone were the bypass,
// and every one of those pastes and runs verbatim.
//
// The fix mirrors what SQL_EXECUTION_CONTEXT already does a few lines below:
// re-inspect the quoted contents, but ONLY when the command has a sink that
// would actually execute them. Prose keeps its false-positive protection.
// It is tested against the SKELETON, not the raw command, and that is
// load-bearing. The skeleton has already had quoted strings replaced, so
// `echo "ssh to the box and rm -rf it"` reduces to `echo <STR>` — no sink, no
// re-inspection, and the prose keeps the false-positive protection the skeleton
// exists to provide. Only a sink that survives OUTSIDE the quotes counts.
const SHELL_EXECUTION_SINK = new RegExp(
  '\\b(?:bash|sh|zsh|dash|ksh|docker|kubectl|podman|xargs|su|sudo|env|nohup|timeout'
  + '|pwsh|powershell|cmd)\\b[^;&|]{0,200}?(?:\\s-{1,2}(?:c|command|exec)\\b|\\s/c\\b)'
  // ssh and `docker/kubectl exec` take the command as a BARE argument with no
  // -c flag at all, so `ssh host "rm -rf /var/www"` has no flag to match on.
  + '|\\bssh\\b'
  + '|\\b(?:docker|kubectl)\\b[^;&|]{0,200}?\\bexec\\b'
  + '|\\bos\\s*\\.\\s*system\\s*\\('
  + '|\\bsubprocess\\s*\\.\\s*(?:run|call|check_call|check_output|Popen)\\s*\\(',
  'i',
);

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
  let skeleton = String(command)
    .replace(/<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\r?\n[\s\S]*?^\s*\1\s*$/gm, ' <<HEREDOC> ')
    .replace(/@'[\s\S]*?'@/g, ' <PSHERE> ')
    .replace(/@"[\s\S]*?"@/g, ' <PSHERE> ')
    // Strings first, comments second, and the order is load-bearing: strip a
    // comment out of `echo "a # b"` first and you leave a dangling quote for the
    // string pass to trip over. Strings go to <STR>, so a `#` living inside one
    // is gone before the comment pass ever sees it.
    .replace(/"[^"]*"|'[^']*'/g, ' <STR> ');

  for (const [pattern, replacement] of COMMENT_PATTERNS) {
    skeleton = skeleton.replace(pattern, replacement);
  }
  return skeleton;
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

  // Same rule, applied to shell payloads: `bash -c "rm -rf /data"` is the same
  // delete as `rm -rf /data`, one quote away from being invisible. The whole
  // pattern list is re-run against the quoted contents, so anything that would
  // be caught unquoted is caught here too — including a future pattern nobody
  // remembers to add in two places.
  if (SHELL_EXECUTION_SINK.test(skeleton)) {
    for (const value of quotedStrings(command)) {
      for (const [label, pattern] of DESTRUCTIVE_PATTERNS) {
        if (pattern.test(value)) hits.push(`${label} (inside a quoted shell payload)`);
      }
    }
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
