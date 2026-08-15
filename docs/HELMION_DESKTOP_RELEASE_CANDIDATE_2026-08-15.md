# Helmian Desktop release candidate (2026-08-15)

The self-contained Windows `win-x64` publish was produced from source commit
`2170c9e` (origin override) plus the audited release docs. The publish output
includes `Helmian.exe`, `Helmion Local Service.exe`, the protocol/security
assemblies, and the .NET runtime, so a target machine does not need .NET 10
installed.

This is an **unsigned release candidate**, not a production installer. The
candidate has not been uploaded or distributed. Signing requires the approved
Helmian code-signing certificate and its protected signing workflow; no
certificate or private key was found or accessed during this task.

Before signing/distribution:

1. Prove the hosted Herald/OAuth routes on the selected origin. Configure
   `HELMION_HERALD_ORIGIN` to that approved HTTPS origin at install/runtime;
   the desktop allowlist accepts only `helmian.vercel.app` and
   `helmian-cloud.fly.dev`.
2. Run the desktop and Local Service smoke suites on a clean Windows machine.
3. Repeat the payload scan for long-form provider/database credential patterns,
   and record the SHA-256 of the final signed artifact.
4. Sign the installer and executable, then verify the Authenticode signature
   from a second clean machine before any customer delivery.

No database URL, provider secret, OAuth secret, or tenant data is bundled by
the publish command. Provider credentials remain user-entered/local-service
inputs and are not release configuration.
