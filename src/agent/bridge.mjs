import { createInterface } from 'node:readline';
import { loadHelmionEnv, parseCustomProviders, resolveProvider } from './env.mjs';
import { createToolRuntime } from './tools.mjs';
import { createSessionState, resetSessionState, runAgentTurn } from './loop.mjs';
import { normalizeTier } from './model-router.mjs';

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
 *
 * Events:
 *   {"event":"hello", ...}
 *   {"event":"ready", ...}
 *   {"event":"status","message":"..."}
 *   {"event":"model","model":"...","tier":"fast|standard|deep","reason":"..."}
 *   {"event":"tool","name":"...","args":{}}
 *   {"event":"tool_result","name":"...","preview":"..."}
 *   {"event":"assistant","text":"..."}
 *   {"event":"error","message":"..."}
 *   {"event":"done"}
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
  let state = createSessionState(workspace, { permissionMode });

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

  const emit = (obj) => {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  };

  const adoptCustomProviders = (req) => {
    if (Array.isArray(req?.customProviders)) {
      customProviders = parseCustomProviders(JSON.stringify(req.customProviders));
      return true;
    }
    return false;
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
    resetSessionState(state, workspace, { permissionMode });
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

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      emit({ event: 'error', message: 'Invalid JSON request line' });
      emit({ event: 'done' });
      continue;
    }

    try {
      const cmd = req.cmd || req.command;
      if (cmd === 'ping') {
        emit({ event: 'pong', t: Date.now() });
        continue;
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
        continue;
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
        continue;
      }
      if (cmd === 'reset') {
        resetSessionState(state, workspace, { permissionMode });
        emit({
          event: 'ready',
          workspace: state.runtime.root,
          permission: state.runtime.permissionMode,
          reset: true,
        });
        continue;
      }
      if (cmd === 'turn') {
        const text = String(req.text || '').trim();
        if (!text) {
          emit({ event: 'error', message: 'turn requires text' });
          emit({ event: 'done' });
          continue;
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
            // Swap tool gate without wiping conversation history.
            state.runtime = createToolRuntime(workspace, { permissionMode });
            state.permissionMode = state.runtime.permissionMode;
          }
        }
        adoptModelRouting(req);
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
        continue;
      }

      emit({ event: 'error', message: `Unknown cmd: ${cmd}` });
      emit({ event: 'done' });
    } catch (err) {
      emit({ event: 'error', message: err.message || String(err) });
      emit({ event: 'done' });
    }
  }
}
