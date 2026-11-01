# helmian-door — preserved source snapshot

This directory preserves the source of **helmian-door**, the door service
that serves the owner's approvals page at `connect.helmian.cloud/approvals`
(and fronts the one-door MCP gateway to the Scribe memory backend and the
PC hands backend). It was built and edited directly on the Hetzner host and,
until this commit, existed in no repository. This commit is a
**source-preservation snapshot only**: the bytes are preserved exactly as
inspected — nothing cleaned up, nothing fixed, no behavior changed. Cleanup
or fixes belong in separate follow-up changes.

## The working approvals path

```
browser → Caddy (connect.helmian.cloud) → helmian-door :8099
        → Executive Guard :8787 → decision recorded,
          page served back through the door
```

The door renders the pending list from the Guard, takes the owner's
decision, and forwards it to the Guard server-side with the door's own
approver credential (`GUARD_APPROVER_TOKEN`, read from the process
environment — see `src/config.mjs`); the credential never reaches the
browser. The routes exist only when that credential is configured
(fail closed).

## Verification

- Verified 2026-10-31 by read-only inspection: the running container's
  source is byte-identical to the host build tree it was baked from, and
  matches no file in this repository's history on any branch.
  Record: `door-provenance-verification/VERDICT.md` (owner's workspace,
  2026-10-31). The receiving end of the path is verified separately:
  the Executive Guard's running source is byte-identical to
  `feat/executive-guard` @ `8c6e6f84`
  (`executive-guard-verification/VERDICT.md`, 2026-10-31), and the Fly.io
  hub is not on this path (`hub-door-verification/VERDICT.md`, 2026-10-31).
- `MANIFEST.sha256` lists the sha256 of every preserved snapshot file, so
  this commit is provably the inspected snapshot
  (`src/approvals.mjs` = `a10f98c312c6e689…`). Run `sha256sum -c
  MANIFEST.sha256` inside this directory to re-check. `README.md` and
  `MANIFEST.sha256` are the only files added by the preservation itself.

## Provenance of the parts

- **Source files (15, incl. the four `.bak-*` files as found):** byte-exact
  copies of the running door's source (image `helmian-door:1.0.2-approvals`,
  created 2026-10-28; workdir `/srv/helmian-door`).
- **Dockerfile:** the original from the host build tree — not a
  reconstruction.
- **package-lock.json:** the original lockfile from the running tree —
  not regenerated.

## Secrets check

Before committing, every preserved file was read in full and scanned for
embedded secrets (credential-shaped literals, private keys, `.env` files,
URLs carrying credentials; the lockfile was checked for auth fields and
non-registry download URLs). **Result: clean.** The door takes every
credential from its process environment (`AUTH_PASSPHRASE`,
`GUARD_APPROVER_TOKEN`, `GUARD_URL`, backend resource ids) or from runtime
state files under its state directory — none of those values, and no state
file, is in this snapshot.

## Scope note

Preserved 2026-10-31 by the owner's decision. This commit did **not**
change, redeploy, or restart the running service, and it is not a merge to
`main`. The door is now hash-pinned to the inspected snapshot; it is not
yet part of a maintained release line. **Source matching is not security
validation** — the passphrase login, session cookie, and
decision-forwarding protections still need their own review before the
approvals path can be called verified end to end.
