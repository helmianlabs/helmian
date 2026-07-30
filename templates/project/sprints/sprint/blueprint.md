# {{SPRINT_ID}} — blueprint

> **This is a plan document only. Nothing described here has been
> implemented.**

**Project:** {{PROJECT_NAME}}
**Opened:** {{CREATED_DATE}}

## Phase 1 — reproduce

Before touching any code. Record the exact command and its real output.

- Command:
- Expected:
- Observed:
- Cold start or warm? A condition that only appears on a warm run is a
  different condition.

"Did not reproduce" is a complete outcome — go to
`acceptance-criteria.md` Outcome B and stop. Do not manufacture the failure.

**Rollback:** nothing changed.

## Phase 2 — diagnose

Only from what Phase 1 produced.

- Read the real stack trace / response / row. If the failure site is not where
  `requirements.md` hypothesised, that hypothesis is **void**; say so and
  follow the evidence.
- Trace the value to its writer and cite the `file:line`. If nothing writes
  it, that gap is the finding.
- Read the body of every important-sounding name before believing it.

**Rollback:** read-only.

## Phase 3 — fix

- Failing test first. Watch it fail. Record the counts before.
- Smallest correct change. No bundled refactors, renames, or cleanups.
- Watch the test pass. Record the counts after.
- Break the fix on purpose once and confirm the test catches it, then restore.
  A test that has only ever passed proves nothing.

**Rollback — name it here before the first edit:**

- Known-good state:
- One command to return to it:

## Phase 4 — verify by durable side effect

An observable independent of the tool that made the change. Not "the command
exited zero".

## Phase 5 — document

- [ ] `../../planning/STATE.md` — rows updated, proof on each.
- [ ] `../../planning/DECISIONS.md` — anything decided, plus what it ruled out.
- [ ] `../../planning/RISKS.md` — anything found and deliberately not fixed.
- [ ] `../../docs/handoffs/` — a dated handoff from the template.

## Files likely touched

| Path | Why |
|---|---|
| | |

Anything in the diff that is not on this list is a scope question. Stop and
ask rather than widening quietly.

## Sequencing

Phases 1 to 5 are strictly ordered — each consumes the previous one's output.
Any independent reading can happen in parallel with any other independent
reading.
