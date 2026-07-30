import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadHelmionEnv, resolveProvider } from './env.mjs';
import { systemPrompt } from './providers.mjs';
import { createToolRuntime, normalizePermissionMode } from './tools.mjs';
import { runAgentTurn } from './loop.mjs';
import { TIERS, normalizeTier, readEnvTier } from './model-router.mjs';
import { normalizeDecision, summarizeToolCall } from './approval.mjs';
import {
  discoverCommands,
  expandCommand,
  formatCommandList,
  parseSlashInput,
  resolveCommand,
} from './commands.mjs';
import { formatPluginReport, loadEnabledPlugins } from './plugins.mjs';

/** Permission modes the CLI accepts by name, in escalation order. */
const PERMISSION_MODES = ['read-only', 'read-tools', 'ask', 'full'];

/**
 * Names the REPL owns. A user command file may not take one: discoverCommands()
 * refuses it and reports the file, so `/exit` cannot be hijacked by dropping an
 * exit.md into a project someone talked you into cloning.
 */
const BUILTIN_COMMANDS = [
  'exit', 'quit', 'help', 'provider', 'workspace', 'permission',
  'clear', 'tier', 'commands', 'reload',
];

/**
 * Interactive coding agent REPL — type in the CLI; the model codes with real tools.
 */
export async function runAgentCli(argv = process.argv.slice(3)) {
  const flags = parseFlags(argv);
  if (flags.help) {
    process.stdout.write(agentHelp());
    return;
  }

  const env = loadHelmionEnv(flags.cwd || process.cwd());
  const workspace = flags.workspace || env.workspace || process.cwd();

  // --tier is a hard override; a typo should say so rather than silently
  // falling through to auto-routing.
  let tierOverride = null;
  if (flags.tier) {
    tierOverride = normalizeTier(flags.tier);
    if (!tierOverride) {
      process.stderr.write(
        `Helmion agent: unknown --tier "${flags.tier}". Use: ${TIERS.join(' | ')}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }
  const modelOverride = flags.model || null;

  // --endpoint declares a custom OpenAI-compatible provider inline, without needing
  // it saved in HELMION_CUSTOM_PROVIDERS or the desktop Settings page.
  const inlineCustom = flags.endpoint
    ? [{
      name: flags.provider || 'custom',
      baseUrl: flags.endpoint,
      apiKey: flags.apiKey || '',
      model: flags.model || flags.provider || 'custom',
    }]
    : [];

  let provider = resolveProvider(flags.provider || env.maestro, env, inlineCustom);

  if (!provider.key) {
    process.stderr.write(
      `Helmion agent: no API key for ${provider.label}.\n`
      + `Set the matching key in .env (walk-up from cwd) or environment:\n`
      + `  openai → OPENAI_API_KEY\n`
      + `  claude → ANTHROPIC_API_KEY\n`
      + `  gemini → GEMINI_API_KEY\n`
      + `  grok   → XAI_API_KEY\n`
      + `  custom → HELMION_CUSTOM_PROVIDERS, or --endpoint <url> [--api-key <key>]\n`,
    );
    process.exitCode = 1;
    return;
  }

  // CLI agent defaults to full tools (read + write + run_command).
  // Desktop EXE has explicit permission dropdown; CLI should work out of the box.
  // --permission ask puts a human in front of every individual tool call.
  let permissionMode = 'full';
  if (flags.permission) {
    const resolved = resolvePermissionFlag(flags.permission);
    if (!resolved) {
      // An unknown word normalizes to read-only, which is safer than asked for
      // but not what was asked for. Say so rather than silently substituting.
      process.stderr.write(
        `Helmion agent: unknown --permission "${flags.permission}". `
        + `Use: ${PERMISSION_MODES.join(' | ')}\n`,
      );
      process.exitCode = 1;
      return;
    }
    permissionMode = resolved;
  }

  // One readline interface for the whole session, shared by the REPL prompt and
  // by approval questions. Created lazily so the one-shot paths do not open one
  // they never use.
  let rl = null;
  const ensureInterface = () => {
    if (!rl) rl = createInterface({ input, output, terminal: true });
    return rl;
  };
  const closeInterface = () => {
    if (!rl) return;
    try { rl.close(); } catch { /* already closed */ }
    rl = null;
  };

  /**
   * Ask the human at the terminal. A non-TTY stdin cannot answer, so it DENIES
   * rather than auto-allowing — piping a prompt into the agent must never
   * silently grant it write and shell access.
   */
  const cliApprover = async ({ tool, args, workspace: ws }) => {
    if (!input.isTTY) {
      process.stderr.write(
        `\n[approval] DENIED ${tool} — stdin is not a terminal, so nobody can approve it.\n`,
      );
      return 'deny';
    }
    process.stdout.write(
      `\n  ⚠ APPROVAL NEEDED\n`
      + `    ${summarizeToolCall(tool, args)}\n`
      + `    workspace: ${ws}\n`,
    );
    let answer;
    try {
      answer = await ensureInterface().question('    Allow?  [y] once  [s] session  [n] deny: ');
    } catch {
      return 'deny';
    }
    const decision = normalizeDecision(answer);
    process.stdout.write(`    → ${decision}\n`);
    return decision;
  };

  const runtimeOptions = () => ({
    permissionMode,
    approver: permissionMode === 'ask' ? cliApprover : undefined,
  });

  let runtime = createToolRuntime(workspace, runtimeOptions());
  const messages = [
    { role: 'system', content: systemPrompt(runtime.root) },
  ];

  // Commands are discovered BEFORE the one-shot and stdin paths, not just for
  // the REPL, so `helmion agent -p "/deploy staging"` expands the same file the
  // REPL would run. Plugins load first; their commands join the same registry,
  // namespaced by plugin name. Loading reads markdown and JSON only — it never
  // executes anything a plugin ships, and any MCP server a plugin declares is
  // refused unless the install ledger already approved that exact code.
  let loadedPlugins = [];
  let commandRegistry = {
    commands: new Map(), aliases: new Map(), list: [],
    shadowedBuiltins: [], overridden: [], errors: [],
  };
  const refreshCommands = async () => {
    const { plugins, errors } = await loadEnabledPlugins({ workspace: runtime.root });
    loadedPlugins = plugins;
    commandRegistry = await discoverCommands({
      workspace: runtime.root,
      builtins: BUILTIN_COMMANDS,
      plugins,
    });
    return { errors };
  };
  const { errors: pluginErrors } = await refreshCommands();

  /**
   * Expand "/name args" against the registry. Returns null when the text is not
   * a known command, so each caller decides what that means: the REPL says so
   * and stops, while the one-shot paths pass the text through to the model.
   */
  const expandIfCommand = (raw) => {
    const parsed = parseSlashInput(raw);
    if (!parsed) return null;
    const cmd = resolveCommand(commandRegistry, parsed.name);
    if (!cmd) return null;
    return {
      cmd,
      text: expandCommand(cmd.body, parsed.rawArgs, { argumentNames: cmd.argumentNames }),
    };
  };

  process.stdout.write(
    `Helmion coding agent\n`
    + `  provider:  ${provider.label} (${provider.id})\n`
    + (provider.url
      ? `  endpoint:  ${provider.url} · ${provider.models
        ? `tiers ${TIERS.map((t) => `${t}=${provider.models[t] || provider.model}`).join(', ')}`
        : `model ${provider.model}`}\n`
      : '')
    + `  workspace: ${runtime.root}\n`
    + `  model:     ${describeModelMode({ modelOverride, tierOverride })}\n`
    + `  perms:     ${describePermissionMode(runtime.permissionMode, input.isTTY)}\n`
    + `  tools:     ${Object.keys(runtime.tools).join(', ') || '(none)'}\n`
    + `  quit:      /exit  |  /help\n\n`,
  );

  if (commandRegistry.list.length || loadedPlugins.length) {
    process.stdout.write(
      `  commands:  ${commandRegistry.list.length} user-defined`
      + `${loadedPlugins.length ? ` · ${loadedPlugins.length} plugin(s)` : ''} — /help to list\n`,
    );
  }
  // Refusals and shadowed built-ins are announced at startup, never buried.
  for (const p of loadedPlugins) {
    for (const s of p.refusals) {
      process.stdout.write(`  ! plugin "${p.name}" MCP server "${s.name}" REFUSED — ${s.reason}\n`);
    }
    for (const w of p.warnings) process.stdout.write(`  ! plugin "${p.name}": ${w}\n`);
  }
  for (const s of commandRegistry.shadowedBuiltins) {
    process.stdout.write(`  ! ${s.path} is IGNORED — /${s.name} is a built-in command.\n`);
  }
  for (const e of pluginErrors) process.stdout.write(`  ! plugin ${e.name ?? '?'}: ${e.message}\n`);
  if (commandRegistry.list.length || loadedPlugins.length) process.stdout.write('\n');

  if (flags.prompt) {
    const hit = expandIfCommand(flags.prompt);
    if (hit) process.stdout.write(`[${hit.cmd.name}] ${hit.cmd.path}\n`);
    try {
      await runTurn({
        userText: hit ? hit.text : flags.prompt,
        messages,
        provider,
        runtime,
        tier: tierOverride,
        modelOverride: modelOverride || hit?.cmd.model || null,
      });
    } finally {
      closeInterface();
    }
    return;
  }

  if (!input.isTTY) {
    let raw = '';
    for await (const chunk of input) raw += chunk;
    const text = raw.trim();
    if (!text) {
      process.stderr.write('No prompt on stdin.\n');
      process.exitCode = 1;
      return;
    }
    const hit = expandIfCommand(text);
    if (hit) process.stdout.write(`[${hit.cmd.name}] ${hit.cmd.path}\n`);
    await runTurn({
      userText: hit ? hit.text : text,
      messages,
      provider,
      runtime,
      tier: tierOverride,
      modelOverride: modelOverride || hit?.cmd.model || null,
    });
    return;
  }

  const repl = ensureInterface();

  try {
    while (true) {
      const line = (await repl.question('helmion> ')).trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      if (line === '/help') {
        process.stdout.write(agentHelp());
        process.stdout.write(`Your commands (${commandRegistry.list.length}):\n`);
        process.stdout.write(formatCommandList(commandRegistry));
        continue;
      }
      if (line === '/commands') {
        process.stdout.write(`Your commands (${commandRegistry.list.length}):\n`);
        process.stdout.write(formatCommandList(commandRegistry));
        process.stdout.write(`Plugins:\n${formatPluginReport(loadedPlugins)}`);
        continue;
      }
      if (line === '/reload') {
        // Picks up a command file you just wrote, without restarting the REPL.
        await refreshCommands();
        process.stdout.write(
          `Reloaded — ${commandRegistry.list.length} command(s), ${loadedPlugins.length} plugin(s).\n`,
        );
        continue;
      }
      if (line.startsWith('/provider ')) {
        try {
          const next = resolveProvider(line.slice(10).trim(), env, inlineCustom);
          if (!next.key) {
            process.stdout.write(`No key for ${next.label}\n`);
          } else {
            provider = next;
            process.stdout.write(`Provider → ${provider.label}\n`);
          }
        } catch (err) {
          process.stdout.write(`${err.message}\n`);
        }
        continue;
      }
      if (line.startsWith('/workspace ')) {
        const next = line.slice(11).trim();
        runtime = createToolRuntime(next, runtimeOptions());
        messages[0] = { role: 'system', content: systemPrompt(runtime.root) };
        messages.length = 1;
        process.stdout.write(`Workspace → ${runtime.root}\n`);
        // Project commands are workspace-scoped, so the registry follows.
        await refreshCommands();
        continue;
      }
      if (line === '/permission' || line.startsWith('/permission ')) {
        const arg = line.slice(11).trim();
        if (!arg) {
          process.stdout.write(
            `Permissions → ${describePermissionMode(runtime.permissionMode, input.isTTY)}\n`,
          );
          continue;
        }
        const next = resolvePermissionFlag(arg);
        if (!next) {
          process.stdout.write(`Unknown permission "${arg}". Use: ${PERMISSION_MODES.join(' | ')}\n`);
          continue;
        }
        permissionMode = next;
        // A fresh runtime is what drops any allow-for-session grants, so the
        // grants can never outlive the mode they were given under.
        runtime = createToolRuntime(runtime.root, runtimeOptions());
        process.stdout.write(
          `Permissions → ${describePermissionMode(runtime.permissionMode, input.isTTY)}\n`
          + `Tools → ${Object.keys(runtime.tools).join(', ') || '(none)'}\n`,
        );
        continue;
      }
      if (line === '/clear') {
        messages.length = 1;
        process.stdout.write('Conversation cleared.\n');
        continue;
      }
      if (line === '/tier' || line.startsWith('/tier ')) {
        const arg = line.slice(5).trim().toLowerCase();
        if (!arg) {
          process.stdout.write(`Tier → ${describeModelMode({ modelOverride, tierOverride })}\n`);
        } else if (arg === 'auto') {
          tierOverride = null;
          process.stdout.write('Tier → auto (router picks per task)\n');
        } else {
          const next = normalizeTier(arg);
          if (!next) {
            process.stdout.write(`Unknown tier "${arg}". Use: auto | ${TIERS.join(' | ')}\n`);
          } else {
            tierOverride = next;
            process.stdout.write(`Tier → ${next} (pinned)\n`);
          }
        }
        continue;
      }

      // User-defined slash commands. Deliberately AFTER every built-in above,
      // so a file on disk can never take a name the REPL already owns.
      if (line.startsWith('/')) {
        const hit = expandIfCommand(line);
        if (!hit) {
          const parsed = parseSlashInput(line);
          // An unrecognized slash line is NOT sent to the model as a prompt: a
          // typo'd /deploy silently becoming chat is how you think a command
          // ran when it never did.
          process.stdout.write(
            `Unknown command "${parsed ? `/${parsed.name}` : line}". `
            + `/help lists every command, /reload picks up a file you just added.\n`,
          );
          continue;
        }
        process.stdout.write(`[${hit.cmd.name}] ${hit.cmd.path}\n`);
        try {
          await runTurn({
            userText: hit.text,
            messages,
            provider,
            runtime,
            tier: tierOverride,
            // A command may pin its own model; an explicit --model still wins.
            modelOverride: modelOverride || hit.cmd.model || null,
          });
        } catch (err) {
          process.stdout.write(`\n[agent error] ${err.message}\n`);
        }
        continue;
      }

      try {
        await runTurn({
          userText: line,
          messages,
          provider,
          runtime,
          tier: tierOverride,
          modelOverride,
        });
      } catch (err) {
        process.stdout.write(`\n[agent error] ${err.message}\n`);
      }
    }
  } finally {
    closeInterface();
  }
}

async function runTurn({ userText, messages, provider, runtime, tier, modelOverride }) {
  await runAgentTurn({
    userText,
    messages,
    provider,
    runtime,
    tier,
    modelOverride,
    onEvent: (ev) => {
      if (ev.type === 'model') {
        process.stdout.write(`\n[model] ${ev.model || 'provider default'} · ${ev.tier} — ${ev.reason}\n`);
      } else if (ev.type === 'provenance') {
        // What ANSWERED, as opposed to the [model] line above, which is what
        // the router intended before the request went out. Printed only when a
        // local model answered: that is the case nobody could see on
        // 2026-07-30, and printing it every turn would bury it again.
        if (ev.isLocal) {
          process.stdout.write(
            `\n[answered by a LOCAL model on this machine: ${ev.model} @ ${ev.endpointHost}]\n`,
          );
        }
      } else if (ev.type === 'status') {
        process.stdout.write(`\n[${ev.message}]\n`);
      } else if (ev.type === 'tool') {
        process.stdout.write(`  → ${ev.name}(${summarizeArgs(ev.args)})\n`);
      } else if (ev.type === 'tool_result') {
        process.stdout.write(`  ← ${ev.preview || ''}\n`);
      } else if (ev.type === 'assistant') {
        process.stdout.write(`\n${ev.text}\n\n`);
      } else if (ev.type === 'assistant_partial') {
        process.stdout.write(`${ev.text}\n`);
      }
    },
  });
}

/**
 * Resolve a --permission / /permission argument, or null when it is not a mode
 * we recognize. Distinguishes "unknown word" from "deliberately read-only",
 * which normalizePermissionMode alone cannot do (it maps both to read-only).
 */
export function resolvePermissionFlag(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  const normalized = normalizePermissionMode(s);
  if (normalized !== 'read-only') return normalized;
  const readOnlyAliases = ['read-only', 'readonly', 'chat', 'off', 'none'];
  return readOnlyAliases.includes(s) ? 'read-only' : null;
}

/** Human-readable permission line for the CLI banner. */
function describePermissionMode(mode, isTty) {
  switch (mode) {
    case 'ask':
      return isTty
        ? 'ask — every tool call needs your y/s/n approval'
        : 'ask — NO TERMINAL to ask on, so every tool call will be denied';
    case 'full':
      return 'full — write_file + run_command run without asking';
    case 'read-tools':
      return 'read-tools — read/search only, writes and shell blocked';
    default:
      return 'read-only — chat only, no tools';
  }
}

/** One-line description of which link in the override chain is currently active. */
function describeModelMode({ modelOverride, tierOverride }) {
  if (modelOverride) return `${modelOverride} (pinned via --model)`;
  if (tierOverride) return `${tierOverride} tier (pinned via --tier)`;
  const fromEnv = readEnvTier();
  if (fromEnv) return `${fromEnv} tier (HELMION_MODEL_TIER)`;
  return 'auto — router picks fast/standard/deep per task';
}

function summarizeArgs(args) {
  try {
    const s = JSON.stringify(args ?? {});
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  } catch {
    return '{}';
  }
}

function parseFlags(argv) {
  const out = {
    prompt: null,
    provider: null,
    workspace: null,
    endpoint: null,
    apiKey: null,
    model: null,
    tier: null,
    permission: null,
    cwd: process.cwd(),
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-p' || a === '--prompt') out.prompt = argv[++i];
    else if (a === '--provider') out.provider = argv[++i];
    else if (a === '--workspace') out.workspace = argv[++i];
    else if (a === '--endpoint') out.endpoint = argv[++i];
    else if (a === '--api-key') out.apiKey = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--tier') out.tier = argv[++i];
    else if (a === '--permission' || a === '--permissions') out.permission = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('-') && !out.prompt) out.prompt = a;
  }
  return out;
}

function agentHelp() {
  return `Helmion coding agent — real tools on your disk

Usage:
  helmion agent
  helmion agent --provider grok
  helmion agent --workspace E:\\Helmion -p "list sql migrations"
  helmion chat                  # alias of agent

Custom OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, DeepSeek, …):
  helmion agent --provider my-local --endpoint http://localhost:11434/v1 -p "hi"
  helmion agent --provider my-local --endpoint <url> --api-key <key> --model <id>
  …or save them once in HELMION_CUSTOM_PROVIDERS / the desktop Settings page:
  HELMION_CUSTOM_PROVIDERS='[{"name":"my-local","baseUrl":"http://…/v1","apiKey":"","model":"qwen"}]'

Per-task model switching (on by default):
  Trivial turns run on the cheap model, ordinary coding on the standard one, and
  hard reasoning (root cause, architecture, long prompts, or a turn that has
  already burned many tool rounds) on the deep one. A turn only ever escalates.

  --tier fast|standard|deep   pin one tier for the session
  --model <id>                pin an exact model, bypassing the router
  HELMION_MODEL_TIER=auto|fast|standard|deep   (default auto)
  Precedence: --model > --tier > HELMION_MODEL_TIER > router

  Custom endpoints opt in by declaring per-tier models; a profile with a single
  model keeps that model on every tier:
  HELMION_CUSTOM_PROVIDERS='[{"name":"my-local","baseUrl":"http://…/v1",
    "models":{"fast":"qwen2.5:3b","standard":"qwen2.5:14b","deep":"qwen2.5:32b"}}]'

Permissions (same four tiers as the desktop dropdown, every provider):
  --permission read-only     chat only, no tools
  --permission read-tools    read_file, list_dir, search_text
  --permission ask           ALWAYS ASK — every single tool call needs your
                             approval first: [y] once, [s] rest of session, [n] deny
  --permission full          default for the CLI: writes + shell without asking

  Ask mode fails closed. A denied call does not run. If stdin is not a terminal
  (piped prompt, script, CI) nothing can answer, so every call is denied — there
  is no flag or environment variable that approves on your behalf.
  HELMION_ASK_TIMEOUT_MS sets how long a question waits before denying (default
  300000).

In the REPL:
  /provider openai|claude|gemini|grok|<custom name>
  /tier auto|fast|standard|deep
  /permission read-only|read-tools|ask|full     (clears any session approvals)
  /workspace <path>
  /commands                     # your commands + plugins, with descriptions
  /reload                       # re-read command files after editing one
  /clear
  /exit

Your own slash commands (markdown, same format as Claude Code's):
  .helmion/commands/<name>.md          this project      → /<name>
  ~/.helmion/commands/<name>.md        every project     → /<name>
  .helmion/commands/<dir>/<name>.md    namespaced        → /<dir>:<name>
  Frontmatter: description, argument-hint, arguments, allowed-tools, model,
  user-invocable. In the body $ARGUMENTS is everything typed; $0 is the first
  argument and $1 the second (0-based, as documented); $name uses "arguments:".
  Built-ins above cannot be overridden — a file that tries is listed as IGNORED.
  Plugins: helmion plugin add <local-dir>  → /<plugin>:<name>

Tools: read_file, write_file, list_dir, run_command, search_text
Keys: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, XAI_API_KEY
`;
}
