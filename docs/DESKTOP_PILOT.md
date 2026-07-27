# Helmion Windows desktop pilot

## Scope

Phase Five begins with a native Windows control center. It is a genuine
end-to-end Personal Pilot foundation, not yet a commercial or
production-ready control plane.

The first shell uses WPF on .NET 10 because the Windows Desktop runtime and SDK
are already present, it produces a native `.exe`, and it needs no browser
runtime, Rust toolchain, JavaScript desktop framework, or third-party UI
package.

The current operational boundary is deliberately narrow:

- the selected-workspace inventory can be live-local and read-only;
- handoff, approval, and historical evidence cards remain visibly marked as
  demo where their durable provider is not connected;
- no database client or connection field exists in the desktop state model;
- no environment credentials are read;
- no agent configuration is discovered or modified;
- no approval or external action can execute;
- advanced owner signing is optional and shown as not configured; and
- the app claims no external or destructive authority.

Routine bounded local work remains enabled by the existing pilot policy. The
dashboard does not add a bypass for high-risk, lease, blocker, or confirmation
rules.

## Screens

- **Overview:** personal-pilot posture, workspace metrics, evidence feed, and
  risk guardrails.
- **Workspace:** authenticated service status, folder registration, actual
  project root/branch, local migration hashes, evidence inventory, honest
  lease posture, and the observe/evaluate/evidence flow.
- **Console:** interaction-mode foundation for dashboard, a later
  service-brokered CLI console, later IDE adapters, and a later Helmion-owned
  voice layer. Command execution is off in this read-only slice.
- **Live activity:** Orchestration Timeline design mock for provider routing,
  Maestro decisions, review findings, blockers, tests, checkpoints, and
  handoffs. Every current event is marked demo and non-evidence-backed.
- **Evidence:** handoff history and the checkpoint/handoff/durability contract.
- **Approvals:** non-actionable policy previews plus the clear
  `Advanced owner signing — Not configured` state.
- **Integrations:** provider registry, filename-only local tool availability,
  coordinator/authority boundaries, exact isolated development target, and
  safe connection design.
- **Release roadmap:** clearly non-implemented multi-user architecture for
  tenants, roles, invitations, audit, approvals, integrations, and signed
  distribution.
- **Settings:** explicit demo/live state, safety defaults, and build identity.

The exact Personal Pilot activation sequence, provider profiles, Policy Pack,
voice boundary, and required user inputs are in
[PERSONAL_PILOT_ACTIVATION.md](PERSONAL_PILOT_ACTIVATION.md). The later
commercial architecture is in
[MULTI_USER_RELEASE_ROADMAP.md](MULTI_USER_RELEASE_ROADMAP.md).
A portable learning/policy setup bundle is specified separately in
[HELMION_PROFILE_PACKAGE.md](HELMION_PROFILE_PACKAGE.md); no source folder
inventory or package export is implemented yet.
The real-time event, evidence-link, and recording/redaction requirements are in
[LIVE_ACTIVITY_STREAM.md](LIVE_ACTIVITY_STREAM.md).

## Color themes

Settings includes one keyboard-accessible color-theme selector with:

- Helmion green;
- Ocean blue;
- Clean light; and
- Warm earth.

Themes change presentation only. They do not change data sources, authority,
policy, leases, approval behavior, or integration state. The selected stable
theme ID is stored for the current Windows user at
`%LOCALAPPDATA%\Helmion\desktop-settings.json`. The file contains no
credentials or operational state. Missing, unreadable, malformed, or unknown
settings safely fall back to Helmion green.

## Local-service boundary

The first read-only architecture is implemented:

```text
WPF desktop shell
    ↕ authenticated typed IPC on loopback
Helmion local service
    ├─ read-only workspace inventory
    ├─ filename-only CLI capability detection
    └─ future policy, lease, adapter, and durable-state interfaces
```

The desktop remains presentation and owner-interaction code. The local service
must own future credentials, database connections, adapter processes, and
write authorization. The implemented service uses a current-user-only named
pipe and verifies the server executable path from the client. It exposes only
`hello`, `workspace.inspect`, and `capabilities.detect`; unknown/write commands
fail closed.

The CurrentUser-DPAPI provider store is implemented in a service-only assembly
and tested with disposable fixture bytes. Normal app startup does not create or
use it, and no enrollment or connection command exists yet. Future enrollment
must never accept or return secrets through renderer fields, logs, chat,
command arguments, history, source control, or fixtures.

## Build and run

From a Windows PowerShell terminal:

```powershell
cd E:\Helmion
dotnet build .\desktop\Helmion.Desktop.slnx --configuration Debug
dotnet run --project .\desktop\Helmion.Desktop\Helmion.Desktop.csproj
```

Run the dependency-free state smoke checks:

```powershell
dotnet run --project .\desktop\Helmion.Desktop.SmokeTests\Helmion.Desktop.SmokeTests.csproj
```

Render the compiled UI to an offline QA image:

```powershell
dotnet run --project .\desktop\Helmion.Desktop\Helmion.Desktop.csproj -- `
  --render-preview .\artifacts\desktop-qa\overview.png
```

## Package

Create the default self-contained, single-file Windows x64 pilot executable:

```powershell
npm run desktop:package
```

The script publishes the desktop and its paired local-service executable to
`artifacts\Helmion-Pilot-win-x64-self-contained`, runs both packaged smoke
tests, and reports their SHA-256 hashes.
The build generates the Helmion application icon deterministically from the
local `desktop/scripts/build-icon.ps1` source.

For a much smaller package that relies on an installed .NET 10 Windows Desktop
runtime:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File .\desktop\scripts\publish.ps1 -FrameworkDependent
```

The pilot executable is unsigned and has no installer or auto-update channel.
Those are explicit future release-engineering steps; do not describe this
artifact as production-ready.

## Remaining activation work

Before any live integration:

1. threat-model and implement service-owned enrollment around the protected
   store;
2. implement the existing typed redacted identity/scope/target test contract
   for one integration;
3. activate one read-only canary at a time;
4. add durable lease, handoff, and history reads;
5. bind every write to the existing lease and operation policy;
6. add owner decisions only through an explicitly configured signing path;
7. add health, audit, reconnect, and schema-compatibility states; and
8. threat-model, sign, install, and update the Windows package.
