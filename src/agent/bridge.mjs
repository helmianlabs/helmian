import { createInterface } from 'node:readline';
import { loadHelmionEnv, parseCustomProviders, resolveProvider } from './env.mjs';
import { createToolRuntime } from './tools.mjs';
import { createSessionState, resetSessionState, runAgentTurn } from './loop.mjs';
import { normalizeTier } from './model-router.mjs';
import { createApprovalBroker, resolveAskTimeoutMs } from './approval.mjs';
import {
  discoverCommands,
  expandCommand,
  parseSlashInput,
  resolveCommand,
  serializeRegistry,
} from './commands.mjs';
import { loadEnabledPlugins } from './plugins.mjs';

/**
 * NDJSON bridge for the Windows Pilot EXE.
 * One long-lived process; one JSON request per line on stdin; events on stdout.
 *
 * Requests:
 *   {"cmd":"hello"}
 *   {"cmd":"configure","workspace":"E:\\Helmion","provider":"openai","tier":"auto"}
 *   {"cmd":"turn","text":"list sql files"}
 *   {"cmd":"turn","text":"…","tier":"deep"}      // pin one tier for this turn on
 *   {"cmd":"turn","text":"…","model":"grok-4.5"} // …or pin an exact model
 *   {"cmd":"reset"}
 *   {"cmd":"ping"}
 *   {"cmd":"commands"}                            // list user commands + plugins
 *   {"cmd":"expand","text":"/deploy staging"}     // preview, without a turn
 *   {"cmd":"permission_response","id":"perm-1-…","decision":"allow-once"}
 *
 * Events:
 *   {"event":"hello", ...}
 *   {"event":"ready", ...}
 *   {"event":"status","message":"..."}
 *   {"event":"model","model":"...","tier":"fast|standard|deep","reason":"..."}
 *      — the router's CHOICE, emitted BEFORE the request goes out.
 *   {"event":"provenance","model":"…","provider":"claude|openai|gemini|grok|local",
 *    "endpointHost":"…","isLocal":false,"sessionId":"…"}
 *      — what ACTUALLY answered, emitted after the response arrived and after
 *        the row was written to .helmion/audit/provenance-*.jsonl. When a
 *        fallback fires, this and the `model` event above disagree, and THIS
 *        one is the true statement. Anything showing the user "which model" is
 *        talking to them should render this, not `model`.
 *   {"event":"tool","name":"...","args":{}}
 *   {"event":"tool_result","name":"...","preview":"..."}
 *   {"event":"permission_request","id":"…","tool":"…","summary":"…","timeoutMs":N}
 *   {"event":"permission_decision","id":"…","tool":"…","decision":"…","source":"…"}
 *   {"event":"commands","commands":[…],"plugins":[…],"shadowedBuiltins":[…]}
 *   {"event":"expanded","ok":true,"name":"…","path":"…","text":"…"}
 *   {"event":"command","name":"…","path":"…"}   // a turn began as a slash command
 *   {"event":"assistant","text":"..."}
 *   {"event":"error","message":"..."}
 *   {"event":"done"}
 *
 * `permission_response` is handled OUT OF BAND — it never queues behind the
 * turn that is waiting for it, which would deadlock that turn until its
 * approval timed out.
 */
export async function runAgentBridge() {
  const env = loadHelmionEnv(process.cwd());
  let workspace = env.workspace || process.cwd();
  let providerName = env.maestro || 'Gemini';
  let permissionMode = env.permissionMode || process.env.HELMION_PERMISSION_MODE || 'read-only';
  let provider = null;
  // User-defined OpenAI-compatible endpoints. Seeded from HELMION_CUSTOM_PROVIDERS,
  // then replaced whenever the desktop sends a fresher list on configure/turn.
  let customProviders = env.customProviders || [];
  // Per-task model routing overrides from the desktop. Both default to unset,
  // which leaves the router in auto mode.
  let tierOverride = null;
  let modelOverride = null;

  const emit = (obj) => {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  };

  // Human-in-the-loop approval for 'ask' mode. The broker is the only source of
  // an allow: it hands out ids and waits for a matching permission_response.
  const broker = createApprovalBroker({ emit, timeoutMs: resolveAskTimeoutMs() });

  // Every runtime the bridge builds gets the same approval wiring. Rebuilding a
  // runtime (permission change, reset, workspace change) drops session grants,
  // which is exactly the required behaviour.
  const runtimeOptions = () => ({
    permissionMode,
    approver: broker.approver,
    approvalTimeoutMs: broker.timeoutMs,
  });

  const state = createSessionState(workspace, runtimeOptions());

  // Same command discovery the REPL uses, so the Pilot lists exactly what the
  // CLI would run. Reads markdown and JSON only; a plugin's MCP declaration is
  // refused here for the same reason it is refused there.
  let commandRegistry = null;
  let loadedPlugins = [];
  const refreshCommands = async () => {
    const { plugins } = await loadEnabledPlugins({ workspace: state.runtime.root });
    loadedPlugins = plugins;
    commandRegistry = await discoverCommands({
      workspace: state.runtime.root,
      builtins: [],
      plugins,
    });
    return commandRegistry;
  };
  await refreshCommands().catch(() => { commandRegistry = null; });

  /**
   * Turn "/name args" into the command's expanded body. Returns null when the
   * text is not a known command, so the caller can decide — the bridge sends
   * an unknown slash line through as an ordinary prompt rather than failing a
   * turn the desktop may not have meant as a command at all.
   */
  const expandBridgeCommand = (raw) => {
    if (!commandRegistry) return null;
    const parsed = parseSlashInput(raw);
    if (!parsed) return null;
    const cmd = resolveCommand(commandRegistry, parsed.name);
    if (!cmd) return null;
    return {
      name: cmd.name,
      path: cmd.path,
      text: expandCommand(cmd.body, parsed.rawArgs, { argumentNames: cmd.argumentNames }),
    };
  };

  // 'auto' / empty clears the override; an unknown value is ignored rather than
  // failing the turn, since the router has a safe default either way.
  const adoptModelRouting = (req) => {
    if ('tier' in (req || {})) {
      const raw = String(req.tier ?? '').trim().toLowerCase();
      tierOverride = !raw || raw === 'auto' ? null : (normalizeTier(raw) ?? tierOverride);
    }
    if ('model' in (req || {})) {
      const raw = String(req.model ?? '').trim();
      modelOverride = raw && raw.toLowerCase() !== 'auto' ? raw : null;
    }
  };

  // Whether the desktop is managing the custom-endpoint list. When it is, its
  // list is authoritative and a .env re-read must not override it; when it is
  // not, .env is the only source and has to be re-read to see edits.
  let customProvidersFromDesktop = false;

  const adoptCustomProviders = (req) => {
    if (Array.isArray(req?.customProviders)) {
      customProviders = parseCustomProviders(JSON.stringify(req.customProviders));
      customProvidersFromDesktop = true;
      return true;
    }
    return false;
  };

  /**
   * Pick up an API key the user fixed in .env mid-session.
   *
   * A Windows child process receives its environment at spawn and never again,
   * so the desktop stamping a corrected key into its OWN environment cannot
   * reach this process — re-reading .env here is the only channel that can.
   * Rebuild the provider ONLY when the resolved key actually changed:
   * reconfigure() calls resetSessionState, so doing this unconditionally would
   * wipe the conversation on every message.
   */
  const refreshProviderKeyFromEnv = () => {
    if (!provider?.key) return;
    try {
      const envNow = loadHelmionEnv(workspace);
      const pool = customProvidersFromDesktop ? customProviders : envNow.customProviders;
      const refreshed = resolveProvider(providerName, envNow, pool);
      // Only a real, non-empty, different key swaps. A key deleted from .env
      // leaves the working provider alone rather than killing a live session.
      if (refreshed?.key && refreshed.key !== provider.key) {
        provider = refreshed;
        emit({
          event: 'status',
          message: `Picked up an updated ${provider.label} API key from .env.`,
        });
      }
    } catch {
      // An unreadable or half-saved .env must never fail the turn.
    }
  };

  const reconfigure = () => {
    const envNow = loadHelmionEnv(workspace);
    provider = resolveProvider(providerName, envNow, customProviders);
    if (!provider.key) {
      throw new Error(
        `No API key for ${provider.label}. Save keys in Settings / .env `
        + `(OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, XAI_API_KEY).`,
      );
    }
    resetSessionState(state, workspace, runtimeOptions());
  };

  try {
    reconfigure();
  } catch (err) {
    // Still start; configure/turn will surface the error.
    emit({
      event: 'hello',
      ok: false,
      message: err.message,
      workspace,
      provider: providerName,
      tools: Object.keys(state.runtime.tools),
    });
  }

  if (provider?.key) {
    emit({
      event: 'hello',
      ok: true,
      workspace: state.runtime.root,
      provider: provider.label,
      providerId: provider.id,
      endpoint: provider.url || null,
      permission: state.runtime.permissionMode,
      tools: Object.keys(state.runtime.tools),
    });
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  /** One command, start to finish. Commands stay strictly serialized. */
  async function handleCommand(req) {
    try {
      const cmd = req.cmd || req.command;
      if (cmd === 'ping') {
        emit({ event: 'pong', t: Date.now() });
        return;
      }
      if (cmd === 'hello') {
        emit({
          event: 'hello',
          ok: Boolean(provider?.key),
          workspace: state.runtime.root,
          provider: provider?.label || providerName,
          providerId: provider?.id || null,
          permission: state.runtime.permissionMode,
          tools: Object.keys(state.runtime.tools),
        });
        return;
      }
      if (cmd === 'configure') {
        if (req.workspace) workspace = String(req.workspace);
        if (req.provider) providerName = String(req.provider);
        if (req.permission || req.permissionMode) {
          permissionMode = String(req.permission || req.permissionMode);
        }
        adoptCustomProviders(req);
        adoptModelRouting(req);
        reconfigure();
        // Project commands are workspace-scoped, so a new workspace means a
        // new registry. A discovery failure must not fail the configure.
        await refreshCommands().catch(() => {});
        emit({
          event: 'ready',
          workspace: state.runtime.root,
          provider: provider.label,
          providerId: provider.id,
          endpoint: provider.url || null,
          permission: state.runtime.permissionMode,
          tier: tierOverride || 'auto',
          model: modelOverride || null,
          tools: Object.keys(state.runtime.tools),
        });
        return;
      }
      if (cmd === 'reset') {
        // Anything still waiting on a human is failed closed before the reset.
        broker.denyAllPending('reset');
        resetSessionState(state, workspace, runtimeOptions());
        emit({
          event: 'ready',
          workspace: state.runtime.root,
          permission: state.runtime.permissionMode,
          reset: true,
        });
        return;
      }
      if (cmd === 'commands') {
        // Listing must never be stale: the Pilot may be showing a picker.
        await refreshCommands();
        emit({
          event: 'commands',
          workspace: state.runtime.root,
          ...serializeRegistry(commandRegistry),
          plugins: loadedPlugins.map((p) => ({
            name: p.name,
            root: p.root,
            version: p.version,
            commands: Boolean(p.commandsDir),
            approvedMcpServers: p.registrations.map((s) => s.name),
            refusedMcpServers: p.refusals.map((s) => ({ name: s.name, reason: s.reason })),
            warnings: p.warnings,
          })),
        });
        return;
      }
      if (cmd === 'expand') {
        // Preview what a command would send, without running a turn.
        const hit = expandBridgeCommand(String(req.text || '').trim());
        if (!hit) {
          emit({ event: 'expanded', ok: false, message: 'No such command.' });
          return;
        }
        emit({ event: 'expanded', ok: true, name: hit.name, path: hit.path, text: hit.text });
        return;
      }
      if (cmd === 'turn') {
        // A slash line is expanded before anything else reads req.text. An
        // unknown one is left alone and goes to the model as typed.
        if (typeof req.text === 'string' && req.text.trim().startsWith('/')) {
          const hit = expandBridgeCommand(req.text.trim());
          if (hit) {
            emit({ event: 'command', name: hit.name, path: hit.path });
            req.text = hit.text;
          }
        }
        const text = String(req.text || '').trim();
        if (!text) {
          emit({ event: 'error', message: 'turn requires text' });
          emit({ event: 'done' });
          return;
        }
        let needsFullReset = false;
        if (req.workspace && String(req.workspace) !== workspace) {
          workspace = String(req.workspace);
          needsFullReset = true;
        }
        if (req.provider && String(req.provider) !== providerName) {
          providerName = String(req.provider);
          needsFullReset = true;
        }
        // A saved/edited custom endpoint must reach the resolver before it is used.
        const previousCustom = JSON.stringify(customProviders);
        if (adoptCustomProviders(req) && JSON.stringify(customProviders) !== previousCustom) {
          needsFullReset = true;
        }
        if (req.permission || req.permissionMode) {
          const nextPerm = String(req.permission || req.permissionMode);
          if (nextPerm !== permissionMode) {
            permissionMode = nextPerm;
            // Swap tool gate without wiping conversation history. A fresh
            // runtime also drops every allow-for-session grant, so leaving ask
            // mode can never leave a standing approval behind.
            state.runtime = createToolRuntime(workspace, runtimeOptions());
            state.permissionMode = state.runtime.permissionMode;
          }
        }
        adoptModelRouting(req);
        // Before deciding whether to rebuild: a stale-but-non-empty key makes
        // both conditions below false, so without this the corrected .env key
        // would never be read and every turn would keep 401-ing.
        if (!needsFullReset) refreshProviderKeyFromEnv();
        if (needsFullReset || !provider?.key) reconfigure();

        await runAgentTurn({
          userText: text,
          messages: state.messages,
          provider,
          runtime: state.runtime,
          tier: tierOverride,
          modelOverride,
          onEvent: (ev) => {
            if (ev.type === 'model') {
              emit({
                event: 'model',
                model: ev.model,
                tier: ev.tier,
                reason: ev.reason,
                round: ev.round,
                provider: ev.provider,
                providerId: ev.providerId,
              });
            } else if (ev.type === 'provenance') {
              // WHAT ANSWERED, not what was going to. The 'model' event above
              // fires before the request leaves, so it reports an intention; on
              // 2026-07-30 an intention on screen ("Qwen 3.5") was all Troy had
              // while something else did the answering. This one carries the row
              // written to .helmion/audit/provenance-*.jsonl once the response
              // arrived, so a header rendering it is rendering evidence.
              emit({
                event: 'provenance',
                model: ev.model,
                provider: ev.provider,
                providerId: ev.providerId,
                providerLabel: ev.providerLabel,
                endpointHost: ev.endpointHost,
                isLocal: ev.isLocal,
                tier: ev.tier,
                round: ev.round,
                timestamp: ev.timestamp,
                sessionId: ev.sessionId,
              });
            } else if (ev.type === 'status') emit({ event: 'status', message: ev.message });
            else if (ev.type === 'tool') {
              emit({ event: 'tool', name: ev.name, args: ev.args });
            } else if (ev.type === 'tool_result') {
              emit({
                event: 'tool_result',
                name: ev.name,
                preview: ev.preview,
                bytes: ev.bytes,
              });
            } else if (ev.type === 'assistant' || ev.type === 'assistant_partial') {
              emit({ event: 'assistant', text: ev.text, partial: ev.type === 'assistant_partial' });
            } else if (ev.type === 'done') {
              emit({ event: 'done' });
            }
          },
        });
        return;
      }

      emit({ event: 'error', message: `Unknown cmd: ${cmd}` });
      emit({ event: 'done' });
    } catch (err) {
      emit({ event: 'error', message: err.message || String(err) });
      emit({ event: 'done' });
    }
  }

  // Commands run one at a time, in arrival order, exactly as the previous
  // for-await loop did. Approval answers deliberately bypass this queue.
  let queue = Promise.resolve();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      emit({ event: 'error', message: 'Invalid JSON request line' });
      emit({ event: 'done' });
      return;
    }

    const cmd = String(req.cmd || req.command || '');
    if (cmd === 'permission_response') {
      // Must not queue: the turn that asked is blocked waiting for this answer.
      if (!broker.handleResponse(req)) {
        emit({
          event: 'permission_unknown',
          id: typeof req?.id === 'string' ? req.id : null,
          message: 'No pending approval with that id (already decided, timed out, or unknown).',
        });
      }
      return;
    }

    queue = queue.then(() => handleCommand(req)).catch((err) => {
      emit({ event: 'error', message: err?.message || String(err) });
      emit({ event: 'done' });
    });
  });

  await new Promise((resolveClose) => rl.once('close', resolveClose));
  // stdin is gone: nobody can answer an approval any more, so fail them closed.
  broker.denyAllPending('shutdown');
  await queue;
}
