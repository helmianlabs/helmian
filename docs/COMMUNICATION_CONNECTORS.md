# Helmian Discord / Slack connector boundary

This slice adds the safe connector primitives for Discord and Slack:

- exact Slack HMAC freshness/body verification;
- Discord Ed25519 interaction verification;
- bounded normalized messages;
- HTTPS host allowlists for outbound webhooks;
- abortable outbound delivery;
- secret-free configuration status.
- fail-closed provider-user/channel binding to a live Helmian subject, tenant,
  and membership role (`communication-identity.mjs`).

The next source-only slice is now present in
`src/cloud/communication-session-bridge.mjs`. It still does **not** enable the
live provider route or claim production readiness. The bridge takes only the
identity binding returned by `communication-identity.mjs`, mints a 15-minute
HMAC session, verifies it on every turn, binds its receipt to one connection,
rejects duplicate provider events, refreshes the supplied action policy before
each turn, and refuses to run unless a durable audit sink and bounded runtime
adapter are supplied. `toHelmianTenantContext()` maps the verified subject,
role, tenant, and session into the existing `withTenantTransaction()` / Neon
RLS context. Audit callbacks receive sanitized identifiers; the signed token
and provider secrets are never sent to the runtime or audit payload.

The bridge is an integration contract, not a deployed webhook. The caller must
still provide DB-backed resolvers, a policy resolver, an append-only audit
sink, and a runtime adapter that exposes only approved tools. No provider user
can create membership, choose a tenant, widen the action list, or bypass the
existing global action policy. A live route remains blocked until those
adapters are wired to the cloud server and exercised with positive and negative
Discord/Slack webhook tests.

Required provider setup, when the bridge is approved:

1. Create a Discord application and configure its public key plus an HTTPS
   interaction endpoint. Use a bot/webhook identity scoped only to the selected
   channel(s).
2. Create a Slack app, signing secret, event/command endpoint, and a bot token
   scoped only to the selected workspace/channel(s).
3. Store values only in the Fly secret store. Never put tokens in Git, Neon
   rows, browser JavaScript, or Cora prompts.
4. Add explicit platform-user → Helmian subject/tenant membership before any
   agent turn is allowed.

Until those steps and an end-to-end negative/positive test pass, these
connectors are verification/session foundations, not production agent access.
