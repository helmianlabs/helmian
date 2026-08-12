# Envoy chat foundation

Envoy is Helmian's in-house Slack/Discord-style option. This first slice is
source-only and additive: migration `009_envoy_chat.sql` defines tenant-scoped
channels and bounded messages with row-level isolation; `src/cloud/envoy-chat.mjs`
normalizes channels/messages and requires a live membership plus an explicit
policy decision before use.

It does not yet provide public chat routes, WebSocket fan-out, provider/model
execution, or agent-session minting. Those must reuse the signed session bridge,
global action policy, audit, replay, and human-confirmation controls. A message
must never grant a tenant, role, provider, URL, shell, or tool authority.

The desktop/browser UI can be built over this contract once the authenticated
cloud route and persistence tests exist. Production migration and activation
remain intentionally gated.
