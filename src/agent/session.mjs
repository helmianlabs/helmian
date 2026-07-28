import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadHelmionEnv, resolveProvider } from './env.mjs';
import { systemPrompt } from './providers.mjs';
import { createToolRuntime } from './tools.mjs';
import { runAgentTurn } from './loop.mjs';
import { TIERS, normalizeTier, readEnvTier } from './model-router.mjs';

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
  let runtime = createToolRuntime(workspace, { permissionMode: 'full' });
  const messages = [
    { role: 'system', content: systemPrompt(runtime.root) },
  ];

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
    + `  tools:     ${Object.keys(runtime.tools).join(', ')}\n`
    + `  quit:      /exit  |  /help\n\n`,
  );

  if (flags.prompt) {
    await runTurn({
      userText: flags.prompt,
      messages,
      provider,
      runtime,
      tier: tierOverride,
      modelOverride,
    });
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
    await runTurn({
      userText: text,
      messages,
      provider,
      runtime,
      tier: tierOverride,
      modelOverride,
    });
    return;
  }

  const rl = createInterface({ input, output, terminal: true });

  try {
    while (true) {
      const line = (await rl.question('helmion> ')).trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      if (line === '/help') {
        process.stdout.write(agentHelp());
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
        runtime = createToolRuntime(next, { permissionMode: 'full' });
        messages[0] = { role: 'system', content: systemPrompt(runtime.root) };
        messages.length = 1;
        process.stdout.write(`Workspace → ${runtime.root}\n`);
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
    rl.close();
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

In the REPL:
  /provider openai|claude|gemini|grok|<custom name>
  /tier auto|fast|standard|deep
  /workspace <path>
  /clear
  /exit

Tools: read_file, write_file, list_dir, run_command, search_text
Keys: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, XAI_API_KEY
`;
}
