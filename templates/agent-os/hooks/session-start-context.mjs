#!/usr/bin/env node
// Agent OS — session start context injection.
//
// Prints the current loop state so a fresh session opens already knowing what
// is blocked, what was learned, and which files another session is holding.
//
// Two output formats, because the two hook systems differ:
//
//   --format text  (default)  Claude Code: "Any text your hook script prints to
//                             stdout is added as context for Claude."
//                             https://code.claude.com/docs/en/hooks
//   --format json             Gemini CLI: context is injected through
//                             hookSpecificOutput.additionalContext.
//                             https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md
//
// Claude Code accepts either form; text is used there because it is simpler.
//
// Two properties this hook must never violate:
//   1. It never blocks session start. Every failure path exits 0 silently.
//   2. It is bounded. A runaway lessons file cannot flood the context window.

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env.AGENT_OS_ROOT ?? join(HOOK_DIR, '..', '..'));

const MAX_LINES_PER_SECTION = 40;
const MAX_TOTAL_CHARS = 6000;

// Guidance in these files lives inside HTML comment blocks. Strip whole blocks,
// not lines that merely start with a marker — a multi-line comment filtered
// line-by-line leaks its entire middle, which is how a fresh install ends up
// injecting its own format examples as if they were real blockers.
function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

const STRUCTURAL_HEADING = /^#{1,6}\s+(lessons|learnings|blockers|wins|session board|memory index|proposed|approved|open|resolved|index)\s*$/i;

async function section(title, relativePath, { onlyBefore = null, keep = null } = {}) {
  let raw;
  try {
    raw = await readFile(join(ROOT, relativePath), 'utf8');
  } catch {
    return null; // Not installed, not readable, not our problem — stay quiet.
  }

  let body = stripComments(raw);
  if (onlyBefore) {
    const cut = body.indexOf(onlyBefore);
    if (cut !== -1) body = body.slice(0, cut);
  }

  let lines = body.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim() !== '');

  if (keep) lines = lines.filter(keep);

  // A section with nothing but its own scaffolding has nothing to say. Saying
  // so anyway trains the reader to skip this whole block.
  const substantive = lines.filter((line) => {
    const t = line.trim();
    if (STRUCTURAL_HEADING.test(t)) return false;
    if (/^\|[\s|:-]*\|$/.test(t)) return false; // table separator
    if (/^\|\s*session\s*\|/i.test(t)) return false; // board header row
    return true;
  });
  if (substantive.length === 0) return null;

  return `## ${title}\n${substantive.slice(0, MAX_LINES_PER_SECTION).join('\n')}`;
}

async function main() {
  const parts = await Promise.all([
    section('Open blockers', 'BLOCKERS.md'),
    section('Recent lessons', 'LESSONS.md'),
    section('Recent learnings', 'LEARNINGS.md'),
    // The index is curated by hand and is worthless if nothing loads it. A file
    // with a writer and no reader is a dead arrow, however tidy it looks.
    section('Memory index', 'memory/MEMORY.md'),
    // Only rows still holding files matter; a finished session is noise.
    section('Sessions holding files', 'SESSION_BOARD.md', {
      keep: (line) => line.trim().startsWith('|') && /\bactive\b/i.test(line),
    }),
  ]);

  const present = parts.filter(Boolean);
  if (present.length === 0) return;

  let out = [
    '# Agent OS — carried forward from previous sessions',
    '',
    'Treat every line below as UNVERIFIED until you check it against a primary',
    'source in this session. It tells you where to look; it is not the answer.',
    '',
    present.join('\n\n'),
  ].join('\n');

  if (out.length > MAX_TOTAL_CHARS) {
    out = `${out.slice(0, MAX_TOTAL_CHARS)}\n\n[truncated — read the files directly for the rest]`;
  }

  const formatIndex = process.argv.indexOf('--format');
  const format = formatIndex === -1 ? 'text' : process.argv[formatIndex + 1];

  if (format === 'json') {
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: out,
      },
    })}\n`);
    return;
  }

  process.stdout.write(`${out}\n`);
}

try {
  await main();
} catch {
  // A context hook that breaks session start is worse than no context hook.
}
process.exit(0);
