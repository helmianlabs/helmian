// Stage 2 of the MCP install security pipeline: READ THE CODE.
//
// This runs BEFORE anything is installed and before anything is executed. It
// reads every source file in a candidate MCP server and reports what the code
// actually does, with a file:line citation on every finding.
//
// ─────────────────────────────────────────────────────────────────────────────
// HONEST STATEMENT OF WHAT THIS IS AND IS NOT
//
// This is STATIC ANALYSIS. It can prove the PRESENCE of a pattern. It can
// NEVER prove the ABSENCE of malice. A clean report means "none of the
// patterns below were found in the files scanned" — it does not mean "safe".
//
// Concretely, a hostile server can defeat every detector here by:
//   - computing a string at runtime that this scanner never sees as a literal
//     (`['ev','al'].join('')`, char-code arithmetic, a value fetched from the
//     network and then executed);
//   - putting the payload in a dependency this scanner does not walk into
//     (node_modules is intentionally skipped — see collectSourceFiles);
//   - putting the payload in a native .node addon, a WASM blob, or a binary
//     this scanner reads as opaque bytes;
//   - behaving benignly until a date, a hostname, or a server-side flag says
//     otherwise.
//
// That is why this stage is one of five and not the whole pipeline, and why a
// human still has to say yes at stage 4. `auditCandidate` returns its own
// limitations in `report.limitations` so callers cannot render a verdict
// without also being handed the caveats.
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, extname, sep } from 'node:path';

export const AUDIT_SEVERITY = Object.freeze({
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFO: 'info',
});

const SEVERITY_RANK = Object.freeze({ info: 0, low: 1, medium: 2, high: 3, critical: 4 });

// Directories never worth scanning as first-party source. node_modules is
// skipped deliberately and LOUDLY: a dependency tree is a supply chain this
// scanner does not audit, which is itself reported as a limitation.
const SKIPPED_DIRECTORIES = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'coverage', '.cache',
]);

const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.json',
]);

// Extensions this scanner CANNOT meaningfully read. Their presence is itself a
// finding, because they are executable surface the static pass cannot cover.
const OPAQUE_EXTENSIONS = new Set(['.node', '.wasm', '.exe', '.dll', '.so', '.dylib', '.bin']);

/**
 * Replace the CONTENT of comments and the INTERIOR of string literals with
 * spaces while preserving every newline, so line numbers still line up.
 *
 * Why this matters: without it, a server whose README-ish header comment says
 * "we never call eval()" gets flagged for calling eval. A scanner that flags
 * its own documentation is a scanner nobody keeps running. Comment text is
 * removed entirely; string interiors are blanked only for CODE-pattern rules,
 * because URL and credential rules need the literals intact (they run against
 * the raw source instead).
 */
export function stripCommentsPreservingLines(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  let state = 'code'; // code | line-comment | block-comment | single | double | template
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line-comment'; out += '  '; i += 2; continue; }
      if (c === '/' && next === '*') { state = 'block-comment'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'single'; out += c; i += 1; continue; }
      if (c === '"') { state = 'double'; out += c; i += 1; continue; }
      if (c === '`') { state = 'template'; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === 'line-comment') {
      if (c === '\n') { state = 'code'; out += '\n'; i += 1; continue; }
      out += ' '; i += 1; continue;
    }
    if (state === 'block-comment') {
      if (c === '*' && next === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' '; i += 1; continue;
    }
    // Inside a string literal. Keep the quotes and the newlines; blank the rest
    // so that prose inside a string cannot trip a code-shaped rule.
    const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (c === quote) { state = 'code'; out += c; i += 1; continue; }
    out += c === '\n' ? '\n' : ' '; i += 1; continue;
  }
  return out;
}

function finding({ rule, severity, file, line, evidence, message }) {
  return {
    rule,
    severity,
    file,
    line,
    evidence: String(evidence ?? '').trim().slice(0, 200),
    message,
    citation: `${file}:${line}`,
  };
}

function eachLine(text, visit) {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) visit(lines[index], index + 1);
}

/**
 * Visit only lines that contain real CODE, handing back the RAW line as well.
 *
 * Rules that need string LITERALS (a URL, a module specifier, a credential)
 * cannot read the stripped source, because stripCommentsPreservingLines blanks
 * string interiors. But reading raw source alone re-introduces the bug that
 * stripping existed to fix: flagging prose in a comment.
 *
 * So: use the stripped line to decide whether the line is code at all, and the
 * raw line to read the literal. A pure comment strips to whitespace and is
 * skipped; a real statement keeps its keywords and is scanned raw.
 *
 * This exists because of a defect found while proving the scanner: the
 * poisoned fixture's `import { execSync } from 'node:child_process'` was NOT
 * flagged, since the specifier had already been blanked to spaces.
 */
function eachCodeLine(raw, stripped, visit) {
  const rawLines = raw.split(/\r?\n/);
  const strippedLines = stripped.split(/\r?\n/);
  for (let index = 0; index < rawLines.length; index += 1) {
    const strippedLine = strippedLines[index] ?? '';
    // A line whose stripped form is only whitespace and quote characters holds
    // no executable code — it is a comment, or the tail of a multi-line string.
    if (!strippedLine.replace(/['"`\s]/g, '')) continue;
    visit(rawLines[index], strippedLine, index + 1);
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostAllowed(host, allowedHosts) {
  return allowedHosts.some((allowed) => {
    const a = String(allowed).toLowerCase().replace(/^\*\./, '');
    return host === a || host.endsWith(`.${a}`);
  });
}

// ── Detectors ───────────────────────────────────────────────────────────────
// Each detector takes the comment-stripped source (for code shape) AND the raw
// source (for literals), and pushes findings. Rule ids are stable strings so
// tests can assert on them rather than on message prose.

function detectDynamicEvaluation(stripped, file, findings) {
  eachLine(stripped, (line, no) => {
    if (/\beval\s*\(/.test(line)) {
      findings.push(finding({
        rule: 'obfuscation/eval',
        severity: AUDIT_SEVERITY.CRITICAL,
        file, line: no, evidence: line,
        message: 'Calls eval() — executes a string as code at runtime. Whatever it evaluates is invisible to this scan.',
      }));
    }
    if (/\bnew\s+Function\s*\(|\bFunction\s*\(\s*['"`]/.test(line)) {
      findings.push(finding({
        rule: 'obfuscation/function-constructor',
        severity: AUDIT_SEVERITY.CRITICAL,
        file, line: no, evidence: line,
        message: 'Uses the Function constructor — an eval equivalent that builds code from a string.',
      }));
    }
    if (/\bvm\s*\.\s*(runInNewContext|runInThisContext|compileFunction)\s*\(/.test(line)) {
      findings.push(finding({
        rule: 'obfuscation/vm-execution',
        severity: AUDIT_SEVERITY.CRITICAL,
        file, line: no, evidence: line,
        message: 'Executes code through node:vm — the executed source is not visible to this scan.',
      }));
    }
  });
}

function detectEncodedBlobs(raw, stripped, file, findings) {
  eachCodeLine(raw, stripped, (line, _strippedLine, no) => {
    // A long base64-looking literal. Tuned to 80+ chars so ordinary tokens,
    // hashes, and short ids do not trip it.
    const b64 = line.match(/['"`]([A-Za-z0-9+/]{80,}={0,2})['"`]/);
    if (b64) {
      findings.push(finding({
        rule: 'obfuscation/base64-blob',
        severity: AUDIT_SEVERITY.HIGH,
        file, line: no, evidence: b64[1].slice(0, 60) + '…',
        message: `Long base64 literal (${b64[1].length} chars) — hidden payload or embedded data this scan cannot read.`,
      }));
    }
    if (/Buffer\.from\s*\([^)]*['"`]base64['"`]\s*\)|\batob\s*\(/.test(line)) {
      findings.push(finding({
        rule: 'obfuscation/base64-decode',
        severity: AUDIT_SEVERITY.MEDIUM,
        file, line: no, evidence: line,
        message: 'Decodes base64 at runtime. Combined with eval/Function this is a classic hidden-payload loader.',
      }));
    }
    // 8+ consecutive hex escapes — string built to defeat grep.
    const hex = line.match(/(?:\\x[0-9a-fA-F]{2}){8,}/);
    if (hex) {
      findings.push(finding({
        rule: 'obfuscation/hex-escaped-string',
        severity: AUDIT_SEVERITY.HIGH,
        file, line: no, evidence: hex[0].slice(0, 60) + '…',
        message: 'Hex-escaped string literal — text deliberately written so a reader or grep cannot see it.',
      }));
    }
    if (line.length > 500) {
      findings.push(finding({
        rule: 'obfuscation/minified-line',
        severity: AUDIT_SEVERITY.MEDIUM,
        file, line: no, evidence: `${line.length}-char line`,
        message: `Line is ${line.length} chars — minified or generated code cannot be meaningfully reviewed by a human.`,
      }));
    }
  });
}

function detectNetwork(raw, stripped, file, findings, declared) {
  const allowedHosts = declared.allowedHosts ?? [];
  // URLs live in string literals, so read RAW — but only on real code lines, so
  // a host mentioned in documentation is not reported as an outbound call.
  eachCodeLine(raw, stripped, (line, _strippedLine, no) => {
    const urls = line.match(/https?:\/\/[^\s'"`)\\]+/g) ?? [];
    for (const url of urls) {
      const host = hostOf(url);
      if (!host) continue;
      if (host === 'localhost' || host === '127.0.0.1') continue;
      if (hostAllowed(host, allowedHosts)) {
        findings.push(finding({
          rule: 'network/declared-host',
          severity: AUDIT_SEVERITY.INFO,
          file, line: no, evidence: url,
          message: `Contacts ${host}, which is in the candidate's declared purpose.`,
        }));
      } else {
        findings.push(finding({
          rule: 'network/undeclared-host',
          severity: AUDIT_SEVERITY.CRITICAL,
          file, line: no, evidence: url,
          message: `Contacts ${host}, which is NOT in the declared host list [${allowedHosts.join(', ') || 'none declared'}]. This is where data leaves the machine.`,
        }));
      }
    }
  });
  eachLine(stripped, (line, no) => {
    if (/\bnet\s*\.\s*(connect|createConnection)\s*\(|\bdgram\s*\.\s*createSocket\s*\(|new\s+WebSocket\s*\(/.test(line)) {
      findings.push(finding({
        rule: 'network/raw-socket',
        severity: AUDIT_SEVERITY.HIGH,
        file, line: no, evidence: line,
        message: 'Opens a raw socket — traffic that URL-based review and most logging will not show.',
      }));
    }
  });
}

function detectProcessExecution(raw, stripped, file, findings) {
  // The module specifier lives inside a string literal, so this rule must read
  // the RAW line — but only on lines the stripped source proves are code.
  eachCodeLine(raw, stripped, (rawLine, strippedLine, no) => {
    const isImportStatement = /\b(?:import|require)\b/.test(strippedLine) || /\bfrom\b/.test(strippedLine);
    if (isImportStatement && /['"](?:node:)?child_process['"]/.test(rawLine)) {
      findings.push(finding({
        rule: 'process/child-process-import',
        severity: AUDIT_SEVERITY.HIGH,
        file, line: no, evidence: rawLine,
        message: 'Imports child_process — the server can run arbitrary commands on this machine.',
      }));
    }
  });
  eachLine(stripped, (line, no) => {
    if (/\b(execSync|execFileSync|spawnSync|exec|execFile|spawn|fork)\s*\(/.test(line)) {
      findings.push(finding({
        rule: 'process/command-execution',
        severity: AUDIT_SEVERITY.CRITICAL,
        file, line: no, evidence: line,
        message: 'Executes a subprocess. Anything the user can run, this can run.',
      }));
    }
  });
}

function detectFilesystem(raw, stripped, file, findings) {
  const WRITE_CALL = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|unlink|unlinkSync|rm|rmSync|rmdir|rename|renameSync|copyFile|copyFileSync|mkdir|mkdirSync|chmod|chmodSync)\s*\(/;
  eachLine(stripped, (line, no) => {
    if (!WRITE_CALL.test(line)) return;
    const rawLine = raw.split(/\r?\n/)[no - 1] ?? '';
    const escapesOwnDir =
      /['"`][A-Za-z]:[\\/]/.test(rawLine)          // C:\... absolute Windows path
      || /['"`]\/(?:etc|usr|bin|var|home|root|tmp)\//.test(rawLine) // absolute POSIX system path
      || /\.\.[\\/]/.test(rawLine)                  // parent traversal
      || /homedir\s*\(\s*\)|process\.env\.(HOME|USERPROFILE|APPDATA|LOCALAPPDATA)/.test(rawLine);
    findings.push(finding({
      rule: escapesOwnDir ? 'filesystem/write-outside-own-directory' : 'filesystem/write',
      severity: escapesOwnDir ? AUDIT_SEVERITY.CRITICAL : AUDIT_SEVERITY.LOW,
      file, line: no, evidence: rawLine,
      message: escapesOwnDir
        ? 'Writes to a path outside the server\'s own directory — this can modify the user\'s files, config, or startup items.'
        : 'Writes to a relative path inside its own directory. Expected for a server that caches; noted, not a flag.',
    }));
  });
  eachLine(stripped, (line, no) => {
    if (/\b(readFile|readFileSync)\s*\(/.test(line)) {
      const rawLine = raw.split(/\r?\n/)[no - 1] ?? '';
      if (/\.ssh|id_rsa|\.aws|credentials|\.npmrc|\.env|\.claude\.json|Login Data|Cookies/i.test(rawLine)) {
        findings.push(finding({
          rule: 'credential/reads-secret-file',
          severity: AUDIT_SEVERITY.CRITICAL,
          file, line: no, evidence: rawLine,
          message: 'Reads a path that holds credentials. No MCP server needs the user\'s keys, cookies, or .env.',
        }));
      }
    }
  });
}

function detectEnvironmentAccess(stripped, raw, file, findings, declared) {
  const allowedEnv = declared.allowedEnv ?? [];
  eachLine(stripped, (line, no) => {
    // ENUMERATION — sweeping the whole environment. This is the harvesting
    // signal, and it is categorically different from reading one named var.
    if (/Object\.(keys|entries|values|assign)\s*\(\s*process\.env\s*\)/.test(line)
      || /\{\s*\.\.\.\s*process\.env\s*\}/.test(line)
      || /JSON\.stringify\s*\(\s*process\.env\s*\)/.test(line)
      || /for\s*\(\s*(?:const|let|var)\s+\w+\s+in\s+process\.env\s*\)/.test(line)) {
      findings.push(finding({
        rule: 'env/enumeration',
        severity: AUDIT_SEVERITY.CRITICAL,
        file, line: no, evidence: line,
        message: 'Enumerates the ENTIRE environment. A server that needs one API key reads that key by name; sweeping every variable is harvesting.',
      }));
      return;
    }
    // TARGETED access — reading a named variable. This is normal and is
    // reported at INFO so the approval screen can list exactly what the server
    // wants, without drowning the real signal.
    const named = [...line.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
    const bracket = [...line.matchAll(/process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g)].map((m) => m[1]);
    for (const name of [...named, ...bracket]) {
      const declaredVar = allowedEnv.includes(name);
      findings.push(finding({
        rule: declaredVar ? 'env/declared-read' : 'env/undeclared-read',
        severity: declaredVar ? AUDIT_SEVERITY.INFO : AUDIT_SEVERITY.MEDIUM,
        file, line: no, evidence: `process.env.${name}`,
        message: declaredVar
          ? `Reads ${name}, which the candidate declared it needs.`
          : `Reads ${name}, which was NOT declared. Undeclared variable reads are how a "weather server" ends up holding a database URL.`,
      }));
    }
  });
}

function detectCredentialShapes(raw, stripped, file, findings) {
  const PATTERNS = [
    [/\bsk-[A-Za-z0-9]{16,}/, 'OpenAI-style secret key'],
    [/\bgh[pousr]_[A-Za-z0-9]{16,}/, 'GitHub token'],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
    [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, 'private key block'],
    [/\bey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\./, 'JWT'],
    [/postgres(?:ql)?:\/\/[^\s'"`]*:[^\s'"`@]+@/, 'Postgres URL with an inline password'],
  ];
  eachCodeLine(raw, stripped, (line, _strippedLine, no) => {
    for (const [pattern, label] of PATTERNS) {
      const hit = line.match(pattern);
      if (hit) {
        findings.push(finding({
          rule: 'credential/embedded-secret',
          severity: AUDIT_SEVERITY.HIGH,
          file, line: no, evidence: `${label}: ${hit[0].slice(0, 12)}…`,
          message: `Source contains what looks like a ${label}. Either a real leaked secret or an exfiltration target.`,
        }));
      }
    }
  });
}

function detectPackageManifest(raw, file, findings) {
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return; // Not valid JSON; the JSON-shape rules simply do not apply.
  }
  const scripts = pkg.scripts ?? {};
  const lines = raw.split(/\r?\n/);
  const lineOf = (key) => {
    const index = lines.findIndex((l) => new RegExp(`"${key}"\\s*:`).test(l));
    return index === -1 ? 1 : index + 1;
  };
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (scripts[hook]) {
      findings.push(finding({
        rule: 'package/install-hook',
        severity: AUDIT_SEVERITY.CRITICAL,
        file, line: lineOf(hook), evidence: `"${hook}": ${JSON.stringify(scripts[hook])}`,
        message: `package.json defines a ${hook} script. This runs automatically at "npm install" — BEFORE any human reviews the server, and before it is ever started.`,
      }));
    }
  }
}

// ── File collection ─────────────────────────────────────────────────────────

async function collectSourceFiles(root) {
  const source = [];
  const opaque = [];
  const skipped = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) {
          skipped.push(relative(root, full).split(sep).join('/'));
          continue;
        }
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, full).split(sep).join('/');
      const ext = extname(entry.name).toLowerCase();
      if (OPAQUE_EXTENSIONS.has(ext)) { opaque.push(rel); continue; }
      if (SOURCE_EXTENSIONS.has(ext)) { source.push(rel); continue; }
    }
  }
  await walk(root);
  return { source: source.sort(), opaque: opaque.sort(), skipped: skipped.sort() };
}

/**
 * Audit one file's text. Exported so tests can drive a single file without a
 * directory on disk.
 */
export function auditSourceText({ file, source, declared = {} }) {
  const findings = [];
  const stripped = stripCommentsPreservingLines(source);
  if (file.endsWith('.json')) {
    if (/(^|\/)package\.json$/.test(file)) detectPackageManifest(source, file, findings);
    detectCredentialShapes(source, stripped, file, findings);
    detectNetwork(source, stripped, file, findings, declared);
    return findings;
  }
  detectDynamicEvaluation(stripped, file, findings);
  detectEncodedBlobs(source, stripped, file, findings);
  detectNetwork(source, stripped, file, findings, declared);
  detectProcessExecution(source, stripped, file, findings);
  detectFilesystem(source, stripped, file, findings);
  detectEnvironmentAccess(stripped, source, file, findings, declared);
  detectCredentialShapes(source, stripped, file, findings);
  return findings;
}

function summarize(findings) {
  const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) summary[f.severity] += 1;
  return summary;
}

/**
 * Stage 2 entry point. Reads every source file under `root` and returns a
 * structured report. Never executes anything.
 *
 * `declared` describes what the candidate SAYS it needs:
 *   { purpose: string, allowedHosts: string[], allowedEnv: string[] }
 * Undeclared network hosts and undeclared env reads are the whole point — the
 * gap between the stated purpose and the actual code is the signal.
 */
export async function auditCandidate({ root, declared = {} }) {
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error(`Candidate root is not a directory: ${root}`);

  const { source, opaque, skipped } = await collectSourceFiles(root);
  const findings = [];
  for (const rel of source) {
    const text = await readFile(join(root, rel), 'utf8').catch(() => null);
    if (text === null) continue;
    findings.push(...auditSourceText({ file: rel, source: text, declared }));
  }
  for (const rel of opaque) {
    findings.push(finding({
      rule: 'coverage/unreadable-binary',
      severity: AUDIT_SEVERITY.HIGH,
      file: rel, line: 1, evidence: rel,
      message: 'Binary/native artifact. This is executable surface that static analysis CANNOT read. Treat as unreviewed code.',
    }));
  }

  findings.sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    || a.file.localeCompare(b.file) || a.line - b.line);

  const summary = summarize(findings);
  const blocking = summary.critical > 0;
  const verdict = blocking ? 'blocked' : (summary.high > 0 || summary.medium > 0) ? 'review' : 'clean';

  const limitations = [
    'Static analysis proves the PRESENCE of a pattern; it can never prove the ABSENCE of malice.',
    'Runtime-computed strings (e.g. ["ev","al"].join("")) are invisible to every rule here.',
    `Dependencies were NOT audited: ${skipped.length ? skipped.join(', ') : 'no dependency directories present'}. A clean first-party scan says nothing about the supply chain underneath it.`,
    'Time-bombed or server-flagged behaviour looks identical to benign code at rest.',
  ];
  if (opaque.length) {
    limitations.push(`${opaque.length} binary/native file(s) could not be read: ${opaque.join(', ')}.`);
  }

  return {
    stage: 'code-read',
    root,
    declared,
    filesScanned: source,
    filesUnreadable: opaque,
    directoriesSkipped: skipped,
    findings,
    summary,
    verdict,
    blocking,
    limitations,
  };
}

/** Human-readable rendering used by the CLI and by the approval screen. */
export function formatAuditReport(report) {
  const lines = [];
  lines.push(`CODE READ — ${report.root}`);
  lines.push(`  files scanned: ${report.filesScanned.length}   verdict: ${report.verdict.toUpperCase()}`);
  lines.push(`  critical ${report.summary.critical}  high ${report.summary.high}  medium ${report.summary.medium}  low ${report.summary.low}  info ${report.summary.info}`);
  const notable = report.findings.filter((f) => f.severity !== AUDIT_SEVERITY.INFO);
  if (!notable.length) lines.push('  (no findings above INFO)');
  for (const f of notable) {
    lines.push(`  [${f.severity.toUpperCase().padEnd(8)}] ${f.citation}  ${f.rule}`);
    lines.push(`             ${f.message}`);
    if (f.evidence) lines.push(`             evidence: ${f.evidence}`);
  }
  lines.push('  LIMITATIONS OF THIS STAGE:');
  for (const l of report.limitations) lines.push(`    - ${l}`);
  return lines.join('\n');
}
