# {{SPRINT_ID}} — requirements

**Project:** {{PROJECT_NAME}} (`{{PROJECT_SLUG}}`)
**Opened:** {{CREATED_DATE}}
**Status:** not started

## The task, bounded

One task. If the sentence needs an "and", it is two sprints.

## Honest starting point

Written by the architect, before the builder is invoked. Everything below is
what the builder is allowed to treat as given; anything not here has to be
established from a primary source during the sprint.

**Known, with a source**

| Fact | Source |
|---|---|
| | |

**Searched and found nothing**

A recorded zero-match is a real finding, and it is the thing that stops the
builder inventing what it could not find.

| What was searched | Where | Result |
|---|---|---|
| | | zero matches |

**Hypotheses — not causes**

Each lead, its code-grounded reasoning with a `file:line`, and the observation
that would void it. A lead written as a conclusion will be confirmed rather
than tested.

| Lead | Reasoning (`file:line`) | What would void it |
|---|---|---|
| | | |

**Unknown**

The questions nobody has answered, and who could answer them.

## Constraints — do not violate

- **Out of bounds:** paths nothing in this sprint may modify, and why.
- **Needs an explicit yes first:** deleting, overwriting, force-pushing,
  anything irreversible, anything touching shared or live state, anything that
  spends money. Approval for one action never carries to the next.
- **History:** whether commits are allowed in this sprint, whether pushes are,
  and the exact rollback command.
- **Environment:** runtime version, offline-only, platform limits, any build or
  test that cannot run here — and what to do instead of guessing.

## Non-goals

- Anything in `../../planning/RISKS.md` under "Parked".
- ...

## Why this scope

Small enough to finish in one session, falsifiable enough that both outcomes
are gradable, and it exercises the part of the system worth testing.
