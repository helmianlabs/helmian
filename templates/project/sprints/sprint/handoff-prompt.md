# {{SPRINT_ID}} — handoff prompt

<!-- Paste the section below into a fresh session. It assumes zero memory of any
     prior conversation on purpose: if it only works for someone who was
     already here, it is not a handoff. -->

{{SOURCE_OF_TRUTH}}

You have zero memory of any prior conversation. Everything you need is in this
project's `planning/`, `sprints/`, and `docs/` folders. Do not ask what the
project is — read it.

## Read these first, in this order

1. `PROJECT.md` — what this project is, and the map of every other file.
2. `planning/requirements.md` — the project goal, what is honestly known, the
   constraints, the non-goals.
3. `planning/STATE.md` — where the work actually stands. Every row has a proof
   column; a row with an empty proof is a claim, not a state.
4. `sprints/{{SPRINT_ID}}/requirements.md` — your task, and specifically the
   "Honest starting point" section. What is not in it is not established.
5. `sprints/{{SPRINT_ID}}/blueprint.md` — the phases, in order, each with its
   rollback.
6. `sprints/{{SPRINT_ID}}/acceptance-criteria.md` — how you will be graded,
   including the outcome where nothing needed fixing.
7. `planning/RISKS.md` — the parked table. Those are known and deliberately
   out of scope; do not fix them.

## The task, in one sentence

<!-- The architect writes this. One sentence. If it needs an "and", split the
     sprint. -->

## Hard constraints — do not violate

- **Cite every claim.** Primary source named inside the claim: `file:line`, an
  endpoint plus its response, a docs URL plus the quoted sentence, a query plus
  its row, a command plus its real output. If you cannot cite it right now, do
  not say it.
- **Stay inside the scope.** Anything you find that is real but outside the
  task goes into `planning/RISKS.md` under "Parked". Do not fix it.
- **Nothing irreversible without an explicit yes** for that exact action. Read
  a file before deleting or overwriting it. Approval for one action never
  carries to the next.
- **Name the rollback before the first change.** If you cannot name it, the
  change is not ready.
- **A test you did not watch fail is not a test.** Break it once, confirm it
  catches the break, restore, and report the counts before and after.
- **"Did not reproduce" is a real answer.** So are "could not determine" and
  "still unverified". Report them plainly. Never round one up into a result.
- **The starting point is not the truth.** Everything in these files is
  unverified until you check it against a primary source in this session.
  Where you find it wrong, record both halves in `planning/STATE.md` under
  "Corrections".

## What "done" looks like

`sprints/{{SPRINT_ID}}/acceptance-criteria.md`, fully ticked under Outcome A or
Outcome B, plus the process-quality bar that applies to both. Then the five
documentation items in `blueprint.md` Phase 5.

Ask before starting if anything above is ambiguous. A question costs minutes;
an invented assumption costs the sprint.
