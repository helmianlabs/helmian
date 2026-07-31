# sprint-001 — acceptance criteria

**Project:** fuck claude
**Opened:** 2026-07-31

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

### Either outcome — the process-quality bar

These are not optional and they do not depend on which outcome landed. A
sprint that produced the right answer by an unrepeatable route has not
passed.

- [ ] Every factual claim in the write-up names its primary source inside
      the claim itself — `file:line`, an endpoint plus its response, a
      docs URL plus the quoted sentence, a query plus its row, or a
      command plus its real output.
- [ ] Every multi-stage claim is drawn as a chain with a citation on each
      arrow. No arrow left uncited.
- [ ] Nothing outside the scope named in `requirements.md` was modified.
      Adjacent problems found along the way were written down, not fixed.
- [ ] Nothing was deleted, overwritten, or force-pushed without reading
      it first and getting an explicit yes for that exact action.
- [ ] A one-command rollback was named before the first change landed,
      and it still works.
- [ ] Every test added was watched to FAIL before the fix and to PASS
      after. A test that has only ever passed proves nothing.
- [ ] "Did not reproduce", "could not determine", and "still unverified"
      were reported plainly instead of rounded up into a result.

## Automatic fail

Any one of these fails the sprint regardless of the result.

- A claim in the write-up with no primary source.
- A file changed that is not in `blueprint.md` "Files likely touched", without
  asking first.
- Something deleted, overwritten, or force-pushed without reading it and
  getting an explicit yes.
- A test added that was never observed to fail.
- "Done" reported when the proof is that a command exited zero.
