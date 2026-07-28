# Wiring the hooks — a merge, not an overwrite

The installer does **not** edit `{{SETTINGS_PATH}}`. That file is yours and may
already contain hooks, permissions, and settings the installer knows nothing
about, so it writes the snippet beside it and leaves the merge to you.

Snippet: `{{SNIPPET_PATH}}`
Target:  `{{SETTINGS_PATH}}`

## If the target file does not exist yet

Copy the snippet over it. Nothing to merge.

## If it already exists

Open both. Copy the `SessionStart` and `{{TURN_END_EVENT}}` entries from the
snippet into the `hooks` object of your settings file.

If a `hooks` key is already there, add these events alongside the existing ones.
If one of these events is already configured, append the new entry to that
event's array rather than replacing it — each event holds a list, and several
hooks can run on the same event.

Do not paste the whole snippet over a file that has other keys in it. That is
the one move that loses work.

## What the two hooks do

`session-start-context.mjs` reads `BLOCKERS.md`, `LESSONS.md`, `LEARNINGS.md`,
and `SESSION_BOARD.md`, and prints a bounded summary at session start. It is
capped at 40 lines per section and 6000 characters total, and it exits quietly
if a file is missing. It cannot block a session from starting.

`stop-capture.mjs` appends one line per turn to `agent-os/journal/`. That
journal is the raw material for the propose stage. It never returns a blocking
decision, so it cannot trap a session in a loop.

Both are plain Node scripts with no dependencies. Read them before wiring them
up — they are short, and you should not run something on every session start
that you have not looked at.

## Verifying it worked

Start a fresh session and confirm the blockers and lessons appear in context.
Then check that `agent-os/journal/` gained a file after your first turn. If the
journal is empty, the turn-end hook is not wired — the tool will not tell you.

## Removing it

Delete the entries you added from `{{SETTINGS_PATH}}` and delete the
`agent-os/` directory. The files outside `agent-os/` are your own notes; keep
them or delete them as you like.
