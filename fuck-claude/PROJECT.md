# fuck claude

<!-- Created by `helmion project init` on 2026-07-31. This file is yours
     from here on: re-running the command reports it as preserved and does not
     touch a single byte of it. -->

| Field | Value |
|---|---|
| Slug | `fuck-claude` |
| Started | 2026-07-31 |
| Current sprint | `sprints/sprint-001/` |
| Status | not started |

## What this is

One paragraph, written before any code exists. What the thing does, who uses
it, and what it replaces. If you cannot write this paragraph, the project is
not scoped yet — that is the finding, and it belongs in
`planning/requirements.md` under "Honest starting point".

## Read these first, in this order

A session with zero memory of any prior conversation should be able to start
here and be productive without asking a single question.

1. `PROJECT.md` — this file. What the project is and where everything lives.
2. `planning/requirements.md` — the goal, what is actually known today, the
   constraints, and the explicit non-goals.
3. `planning/blueprint.md` — the phased plan, and the rollback for each phase.
4. `planning/STATE.md` — where the work actually stands, with a proof for
   every row.
5. `sprints/sprint-001/handoff-prompt.md` — the task in front of you right
   now.

## Where things live

| Path | Holds | Written by |
|---|---|---|
| `PROJECT.md` | the charter and this map | the architect, once |
| `planning/requirements.md` | goal, honest starting point, constraints, non-goals | the architect |
| `planning/blueprint.md` | phases, sequencing, files likely touched, rollback | the architect |
| `planning/acceptance-criteria.md` | what "done" means for the project | the architect |
| `planning/STATE.md` | current state, one row per thing, each with a proof | whoever last changed something |
| `planning/DECISIONS.md` | decisions and what they ruled out, append-only | whoever decided |
| `planning/RISKS.md` | what could go wrong and the early warning for each | anyone |
| `sprints/sprint-001/` | one bounded, falsifiable unit of work | the architect writes it, the builder executes it |
| `sprints/README.md` | how to open the next sprint | reference |
| `docs/ARCHITECTURE.md` | how the built thing actually works | the builder, after it works |
| `docs/handoffs/` | one dated handoff per session that ends | whoever ends the session |
| `prompts/architect.md` | the role prompt for scoping work | reference |
| `prompts/builder.md` | the role prompt for executing a sprint | reference |

## The two roles

**The architect** never writes production code. It reads, scopes, and writes
the sprint pack: requirements, blueprint, handoff prompt, acceptance criteria.
Its output is a task a stranger could execute correctly.

**The builder** never re-scopes. It executes exactly one sprint pack, cites
every claim, and stops at the edge of the stated scope — adjacent problems get
written into `planning/RISKS.md`, not fixed on the way past.

Splitting them is the whole point of this folder existing before any tool
touches the build. A single session that scopes and builds at the same time
grades its own homework.

## Ground rules that outrank convenience

1. **Cite or say nothing.** If the primary source cannot be named right now,
   the claim does not get made.
2. **Never destroy what you did not create.** Read a file before deleting,
   overwriting, or force-pushing it. If it does not match how it was
   described, stop and report the mismatch.
3. **"Done" means a durable side effect proves it.** A tool reporting success
   is not proof. Submitted, written, pushed, and deployed are four different
   states; never round one up to another.
4. **Scope is a boundary, not a suggestion.** New work found mid-sprint gets
   recorded and left for the next sprint.
