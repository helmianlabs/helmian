# Helmian PC Bridge (optional, spec 3.6)

Keeps `bin/pc-bridge.mjs` (or a packaged `pc-bridge.exe`) and, once paired, the hands spoke (`bin/hands-spoke.mjs`)
running in the background with no window, restarting each with backoff (2s doubling to 5 min). Separate from the Helmian EXE.

## Two ways to run (same exe)

- **Default: sign-in task, no password.** A hidden Task Scheduler task starts the exe when you sign in, as you,
  with normal rights. No Windows password is asked for or stored, and no admin rights are needed unless you
  install under Program Files. Default folder: `%LOCALAPPDATA%\Programs\Helmian\Bridge`.
- **Optional: Windows service (`-Mode Service`).** Starts at boot. Needs an elevated PowerShell and your Windows password.

The exe is a windowless app (WinExe), so it runs fine as a plain process; outside the service manager
`AddWindowsService` does nothing. Child node processes start with `CreateNoWindow`, stdin closed, and inside a
kill-on-close job, so stopping or killing the exe never leaves them behind. Only one copy runs per PC.

## Install

From the publish folder (no admin needed for the default):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Install-HelmianBridge.ps1 -HelmianRoot E:\Helmion
```

- Checks free space first. If the target drive is too full, it names a fixed drive with room
  (for example `E:\HelmianService`) and asks before using it. `-Yes` accepts without asking; `-InstallDir` picks a folder.
- Writes `helmian-bridge.json` next to the exe with the Helmian folder, and sets `HELMIAN_ROOT` for your account.
- **Opt-in:** shows a plain-language disclosure and installs nothing unless you type `I AGREE`. Consent is recorded in
  `%ProgramData%\Helmian\bridge-consent.json`; the bridge will not start without it.
- **Outbound only;** provider keys stay in the PC vault (019 contract).

Logs: `%LOCALAPPDATA%\Helmian\logs\bridge-service.log` (also Event Viewer, source "Helmian Bridge", when installed elevated).

Off: `scripts\Uninstall-HelmianBridge.ps1` removes the sign-in task (and the service, when run elevated).

## Build and test

- Publish: `dotnet publish desktop/Helmion.BridgeService -c Release -r win-x64 --self-contained -o <folder>`
- Tests (any OS): `dotnet run --project desktop/Helmion.BridgeService.Tests` and
  `pwsh -NoProfile -File desktop/Helmion.BridgeService.Tests/Installer.Tests.ps1`

Remote PC control stays off until Troy gives a direct OK.
