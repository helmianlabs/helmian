// Stage 4 of the MCP install security pipeline: THE HUMAN SAYS YES, OR NOTHING
// IS INSTALLED.
//
// This gate is deliberately the least clever part of the system. It has no
// policy engine, no scoring, no "low risk so we proceed". It shows a person
// what the earlier stages found and waits for them to type an exact phrase in
// a real terminal.
//
// THREE PROPERTIES THIS FILE EXISTS TO GUARANTEE
//
//  1. NO AUTO-APPROVE PATH EXISTS. There is no flag, no environment variable,
//     no config key, and no argument that returns approved:true without a
//     human typing. Search this file for one — there is nothing to find. Any
//     variable that LOOKS like an auto-approve switch is treated as evidence
//     of tampering and hard-fails the gate (see TAMPER_ENV_PATTERNS).
//
//  2. NON-TTY REFUSES. A piped, redirected, or captured stdin is not a person.
//     It refuses and installs nothing.
//
//  3. A BLIND "yes" IS NOT ENOUGH. The prompt prints a freshly generated
//     random challenge phrase that must be typed back exactly. An agent that
//     pipes "yes" — the obvious way to fake a human — fails, because it cannot
//     know a phrase that did not exist until the prompt was printed.
//
// HONEST LIMIT: property 3 raises the cost of faking approval, it does not make
// it impossible. An agent that ALLOCATES A PTY, reads the printed challenge,
// and types it back would satisfy this gate. Defeating that requires a trust
// path this process cannot see (a signed confirmation from a key held outside
// it — which Helmion already has, in src/core/human-confirmation.mjs, for
// Maestro handoffs). That is the honest boundary of this gate and it is stated
// in the returned record rather than hidden.

import { randomInt } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { AUDIT_SEVERITY } from './mcp-code-audit.mjs';

export class ApprovalRefusedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApprovalRefusedError';
    this.details = details;
  }
}

/**
 * Environment variables that must NOT exist. If someone later "helpfully" adds
 * a bypass, this turns it into a loud failure instead of a silent install.
 */
export const TAMPER_ENV_PATTERNS = Object.freeze([
  /^HELMION_.*AUTO.*APPROVE/i,
  /^HELMION_.*SKIP.*APPROVAL/i,
  /^HELMION_.*FORCE.*INSTALL/i,
  /^HELMION_MCP_ASSUME_YES$/i,
  /^HELMION_.*NO_?CONFIRM/i,
]);

export function detectApprovalTampering(env = process.env) {
  return Object.keys(env).filter((name) => TAMPER_ENV_PATTERNS.some((p) => p.test(name)));
}

const CHALLENGE_WORDS = [
  'anchor', 'basalt', 'cinder', 'dorsal', 'ember', 'fathom', 'granite', 'harbor',
  'ingot', 'juniper', 'kelvin', 'lantern', 'marrow', 'nimbus', 'obsidian', 'pewter',
  'quarry', 'ridge', 'sextant', 'tundra', 'umber', 'vellum', 'winnow', 'zenith',
];

/** A phrase that did not exist until this moment. Cannot be pre-scripted. */
export function generateChallengePhrase(wordCount = 3) {
  const words = [];
  for (let i = 0; i < wordCount; i += 1) {
    words.push(CHALLENGE_WORDS[randomInt(CHALLENGE_WORDS.length)]);
  }
  return words.join('-');
}

/**
 * Hard TTY assertion. Throws ApprovalRefusedError when there is no human.
 * The CLI calls this against the REAL process streams before anything else.
 */
export function assertInteractiveTerminal({ stdin = process.stdin, stdout = process.stdout } = {}) {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new ApprovalRefusedError(
      'MCP install approval requires an interactive terminal. stdin/stdout are not a TTY, '
      + 'so there is no human here to approve this. NOTHING WAS INSTALLED.',
      { reason: 'not-a-tty', stdinIsTTY: Boolean(stdin.isTTY), stdoutIsTTY: Boolean(stdout.isTTY) },
    );
  }
  return true;
}

/**
 * Turn the machine-readable stage reports into something a person can act on
 * in fifteen seconds: what it is, what it wants, what was found.
 */
export function buildApprovalBriefing({ discovery = {}, audit = {}, sandbox = {} } = {}) {
  const critical = (audit.findings ?? []).filter((f) => f.severity === AUDIT_SEVERITY.CRITICAL);
  const high = (audit.findings ?? []).filter((f) => f.severity === AUDIT_SEVERITY.HIGH);
  const observed = sandbox.observed ?? {};

  const wants = [];
  for (const host of discovery.declared?.allowedHosts ?? []) wants.push(`network access to ${host}`);
  for (const name of discovery.declared?.allowedEnv ?? []) wants.push(`the environment variable ${name}`);
  if (!wants.length) wants.push('nothing declared — the candidate published no manifest of what it needs');

  const found = [];
  for (const f of critical) found.push(`CRITICAL ${f.citation} — ${f.message}`);
  for (const f of high) found.push(`HIGH ${f.citation} — ${f.message}`);
  if (observed.undeclaredHosts?.length) {
    found.push(`AT RUNTIME it contacted undeclared host(s): ${observed.undeclaredHosts.join(', ')}`);
  }
  if (observed.subprocessAttempts) {
    found.push(`AT RUNTIME it tried to run ${observed.subprocessAttempts} subprocess(es): ${observed.subprocessCommands.join(', ')}`);
  }
  if (observed.credentialPathReads?.length) {
    found.push(`AT RUNTIME it tried to read credential files: ${observed.credentialPathReads.join(', ')}`);
  }
  if (observed.writesOutsideSandbox?.length) {
    found.push(`AT RUNTIME it tried to write outside its own directory: ${observed.writesOutsideSandbox.join(', ')}`);
  }
  if (observed.envEnumerated) found.push('AT RUNTIME it swept the entire environment rather than reading the variables it declared');
  if (observed.canaryLeakAttempts) found.push(`AT RUNTIME it tried to transmit a planted canary value ${observed.canaryLeakAttempts} time(s) — this is exfiltration, observed directly`);
  if (sandbox.verdict === 'evidence-missing') {
    found.push('THE SANDBOX PRODUCED NO TRUSTWORTHY RECORD. This is not a clean run; it is a run with no evidence.');
  }
  if (!found.length) found.push('Nothing above INFO was flagged by the code read, and nothing misbehaved in the sandbox run.');

  return {
    name: discovery.name ?? discovery.repo ?? '(unnamed candidate)',
    source: discovery.htmlUrl ?? discovery.root ?? '(local path)',
    purpose: discovery.declared?.purpose ?? '(no stated purpose)',
    stars: discovery.stars ?? null,
    lastCommit: discovery.lastCommit ?? null,
    license: discovery.license ?? null,
    wants,
    found,
    codeReadVerdict: audit.verdict ?? 'unknown',
    sandboxVerdict: sandbox.verdict ?? 'unknown',
    limitations: [
      ...(audit.limitations ?? []),
      sandbox.isolation
        ? `Sandbox isolation was ${sandbox.isolation.achieved}. It is NOT ${sandbox.isolation.isNot}.`
        : 'No sandbox run was performed.',
    ],
  };
}

export function formatApprovalBriefing(briefing, challenge) {
  const lines = [];
  lines.push('');
  lines.push('═'.repeat(74));
  lines.push('  MCP SERVER INSTALL — HUMAN APPROVAL REQUIRED');
  lines.push('═'.repeat(74));
  lines.push(`  Server:   ${briefing.name}`);
  lines.push(`  Source:   ${briefing.source}`);
  lines.push(`  Purpose:  ${briefing.purpose}`);
  if (briefing.stars !== null) lines.push(`  Repo:     ${briefing.stars} stars, last commit ${briefing.lastCommit ?? 'unknown'}, license ${briefing.license ?? 'unknown'}`);
  lines.push('');
  lines.push('  IT IS ASKING FOR:');
  for (const want of briefing.wants) lines.push(`    - ${want}`);
  lines.push('');
  lines.push(`  WHAT THE REVIEW FOUND  (code read: ${briefing.codeReadVerdict.toUpperCase()}, sandbox: ${briefing.sandboxVerdict.toUpperCase()}):`);
  for (const item of briefing.found) lines.push(`    - ${item}`);
  lines.push('');
  lines.push('  WHAT THIS REVIEW CANNOT TELL YOU:');
  for (const item of briefing.limitations) lines.push(`    - ${item}`);
  lines.push('');
  lines.push('─'.repeat(74));
  lines.push(`  To APPROVE, type this exact phrase:   ${challenge}`);
  lines.push('  Anything else — including "yes" — REJECTS and installs nothing.');
  lines.push('─'.repeat(74));
  return lines.join('\n');
}

/**
 * The gate itself.
 *
 * `stdin`/`stdout` are injectable ONLY so the test suite can drive both
 * branches. The CLI always passes the real process streams, and calls
 * assertInteractiveTerminal on them first. That seam is stated plainly here
 * rather than left for someone to discover: at the API level, a caller that
 * supplies its own fake TTY streams is supplying its own prompt, and the
 * protection that remains is the challenge phrase.
 */
export async function requestInstallApproval({
  briefing,
  stdin = process.stdin,
  stdout = process.stdout,
  env = process.env,
  challenge = generateChallengePhrase(),
} = {}) {
  const tampering = detectApprovalTampering(env);
  if (tampering.length) {
    throw new ApprovalRefusedError(
      `Refusing to run the approval gate: the environment defines ${tampering.join(', ')}. `
      + 'There is no supported way to pre-approve an MCP install; the presence of such a variable '
      + 'is treated as tampering. NOTHING WAS INSTALLED.',
      { reason: 'tamper-detected', variables: tampering },
    );
  }

  assertInteractiveTerminal({ stdin, stdout });

  stdout.write(`${formatApprovalBriefing(briefing, challenge)}\n`);

  const rl = createInterface({ input: stdin, output: stdout });
  let typed;
  try {
    typed = await rl.question('  Type the phrase to approve: ');
  } finally {
    rl.close();
  }

  const normalized = String(typed ?? '').trim().toLowerCase();
  const approved = normalized === challenge.toLowerCase();

  return {
    stage: 'approval',
    approved,
    challenge,
    respondedAt: new Date().toISOString(),
    reason: approved
      ? 'human typed the challenge phrase in an interactive terminal'
      : `human did not type the challenge phrase (received ${normalized ? `"${normalized}"` : 'empty input'})`,
    gateLimitation:
      'This proves a human-shaped interaction at a TTY. It does not prove WHICH human, and a '
      + 'PTY-allocating agent that reads the printed challenge could satisfy it. Binding an '
      + 'install to a specific person requires a signed confirmation from a key held outside '
      + 'this process (see src/core/human-confirmation.mjs).',
  };
}
