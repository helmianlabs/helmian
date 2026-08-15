# Helmian Desktop production-release audit (2026-08-15)

Scope: the checked-out desktop source at `E:\Helmion\desktop\Helmion.Desktop`,
branch `main`, commit `0256f7d25e994977a6c900cad029528801ba4c08`, remote
`https://github.com/helmianlabs/helmian.git`. This is a source audit only; no
installer was built, published, uploaded, or installed.

## Identity and release boundary

- Desktop target: `Helmion.Desktop` (`net10.0-windows`, `WinExe`).
- The current local release output is a framework-dependent build tree, not a
  signed installer or a self-contained production package.
- No `DATABASE_URL`, provider key, OAuth secret, PEM/key, or token literal was
  found in the inspected source files or the release output filenames. Values
  must still be scanned by CI before packaging; this audit never prints or
  reads secret values.
- The desktop UI intentionally accepts user credentials and passes them to
  child provider processes. That is a desktop-local credential boundary, not a
  reason to embed credentials in an installer.

## Blocking finding: stale hosted origin

The desktop Herald path previously hard-coded `https://helmian.vercel.app` in
`MainWindow.Herald.cs`; commit `2170c9e` now accepts the explicit
`HELMION_HERALD_ORIGIN` environment override, restricted to the approved
Vercel and Fly hosts, and applies the same origin to QR validation. The Local
Service default in `Helmion.LocalService/Program.cs` and the hosted OAuth setup
copy in `Helmion.LocalService.Security/TeamProviderAdapters.cs` still use the
Vercel default. The canonical cloud deployment is the Fly app
`helmian-cloud` (`https://helmian-cloud.fly.dev`).

Do not call a desktop build production-ready until the hosted origin is chosen
and updated consistently across the desktop, Local Service, Herald CLI, OAuth
callback instructions, and the deployed web routes. A blind string replacement
is unsafe because the current web source still contains Vercel-specific Herald
routes and tests. Required follow-up is an integrated origin change with a
positive pairing/QR test and a deployed route check.

## Packaging checklist

Before distributing a Windows installer:

1. Build from a clean, reviewed commit with a pinned Windows RID and a
   self-contained publish profile; do not ship the ad-hoc `bin/Release` tree.
2. Exclude PDB files, source maps, test fixtures, `.env*`, database dumps,
   provider credentials, OAuth client secrets, and local logs from the payload.
3. Verify the payload contains no credential-shaped literals (`sk-*`, `AIza*`,
   `ghp_*`, `xai-*`, database URLs, private keys) without printing matches.
4. Verify child-process environments are least-privilege. `MainWindow.Herald`
   already removes provider/database/relay secrets before starting the Herald
   shell; preserve that test.
5. Verify all remote origins are HTTPS and belong to the approved production
   host. Loopback endpoints are permitted only for local OAuth/voice callbacks.
6. Run desktop smoke tests, Local Service protocol/security tests, and a
   clean-install launch test on a machine without the developer checkout.
7. Sign the installer and record SHA-256, source commit, RID, .NET runtime
   requirement, and rollback artifact before any release upload.

## Safe current conclusion

Source-level credential handling is bounded, but the desktop release is **not
production-ready** while the Vercel/Fly origin mismatch remains unresolved and
the output is an unsigned framework-dependent build tree. No live state was
changed by this audit.
