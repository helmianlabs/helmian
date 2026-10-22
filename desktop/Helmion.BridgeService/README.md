# Helmian PC Bridge service (optional, spec 3.6)

A Windows service that keeps `bin/pc-bridge.mjs` (or a packaged `pc-bridge.exe`) running from boot with no
console window, restarting it with backoff (2s doubling to 5 min). Separate from the Helmian EXE.

- **Opt-in:** `scripts/Install-HelmianBridge.ps1` shows a plain-language disclosure and installs nothing unless the
  user types `I AGREE`. It records consent in `%ProgramData%\Helmian\bridge-consent.json`; the service refuses to start
  the bridge without that record.
- **Runs as the user** (not LocalSystem) because the bridge's device token and vault live in the user's profile.
- **Outbound only;** provider keys stay in the PC vault (019 contract).
- **Off:** `scripts/Uninstall-HelmianBridge.ps1` or stop `HelmianBridge` in services.msc.

Build: `dotnet publish desktop/Helmion.BridgeService -c Release -r win-x64 --self-contained`.
It also keeps the hands spoke (`bin/hands-spoke.mjs`, no arguments) running as you with no window, once you have paired it with `node bin/hands-spoke.mjs pair`. Not paired means it is skipped and checked again each minute. Both children restart with backoff (2s doubling to 5 min).

Install (elevated PowerShell, from the repo root): `dotnet publish desktop\Helmion.BridgeService -c Release -r win-x64 --self-contained -o $env:TEMP\HelmianBridge; powershell -ExecutionPolicy Bypass -File $env:TEMP\HelmianBridge\scripts\Install-HelmianBridge.ps1 -HelmianRoot $PWD.Path`

Tests (any OS): `dotnet run --project desktop/Helmion.BridgeService.Tests`.

Status: publishes for win-x64; launch planning tested; not yet installed on a Windows PC. Remote PC control stays off until Troy gives a direct OK.
