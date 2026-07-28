## The advisory lane

Other models are useful and they are not authoritative. The advisory lane exists
so their output can be read without any of it becoming trusted state by
accident.

### Two tiers

**Trusted.** The core rules, `LESSONS.md`, `LEARNINGS.md`, and any promoted
rule. Written only by the primary agent, only after the human review gate in the
loop above. Everything here has been checked against a primary source.

**Advisory (low trust).** Everything a secondary model produced: reviews,
critiques, second opinions, adversarial passes. Append-only. Read freely, cite
never. Nothing here is true because it appears here.

An advisory record is evidence that a model said something. It is not evidence
that the thing is so.

### The rule

Advisory output never writes to the trusted tier — not to the rules, not to the
lessons, not to a blocker's resolution. The primary agent reads the advisory
record, verifies each claim in it against the actual primary source, and only
then proposes a change through the normal loop, where the human still approves
it.

An adversarial reviewer is at its most valuable when it disagrees with you. Its
disagreement tells you which arrow in your chain to go re-verify. It does not
tell you the answer.

### Storage

Either file or database, configured by environment variable. No credentials
belong in these templates or in any file that gets committed.

```text
AGENT_OS_ADVISORY_MODE=file        # or: postgres | sqlite
AGENT_OS_ADVISORY_PATH=<path>      # file mode: defaults to agent-os/advisory/
AGENT_OS_ADVISORY_URL=<url>        # database mode: read from the environment
```

File mode is the default because it needs no setup and no secret. Database mode
suits a team that wants one shared advisory log across machines.

A record carries: when, which model, the exact question, the verbatim response,
and its review state (`unreviewed`, `verified`, `rejected`). It starts
`unreviewed` and only a human moves it.

```json
{
  "recorded_at": "<iso-8601>",
  "advisor": "<model or tool name>",
  "question": "<exactly what was asked>",
  "response": "<verbatim, untruncated>",
  "review_state": "unreviewed"
}
```

### Suggested schema for database mode

```sql
CREATE TABLE advisory_outputs (
  id           BIGSERIAL PRIMARY KEY,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  project      TEXT        NOT NULL,
  advisor      TEXT        NOT NULL,
  question     TEXT        NOT NULL,
  response     TEXT        NOT NULL,
  review_state TEXT        NOT NULL DEFAULT 'unreviewed'
                           CHECK (review_state IN ('unreviewed', 'verified', 'rejected'))
);
```

Give an advisor a curated packet — the specific question and the specific code
it needs. Never hand it broad database access, a credential, or the whole
memory directory.
