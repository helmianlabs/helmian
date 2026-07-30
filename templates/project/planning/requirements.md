# {{PROJECT_NAME}} — requirements

<!-- Filled in by the architect BEFORE any coding tool opens the project. The
     honest-starting-point section is the load-bearing one: it is what stops a
     builder from inventing a cause it was never given. -->

**Created:** {{CREATED_DATE}}

## Goal

One bounded outcome, stated so that two people would agree on whether it
happened. Not "improve the importer" — "the importer accepts a file with a
missing trailing newline instead of throwing".

## Honest starting point

State plainly what is known and what is not. This section is worth more than
the rest of the file combined, because everything downstream inherits it.

- **Known, with a source:** each fact plus where it came from — `file:line`, a
  command and its real output, a docs URL plus the sentence quoted.
- **Searched and found nothing:** name the search and its zero result, e.g.
  "searched the whole tree for a retry helper — zero matches". A recorded
  zero-match is a finding. Its absence is what makes the next session invent
  one.
- **Hypotheses, labelled as hypotheses:** a lead with code-grounded reasoning
  and a `file:line`, explicitly marked as not-yet-a-cause. Never write a lead
  as though it were the answer; a builder handed a confident guess will
  confirm it.
- **Unknown:** the questions nobody has answered yet, and who could answer
  them.

## Constraints

Everything the work must respect. Be specific — a vague constraint is not
enforceable.

- Out-of-bounds paths: directories nothing may modify, and why.
- Actions that need an explicit yes first: irreversible ones, anything that
  touches shared or live state, anything that spends money.
- Environment facts that cannot be changed: runtime version, offline-only,
  platform, a build that cannot run here.
- Rules about history: whether commits are allowed, whether pushes are, and
  what the rollback is.

## Non-goals

What this project deliberately does NOT do. An unwritten non-goal becomes
scope creep the first time someone is unsure.

- ...

## Why this scope was chosen

Small enough to finish, falsifiable enough to grade, and it exercises the
parts of the process that are worth testing. If the scope cannot be defended
in three sentences it is probably two projects.

## Success, in one sentence

The single sentence that will be pasted into the handoff when this is done.
Write it now, while it is still a target and not a rationalisation.
