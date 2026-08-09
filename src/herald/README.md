# Helmian Herald source map

Herald is Helmian on a phone. The phone is a paired view and deliberate input
surface for one running desktop-owned session. It is not a terminal, file
browser, provider client, or a dependency on the Thinking Buddy product.

## Files

- `mobile-shell.mjs` — Midnight mobile/PWA interface, pairing, offline/stale
  presentation, active project/session view, reviewed text input, approvals,
  and the honest Voice availability surface.
- `pairing.mjs` — short-lived pairing codes, device-bound session credentials,
  expiry, revocation, scopes, and replay-nonce denial.
- `server.mjs` — HTTP boundary and routes. It authenticates and validates before
  status reads or calls to the injected desktop bridge.
- `relay-bridge.mjs` — closed typed request/result envelopes and phone/desktop
  adapters over the existing bounded-text relay lane, including trusted-ingress
  and desktop-outbound polling factories. The phone PWA never receives the
  relay credential.
- `desktop-pipe.mjs` — bounded current-user Windows named-pipe client for the
  selected-session desktop gateway. It has no shell, file, tool, or install call.
- `status.mjs` — sanitizes the local Guard digest for the phone.
- `digest.mjs` — reads only the fixed local Guard/lease evidence used by status.
- `../../test/herald.test.mjs` — denial, pairing, replay, context-scope, audit,
  desktop-offline, and mobile-shell contract tests.

## The missing production wire

`startHerald` accepts a `desktopBridge`. The desktop-owned policy gateway exists
at `desktop/Helmion.Desktop.Core/Herald/HeraldDesktopGateway.cs`; MainWindow now
supplies its real selected project/session, ordinary Maestro text dispatch,
Allow once/Deny approval delegate, and append-only audit sink. The Integrations
card starts this local path only after an explicit click.

The existing `../relay/` polling protocol is the starting transport layer. It
already proved cursor replay, presence, reconnect/outbox, and bounded text-frame
delivery through Vercel/Neon. Herald must put its own pairing, device identity,
typed session messages, scopes, context checks, and audit around that transport.
It must not directly reuse Thinking Buddy's public proxy, fixed channel, shared
authority, or `hands.mjs` execution path.

The real adapter must provide only:

1. `isAvailable()`
2. `getSessionContext()`
3. `submitInstruction(command)`
4. `decideApproval(decision)`
5. `audit(event)`

Every call must remain paired-owner, selected-project, and selected-session
scoped. A desktop shutdown or context change fails closed.

See `docs/herald/HANDOFF.md` for the ordered handoff plan.
