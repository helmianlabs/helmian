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

## Agents and Discord (October 2026)

Status has moved on from the paragraph above: channels, messages, Ably fan-out
and the /app chat are live. This slice adds agents as channel members and the
Discord mirror, with no migration.

- **Channel config** (agents and their join times, the Discord link, a pending
  link-code hash) is stored as append-only rows in `envoy_messages` with
  `author_subject = 'system:envoy-config'`. Newest row wins; chat reads skip
  them. Visible join/link notices use `system:envoy`. Code:
  `src/cloud/envoy-agents.mjs` (pure) and `src/cloud/envoy-mesh.mjs` (routes).
- **Routes** (all under `/api/admin/envoy/`): `channel-config` GET/POST
  (add-agent, remove-agent: members and admins; link-discord, unlink-discord:
  owner/admin), `agent-work` and `agent-messages` (device token only, for the PC
  bridge), `bridge/links|outbound|confirm-link|inbound` (bearer
  `HELMIAN_ENVOY_BRIDGE_TOKEN`, Discord bridge only).
- **Routing**: `@all` reaches every agent, `@Claude` etc. reach the named ones,
  no mention goes to Maestro if it is in the channel, otherwise to every agent.
  Agents only see messages after they joined. Only Maestro's @mentions hand
  work to other agents, one hop deep. Replies are idempotent per message
  (`reply:<messageId>`). Workers start their answer with `Claim:`.
- **Execution** stays on the user's PC bridge (`bin/pc-bridge.mjs`), which polls
  `agent-work`, runs each agent with keys from the PC vault, and posts with
  `agent-messages`. No provider key is stored in Vercel (migration 019 rule).
- **Discord**: see `discord-bridge/README.md`.
