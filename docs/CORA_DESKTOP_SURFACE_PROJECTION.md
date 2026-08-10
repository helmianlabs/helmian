# Cora desktop surface projection

`src/cora/desktop-surface-intent-projection.mjs` is the sample-safe seam from
Cora's typed tenant-surface plan to the known Helmian desktop shell. It uses
the existing `planCoraSurfaceIntent()` validation and returns a frozen
`cora.desktop-surface-intent-projection.v1` result.

The known desktop page mappings are intentionally limited to the pages the
Helmian desktop shell actually has today: Overview, Activity, Workspace,
Integrations, Settings, Console, and Approvals. The projection returns
`navigation: "not_performed"`; it never calls the desktop navigator, launches
an application, opens a browser, or changes a selected page.

Operations surfaces such as fleet, dispatch, loads, driver work, pre-trip,
payroll, money, settlements, and notifications return
`awaiting-desktop-surface`. This is deliberate: Cora must not claim it opened
or controlled a desktop feature that does not exist in the Helmian desktop
shell yet. Their original sample plan, tenant/role scope, audit reference, and
approval gates remain available to a future desktop host.

This is the first connection point for Cora's desktop "hands": a future UI
adapter may display one known-page preview, then invoke navigation only through
a separately authorized desktop action boundary. Real provider calls,
credentials, network access, mutations, submissions, notifications,
authorization decisions, and cross-tenant access remain out of scope.
