# Herald desktop adapter boundary

This folder owns the desktop half of Helmian Herald. The safe Core gateway is
implemented and tested here; WPF still needs to supply the real selected
project/session snapshot and the existing session-owned Maestro delegates.

The adapter must call Maestro through an approved in-process or authenticated
local-service contract. It must never call a provider directly from the phone
server and must never expose a shell, arbitrary filesystem operation, installer,
credential, or unscoped tool route.

Implemented:

- `HeraldDesktopGateway.cs` — sanitized snapshot, instruction/approval schemas,
  selected-context and confirmation checks, delegation, and request/result
  audit records.
- `HeraldDesktopGatewayChecks.cs` in Desktop.SmokeTests — thirteen checks covering
  confirmed input, changed context, unavailable desktop, approvals, audit, and
  absence of path/secret/token/file fields in the phone snapshot.
- `HeraldDesktopPipe.cs` — bounded, current-user-only local IPC with a closed
  presence/session/instruction/approval action set.
- `HeraldAuditStore.cs` — append-only request/result metadata with no instruction
  text or credential content.

`MainWindow.Herald.cs` now supplies the selected project/session snapshot and
delegates ordinary remote text into the existing Maestro path. It refuses shell
escapes, slash controls, locally staged attachments, changed context, busy state,
and unavailable desktop state. The Integrations button is the sole sharing start.

The desktop UI portion belongs in a narrow partial such as
`desktop/Helmion.Desktop/MainWindow.Herald.cs`: start/stop sharing, display a
short-lived pairing code/QR route, list paired devices and scopes, and revoke a
device. Starting sharing must always be explicit.
