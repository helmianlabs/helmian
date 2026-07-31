# fuck claude — sprints

A sprint is one bounded, falsifiable unit of work, written by the architect and
executed by the builder. Four files, always the same four:

| File | Answers |
|---|---|
| `requirements.md` | what the task is, what is honestly known, what is off limits |
| `blueprint.md` | the phases, in order, each with a rollback |
| `handoff-prompt.md` | what to paste into a session that has zero context |
| `acceptance-criteria.md` | how to tell it is finished, both outcomes |

`sprint-001` was created with the project on 2026-07-31.

## Opening the next sprint

1. Copy the whole `sprint-001` directory to the next number —
   `sprint-002`, then `sprint-003`. Numbers never get reused and a sprint is
   never edited after it closes; a closed sprint is the record of what was
   actually asked for.
2. Before writing the new scope, read `../planning/RISKS.md` — the parked
   table is the backlog the last sprint actually produced.
3. Fill in `requirements.md` first, and finish the honest-starting-point
   section before writing any phase. A blueprint written before the starting
   point is known is a guess with headings.
4. Update `../planning/STATE.md` so the current-sprint row points at the new
   directory.

## Closing a sprint

- [ ] `acceptance-criteria.md` fully ticked, under Outcome A **or** Outcome B.
      Both are complete outcomes.
- [ ] `../planning/STATE.md` updated, with a proof on every row that changed.
- [ ] Anything decided appended to `../planning/DECISIONS.md`.
- [ ] Anything found and not fixed recorded in `../planning/RISKS.md`.
- [ ] A dated handoff written into `../docs/handoffs/`.

A sprint is not closed because time ran out. If it is unfinished, say so in
the handoff and name the exact remaining step.

## Rules that apply to every sprint

- One sprint open at a time. Two open sprints share files and neither one
  can be reverted cleanly.
- The builder does not re-scope. A scope that turns out to be wrong is a
  finding for the architect, not a licence to widen it.
- Every sprint names its rollback before its first change.
