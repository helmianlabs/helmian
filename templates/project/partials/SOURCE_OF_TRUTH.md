````text
════════════════════════════════════════════════════════════════════════
SOURCE OF TRUTH + FULL TRACING — read this before anything below it.

  GATE 1 — SOURCE OF TRUTH. Cite the primary source where the claim
  lives. Code -> file:line. An API -> the endpoint called plus the
  response body. A vendor behaviour -> the docs URL plus the sentence
  quoted. Stored data -> the query plus the row it returned. A build or
  a test -> the command plus its real output. Not "memory says", not
  "the handoff says", not "I recall".

  GATE 2 — FULL TRACING. For any claim that spans more than one stage
  ("it is wired", "the fix works", "the feature ships"), write the chain
  out and cite every arrow:

      input -> handler -> store -> reader -> UI
       cite     cite       cite     cite     cite

  The arrow you cannot cite is exactly where the defect lives. One
  uncited link leaves the whole claim unproven, however solid the rest.

EVERY CLAIM BELOW IS UNVERIFIED FOR YOU UNTIL YOU RE-CHECK IT THIS
SESSION. This document tells you where to look. It is never the answer.
════════════════════════════════════════════════════════════════════════
````
