# Maestro Phase One

## Goal and boundary

Phase One creates a Codex-side path beside the existing Claude system. It does
not edit Claude settings or hooks. Both future coordinator adapters use the
same customer-owned `helmion` schema in Neon/PostgreSQL.

Production Maestro state is not cached in a local lock file. Local adapter
objects are stateless clients of the database.

## Adapter modes

`createMaestroAdapter` is vendor-neutral. It binds a stable coordinator ID,
instance ID, store, and mode. `createCodexAdapter` binds the coordinator ID to
`codex`.

The Codex binding defaults to `read-only`. In that mode it can read project
state and the latest handoff, but it rejects lease, checkpoint, release, and
transfer calls before invoking the store.

The Codex MCP process follows the same rule. It does not even advertise write
tools unless `HELMION_CODEX_MODE=read-write` and a stable
`HELMION_CODEX_INSTANCE_ID` is provided.

## Switch sequence

1. The current coordinator holds the active project lease.
2. It creates a structured checkpoint containing work completed, changed
   files, test results, blockers, risks, and the next safe action.
3. A transfer transaction locks the project row and verifies the current lease
   token, coordinator ID, instance ID, status, and expiry.
4. The transaction verifies that the checkpoint belongs to that lease.
5. It closes the old lease, creates the target coordinator's lease, snapshots
   shared blockers/context/rules, generates a handoff, and commits all state.
6. Only after `COMMIT` does the caller receive
   `durability: "committed"`.

The partial unique index
`maestro_one_active_lease_per_project_idx` prevents a second active lease even
if application logic regresses. Project-row locking serializes contenders and
same-project idempotency checks.

## Checkpoint failure

If the old coordinator cannot create a checkpoint, transfer is allowed only
with a nonblank `incompleteReason`. The generated handoff has:

```json
{
  "status": "INCOMPLETE",
  "warning": "INCOMPLETE HANDOFF: ...",
  "requires_human_confirmation": true,
  "checkpoint": null
}
```

Tier A scoped work may continue with the warning visible. Tier B work such as a
schema migration, production-data access, authentication change, or
cross-project contract is denied while the incomplete handoff has no durable
human confirmation.

Phase One deliberately does not invent an unauthenticated confirmation
endpoint. The later local Phase Two primitive is documented in
`HUMAN_CONFIRMATIONS.md`; it still requires an authenticated owner/admin
enrollment path before live use.

## Retry behavior

Every governance write requires an 8-200 character idempotency key. The
database stores the operation type, canonical request hash, and committed
response under `(project_slug, idempotency_key)`.

- Same key and same request: return the original response with
  `replayed: true`.
- Same key and different request: reject with `IdempotencyConflictError`.
- Failed transaction: store no operation response and make no partial switch.

## Operation classes

| Class | Failure behavior | Commit requirement |
| --- | --- | --- |
| `shared-read` | Error is visible; callers cannot assume safe state | N/A |
| `governance-write` | Fail closed | Must return `durability: "committed"` |
| `telemetry` | Fail open with `failed_open: true` | Best effort |

Only optional health/usage telemetry belongs in the telemetry class.
Checkpoints, leases, handoffs, blockers, approvals, and policy state are
governance data.

## Migration contents

`002_maestro_phase_one.sql` adds:

- `maestro_operations`
- `maestro_leases`
- `project_checkpoints`
- `maestro_handoffs`
- `telemetry_events`

It does not alter or delete existing Claude-side tables, settings, hooks, or
local files.
