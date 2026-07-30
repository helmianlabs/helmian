// Drives the advisory loop end to end: publish what is about to happen, ask the
// other three models, record what they said, and hand back a verdict.
//
// This is the wiring. src/agent/mcp-client.mjs can talk to a server and
// src/core/advisory-loop.mjs can judge a set of reviews; neither knows about the
// other. This joins them, and writes the evidence down.
//
// LOCAL-FIRST, ON PURPOSE. Troy's design puts the advisory lane in Neon
// (BIGSISTER_DATABASE_URL). That endpoint is NOT configured on this machine, so
// a DB-only publisher would mean the whole loop does nothing today and nobody
// would find out until they looked. Instead every proposal and every review is
// written to a durable JSONL journal under <workspace>/.helmion/advisory/ FIRST,
// and the database is an upgrade rather than a dependency. Same shape as the
// block ledger, and for the same reason: evidence that only exists when a remote
// service is reachable is not evidence.
//
// THE ADVISORS ARE MCP SERVERS THIS MACHINE ALREADY HAS. Read from
// ~/.claude.json rather than hardcoded, so a server that moves or gains a flag
// does not silently stop being asked. If one is not configured, it is reported
// MISSING by name — never skipped so a smaller quorum passes.

import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { createMcpClient } from '../agent/mcp-client.mjs';
import { ADVISORS, buildProposal, gate, parseReview, reviewPrompt } from './advisory-loop.mjs';

/** Where the journal lives, mirroring the block ledger's placement. */
export const ADVISORY_DIR = join('.helmion', 'advisory');

/** Which MCP server answers for which advisor. */
export const ADVISOR_SERVERS = Object.freeze({
  grok: 'Grok',
  gemini: 'Gemini',
  chatgpt: 'OpenAI',
});

/**
 * The tool each advisor's server exposes for a plain question.
 *
 * Ordered by preference. The runner asks the server what it HAS
 * (`tools/list`) and picks the first of these it finds, rather than assuming a
 * name — a server that renames a tool would otherwise fail as "no answer",
 * which the gate would correctly but unhelpfully read as a missing advisor.
 */
export const PREFERRED_TOOLS = Object.freeze([
  'ask', 'chat', 'chat_with_gemini', 'chat_with_openai', 'code_review', 'query',
]);

export function journalPath(workspace, now = new Date()) {
  const day = new Date(now).toISOString().slice(0, 10);
  return join(workspace, ADVISORY_DIR, `advisory-${day}.jsonl`);
}

/**
 * Appends one record. Returns what happened rather than throwing: a journal that
 * takes the review down with it is worse than one that reports a gap.
 */
export async function record(workspace, entry, now = new Date()) {
  try {
    const file = journalPath(workspace, now);
    await mkdir(join(workspace, ADVISORY_DIR), { recursive: true });
    await appendFile(file, `${JSON.stringify({ at: new Date(now).toISOString(), ...entry })}\n`, 'utf8');
    return { logged: true, file, reason: '' };
  } catch (error) {
    return { logged: false, file: null, reason: error.message };
  }
}

/** Everything written for one day, newest last. Empty when there is nothing. */
export async function readJournal(workspace, now = new Date()) {
  try {
    const text = await readFile(journalPath(workspace, now), 'utf8');
    return text.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/** The MCP server table this machine actually has. */
export async function loadServerRegistry(configPath = join(homedir(), '.claude.json')) {
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    return parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {};
  } catch {
    return {};
  }
}

/**
 * Resolves the env an advisor's server needs, from the real environment.
 *
 * The registry records WHICH variables a server wants; the values come from
 * process.env here. Passing them is the explicit grant the MCP client's
 * allow-list is designed to require.
 */
function grantFor(config, env = process.env) {
  const granted = {};
  for (const name of Object.keys(config?.env ?? {})) {
    const configured = config.env[name];
    // A registry value that is a real secret wins; otherwise fall back to the
    // live environment. Either way it is named, never inherited wholesale.
    granted[name] = configured && !String(configured).startsWith('$') ? configured : env[name] ?? '';
  }
  return granted;
}

/**
 * Asks ONE advisor. Always returns a review-shaped object — a failure becomes an
 * uncounted review carrying the reason, never a thrown error and never silence,
 * because the gate must be able to tell "said nothing" from "said fine".
 */
export async function askAdvisor(advisor, prompt, { registry, timeoutMs = 120_000 } = {}) {
  const serverName = ADVISOR_SERVERS[advisor];
  const config = registry?.[serverName];

  if (!config?.command) {
    return {
      advisor,
      counted: false,
      verdict: null,
      reason: `no MCP server named "${serverName}" is configured on this machine`,
    };
  }

  let client;
  try {
    client = await createMcpClient({
      command: config.command,
      args: config.args ?? [],
      env: grantFor(config),
      timeoutMs,
    });

    const tools = await client.listTools();
    const names = tools.map((t) => t.name);
    const tool = PREFERRED_TOOLS.find((candidate) => names.includes(candidate))
      ?? names.find((n) => /ask|chat|review|query/i.test(n));

    if (!tool) {
      return {
        advisor,
        counted: false,
        verdict: null,
        reason: `${serverName} exposes no tool that takes a question (has: ${names.join(', ') || 'none'})`,
      };
    }

    const result = await client.callTool(tool, { prompt, message: prompt, query: prompt });
    return { ...parseReview(advisor, client.textOf(result)), tool, server: serverName };
  } catch (error) {
    return {
      advisor,
      counted: false,
      verdict: null,
      reason: `${serverName} could not be reached: ${error.message}`,
    };
  } finally {
    try { await client?.close(); } catch { /* already gone */ }
  }
}

/**
 * The whole loop. Publish, ask everyone in parallel, judge, record.
 *
 * Advisors are asked CONCURRENTLY because they are independent and a serial loop
 * would make the gate cost three model round-trips end to end. One slow advisor
 * still cannot hold the others up.
 *
 * NOTHING HERE COMMITS ANYTHING. It returns a decision. Rule 0.27: advisory
 * output is low-trust and never auto-promotes.
 */
export async function runAdvisoryReview({
  workspace,
  projectSlug,
  summary,
  intent = '',
  diff = '',
  files = [],
  citation = '',
  operation = {},
  advisors = ADVISORS,
  registry = null,
  timeoutMs = 120_000,
  now = new Date(),
} = {}) {
  const proposal = buildProposal({ projectSlug, summary, intent, diff, files, citation, operation, now });
  const table = registry ?? await loadServerRegistry();
  const prompt = reviewPrompt(proposal);

  const published = await record(workspace, { kind: 'proposal', proposal }, now);

  const reviews = await Promise.all(
    advisors.map((advisor) => askAdvisor(advisor, prompt, { registry: table, timeoutMs })),
  );

  for (const review of reviews) {
    await record(workspace, { kind: 'review', summary: proposal.summary, review }, now);
  }

  const decision = gate({ proposal, reviews, required: advisors });
  await record(workspace, { kind: 'decision', summary: proposal.summary, decision }, now);

  return { proposal, reviews, decision, published };
}
