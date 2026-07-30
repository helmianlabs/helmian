# {{PROJECT_NAME}} — blueprint

> **This is a plan document only. Nothing described here has been
> implemented.** Every phase below is intent. When a phase actually lands, the
> proof goes in `planning/STATE.md`, not here.

**Created:** {{CREATED_DATE}}

## Phase 0 — reproduce, before touching any code

Prove the starting condition exists, from a cold start, with the exact command
and its real output recorded.

- What to run:
- What was observed:
- Cold start matters: a state that only appears after a warm run is a
  different bug from one that appears on first launch. Say which this is.

**"Did not reproduce" is a valid, complete outcome.** Never manufacture the
failure to have something to fix. If it does not reproduce, record exactly
what was tried and stop — that finding is the deliverable.

**Rollback for this phase:** nothing was changed, so there is nothing to undo.

## Phase 1 — diagnose from the real evidence

Work only from what Phase 0 actually produced: the real stack trace, the real
response body, the real row.

- If the failure site turns out to be somewhere other than the hypothesis in
  `requirements.md`, **that hypothesis is void** — say so plainly and follow
  the evidence instead of rescuing the guess.
- Trace the value, do not grep the name. A function that returns the right
  thing to a caller that drops it is still a defect; find the writer, cite its
  `file:line`, or record the gap.
- Read the body of every promisingly-named function. Names lie.

**Rollback for this phase:** read-only. Nothing to undo.

## Phase 2 — fix, smallest correct change

- One change that addresses the diagnosed cause. No bundled refactors, no
  drive-by cleanups, no renames "while we are in here".
- Write the failing test FIRST and watch it fail. A test authored after the
  fix, that has only ever passed, proves nothing.
- Anything else noticed goes into `planning/RISKS.md` and stays there.

**Rollback for this phase:** name it here, before the first edit — the exact
one-command undo and the known-good state it returns to. If a rollback cannot
be named, the change is not ready to make.

## Phase 3 — verify by durable side effect

Proof is an independent observable, not a tool's own report.

| Counts as proof | Does not count |
|---|---|
| the test you watched go from red to green | the process exited zero |
| the row actually present when queried | a log line saying it worked |
| the endpoint returning the new response | "the tool reported success" |
| the artifact present at the path, with its size | it worked last session |

## Phase 4 — document

- Update `planning/STATE.md`: one row per thing, each with a proof column.
- Append to `planning/DECISIONS.md` anything that was decided, including what
  it ruled out.
- Write the dated handoff into `docs/handoffs/` using the template there.
- If something was learned that would have saved hours, write it where the
  next session will actually hit it — with a trigger, a citation, and a number.

## Files likely touched

List them now, before starting. A file that turns up in the diff and is not on
this list is a scope question, not a detail.

| Path | Why it would change |
|---|---|
| | |

## Sequencing

What must happen before what, and what can run at the same time. If a
dependency cannot be named in one sentence, the two pieces are independent and
should run in parallel.
