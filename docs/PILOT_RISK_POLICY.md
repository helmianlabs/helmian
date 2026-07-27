# Windows pilot risk policy

## Outcomes

`evaluatePilotAction` in `src/core/pilot-policy.mjs` has three outcomes:

| Outcome | Meaning |
| --- | --- |
| `AUTO_RUN` | Routine Tier A work may proceed without interrupting the owner. |
| `PAUSE_FOR_OWNER` | Tier B work pauses until the owner reviews the exact action and chooses `APPROVE` or `DECLINE`. |
| `BLOCK` | A deterministic guardrail failed. Approval does not override it; fix the guard condition first. |

Advisor consensus never changes an outcome to `AUTO_RUN` and cannot authorize
Tier B.

## Tier A: automatic inside guardrails

Automatic work must state all of these explicitly:

- `pilotScope: "local-workspace"`;
- `wellBounded: true`;
- `reversible: true`;
- `sensitiveData: false`;
- no protected-boundary flag; and
- no deterministic guard, block rule, active scoped blocker, lease conflict,
  or unverifiable shared state.

Examples include local code edits, local unit tests, read-only inspection, and
reversible workspace artifacts when they satisfy those fields.

Missing or ambiguous fields do not default to low risk. They pause for owner
review.

For local integration checks, pipe `{ "operation": ..., "guardState": ... }`
JSON to:

```powershell
node .\bin\helmion.mjs pilot-policy
```

It exits `0` for auto-run, `2` for owner pause, and `3` for a hard block.

## Tier B: owner decision required

The policy pauses for:

- schema or migration changes;
- production-data access;
- authentication changes;
- cross-project contracts;
- destructive or irreversible changes;
- external/shared writes and deployments;
- credential or secret access;
- permission, identity-trust, or security-control changes; and
- any scope other than explicit `local-workspace`.

The request must include a plain-English `operation.description`. The Windows
approval tool displays that description, structured risk reasons, full
operation JSON, handoff, project, and exact action hash. Because the
description is inside `operation`, it is covered by the hash and signature.

`APPROVE` produces a five-minute Ed25519 assertion for only that project,
handoff, and operation. `DECLINE` produces no assertion. A signature expires
and is consumed once by the exact handoff target lease.

## Hard blocks

These pause no decision dialog because they are not approval-bypassable:

- deterministic destructive-operation guard block;
- active block-severity autonomy rule;
- active scoped blocker;
- missing/conflicting write lease; or
- unverifiable shared governance state.

The action may be reconsidered only after the underlying condition changes.

## Integration boundary

The policy function and CLI reference are local and deterministic. Existing
hooks keep their Phase One behavior until a pilot coordinator explicitly
supplies the structured operation and guard-state fields. This avoids silently
reclassifying existing workflows.

Flag-to-block rule promotion remains disabled. Human confirmation authorizes
only the exact handoff action and does not create a general production writer.
