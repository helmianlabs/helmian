# {{PROJECT_NAME}} — state

<!-- The one file to update as you go. Every row carries a proof; a row with an
     empty Proof cell is a claim, not a state.

     This file is yours: `helmion project init` will report it as preserved and
     will not rewrite it. -->

**Last updated:** {{CREATED_DATE}}

## The one thing to know first

The single fact that would change what the next session does. If nothing has
happened yet, say that — an empty project is a legitimate state.

## Now

| Thing | State | Proof |
|---|---|---|
| Project scaffold | created {{CREATED_DATE}} | this folder exists |
| `planning/requirements.md` | not filled in | file is still the template |
| `sprints/{{SPRINT_ID}}` | not started | no entry in `docs/handoffs/` |

State values that mean different things and must not be blended: `not
started`, `in progress`, `written but unverified`, `verified locally`,
`shipped`. Pick the narrowest one that is true.

Proof values that count: a `file:line`, a command plus its real output, a
measured number, a query plus the row, a URL plus what it returned. "It looks
right" is not a proof and neither is a prior handoff.

## Verified this session

Rows checked against a primary source during the current session, with the
citation. Everything not in this list is unverified by default, regardless of
what an earlier session wrote.

## Unverified, carried forward

Claims inherited from earlier work that nobody has re-checked. Do not build on
one of these — verify it first, or say out loud that you are building on an
unverified claim.

## Corrections — do not re-inherit the wrong version

When an earlier claim turns out to be false, record BOTH halves here. Deleting
the wrong claim silently means the next session rediscovers it.

| Earlier claim | What is actually true | Proof |
|---|---|---|
| | | |
