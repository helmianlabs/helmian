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

It deliberately does **not** claim that Discord or Slack can execute a Helmian
agent yet. `agentBridge: not-connected` is intentional until a reviewed route
binds a verified platform user/channel to a tenant, role, workspace, and
Helmian session. That route must reuse the same signed-session, global action
policy, human-confirmation, audit, and replay controls as browser/Hume actions.
The identity binding helper is only the first half of that route: it rejects
missing, duplicate, inactive, unsupported, and cross-tenant mappings, then
returns `sessionIssuer: signed-session-required`. It does not mint a session or
call a model.

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
connectors are verification/delivery foundations, not production agent access.
