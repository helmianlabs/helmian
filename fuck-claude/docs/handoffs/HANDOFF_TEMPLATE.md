# Handoff template

<!-- Copy to HANDOFF_YYYY-MM-DD_short-topic.md and fill in. Keep the header
     block below verbatim and first: the next session must see the gates before
     it sees any content, because everything after them is unverified for it. -->

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

# HANDOFF 2026-07-31 — fuck claude: <one line on what this session did>

## The one thing to know first

The single fact that changes what the next session does. Not a summary — one
fact, with its proof. If the most important thing is that something is broken,
lead with that.

## State, verified this session

| Thing | State | Proof |
|---|---|---|
| Branch | | `git rev-parse --abbrev-ref HEAD` |
| Test suite | | the command and its real counts |
| | | |

Every row needs the Proof cell filled. A row without a proof belongs in the
"Unverified" section below, not in this table.

## What landed

One subsection per change. Each one says what it does, where it lives
(`file:line`), and what proves it works. A change with no proof is "written",
which is not the same as "works" and not the same as "shipped".

### <change>

- What it does:
- Where:
- Proof:
- Rollback:

## What did NOT land

Started and unfinished, with the exact remaining step. Never let a reader infer
completion from silence.

| Item | How far it got | Exact next step |
|---|---|---|
| | | |

## Corrections — do not re-inherit the wrong ones

The most valuable section in the file. Every claim from an earlier session that
turned out to be false, with the truth and its proof. A wrong claim that is
deleted rather than corrected gets rediscovered and re-believed.

| Earlier claim | Truth | Proof |
|---|---|---|
| | | |

## Open work, in priority order

Highest value first, with enough detail that a session with no context can pick
up the top item. Name the insertion point — the exact file and line where the
work starts — not just the goal.

## Things that will bite you

Traps found the hard way this session. Each one needs a trigger (what you would
observe), a citation, and the fact. "Be careful with the importer" helps nobody;
"the importer silently accepts an empty file and writes zero rows —
`importer.js:88`, no error, exit code 0" stops the next session cold.

## Still unverified

Everything believed but not checked against a primary source this session.
Listing it here is what keeps it from being read as fact.
