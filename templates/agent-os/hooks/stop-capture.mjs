#!/usr/bin/env node
// Agent OS — turn capture (the "capture" stage of the loop).
//
// Runs when the agent finishes a turn and appends one JSON line to
// agent-os/journal/YYYY-MM-DD.jsonl. Later, the propose stage reads the journal
// and drafts candidate lessons into the Proposed section of LESSONS.md, where a
// human decides. Nothing here promotes anything.
//
// The event JSON arrives on stdin. The turn-end event and its message field
// differ by tool, so both spellings are accepted:
//
//   Claude Code  Stop        -> last_assistant_message
//                https://code.claude.com/docs/en/hooks
//   Codex        Stop        -> "Fires when a turn ends"
//                https://learn.chatgpt.com/docs/hooks
//   Gemini CLI   AfterAgent  -> prompt_response
//                https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md
//
// Returning {"decision":"block"} would prevent the agent from stopping. This
// hook never does that: a capture step that can trap a session in a loop is a
// defect, not a feature.
//
// Exits 0 on every path. Exit code 2 from a Stop hook blocks stopping.

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env.AGENT_OS_ROOT ?? join(HOOK_DIR, '..', '..'));
// Inside the managed directory, not beside the user's own notes: the journal is
// installer-owned machine output, and agent-os/ is what an uninstall removes.
const JOURNAL_DIR = join(ROOT, 'agent-os', 'journal');

const MAX_MESSAGE_CHARS = 2000;
const STDIN_TIMEOUT_MS = 3000;

function readStdin() {
  // Resolve on timeout rather than hanging: a hook that never exits stalls the
  // session it was supposed to be observing.
  return new Promise((resolveStdin) => {
    if (process.stdin.isTTY) {
      resolveStdin('');
      return;
    }
    let raw = '';
    const finish = () => {
      clearTimeout(timer);
      resolveStdin(raw);
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

function truncate(value) {
  if (typeof value !== 'string') return null;
  return value.length > MAX_MESSAGE_CHARS
    ? `${value.slice(0, MAX_MESSAGE_CHARS)}…[truncated]`
    : value;
}

async function main() {
  const raw = await readStdin();
  let event = {};
  try {
    event = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    event = {};
  }

  const entry = {
    recorded_at: new Date().toISOString(),
    session_id: event.session_id ?? null,
    cwd: event.cwd ?? null,
    hook_event: event.hook_event_name ?? 'Stop',
    tool_use_count: Array.isArray(event.tool_use_ids) ? event.tool_use_ids.length : null,
    last_assistant_message: truncate(event.last_assistant_message ?? event.prompt_response),
    review_state: 'uncaptured',
  };

  await mkdir(JOURNAL_DIR, { recursive: true });
  const day = entry.recorded_at.slice(0, 10);
  await appendFile(join(JOURNAL_DIR, `${day}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8');
}

try {
  await main();
} catch {
  // Capture is best effort. Losing one journal line is acceptable; blocking the
  // session to complain about it is not.
}
process.exit(0);
