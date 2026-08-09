# Helmian Remote Control wire contract v1

This is the canonical account-based Remote Control control-plane contract.
The `/api/remote/v1/*` routes are versioned aliases of the existing Herald
handlers, so there is one implementation and one set of security semantics.
The older `/api/herald-*` names remain compatibility routes only.

The account PWA and Desktop Local Service now consume these exact boundaries in
source. Production remains inactive until Clerk, migration, Ably, and deployment
readiness checks pass. Legacy phone pairing is separate and cannot mint an
account Remote Control token.

## Common rules

- JSON request bodies are bounded to 16 KiB. Responses use `Cache-Control: no-store`.
- `x-helmian-nonce` is 16–160 characters from `[A-Za-z0-9._:-]` and must be fresh.
- Clerk account mutations and every registered-Desktop request consume their
  nonce durably. Reuse returns `401 replay_denied`.
- Desktop registration credentials and control-grant cookies are opaque. Never
  log, persist in plaintext, or send them in URLs.
- `401 desktop_denied` from any Desktop route means the registration is invalid,
  expired, or server-revoked. The Desktop must immediately stop publishing
  presence, stop Remote Control transport, and present itself as unavailable.
  It must not wait for or assume a local self-revoke action.
- `401 replay_denied` means the request nonce was reused; it is not by itself a
  registration-revocation signal. Retry only with a fresh nonce when safe.
- `503` is relay/configuration unavailability, not proof of revocation.
- Session presence becomes non-selectable after 45 seconds without a heartbeat;
  each heartbeat extends its stored presence for 90 seconds.

## Route mapping

| Canonical v1 route | Compatibility route | Authentication |
| --- | --- | --- |
| `POST /api/remote/v1/enrollment` | `/api/herald-enrollment` | Step-specific |
| `POST /api/remote/v1/desktop` | `/api/herald-desktop` | Desktop bearer + nonce |
| `GET/POST /api/remote/v1/desktops` | `/api/herald-desktops` | Clerk session; POST also nonce |
| `GET/DELETE /api/remote/v1/control` | `/api/herald-control` | Clerk session + control cookie; DELETE also nonce |
| `POST /api/remote/v1/control-token` | `/api/herald-realtime-token` | Clerk + control cookie + nonce |
| `POST /api/remote/v1/desktop-token` | `/api/herald-desktop-realtime-token` | Desktop bearer + nonce |

## 1. One-time Desktop enrollment

The Desktop locally generates:

- `enrollmentId`: `enroll_` plus at least 20 URL-safe random characters.
- `proofSecret`: 43–128 URL-safe random characters (32 random bytes minimum).
- `confirmationCode`: exactly eight digits, shown to the user.

### Request

`POST /api/remote/v1/enrollment`

```json
{
  "action": "request",
  "enrollmentId": "enroll_...",
  "proofSecret": "...",
  "confirmationCode": "12345678",
  "displayName": "Troy desktop"
}
```

This step is not account-authenticated because the Desktop is not enrolled yet.
The server requires Clerk and enrollment-pepper configuration, stores only the
proof hash and confirmation-code HMAC, and expires the request after 10 minutes.

`201`:

```json
{
  "pending": true,
  "enrollmentId": "enroll_...",
  "expiresAt": "2026-08-01T00:10:00.000Z",
  "confirmationRequired": true
}
```

### Confirm from signed-in web account

Headers: a valid Clerk session plus a fresh `x-helmian-nonce`.

```json
{ "action": "confirm", "confirmationCode": "12345678" }
```

The server binds the pending enrollment to the verified Clerk user. Confirmation
attempts are account-throttled. It returns the enrollment ID, bounded Desktop
display name, and expiry; it never returns the proof or registration token.

### Redeem from Desktop

```json
{
  "action": "redeem",
  "enrollmentId": "enroll_...",
  "proofSecret": "..."
}
```

- Before confirmation: `409 enrollment_pending`.
- Invalid/expired/reused proof: `401 enrollment_denied`.
- Success `201` (returned exactly once):

```json
{
  "enrolled": true,
  "desktopId": "desktop_...",
  "displayName": "Troy desktop",
  "registrationToken": "...",
  "credentialExpiresAt": "2026-09-01T00:00:00.000Z"
}
```

Only the token hash is stored server-side. Desktop stores the returned record
with Windows CurrentUser DPAPI and a restricted ACL.

## 2. Registered Desktop presence and revocation observation

All calls use:

```http
Authorization: Bearer <registrationToken>
x-helmian-nonce: <fresh nonce>
```

### Observe registration/revocation

```json
{ "action": "status", "desktopId": "desktop_..." }
```

`200` returns `registered: true`, `desktopId`, `credentialExpiresAt`, and
`serverTime`. The Desktop must call this while enrolled even if it has no active
session. A server revocation is observed as `401 desktop_denied`.

### Heartbeat an actual selected session

```json
{
  "action": "heartbeat",
  "desktopId": "desktop_...",
  "session": {
    "sessionId": "session-1",
    "sessionName": "Build",
    "state": "ready",
    "project": { "id": "project-1", "name": "Helmion" },
    "agent": { "id": "claude", "name": "Claude", "state": "idle" },
    "guard": { "state": "quiet", "detail": "No pending review." }
  }
}
```

Allowed session states: `ready`, `working`, `blocked`, `waiting`.
Allowed agent states: `idle`, `working`, `blocked`, `unavailable`.
Allowed Guard states: `quiet`, `unknown`, `attention`, `blocked`.
Workspace paths, transcript, provider credentials, and tool data are not accepted.

`200` returns `registered: true`, the sanitized session projection, and
`nextHeartbeatBefore`. It does not claim realtime connection.

### Stop presence

```json
{ "action": "stop-session", "desktopId": "desktop_...", "sessionId": "session-1" }
```

This marks the session stopped and revokes its active control grants.

## 3. Account-owned Desktop/session list, select, and revoke

`GET /api/remote/v1/desktops` requires a verified Clerk session and returns only
non-revoked Desktops owned by that Clerk subject. Only fresh sessions are nested.
An account with no enrolled/online Desktop receives `{ "desktops": [] }`.

### Select

Clerk session plus fresh nonce:

```json
{ "action": "select", "desktopId": "desktop_...", "sessionId": "session-1" }
```

The server rechecks account ownership, Desktop credential validity, Desktop and
session freshness, and session expiry. Success sets a 15-minute HttpOnly,
Secure, SameSite=Strict `helmian_herald_control` cookie and returns:

```json
{
  "selected": true,
  "desktopId": "desktop_...",
  "sessionId": "session-1",
  "expiresAt": "...",
  "transport": "not-activated"
}
```

### Revoke Desktop

Clerk session plus fresh nonce:

```json
{ "action": "revoke", "desktopId": "desktop_...", "confirmed": true }
```

The server rechecks ownership and atomically revokes the Desktop, its sessions,
and grants. The Desktop observes revocation on its next `status`, `heartbeat`, or
token request as `401 desktop_denied`.

## 4. Selected control grant

- `GET /api/remote/v1/control`: Clerk session + control cookie; rechecks account,
  grant, Desktop registration, and current session. Returns only sanitized state
  and `transport: "not-activated"`.
- `DELETE /api/remote/v1/control`: same plus fresh nonce; revokes the grant and
  clears the cookie.

## 5. Account-bound Ably TokenRequests

### PWA/control token

`POST /api/remote/v1/control-token` with Clerk session, control cookie, and fresh
nonce. The server rechecks ownership/grant/Desktop/session and returns a signed
TokenRequest with `clientId=herald-control:<grantId>`, publish only on the exact
session request channel, and subscribe only on that grant's exact result channel.

### Desktop token

`POST /api/remote/v1/desktop-token` with Desktop bearer + fresh nonce:

```json
{ "desktopId": "desktop_...", "sessionId": "session-1" }
```

The server rechecks registration/revocation/expiry, current session freshness,
and active grants. It returns `clientId=herald-desktop:<desktopId>`, subscribe
only on the exact session request channel, and publish only on the exact result
channels of currently active grants (maximum 16; no wildcard).

Both token TTLs are at most five minutes and cannot outlive the Desktop
credential, session presence, or control grant. The scoped issuer credential
stays server-side and is never returned.
