# DairyForge Integration Boundary

## Deployment map

| Concern | Production surface | Rule |
| --- | --- | --- |
| Public product and app | `dairyforge.com` | Do not expose Helmion internals publicly. |
| Helmion UI | `dairyforge.com/admin/helmion` | Require an explicit owner/admin role. |
| Helmion API | `api.dairyforge.com/internal/helmion` | Server-to-server and authenticated admin access only. |
| Governance state | Neon PostgreSQL, `helmion` schema | Use a schema-scoped least-privilege role. |
| Local enforcement | Developer workstation | This remains the only execution/write lane. |
| Model advisors | Vendor APIs | Read-only proposals and immutable action hashes only. |

## API slice

The first hosted slice should expose:

- `GET /internal/helmion/projects/:slug/context`
- `GET /internal/helmion/projects/:slug/blockers`
- `POST /internal/helmion/blockers/:id/resolve`
- `POST /internal/helmion/actions`
- `POST /internal/helmion/actions/:hash/reviews`
- `GET /internal/helmion/actions/:hash/consensus`
- `GET /internal/helmion/as2/stale`

The API must call the same governance functions exported by this package. It
must not reimplement proof validation or consensus in route handlers.

## DairyForge repository safety

The active local repository is:

```text
C:\Users\troyh\dairyforge-monorepo
```

It currently contains unrelated active EDI and schema changes. Integrate
Helmion through a dedicated branch/worktree only after this standalone kernel
is committed. Do not mix the control-plane dashboard with the existing EDI 204
conformance changes.

## Authentication boundary

The admin UI may reuse DairyForge's existing authenticated session, but the API
must enforce the owner/admin role independently. Workstation enrollment and MCP
servers need separate signed service credentials with:

- a workstation identifier;
- a tenant/project allowlist;
- a short expiration;
- revocation support; and
- no permission to access driver, payroll, or plant production records.

## Rollout order

1. Apply `sql/001_helmion.sql` with a schema-scoped database role.
2. Add read-only context and blocker endpoints.
3. Add resolution writes with the proof validator.
4. Add advisory review recording and consensus display.
5. Enroll one canary workstation with `severity: flag`.
6. Promote specific rules to `block` only after reviewing canary evidence.
7. Add stale AS2 alerting after the transport records use the new state
   machine.
