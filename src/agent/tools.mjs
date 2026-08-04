import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
  WORKBENCH_CONTRACT,
  assertNoFilesystemLinks,
  discoverWorkbenchArtifacts,
  isPrivateWorkbenchPath,
  projectTaskCommand,
  resolveWorkbenchPath,
  startStaticPreview,
  workspaceContext,
} from './workbench.mjs';
import {
  evaluateToolCall,
  governanceRefusalMessage,
  requiresWriteLease,
} from '../core/governance-gate.mjs';

const READ_TOOLS = new Set(['workspace_context', 'read_file', 'list_dir', 'search_text']);
const WRITE_TOOLS = new Set([
  'create_file',
  'edit_file',
  'run_project_task',
  'start_project_preview',
  'stop_project_preview',
]);

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
 * - read-tools: workspace_context, read_file, list_dir, search_text
 * - ask:       every tool is eligible, but each individual call must be
 *              approved by a human before it runs
 * - full:      every tool in the caller-selected catalog, no asking
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

  // OPEN QUESTION FOR THE OWNER — deliberately NOT changed here.
  //
  // A session grant is keyed on the tool NAME and nothing else: not the command,
  // not the path, not a hash of the arguments (see requestApproval below). For
  // `write_file` or `list_dir` that is a reasonable trade, because workspace
  // confinement still bounds what they can touch. For `run_command` the "tool"
  // is the entire shell, so approving `git status` once turns ask mode into full
  // mode for every command that follows in that runtime.
  //
  // What still protects the user, verified rather than assumed: the governance
  // kernel runs BEFORE the approval tier, so a held grant cannot launder a
  // destructive command. test/governance-wiring.test.mjs pins exactly that, and
  // it passes. The residual exposure is commands the deny-list does not name —
  // which is the same exposure a full-mode user accepts.
  //
  // Scoping the grant to run_command was tried during this audit and reverted:
  // that test also pins `grantedTools === ['run_command']` as intended
  // behaviour, so the feature is deliberate, and narrowing it changes what a
  // button in the UI does. That is the owner's call, not an auditor's. The two
  // candidate fixes are (a) key the grant on tool + a hash of the arguments, or
  // (b) offer only allow-once for run_command and relabel the button.

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
  let previewServer = null;
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

  /**
   * The deepest ancestor of `target` that exists on disk, with every symlink
   * along the way resolved. Needed because a write may name a file that is not
   * there yet — realpathSync on the target itself would just throw ENOENT and
   * tell us nothing about where the path really lands.
   */
  function realpathOfNearestExistingAncestor(target) {
    let candidate = target;
    for (;;) {
      if (existsSync(candidate)) return realpathSync(candidate);
      const parent = dirname(candidate);
      // dirname of a root returns the root, which would loop forever.
      if (parent === candidate) return realpathSync(parent);
      candidate = parent;
    }
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

    // BOTH CHECKS ABOVE ARE LEXICAL, and resolve() does not follow links.
    //
    // A symlink or junction INSIDE the workspace that points anywhere on disk
    // keeps a textual path under root, satisfies both checks, and then
    // readFileSync/writeFileSync follow it to the real target. On Windows the
    // agent can create one itself with `mklink /J` through run_command and then
    // read or overwrite outside the workspace using ordinary read_file and
    // write_file — which in read-tools mode are not even gated.
    //
    // So the containment is re-checked against the REAL path. Note the codebase
    // already does this kind of check elsewhere
    // (ProtectedProviderProfileStore.RejectReparsePoint) — it was simply never
    // applied to the agent's own file tools.
    let realFull;
    let realRoot;
    try {
      realRoot = realpathSync(root);
      realFull = realpathOfNearestExistingAncestor(full);
    } catch {
      // If the real path cannot be determined, do not guess. Refusing a legal
      // path is recoverable; allowing an escape is not.
      throw new Error(`Path could not be verified against the workspace: ${userPath}`);
    }

    const realRel = relative(realRoot, realFull);
    if (realRel && (realRel.startsWith('..') || realRel.includes(`..${sep}`))) {
      throw new Error(`Path escapes workspace through a symlink: ${userPath}`);
    }

    return full;
  }

  const safeTools = {
    workspace_context: {
      description:
        'Inspect the selected workspace boundary, bounded file inventory, declared project tasks, and artifacts. Private configuration files are excluded.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return JSON.stringify(workspaceContext(root));
      },
    },

    read_file: {
      description: 'Read a non-private UTF-8 text file under the selected workspace. Refuses filesystem links.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path from workspace root' },
        },
        required: ['path'],
      },
      async execute({ path }) {
        const { full, relativePath } = resolveWorkbenchPath(root, path);
        if (isPrivateWorkbenchPath(relativePath)) return 'Error: private configuration files are not available to the agent workbench.';
        assertNoFilesystemLinks(root, relativePath, { allowMissingLeaf: false });
        if (!existsSync(full)) return `Error: file not found: ${relativePath}`;
        const st = statSync(full);
        if (!st.isFile()) return `Error: not a file: ${relativePath}`;
        if (st.size > 400_000) {
          return `Error: file too large (${st.size} bytes). Read a smaller file.`;
        }
        const content = readFileSync(full, 'utf8');
        return redactSecrets(content);
      },
    },

    create_file: {
      description: 'Create one new UTF-8 file beneath the selected workspace. Refuses overwrite, links, and private configuration paths.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
      async execute({ path, content }) {
        const { full, relativePath } = resolveWorkbenchPath(root, path);
        if (isPrivateWorkbenchPath(relativePath)) return 'Error: private configuration paths cannot be created by the agent workbench.';
        assertNoFilesystemLinks(root, relativePath);
        if (existsSync(full)) return `Error: file already exists: ${relativePath}. Use edit_file with an exact precondition.`;
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content ?? '', 'utf8');
        const bytes = Buffer.byteLength(content ?? '', 'utf8');
        return JSON.stringify({
          contract: WORKBENCH_CONTRACT,
          kind: 'file_change',
          status: 'completed',
          operation: 'created',
          path: relativePath.split(sep).join('/'),
          bytes,
          sha256: createHash('sha256').update(content ?? '', 'utf8').digest('hex'),
        });
      },
    },

    edit_file: {
      description: 'Replace one exact text occurrence in an existing UTF-8 workspace file. Refuses ambiguous or stale edits.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string', description: 'Exact text expected once in the current file' },
          new_text: { type: 'string' },
          expected_sha256: { type: 'string', description: 'Optional SHA-256 precondition for the current file' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
      async execute({ path, old_text, new_text, expected_sha256 }) {
        const { full, relativePath } = resolveWorkbenchPath(root, path);
        if (isPrivateWorkbenchPath(relativePath)) return 'Error: private configuration paths cannot be edited by the agent workbench.';
        assertNoFilesystemLinks(root, relativePath, { allowMissingLeaf: false });
        if (!existsSync(full) || !statSync(full).isFile()) return `Error: file not found: ${relativePath}`;
        if (statSync(full).size > 400_000) return 'Error: file is too large for a controlled exact edit.';
        const before = readFileSync(full, 'utf8');
        const beforeHash = createHash('sha256').update(before, 'utf8').digest('hex');
        if (expected_sha256 && String(expected_sha256).toLowerCase() !== beforeHash) {
          return 'Error: file changed since it was reviewed; SHA-256 precondition did not match.';
        }
        if (!String(old_text ?? '').length) return 'Error: old_text must not be empty.';
        const first = before.indexOf(old_text);
        if (first < 0 || before.indexOf(old_text, first + old_text.length) >= 0) {
          return 'Error: old_text must match exactly once; nothing was changed.';
        }
        const after = `${before.slice(0, first)}${new_text ?? ''}${before.slice(first + old_text.length)}`;
        writeFileSync(full, after, 'utf8');
        return JSON.stringify({
          contract: WORKBENCH_CONTRACT,
          kind: 'file_change',
          status: 'completed',
          operation: 'edited',
          path: relativePath.split(sep).join('/'),
          bytes: Buffer.byteLength(after, 'utf8'),
          beforeSha256: beforeHash,
          sha256: createHash('sha256').update(after, 'utf8').digest('hex'),
        });
      },
    },

    list_dir: {
      description: 'List non-private files and directories under a selected workspace path. Filesystem links are omitted.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory (default .)' },
        },
      },
      async execute({ path = '.' } = {}) {
        const { full, relativePath } = resolveWorkbenchPath(root, path);
        if (isPrivateWorkbenchPath(relativePath)) return 'Error: private configuration paths are not available to the agent workbench.';
        assertNoFilesystemLinks(root, relativePath, { allowMissingLeaf: false });
        if (!existsSync(full)) return `Error: directory not found: ${relativePath}`;
        const entries = readdirSync(full, { withFileTypes: true });
        const visible = entries.filter((entry) => {
          if (entry.isSymbolicLink()) return false;
          const child = relativePath === '.' ? entry.name : join(relativePath, entry.name);
          return !isPrivateWorkbenchPath(child);
        });
        if (visible.length === 0) return `(empty) ${relativePath}`;
        return visible
          .map((e) => `${e.isDirectory() ? '[DIR] ' : '[FILE]'} ${e.name}`)
          .join('\n');
      },
    },

    run_project_task: {
      description:
        'Run one project-declared task by id from workspace_context (package.json script or bounded dotnet build/test). Arbitrary shell text and arguments are not accepted.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          timeout_ms: { type: 'number', description: 'Max wait (default 120000)' },
        },
        required: ['task_id'],
      },
      async execute({ task_id, timeout_ms = 120_000 }, { signal = null } = {}) {
        const command = projectTaskCommand(root, String(task_id ?? ''));
        const timeout = Math.max(1_000, Math.min(Number(timeout_ms) || 120_000, 300_000));
        const execution = await runDirect(command.executable, command.args, root, timeout, signal);
        return JSON.stringify({
          contract: WORKBENCH_CONTRACT,
          kind: 'task_run',
          // 'cancelled' is checked FIRST: a killed task has exitCode null and
          // timedOut false, which the old two-way ternary would have reported as
          // a plain 'failed' — indistinguishable from a task that ran and broke.
          status: execution.cancelled
            ? 'cancelled'
            : execution.exitCode === 0 ? 'completed' : execution.timedOut ? 'timed_out' : 'failed',
          task: command.task,
          exitCode: execution.exitCode,
          timedOut: execution.timedOut,
          output: redactSecrets(execution.output),
          artifacts: discoverWorkbenchArtifacts(root),
        });
      },
    },

    start_project_preview: {
      description:
        'Serve one existing static HTML file or folder from the selected workspace on a random 127.0.0.1 port. '
        + 'Helmian Desktop opens that URL in the right-hand Browser panel (WebView2). '
        + 'One preview per agent session; multi-agent = one-at-a-time in the shared panel. '
        + 'No external bind and no general browser-control API.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative HTML file or directory containing index.html' } },
        required: ['path'],
      },
      async execute({ path }) {
        if (previewServer) await new Promise((done) => previewServer.close(done));
        const started = await startStaticPreview(root, path);
        previewServer = started.server;
        return JSON.stringify(started.result);
      },
    },

    stop_project_preview: {
      description: 'Stop the loopback preview owned by this agent session.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        if (!previewServer) return JSON.stringify({ contract: WORKBENCH_CONTRACT, kind: 'preview', status: 'stopped', alreadyStopped: true });
        await new Promise((done) => previewServer.close(done));
        previewServer = null;
        return JSON.stringify({ contract: WORKBENCH_CONTRACT, kind: 'preview', status: 'stopped', alreadyStopped: false });
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
        const { full, relativePath } = resolveWorkbenchPath(root, path);
        if (isPrivateWorkbenchPath(relativePath)) return 'Error: private configuration paths are not available to the agent workbench.';
        assertNoFilesystemLinks(root, relativePath, { allowMissingLeaf: false });
        const hits = [];
        walk(full, (file) => {
          if (hits.length >= max_hits) return;
          try {
            const rel = relative(root, file);
            if (isPrivateWorkbenchPath(rel)) return;
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
                hits.push(`${rel}:${idx + 1}: ${line.trim().slice(0, 200)}`);
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

  // The committed CLI / `relay --hands` surface remains available only when a
  // caller has not opted into the modern workbench contract. This preserves the
  // explicit legacy proof without exposing arbitrary shell text to the Desktop
  // and account Remote Control paths, which pass safeWorkspaceTools:true.
  const legacyTools = {
    read_file: safeTools.read_file,
    write_file: {
      description: 'Write UTF-8 content to a file under the workspace (creates parent dirs).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      async execute({ path, content }) {
        const full = resolveInWorkspace(path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content ?? '', 'utf8');
        return `Wrote ${Buffer.byteLength(content ?? '', 'utf8')} bytes to ${path}`;
      },
    },
    list_dir: safeTools.list_dir,
    run_command: {
      description: 'Run a shell command in the workspace (legacy explicit CLI/hands surface).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_ms: { type: 'number', description: 'Max wait (default 120000)' },
        },
        required: ['command'],
      },
      async execute({ command, timeout_ms = 120_000 }, { signal = null } = {}) {
        if (!command || !String(command).trim()) return 'Error: empty command';
        return redactSecrets(await runShell(String(command), root, Number(timeout_ms) || 120_000, signal));
      },
    },
    search_text: safeTools.search_text,
  };
  const tools = options.safeWorkspaceTools === true ? safeTools : legacyTools;

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
    async execute(name, args, { signal = null } = {}) {
      // The FIRST gate — before permission, before governance, before approval.
      // Once the user has said stop, the correct number of NEW tool calls to
      // begin is zero, including ones that would otherwise have been allowed.
      if (signal?.aborted) return CANCELLED_TOOL_MESSAGE;
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

      // Re-checked after the gates, deliberately. In 'ask' mode requestApproval
      // waits on a human; a cancel that arrives during that wait must not be
      // overtaken by an approval landing a moment later.
      if (signal?.aborted) return CANCELLED_TOOL_MESSAGE;

      try {
        // The signal is handed to the tool itself so a LONG-RUNNING one can stop
        // mid-flight. Every other tool ignores the second argument, which is why
        // this is additive rather than a signature change across the catalog.
        const result = await tool.execute(callArgs, { signal });
        // Redact secrets from all tool outputs as a final safety net
        return redactSecrets(String(result));
      } catch (err) {
        const errMsg = `Error: ${err.message || String(err)}`;
        return redactSecrets(errMsg);
      }
    },
    async dispose() {
      if (!previewServer) return;
      await new Promise((done) => previewServer.close(done));
      previewServer = null;
    },
  };
}

/**
 * What a tool call returns when the turn was cancelled.
 *
 * Phrased FOR THE MODEL, not for a log. If a cancelled turn is ever resumed the
 * model reads this string as the tool result, and it has to be unambiguous that
 * the work did not happen and that retrying is not the right response — a vague
 * "error" invites an immediate retry of the exact thing the user just stopped.
 */
export const CANCELLED_TOOL_MESSAGE =
  'Cancelled: the user interrupted this turn before this tool ran. Nothing was '
  + 'changed. Do NOT retry it — wait for the next instruction.';

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
    if (e.isSymbolicLink()) continue;
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

/**
 * Kill a spawned child AND its descendants.
 *
 * `child.kill()` terminates only the DIRECT child. On Windows that direct child
 * is `powershell.exe`, so a command which itself spawned something (`npm test`,
 * `dotnet build`) leaves the grandchild running after its parent is gone. That
 * would make "the tool was cancelled" a claim about a process tree still
 * writing to disk, which is the exact lie this whole change exists to remove.
 * `taskkill /T` walks the tree.
 *
 * Best-effort by construction: the process may already have exited, and a kill
 * that fails must never throw into a turn that is being torn down.
 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (process.platform === 'win32' && pid) {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).unref();
      return;
    } catch { /* fall through to the portable path */ }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

/**
 * @param {AbortSignal|null} signal fires when the user cancelled the turn this
 *   task belongs to. The child is killed and the promise settles immediately
 *   rather than waiting for 'close': the caller has stopped caring about the
 *   output, and on Windows a taskkill'd tree can take a moment to reap. What
 *   has to be true the instant the signal fires is that the process was
 *   SIGNALLED, not that it has finished dying.
 */
function runDirect(executable, args, cwd, timeoutMs, signal = null) {
  return new Promise((resolvePromise) => {
    // Checked BEFORE the spawn. Spawning and then killing on the next tick is a
    // race that can leave a real process behind, and the point of the signal is
    // that nothing NEW starts once it has fired.
    if (signal?.aborted) {
      resolvePromise({
        exitCode: null, timedOut: false, cancelled: true,
        output: 'Cancelled before the task started; nothing ran.',
      });
      return;
    }
    const child = spawn(executable, args, { cwd, env: buildSafeEnv(), windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    let onAbort = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      resolvePromise(value);
    };
    timer = setTimeout(() => {
      killTree(child);
      finish({ exitCode: null, timedOut: true, cancelled: false, output: `Task timed out after ${timeoutMs}ms\n${stdout}\n${stderr}` });
    }, timeoutMs);
    if (signal) {
      onAbort = () => {
        killTree(child);
        finish({
          exitCode: null, timedOut: false, cancelled: true,
          output: 'Cancelled by the user while the task was running; the process tree was killed.',
        });
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > 80_000) stdout = `${stdout.slice(0, 80_000)}\n…truncated`;
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 40_000) stderr = `${stderr.slice(0, 40_000)}\n…truncated`;
    });
    child.on('close', (code) => {
      const parts = [];
      if (stdout) parts.push(stdout.trimEnd());
      if (stderr) parts.push(`STDERR:\n${stderr.trimEnd()}`);
      finish({ exitCode: code, timedOut: false, cancelled: false, output: parts.join('\n') || '(no output)' });
    });
    child.on('error', (err) => {
      finish({ exitCode: null, timedOut: false, cancelled: false, output: `Error starting project task: ${err.message}` });
    });
  });
}

/** @param {AbortSignal|null} signal see runDirect — same contract, string result. */
function runShell(command, cwd, timeoutMs, signal = null) {
  return new Promise((resolvePromise) => {
    if (signal?.aborted) {
      resolvePromise('Cancelled before the command started; nothing ran.');
      return;
    }
    const isWin = process.platform === 'win32';
    const child = spawn(
      isWin ? 'powershell.exe' : 'sh',
      isWin ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command],
      { cwd, env: buildSafeEnv(), windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    let onAbort = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      resolvePromise(value);
    };
    timer = setTimeout(() => {
      killTree(child);
      finish(`Error: command timed out after ${timeoutMs}ms\n${stdout}\n${stderr}`);
    }, timeoutMs);
    if (signal) {
      onAbort = () => {
        killTree(child);
        finish('Cancelled by the user while the command was running; the process tree was killed.');
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (data) => {
      stdout += data.toString();
      if (stdout.length > 80_000) stdout = `${stdout.slice(0, 80_000)}\n…truncated`;
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.length > 40_000) stderr = `${stderr.slice(0, 40_000)}\n…truncated`;
    });
    child.on('close', (code) => {
      const parts = [];
      if (stdout) parts.push(stdout.trimEnd());
      if (stderr) parts.push(`STDERR:\n${stderr.trimEnd()}`);
      parts.push(`exit_code=${code}`);
      finish(parts.join('\n') || `(no output) exit_code=${code}`);
    });
    child.on('error', (error) => {
      finish(`Error starting shell: ${error.message}`);
    });
  });
}
