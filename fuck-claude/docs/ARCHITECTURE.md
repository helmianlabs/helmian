# fuck claude — architecture

> Write this **after** something works, and describe only what does. An
> architecture document that describes the intention is a second, competing
> plan, and the next session cannot tell which one is real.

**Opened:** 2026-07-31 — empty on purpose.

## The shape of it

One paragraph and, if it helps, one diagram. What the pieces are and which way
the data moves.

## The chain, end to end

Draw the real path with a citation on every arrow. The arrow with no citation
is where the next defect will be found.

```text
entry point -> validation -> core logic -> storage -> read path -> output
  file:line     file:line     file:line    file:line   file:line   file:line
```

## Components

| Component | Path | Responsibility | Depends on |
|---|---|---|---|
| | | | |

## Boundaries this project does not cross

The things the code deliberately refuses to do, and where that refusal is
enforced — with the `file:line`. A boundary nobody can point at is not a
boundary.

| Boundary | Enforced at | What happens on violation |
|---|---|---|
| | | |

## How to run and test it

The exact commands, and what each one actually proves. Note anything that
cannot run in this environment, so the next session does not read a silent skip
as a pass.

| Command | Proves | Does not prove |
|---|---|---|
| | | |

## Known sharp edges

Behaviour that is correct but surprising, and the reason it is that way. Each
one is an hour somebody already spent.
