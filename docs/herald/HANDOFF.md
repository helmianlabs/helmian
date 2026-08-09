# Helmian Herald handoff

## Explain it simply

The desktop is the engine. The phone is a second steering wheel and dashboard.
The phone does not receive the engine, keys, project files, or a terminal.

Today the dashboard, locks, and message shapes are built and tested. The cable
from those message shapes to the real running Helmian session is not connected.

## How Anthropic Remote Control works

Anthropic keeps Claude Code running on the user's computer. That local process
opens outbound HTTPS/TLS connections to Anthropic; it does not open an inbound
port. Anthropic's service routes synchronized session messages between the local
process and Claude's web/mobile clients. Local tools and filesystem execution
remain on the computer, while the synchronized transcript is stored by
Anthropic. Short-lived credentials, account authentication, optional trusted
devices, and revocation protect access. If the local process stops, remote
control stops.

Official reference:
`https://code.claude.com/docs/en/remote-control`

## How Herald is being built

```text
Helmian Herald phone/PWA
        |
        | paired device credential + scoped request + one-time nonce
        v
First-party Herald transport
        |
        | authenticated outbound session; no public anonymous endpoint
        v
Helmian Desktop bridge
        |
        | selected project/session check + Guard policy + immutable audit
        v
Desktop-owned Maestro session
        |
        v
Official provider API / approved local capability
```

Thinking Buddy must not remain a required product in this chain. Its proven
relay transport is a useful starting point, but `hands.mjs`, the anonymous
browser proxy, direct provider secrets, a generic shell, file browser,
installer, or hidden command path do not belong in Herald.

## Existing relay: reuse it, but do not expose it unchanged

The connection previously proven with Thinking Buddy is real. Its deployed path
is HTTP polling, not the pending WebSocket implementation:

```text
Thinking Buddy browser
  -> Vercel /api/relay-proxy
  -> authenticated /api/relay-http
  -> Neon relay message/presence tables
  -> Helmian desktop polling client
  -> optional hands.mjs agent turn
```

The Helmian side already contains cursor replay, presence, reconnect/outbox,
bounded-frame protocol, and polling-client code under `src/relay/`, with tests
under `test/relay*.test.mjs`. The corresponding deployed prototype contains
`api/relay-http.js`, `api/relay-proxy.js`, `sql/relay.sql`, and
`lib/helmion-relay.js`. Its `_pending/relay.js` WebSocket route is optional and
was not the proven live path.

Reuse the polling protocol and reliability behavior as first-party Helmian
transport. Do not reuse the public proxy authority, fixed shared channel/secret,
or `hands.mjs` unchanged. Herald must add per-owner/per-device credentials,
expiry and revocation, scoped typed messages, selected project/session checks,
explicit approvals, and audit before anything reaches Maestro.

## Legacy Thinkin Buddy relay proof — 2026-08-01

This is evidence for the old Thinkin Buddy polling relay and `--hands` listener.
It is **not** evidence that the first-party Helmian Herald PWA, account identity,
device enrollment, or secure realtime transport is complete.

The observed Thinkin Buddy conversation began at `2026-08-01T06:52:01Z` and
completed after 569 seconds. ElevenLabs recorded two successful, non-blocked
`/api/browse` webhook calls; Vercel recorded successful relay POST traffic at
the corresponding times. The already-running desktop listener was PID 37964,
started on 2026-07-31 with `relay --hands` confined to
`E:\Helmion\mark-hands-test`.

### File `a.txt`

- `06:57:12.244Z`: Thinkin Buddy browse webhook returned 200.
- `06:57:12.473Z`: the legacy relay accepted a POST with status 200.
- `06:57:43.281Z`: listener PID 37964 began a Grok tool-call round.
- `06:57:43.403Z`: `E:\Helmion\mark-hands-test\a.txt` was created.
- `06:57:44.468Z`: the first listener round completed with response content.
- `06:57:45.997Z`–`06:57:46.833Z`: a second audited tool-call/response round
  touched the same file; its final write time is `06:57:46.019Z`.
- Verified result: the file exists but is empty (0 bytes), with the standard
  SHA-256 for an empty file.

### File `thankyoucodex.txt`

- `06:58:58.500Z`: Thinkin Buddy browse webhook returned 200.
- `06:58:58.648Z`: the legacy relay accepted a POST with status 200.
- `06:59:02.583Z`: listener PID 37964 began a Grok tool-call round.
- `06:59:02.586Z`: `E:\Helmion\mark-hands-test\thankyoucodex.txt` was created.
- `06:59:04.187Z`: the first listener round completed with response content.
- `06:59:06.219Z`–`06:59:07.376Z`: a second audited tool-call/response round
  touched the same file; its final write time is `06:59:06.221Z`.
- Verified result: the file exists but is empty (0 bytes), with the standard
  SHA-256 for an empty file.
- The reported name `thank-you-codex.txt` does **not** exist. The observed agent
  created `thankyoucodex.txt` without hyphens.

The timing proves the legacy sequence from the live Thinkin Buddy conversation,
through successful cloud relay calls, to the existing desktop listener, Grok
tool execution, and confined filesystem results. ElevenLabs redacts the spoken
transcript and does not provide hardware device attestation, so the logs cannot
cryptographically prove which physical handset originated the call or recover
the exact spoken wording. They are consistent with the user's reported phone
test. No current simulator process, recent simulator execution in Claude/Codex
history, or PowerShell simulator event was found. Windows Security process audit
was unavailable without elevation and Sysmon is not installed, so this is strong
correlated evidence rather than an absolute OS-level proof that no unrelated
process could have imitated the phone role.

No secret, credential, channel value, or usable send URL is recorded here. The
legacy public proxy still lacks first-party account/device/session identity and
must not be reused as Herald's production authority. Herald's target remains an
authenticated, revocable, desktop-owned path with scoped typed commands,
selected-project/session checks, explicit approvals, and immutable audit.

## What is complete

- Midnight mobile/PWA shell.
- Pairing code and device-bound credential.
- Expiry, revocation, scopes, and nonce replay denial.
- Sanitized status and honest offline/stale states.
- Project/session/agent/Guard/output mobile contract.
- Two-step review and confirmation for text instructions.
- Explicit allow-once/deny approval contract.
- Audited request/result hooks.
- Voice UI with an honest unavailable state.
- A closed, typed Herald request/result protocol over the existing bounded-text
  relay lane; raw text and unknown actions are refused before desktop access.
- Trusted-ingress and desktop-outbound polling adapters now use the proven
  `phone`/`desktop` relay roles, presence, wake, cursor, outbox, and reconnect
  behavior. The relay credential remains server-side and is not in PWA traffic.
- A desktop-owned Core gateway that rechecks selected project/session context,
  explicit confirmation, current approvals, and desktop availability before
  delegating to a Maestro callback.
- A current-user-only Windows named pipe joins the Node companion service to the
  running desktop gateway without opening a desktop network listener.
- An explicit Integrations card starts/stops the owned same-Wi-Fi Herald process,
  displays its local URL and short-lived pairing code, strips provider/database/
  relay credentials from that child, and stops sharing with the desktop.
- The phone UI renders recent output, two-step text review, and two-step Allow
  once/Deny approval review. Phone Voice remains honestly unavailable.
- Nineteen Herald tests, the existing relay suite, and thirteen desktop gateway
  checks passing.

## What is not complete

- Packaging/relaunch of the new WPF sharing control and a live phone test.
- Per-device management UI for listing and individually revoking a device. Stop
  sharing already ends the owned process and therefore invalidates all its
  in-memory pairings.
- Live phone-to-desktop instruction and approval test; the equivalent isolated
  phone/relay/desktop fixture now passes.
- A first-party cloud ingress endpoint that validates Herald's device identity
  before calling the new trusted-ingress polling adapter. The adapter and typed
  messages exist; no existing Thinking Buddy endpoint was changed.
- Reconnection/status synchronization and push notification delivery.
- Live phone Voice input integration.

The current local server defaults to loopback. Do not call it production remote
control and do not expose it publicly as a shortcut.

## Exact next task for the next agent

Implement one vertical slice only:

> Package/relaunch only after approval. Select one test project and named session,
> press Start phone sharing, pair one phone on the same Wi-Fi, read the sanitized
> session, send one reviewed plain-text instruction, and exercise one Deny decision.
> Confirm the desktop transcript and append-only Herald audit agree. Then stop
> sharing and prove the phone is denied. Do not call this WAN remote control.

Do not add WAN transport, Voice, attachments, or third-party connectors in that
slice. The result is the first honest end-to-end local Herald control path.

## Verification commands

```powershell
node --check src/herald/pairing.mjs
node --check src/herald/server.mjs
node --check src/herald/mobile-shell.mjs
node --test test/herald.test.mjs test/relay.test.mjs test/relay-poller.test.mjs
dotnet build desktop/Helmion.Desktop/Helmion.Desktop.csproj -c Debug --no-restore
dotnet build desktop/Helmion.Desktop.SmokeTests/Helmion.Desktop.SmokeTests.csproj -c Debug --no-restore
```
