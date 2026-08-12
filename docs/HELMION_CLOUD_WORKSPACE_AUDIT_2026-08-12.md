# Helmian Cloud/browser workspace audit — 2026-08-12

This is a source-and-reachability audit, not a production-readiness claim.
No deployment, provider secret, Hume tool, Clerk cutover, or migration was
performed during this audit.

## What is reachable now

- `https://helmian-cloud.fly.dev/admin/` returned HTTP 200 and serves the
  hosted four-column Maestro-shaped shell (navigation, conversation, agent
  cards, and Guard panel).
- Fly reports `helmian-cloud` Machine `0803e9db390658`, release `v30`,
  started in `dfw`, with its single health check passing at audit time.
- The public page labels itself `READ-ONLY PREVIEW`; its composer is disabled,
  the agent cards are placeholders, and Browser/Canvas/Preview/Guard actions
  are disabled. These statements are visible in
  `web/cloud-admin/index.html:61-68,98-122`.
- Unauthenticated `/api/admin/workspace` and `/api/admin/control-surface`
  returned HTTP 403, which is the expected owner/admin identity boundary.
  A plain GET to `/api/healthz` returned HTTP 426 because the mounted Cora
  service speaks WebSocket except for its bearer-protected status path;
  `src/cora/clm-server.mjs:978-1036` is the source-of-truth behavior.

## Source readiness by surface

### Signed Discord/Slack session bridge — foundation complete, route absent

`src/cloud/communication-connectors.mjs:85-93` still reports
`agentBridge: 'not-connected'`. The signed bridge itself is implemented in
`src/cloud/communication-session-bridge.mjs:250-379`: it requires a prior
exact-one tenant binding, signs a short-lived session, verifies every turn,
binds a receipt to one connection, rejects event replay, refreshes policy,
requires an audit sink, and accepts only a bounded runtime adapter. The
connector identity boundary remains in `src/cloud/communication-identity.mjs`.

What is still missing is the cloud webhook route and DB adapter: verified
Discord/Slack request -> Neon-backed provider identity/channel resolvers ->
`createConnectorSessionBridge()` -> outbound provider response. No live
provider credentials are configured or enabled.

### Envoy — schema and normalization foundation only

`sql/009_envoy_chat.sql:1-38` defines tenant-scoped channels/messages with
RLS. `src/cloud/envoy-chat.mjs:10-42` bounds channel/message shapes and
requires an upstream membership decision. There is currently no authenticated
Envoy HTTP route, WebSocket fan-out, message persistence adapter, browser
composer, desktop client, or agent-session integration. This is documented in
`docs/ENVOY_CHAT_FOUNDATION.md`.

### Full Discord-style multi-agent workspace — visual projection only

The hosted shell is a truthful visual target, but not the Windows Pilot's full
workspace. The source explicitly says builder actions/shared ledger are not
wired (`web/cloud-admin/index.html:61`), the conversation send control is
disabled (`:65-68`), agent cards wait for Neon event-ledger data (`:98-106`),
and Guard controls are disabled (`:109-122`). There is no selected builder,
real-time monitor stream, shared workspace/knowledge graph, browser-control
hand, or cross-agent error interception in the live browser surface.

### Existing authenticated admin/policy surface — bounded and reachable

The live admin route constants and authenticated endpoints are defined in
`src/cloud/live-admin.mjs:28-39`. The current scope is tenant/admin session,
workspace/control-surface reads, audit/event reads, and fixed global action
policy preview/confirm. It is not a general Helmian company-brain console and
does not expose arbitrary model/provider/tool configuration.

## Target comparison

| Target capability | Current state | Truthful status |
|---|---|---|
| Browser-hosted Helmian shell | Live at `/admin/` | Reachable visual preview |
| OIDC + Neon tenant/admin boundary | Source/live boundary present; unauthenticated reads denied | Bounded admin surface |
| Discord/Slack signature verification | Source + focused tests | Ready foundation |
| Discord/Slack user/channel -> signed session | Source bridge + tests | Not wired to public route |
| Envoy tenant chat | SQL + normalizers | Not routed or deployed |
| Maestro live conversation | Disabled composer | Not implemented in browser |
| Builder + silent monitors | Placeholder cards | Not implemented |
| Shared Neon workspace/knowledge graph | No workspace/event-ledger route | Not implemented |
| Browser-control/navigation hand | Planned typed contract | Not implemented |

## Next safe milestone

Wire one authenticated, tenant-scoped connector route in source and test it
with fake Discord/Slack requests and a fake Neon pool before any deployment.
Then add Envoy channel/message routes over the same `withTenantTransaction()`
context, followed by a browser composer that remains disabled until those
routes pass authorization, audit, replay, and tenant-isolation tests.
