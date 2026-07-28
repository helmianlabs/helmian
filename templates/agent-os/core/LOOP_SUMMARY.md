## The loop

These rules are a starting point that improves itself. Every correction becomes
a durable file the next session reads before it works.

```text
capture  ->  propose  ->  review  ->  promote
(automatic) (the agent) (the human) (only after approval)
```

Nothing promotes itself. A candidate lesson sits in the **Proposed** section of
`LESSONS.md` until the user approves it. A rule that can install itself will
eventually install a wrong one, and a wrong rule is worse than no rule because
it gets trusted.

When you are corrected, or you discover a method worth keeping, propose it —
with a trigger, a citation, and a checkable fact. "Be more careful" helps nobody.

| File | Holds | At session start |
|---|---|---|
| `LESSONS.md` | Corrections that must not repeat (review gated) | injected |
| `LEARNINGS.md` | Techniques worth reusing (review gated) | injected |
| `BLOCKERS.md` | What is stuck now, and what would unblock it | injected |
| `memory/MEMORY.md` | One-line index pointing at the detail files | injected |
| `SESSION_BOARD.md` | Which session is holding which files right now | active rows only |
| `WINS.md` | What shipped, and the evidence that proved it | read on demand |
| `agent-os/AGENT_OS.md` | The full loop and advisory-lane description | read on demand |

"Injected" means the session-start hook loads it automatically, so those files
have to stay short. "Read on demand" means you open it yourself — nothing loads
it for you. A file with a writer and no reader is a dead arrow, so if you add a
companion file, decide which column it belongs in.

Read `agent-os/AGENT_OS.md` before proposing an entry or consulting another
model. Claim your files on the session board before editing when more than one
agent is running.
