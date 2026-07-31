# fuck claude — docs

`planning/` is what we intend. `docs/` is what is true.

| Path | Holds | Written when |
|---|---|---|
| `ARCHITECTURE.md` | how the built thing actually works | after it works, not before |
| `handoffs/` | one dated file per session that ends | at the end of every session |

## The split, and why it matters

A planning document describes a target and is allowed to be wrong — that is
what a plan is. A document in here describes reality and is not. The moment
those two mix, nobody can tell a promise from a fact, and the next session
inherits the promise as though it were a fact.

So: nothing goes into `docs/` until there is a proof for it, and every claim
carries that proof inside the sentence.

## Handoffs

One file per session, named `HANDOFF_YYYY-MM-DD_short-topic.md`, from
`handoffs/HANDOFF_TEMPLATE.md`. Never edited afterwards — a handoff is the
record of what was believed at that moment, including the parts that turned out
to be wrong. When a later session finds one of those parts wrong, it writes the
correction in the new handoff and in `planning/STATE.md`, and leaves the old
file alone.

Do not keep a single rolling handoff. It loses the history of what was believed
when, which is exactly the information needed to work out how a wrong claim
survived four sessions.
