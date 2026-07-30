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
