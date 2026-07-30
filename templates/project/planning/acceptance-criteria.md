# {{PROJECT_NAME}} — acceptance criteria

<!-- Both outcomes below are first-class "done". A criteria file that only
     accepts a fix pressures whoever reads it into producing one. -->

**Created:** {{CREATED_DATE}}

## Outcome A — the goal was met

- [ ] The starting condition in `planning/blueprint.md` Phase 0 was reproduced,
      with the command and its real output recorded.
- [ ] The cause was diagnosed from that real evidence, cited to `file:line`.
- [ ] A failing test was written first and watched to fail.
- [ ] The smallest correct change was made, and nothing else.
- [ ] The test now passes, and the full suite still passes — counts recorded
      before and after.
- [ ] A durable side effect independent of the tooling proves the outcome.
- [ ] `planning/STATE.md` and `docs/handoffs/` were updated.

## Outcome B — it genuinely did not happen

Equally complete, equally acceptable, and reported without softening.

- [ ] Every attempt at the starting condition is recorded, with exact commands
      and real output.
- [ ] The conditions that were varied are listed — cold start, clean
      environment, different input, different platform.
- [ ] The hypothesis from `planning/requirements.md` is marked void, with the
      evidence that voided it.
- [ ] No change was invented to have something to show.
- [ ] The finding is stated plainly to whoever asked, in one sentence, without
      being dressed up as partial success.

{{PROCESS_BAR}}

## What is explicitly NOT required

Naming these stops good work from being held hostage to unrelated debt.

- Fixing anything found along the way that is outside the stated scope.
- Refactoring code that is merely unpleasant.
- Raising overall coverage.
