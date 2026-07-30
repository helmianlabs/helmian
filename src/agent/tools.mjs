import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { redactSecrets } from './redact.mjs';
import { acquireLease, renewLease, verifyLeaseHeld } from '../core/lease.mjs';
import {
  ALLOW_SESSION,
  DENY,
  isAllowed,
  normalizeDecision,
  resolveAskTimeoutMs,
} from './approval.mjs';
import {
  evaluateToolCall,
  governanceRefusalMessage,
  requiresWriteLease,
} from '../core/governance-gate.mjs';

const READ_TOOLS = new Set(['read_file', 'list_dir', 'search_text']);
const WRITE_TOOLS = new Set(['write_file', 'run_command']);

/**
 * Safe environment variable allowlist for child processes.
 * Only variables needed for shell operation — NO credentials.
 */
const SAFE_ENV_VARS = [
  // System paths and config
  'PATH',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'COMSPEC',
  'PATHEXT',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  // Shell and terminal
  'SHELL',
  'TERM',
  'COLORTERM',
  'TERM_PROGRAM',
  // Locale and language
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  // Node.js operational (not credentials)
  'NODE_ENV',
  'NODE_PATH',
  'NODE_OPTIONS',
  // Build tools operational
  'DOTNET_CLI_TELEMETRY_OPTOUT',
  'DOTNET_SKIP_FIRST_TIME_EXPERIENCE',
  'MSBUILDDISABLENODEREUSE',
  // Windows system
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'COMPUTERNAME',
  'USERNAME',
  'USERDOMAIN',
  'LOGONSERVER',
  // Unix/Linux system
  'USER',
  'LOGNAME',
  'HOSTNAME',
  'PWD',
  'OLDPWD',
  'SHLVL',
  // Display
  'DISPLAY',
];

/**
 * Build a sanitized environment for child processes.
 * Strips all API keys, database URLs, and other credentials.
 */
function buildSafeEnv() {
  const safe = {};
  for (const key of SAFE_ENV_VARS) {
    if (process.env[key] !== undefined) {
      safe[key] = process.env[key];
    }
  }
  return safe;
}

/**
 * Normalize console permission mode used by every LLM provider.
 * - read-only: no tools
 * - read-tools: read_file, list_dir, search_text
 * - ask:       every tool is eligible, but each individual call must be
 *              approved by a human before it runs
 * - full:      all tools including write_file + run_command, no asking
 */
export function normalizePermissionMode(mode) {
  const m = String(mode || 'read-only').trim().toLowerCase();
  if (m === 'full' || m === 'execution' || m === 'on' || m === 'write' || m === 'all') {
    return 'full';
  }
  if (
    m === 'ask'
    || m === 'always-ask'
    || m === 'always_ask'
    || m === 'ask-each'
    || m === 'approve'
    || m === 'prompt'
    || m === 'confirm'
  ) {
    return 'ask';
  }
  if (m === 'read-tools' || m === 'read' || m === 'tools-read' || m === 'readonly-tools') {
    return 'read-tools';
  }
  return 'read-only';
}

/**
 * Eligibility only. In `ask` mode every tool is eligible, which is NOT the same
 * as runnable — see the approval gate in `execute`, which is the thing that
 * actually decides whether a call happens.
 */
function isToolAllowed(permissionMode, name) {
  if (permissionMode === 'full') return true;
  if (permissionMode === 'ask') return true;
  if (permissionMode === 'read-tools') return READ_TOOLS.has(name);
  return false;
}

/**
 * Snapshot arguments once, so the object a human approved is byte-for-byte the
 * object that executes. Never throws: an unclonable value falls back to the
 * original rather than failing a call in the non-ask modes.
 */
function cloneArgs(args) {
  if (args === null || args === undefined) return {};
  if (typeof args !== 'object') return args;
  try {
    return structuredClone(args);
  } catch {
    try {
      return JSON.parse(JSON.stringify(args));
    } catch {
      return args;
    }
  }
}

/** Resolve a promise, or DENY if it takes longer than `ms` or rejects. */
async function decideWithTimeout(promise, ms) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((resolvePromise) => {
        timer = setTimeout(() => resolvePromise({ __helmionApprovalTimeout: true }), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Workspace-scoped tools for the Helmion coding agent CLI.
 * Paths outside the workspace root are rejected.
 *
 * @param {string} workspaceRoot
 * @param {{
 *   permissionMode?: string,
 *   approver?: (req: {tool: string, args: any, workspace: string, permissionMode: string}) => Promise<string>,
 *   approvalTimeoutMs?: number,
 *   onApprovalDecision?: (info: {tool: string, decision: string, source: string}) => void,
 *   projectSlug?: string,
 * }} [options]
 *
 * `approver` is the ONLY way a call gets approved in ask mode. Leaving it unset
 * denies every tool call — a runtime that cannot reach a human must not act.
 * Session grants live on this runtime instance, so recreating the runtime (a
 * permission change, a reset, a new workspace) clears them by construction.
 */
export function createToolRuntime(workspaceRoot, options = {}) {
  const root = resolve(workspaceRoot);
  const permissionMode = normalizePermissionMode(options.permissionMode);
  /** Which project's promoted rules apply; null means every rule applies. */
  const projectSlug = options.projectSlug ?? options.project_slug ?? null;
  const approver = typeof options.approver === 'function' ? options.approver : null;
  const approvalTimeoutMs = resolveAskTimeoutMs(
    options.approvalTimeoutMs ?? process.env.HELMION_ASK_TIMEOUT_MS,
  );
  const onApprovalDecision = typeof options.onApprovalDecision === 'function'
    ? options.onApprovalDecision
    : () => {};

  /** Tool names the user approved for the rest of THIS runtime's life. */
  const sessionGrants = new Set();

  // ── THE WRITE LEASE ────────────────────────────────────────────────────────
  //
  // At most one active writer per project, which is what README.md:19 has always
  // advertised and what nothing enforced until now.
  //
  // Acquisition lives HERE and not in the gate, because a gate must stay a pure
  // evaluator — a check with a side effect is a check you cannot reason about.
  // The gate verifies; this acquires.
  //
  // It is acquired LAZILY, on the first mutating call, not at construction.
  // A read-only session must not take a project's write lease and block a real
  // writer for ninety seconds, and constructing a runtime is not a statement of
  // intent to write.
  let leaseToken = options.leaseToken ?? null;
  const leaseSlug = projectSlug ?? basename(root) ?? 'workspace';

  /**
   * Make sure this session holds the lease, renewing or re-taking as needed.
   * Never throws. Returns {ok, reason} — a refusal reason the caller surfaces.
   */
  function ensureWriteLease() {
    // Already ours and still valid? Push the expiry out and carry on. Renewing
    // per mutating call is what stops a long think between two writes from
    // silently losing the project to a takeover.
    if (leaseToken) {
      const held = verifyLeaseHeld(root, { leaseToken });
      if (held.held) {
        try {
          renewLease(root, { leaseToken });
          return { ok: true, reason: '' };
        } catch (err) {
          // Lost it mid-renew. Fall through and try to take it cleanly rather
          // than proceeding on a lease we no longer hold.
          leaseToken = null;
          void err;
        }
      } else if (held.failedClosed) {
        // Unreadable lease file. "Cannot tell" is never "carry on".
        return { ok: false, reason: held.reason };
      } else {
        leaseToken = null;
      }
    }

    try {
      const { record } = acquireLease(root, { projectSlug: leaseSlug });
      leaseToken = record.leaseToken;
      return { ok: true, reason: '' };
    } catch (err) {
      // LeaseHeldError means somebody else is genuinely writing. Anything else
      // means we could not establish the invariant, and both refuse.
      return { ok: false, reason: err.message };
    }
  }

  function noteDecision(tool, decision, source) {
    try {
      onApprovalDecision({ tool, decision, source });
    } catch {
      // A broken host listener must never change a permission outcome.
    }
  }

  /**
   * Ask a human about one call. Returns {decision, reason}; anything other than
   * an explicit allow is a denial with the reason it was denied.
   */
  async function requestApproval(name, args) {
    if (sessionGrants.has(name)) {
      noteDecision(name, ALLOW_SESSION, 'session-grant');
      return { decision: ALLOW_SESSION, reason: 'session-grant' };
    }
    if (!approver) {
      noteDecision(name, DENY, 'no-approver');
      return { decision: DENY, reason: 'no approver is connected' };
    }

    let raw;
    try {
      raw = await decideWithTimeout(
        approver({ tool: name, args, workspace: root, permissionMode }),
        approvalTimeoutMs,
      );
    } catch {
      noteDecision(name, DENY, 'approver-error');
      return { decision: DENY, reason: 'the approval channel failed' };
    }

    if (raw && typeof raw === 'object' && raw.__helmionApprovalTimeout) {
      noteDecision(name, DENY, 'timeout');
      return { decision: DENY, reason: `no answer within ${approvalTimeoutMs}ms` };
    }

    const decision = normalizeDecision(raw);
    if (decision === ALLOW_SESSION) sessionGrants.add(name);
    noteDecision(name, decision, 'approver');
    return {
      decision,
      reason: decision === DENY ? 'the user denied it' : 'approved',
    };
  }

  function resolveInWorkspace(userPath) {
    const raw = (userPath || '.').trim() || '.';
    const full = resolve(root, raw);
    const rel = relative(root, full);
    if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
      throw new Error(`Path escapes workspace: ${userPath}`);
    }
    // Also block absolute paths that don't land under root
    if (!full.toLowerCase().startsWith(root.toLowerCase())) {
      throw new Error(`Path outside workspace: ${userPath}`);
    }
    return full;
  }

  const tools = {
    read_file: {
      description: 'Read a UTF-8 text file under the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path from workspace root' },
        },
        required: ['path'],
      },
      async execute({ path }) {
        const full = resolveInWorkspace(path);
        if (!existsSync(full)) return `Error: file not found: ${path}`;
        const st = statSync(full);
        if (!st.isFile()) return `Error: not a file: ${path}`;
        if (st.size > 400_000) {
          return `Error: file too large (${st.size} bytes). Read a smaller file.`;
        }
        const content = readFileSync(full, 'utf8');
        return redactSecrets(content);
      },
    },

    write_file: {
      description: 'Write UTF-8 content to a file under the workspace (creates parent dirs).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
      async execute({ path, content }) {
        const full = resolveInWorkspace(path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content ?? '', 'utf8');
        return `Wrote ${Buffer.byteLength(content ?? '', 'utf8')} bytes to ${path}`;
      },
    },

    list_dir: {
      description: 'List files and directories under a workspace path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory (default .)' },
        },
      },
      async execute({ path = '.' } = {}) {
        const full = resolveInWorkspace(path);
        if (!existsSync(full)) return `Error: directory not found: ${path}`;
        const entries = readdirSync(full, { withFileTypes: true });
        if (entries.length === 0) return `(empty) ${path}`;
        return entries
          .map((e) => `${e.isDirectory() ? '[DIR] ' : '[FILE]'} ${e.name}`)
          .join('\n');
      },
    },

    run_command: {
      description:
        'Run a shell command in the workspace (PowerShell on Windows, sh elsewhere). Prefer small, non-interactive commands.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_ms: { type: 'number', description: 'Max wait (default 120000)' },
        },
        required: ['command'],
      },
      async execute({ command, timeout_ms = 120_000 }) {
        if (!command || !String(command).trim()) {
          return 'Error: empty command';
        }
        const output = await runShell(String(command), root, Number(timeout_ms) || 120_000);
        return redactSecrets(output);
      },
    },

    search_text: {
      description: 'Search for a literal string in text files under a path (simple scan).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          path: { type: 'string', description: 'Subdirectory to search (default .)' },
          max_hits: { type: 'number' },
        },
        required: ['query'],
      },
      async execute({ query, path = '.', max_hits = 40 }) {
        if (!query) return 'Error: empty query';
        const full = resolveInWorkspace(path);
        const hits = [];
        walk(full, (file) => {
          if (hits.length >= max_hits) return;
          try {
            const st = statSync(file);
            if (!st.isFile() || st.size > 200_000) return;
            if (!/\.(cs|js|mjs|ts|tsx|json|md|sql|ps1|py|xaml|csproj|txt|yml|yaml)$/i.test(file)) {
              return;
            }
            const text = readFileSync(file, 'utf8');
            const lines = text.split(/\r?\n/);
            lines.forEach((line, idx) => {
              if (hits.length >= max_hits) return;
              if (line.includes(query)) {
                hits.push(`${relative(root, file)}:${idx + 1}: ${line.trim().slice(0, 200)}`);
              }
            });
          } catch {
            // skip unreadable
          }
        });
        const result = hits.length ? hits.join('\n') : `No hits for ${JSON.stringify(query)}`;
        return redactSecrets(result);
      },
    },
  };

  function allowedTools() {
    return Object.fromEntries(
      Object.entries(tools).filter(([name]) => isToolAllowed(permissionMode, name)),
    );
  }

  return {
    root,
    permissionMode,
    /** Tools the user granted for this runtime's lifetime (ask mode only). */
    get grantedTools() {
      return Object.freeze([...sessionGrants]);
    },
    get tools() {
      return allowedTools();
    },
    definitionsForOpenAi() {
      return Object.entries(allowedTools()).map(([name, tool]) => ({
        type: 'function',
        function: {
          name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    },
    async execute(name, args) {
      if (!isToolAllowed(permissionMode, name)) {
        return (
          `Error: tool '${name}' blocked by permission mode '${permissionMode}'. `
          + `Use the Console permissions dropdown (Read tools / Ask before each tool / Full tools).`
        );
      }
      const tool = tools[name];
      if (!tool) return `Error: unknown tool ${name}`;

      // Snapshot before approval so the arguments a human sees are the exact
      // arguments that run — nothing can be swapped in between the two.
      const callArgs = cloneArgs(args);

      // GOVERNANCE FIRST, and deliberately BEFORE the ask tier.
      //
      // These are two different things and the order encodes which one wins.
      // Governance is a HARD block: operations that are never allowed, decided
      // by the deterministic kernel. Approval is a SOFT ask: a human choosing.
      // Asking first would let a person click "allow" on something the kernel
      // forbids, so the kernel answers first and a refusal returns here — the
      // approver is never even reached, and neither is tool.execute.
      //
      // Every tool goes through this, not just run_command. write_file is
      // governed because an agent silently overwriting a human's file is the
      // exact harm this repo exists to stop; the built-in destructive-pattern
      // half only inspects `command` (governance.mjs:52-53) so for a write it
      // is the promoted rules that decide, matched against the path AND the
      // content.
      // Take the write lease BEFORE asking the gate, so the gate has a token to
      // verify. A failure to establish it is reported through the same refusal
      // path as any other governance refusal — the model must be told the
      // project has another writer, not left guessing why a write did nothing.
      if (requiresWriteLease(name)) {
        const lease = ensureWriteLease();
        if (!lease.ok) {
          return redactSecrets(governanceRefusalMessage(name, {
            reason: `it needs the project's write lease and this session could not take it: ${lease.reason}`,
          }));
        }
      }

      let governance;
      try {
        governance = evaluateToolCall({
          tool: name,
          args: callArgs,
          workspace: root,
          projectSlug,
          leaseToken,
        });
      } catch (err) {
        // The gate is written not to throw. If it ever does, that is exactly
        // the ambiguous case that must not execute.
        governance = {
          allowed: false,
          reason: `the governance gate itself failed (${err.message}); governance fails closed`,
        };
      }
      if (!governance.allowed) {
        return redactSecrets(governanceRefusalMessage(name, governance));
      }

      if (permissionMode === 'ask') {
        const { decision, reason } = await requestApproval(name, callArgs);
        if (!isAllowed(decision)) {
          return (
            `Error: tool '${name}' was DENIED — ${reason}. `
            + 'It did NOT run and nothing was changed. Permission mode is \'ask\', so every '
            + 'tool call needs the user to approve it first. Do not retry this same call: '
            + 'explain what you need it for, or propose a different step.'
          );
        }
      }

      try {
        const result = await tool.execute(callArgs);
        // Redact secrets from all tool outputs as a final safety net
        return redactSecrets(String(result));
      } catch (err) {
        const errMsg = `Error: ${err.message || String(err)}`;
        return redactSecrets(errMsg);
      }
    },
  };
}

// Keep WRITE_TOOLS referenced so tree-shaking / lint does not drop the policy table.
void WRITE_TOOLS;

function walk(dir, onFile) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (
      e.isDirectory()
      && (e.name === 'node_modules'
        || e.name === '.git'
        || e.name === 'obj'
        || e.name === 'bin'
        || e.name === 'dist'
        || e.name === '_review_export_primary_providers_2026-07-28')
    ) {
      continue;
    }
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, onFile);
    else onFile(full);
  }
}

function runShell(command, cwd, timeoutMs) {
  return new Promise((resolvePromise) => {
    const isWin = process.platform === 'win32';
    const child = spawn(
      isWin ? 'powershell.exe' : 'sh',
      isWin
        ? ['-NoProfile', '-NonInteractive', '-Command', command]
        : ['-c', command],
      {
        cwd,
        env: buildSafeEnv(),
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise(`Error: command timed out after ${timeoutMs}ms\n${stdout}\n${stderr}`);
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > 80_000) stdout = `${stdout.slice(0, 80_000)}\n…truncated`;
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 40_000) stderr = `${stderr.slice(0, 40_000)}\n…truncated`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const parts = [];
      if (stdout) parts.push(stdout.trimEnd());
      if (stderr) parts.push(`STDERR:\n${stderr.trimEnd()}`);
      parts.push(`exit_code=${code}`);
      resolvePromise(parts.join('\n') || `(no output) exit_code=${code}`);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise(`Error starting shell: ${err.message}`);
    });
  });
}
