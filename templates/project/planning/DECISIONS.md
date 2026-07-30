# {{PROJECT_NAME}} — decisions

<!-- Append-only. Never edit or delete an entry: when a decision is reversed,
     add a new entry that supersedes it and say why. The reversal is usually
     more useful than the original.

     A decision that does not record what it ruled out is a preference, and it
     will be re-litigated. -->

**Opened:** {{CREATED_DATE}}

Format for each entry:

```text
## NNN — short imperative title

**Date:** YYYY-MM-DD
**Status:** accepted | superseded by NNN | reversed
**Decision:** what was chosen, in one sentence.
**Context:** what forced the choice — the constraint, the failure, the cost.
**Ruled out:** each alternative and the specific reason it lost. This is the
part that stops the question coming back.
**Consequences:** what this now makes easy, and what it now makes hard.
**Proof:** the primary source the decision rests on — file:line, a measured
number, a docs URL plus the quoted sentence.
```

## 001 — keep the planning folder ahead of the build

**Date:** {{CREATED_DATE}}
**Status:** accepted
**Decision:** `planning/`, `sprints/`, and `docs/` are written before any
coding tool opens this project.
**Context:** an agent given a vague goal invents the missing scope, and the
invented scope is indistinguishable from a real one once it is in the diff.
**Ruled out:** starting in the editor and writing the plan afterwards — the
plan then describes what happened rather than constraining it.
**Consequences:** slower to the first line of code, and every later session
starts from a stated scope instead of guessing at one.
**Proof:** this folder, created by `helmion project init` on {{CREATED_DATE}}.
