# {{SPRINT_ID}} — acceptance criteria

**Project:** {{PROJECT_NAME}}
**Opened:** {{CREATED_DATE}}

Both outcomes below are complete. Neither is the consolation prize.

## Outcome A — reproduced, fixed, re-verified, documented

- [ ] The condition was reproduced, with the exact command and its real output
      recorded in `blueprint.md` Phase 1.
- [ ] The cause was diagnosed from that evidence and cited to `file:line`.
- [ ] Any hypothesis from `requirements.md` that the evidence contradicted was
      marked void rather than rescued.
- [ ] A failing test was written first and watched to fail. Counts before
      recorded.
- [ ] The smallest correct change was made. Nothing bundled.
- [ ] The test passes and the whole suite passes. Counts after recorded.
- [ ] The fix was broken on purpose once, the test caught it, and it was
      restored.
- [ ] A durable side effect independent of the tooling proves the result.
- [ ] The five items in `blueprint.md` Phase 5 are done.

## Outcome B — it genuinely did not reproduce

- [ ] Every attempt is recorded with its exact command and real output.
- [ ] The conditions varied are listed: cold start, clean environment,
      different input, different platform.
- [ ] The hypothesis in `requirements.md` is marked void, with the evidence.
- [ ] No change was invented in order to have something to show.
- [ ] Whoever asked was told plainly, in one sentence, that it did not
      reproduce — not that it was "partially addressed".
- [ ] The finding is written into `../../planning/STATE.md` so the next session
      does not spend the same hours.

{{PROCESS_BAR}}

## Automatic fail

Any one of these fails the sprint regardless of the result.

- A claim in the write-up with no primary source.
- A file changed that is not in `blueprint.md` "Files likely touched", without
  asking first.
- Something deleted, overwritten, or force-pushed without reading it and
  getting an explicit yes.
- A test added that was never observed to fail.
- "Done" reported when the proof is that a command exited zero.
