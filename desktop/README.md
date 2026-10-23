# Helmian Desktop

The Windows desktop Pilot and its local services. The product is **Helmian**;
project, folder, and executable-internal names retain the original `Helmion`
spelling where changing them would break existing installs.

## Pieces

- `Helmion.Desktop/` — the WPF Pilot app (`Helmian.exe`).
- `Helmion.Desktop.Core/` — shared desktop logic, providers, Guard, Herald,
  voice, and project stores.
- `Helmion.LocalService/` and the LocalService protocol/security projects —
  the current-user local service the Pilot talks to.
- `Helmion.BridgeService/` — the optional background PC bridge; see its
  [README](Helmion.BridgeService/README.md).
- `Helmion.Voice.Host/` — the separate voice host process.
- `installer/` — the Inno Setup script and desktop release workflow source.
- `scripts/` — publish, QA, icon, and voice-model scripts.

## Build and run

Use Windows with the .NET 10 SDK. From the repository root:

```powershell
npm run desktop:verify
npm run desktop:run
```

`desktop:verify` builds the solution and runs the desktop smoke tests.
`desktop:package` publishes the Pilot pack; `desktop:qa` runs the QA package
checks. The desktop app is not yet published as a one-download installer.

## Current finish lists

- [Desktop punch list](DESKTOP_PUNCHLIST.md)
- [Voice punch list](VOICE_PUNCHLIST.md)
- [Herald desktop notes](Helmion.Desktop.Core/Herald/README.md)
- [Remote-control notes](Helmion.Desktop.Core/RemoteControl/README.md)
