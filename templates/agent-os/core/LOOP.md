## The self-improvement loop

The rules above are the starting point, not the finished article. The loop is
how they get better: every correction and every win becomes a durable file that
the next session reads before it starts working.

Four stages. Nothing skips a stage, and nothing promotes itself.

### Capture (automatic)

At the end of each turn, the session appends a short record to the journal at
`agent-os/journal/`. Capture is mechanical and unfiltered — it costs nothing and
it records what actually happened while it is still fresh.

### Propose (the agent, at the end of a work block)

Read the journal since the last review. Turn each correction into a candidate
entry and append it to the **Proposed** section of `LESSONS.md` or
`LEARNINGS.md`. A candidate is not a rule yet. It is a suggestion carrying its
own evidence.

A proposal is only worth writing if it names all three:

1. **The trigger** — what you would observe that means this applies.
2. **The citation** — a `file:line`, a measurement, a command and its output.
3. **The fact** — what is actually true, stated so it can be checked.

A lesson with a moral but no number and no citation will not stop anyone. "Verify
things properly" is not a lesson. "`config/limits.js:88` caps the batch at 500;
anything larger is silently truncated, so a job that reports success can still
drop rows" is a lesson.

### Review (the human)

The user reads the Proposed section and decides. Nothing leaves that section on
its own. This is the only gate that matters, and it is deliberately manual — a
loop that promotes its own output drifts, and a drifting rule set is worse than
none because it is trusted.

### Promote (after approval only)

An approved entry moves out of Proposed and into the body of its file, newest
first. If it should change behavior in every future session, it also earns a
line in the core rules. If it turns out to be wrong later, delete it — a stale
rule that contradicts the code is a defect, and the correction is itself a
lesson worth capturing.

### The files

| File | Holds | Written by |
|---|---|---|
| Core rules | Standing behavior, promoted and approved | Human, after review |
| `LESSONS.md` | Corrections that must not repeat | Agent proposes, human approves |
| `LEARNINGS.md` | Techniques and discoveries worth reusing | Agent proposes, human approves |
| `BLOCKERS.md` | What is stuck right now, and what would unblock it | Agent, freely |
| `WINS.md` | What shipped and what proved it | Agent, freely |
| `SESSION_BOARD.md` | Which session owns which files right now | Every session, on start |
| `memory/MEMORY.md` | One-line index pointing at everything above | Agent, freely |

`BLOCKERS.md`, `WINS.md`, and the session board need no approval — they record
state, not rules. Only things that change future behavior go through review.

### Reading the loop back

At session start the context hook prints the current blockers, the newest
lessons, and the open board rows. That is the whole point: the next session
opens already knowing what the last one learned, what it broke, and which files
someone else is holding.
