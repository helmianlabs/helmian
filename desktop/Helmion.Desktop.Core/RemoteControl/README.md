# Account-owned Remote Control desktop boundary

This is the Phase 1 desktop contract for account-owned Remote Control. It is
separate from `Herald/`, which remains the legacy pairing/polling path.

Implemented locally:

- one-time-code enrollment state that remains unowned until server redemption
  and CurrentUser DPAPI storage both succeed;
- a DPAPI credential store in `Helmion.LocalService.Security` that persists only
  the revocable desktop bearer credential plus redacted binding metadata;
- persisted, fail-closed desktop revocation state;
- a bounded canonical-v1 HTTPS adapter that generates the Desktop-owned enrollment
  ID, 32-byte proof and eight-digit code locally, uses a fresh nonce on every
  registered-Desktop request, and never performs Clerk confirmation;
- registered-Desktop status observation even when no session is active. Only
  `401 desktop_denied` removes the local credential; `replay_denied`, `503`, and
  network failure remain distinct and do not manufacture revocation;
- sanitized desktop heartbeat and selected-session schemas with no transcript,
  workspace path, provider credential, Clerk value, Ably key, prompt, file, or
  instruction content;
- selected-session registering, online, updating, revoking, revoked, and offline
  transitions. Registration/update/revocation require control-plane acknowledgement
  before the state becomes remotely selectable or terminal;
- a WPF read-only adapter that captures the currently selected project/session,
  agent display label, busy state, current Guard level, and pending-approval count.
  It does not change the selection or trigger Guard, provider, voice, process, or
  network work.

The route and DTO source of truth is the canonical contract in
`docs/herald/REMOTE_CONTROL_V1.md`, represented in
`Helmion.LocalService.Protocol/RemoteControlContracts.cs`:

- `POST /api/remote/v1/enrollment` with `request` and `redeem` actions — desktop
  one-time enrollment; its `confirm` action is Clerk-account-only and the desktop
  does not call it;
- `POST /api/remote/v1/desktop` with `status`, `heartbeat`, and `stop-session`
  actions — registration/revocation observation and selected-session presence;
- `POST /api/remote/v1/desktop-token` — later short-lived, scoped Ably token
  request (the desktop does not contain an Ably API key);
- `GET|POST /api/remote/v1/desktops` — Clerk-account list/select/revoke operations;
  the desktop does not call this account-only endpoint.

The older `/api/herald-*` names are compatibility aliases. Desktop code uses only
the canonical v1 paths. Registered-Desktop requests use `Authorization: Bearer`
and a fresh `x-helmian-nonce`; registration credentials remain inside the local
service/DPAPI boundary.

`RemoteControlWebWireMapper` maps the local typed lifecycle to the web worker's
exact `ready|working|blocked`, `idle|working|unavailable`, and
`quiet|unknown|attention|blocked` heartbeat vocabulary. It deliberately omits
Guard detail rather than forwarding potentially sensitive local diagnostic text.

Activated locally in source:

- CurrentUserOnly named-pipe commands expose redacted status, one-time enrollment,
  redemption, selected-session publish, and session clear operations;
- Local Service is the sole installation/credential owner and runs bounded
  registration observation, heartbeat, stop-session, offline backoff, and
  server-revocation handling;
- the official Ably .NET client consumes only server-signed, short-lived
  TokenRequests, deduplicates request IDs, and publishes only to exact scoped
  result channels;
- the Desktop integration card exposes only the one-time code and redacted state;
- the account PWA lists owned fresh sessions and distinguishes relay acceptance
  from Desktop acknowledgement.

Production activation still requires complete Clerk configuration, the applied
account-control migration, and deployment of the current PWA/API source.

`RemoteControlHttpApi` is the sole HTTPS implementation of the enrollment,
presence, and scoped-token interfaces. Local Service constructs it; the Desktop
renderer and legacy Herald process do not. Smoke tests use in-memory transports,
so no live control plane is contacted and no enrollment success is manufactured.

The C# Local Service security boundary is the wired owner for the account Remote
Control Desktop identity. The legacy Node pairing path remains separate and is
not started or consulted by this path.
