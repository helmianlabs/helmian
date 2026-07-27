# Phase Two: guarded Neon development verification

## Safety boundary

This runbook targets a separate, newly created Neon project. It must not be
run against the database used by the existing Claude system.

Before opening a database connection, the operator must confirm in the Neon
Console that:

1. the selected project name is `Helmion Development`;
2. the project ID shown under **Settings → General** is the intended new
   development project;
3. the **Connect** modal is still scoped to that project, branch `main`, and
   the intended database (normally `neondb`); and
4. the non-secret endpoint ID from the connection hostname is recorded. It is
   the leading `ep-...` label; remove a trailing `-pooler` if present.

The CLI compares that endpoint ID to the connection URL before constructing a
database pool. A mismatch fails with `no connection was opened`.

## Local-only credential entry

Do not paste a Neon connection string into chat, a command argument, a
checked-in file, or shell history. In the PowerShell session that will run the
commands, use a hidden prompt:

```powershell
$helmionSecret = Read-Host 'Paste the Helmion Development connection string' -AsSecureString
$helmionSecretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($helmionSecret)
try {
  $env:HELMION_DATABASE_URL =
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($helmionSecretPointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($helmionSecretPointer)
  Remove-Variable helmionSecretPointer
  Remove-Variable helmionSecret
}
$env:HELMION_EXPECTED_ENDPOINT_ID = 'ep-replace-from-confirmed-connect-modal'
```

This keeps the credential out of the command line and PowerShell history. The
child Node process necessarily receives it in its local environment. Do not
use `setx`, which would persist the secret.

The fresh-project owner role is appropriate for the one-time schema bootstrap.
The migrations create a new `helmion` schema and therefore cannot be applied
by a role that lacks database `CREATE`. Configure a schema-scoped application
role after bootstrap.

## Read-only preflight

From `E:\Helmion`:

```powershell
node .\bin\helmion.mjs db-inspect
```

Stop unless all of these are true:

- `target.endpointId` equals the endpoint confirmed in the Neon Console;
- `identity.database_name` is the intended development database;
- `helmion.schemaExists` is `false`; and
- every checked-in migration has status `pending`.

The command reports only a sanitized host/endpoint, database name, role name,
server version, schema objects, and migration checksums. It never emits the
connection string or password.

## Apply and verify migrations

Only after the preflight passes:

```powershell
node .\bin\helmion.mjs migrate --require-empty-helmion
node .\bin\helmion.mjs db-inspect
```

The first command aborts if the `helmion` schema already exists. The second
must report `migrationsReady: true`, every migration as `applied`, and no
unexpected migrations.

If a network interruption occurs after one migration commits, inspect before
retrying. Do not use `--require-empty-helmion` on the reviewed retry; the
checksummed runner safely skips a matching committed migration and applies
only pending migrations.

## Isolated real database switch test

Run:

```powershell
node .\bin\helmion.mjs phase-two-switch-test
```

The command refuses project slugs outside the `helmion-phase-two-*` namespace.
Its default isolated project is `helmion-phase-two-switch-test`. It:

1. verifies that every checked-in migration is applied with a matching
   checksum;
2. idempotently creates the isolated test project row;
3. acquires a five-minute lease for
   `codex/helmion-phase-two-test-codex`;
4. commits a structured checkpoint;
5. atomically transfers the lease to
   `claude/helmion-phase-two-test-claude`;
6. reads back the target lease and complete handoff; and
7. releases the target test lease, leaving no active lease.

Success reports:

```text
codexLeaseCommitted: true
checkpointCommitted: true
transferCommitted: true
handoffStatus: COMPLETE
targetCoordinator: claude
targetLeaseReleased: true
activeLeaseAfterTest: null
```

The operation and handoff rows remain as durable development evidence. The
command is idempotently replayable after a partial client-side interruption.
It exercises the database switch seam but does not claim a live Claude adapter
exists, and it never reads or modifies Claude configuration or hooks.

## Clear the local credential

When finished:

```powershell
Remove-Item Env:HELMION_DATABASE_URL
Remove-Item Env:HELMION_EXPECTED_ENDPOINT_ID
```
