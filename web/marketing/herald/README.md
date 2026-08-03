# Herald PWA runtime boundaries

The browser owns presentation and account-scoped transport only. It receives no desktop enrollment secret,
database URL, provider key, Clerk secret, or Ably API key.

## Identity

`../api/_herald-identity.js` is the server-side account-identity boundary. The
resolver remains explicitly unavailable until all Clerk server settings exist.
The PWA loads Clerk from the publishable frontend domain, passes only its session
token to same-origin account routes, and the server verifies it. Browser-supplied
identity headers and legacy pairing identity are never trusted for account control.

## Transport

`account-runtime.js` lists only verified-account Desktop state, selects one fresh
session through a Secure, HttpOnly, SameSite control-grant cookie, and obtains a
short-lived Ably TokenRequest. It can publish only to that session request channel
and subscribe only to that grant's result channel. Token refresh reauthorizes the
account, control grant, Desktop registration, and session freshness server-side.

`/api/remote/v1/control-token` accepts POST only. It validates Clerk identity,
the HttpOnly control grant, a fresh replay nonce, live Desktop registration, and
all expiry timestamps before signing a five-minute-or-shorter TokenRequest. The
scoped issuer key value is never returned.

Relay acceptance is not delivery. User actions stay queued/delayed until a
typed desktop result marks them delivered, refused, or failed.

Pending delivery correlation survives a PWA reload in local storage. The stored
shape is limited to request ID, action kind, state, and timestamps. Instruction
text, approval details, project/session data, outputs, cookies, and credentials
are not stored there. Terminal results remove the pending record.

## Offline shell

`sw.js` caches only static `/herald/` shell assets. It explicitly bypasses every
`/api/` request, so session data and authenticated responses are never placed in
the service-worker cache.
