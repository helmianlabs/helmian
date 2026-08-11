# AimForge → Hume → Helmian signed voice sessions

This is the production authority path for Cora voice sessions. A
`custom_session_id` is routing context forwarded by Hume, not proof of
authorization by itself. AimForge signs its server-verified tenant, subject,
role, surface, session, lifetime, and receipt claims; Helmian verifies them
before enabling its agent/tool runtime.

Primary Hume contracts:

- Session settings accept `custom_session_id` and forward it to a custom
  language model: <https://dev.hume.ai/docs/speech-to-speech-evi/configuration/session-settings>
- A custom language model is configured with a public `wss://` endpoint and
  receives `custom_session_id` at the top level of each message:
  <https://dev.hume.ai/docs/speech-to-speech-evi/guides/custom-language-model>

## Required server configuration

Set the same 32-byte-or-longer random secret only in AimForge API and Helmian
Cloud:

```text
HELMION_AIMFORGE_BRIDGE_SECRET=<shared random secret>
```

AimForge API also requires:

```text
HELMION_HUME_CONFIG_ID=<Hume EVI config UUID>
HELMION_CORA_CLM_URL=wss://<helmian-host>/llm?token=<HELMION_CORA_TOKEN>
```

Helmian Cloud also requires its existing server-to-server WebSocket token:

```text
HELMION_CORA_TOKEN=<32-byte-or-longer random secret>
```

The two secrets are separate boundaries. `HELMION_CORA_TOKEN` authenticates
Hume's connection to `/llm`. `HELMION_AIMFORGE_BRIDGE_SECRET` authenticates the
tenant/user/role context inside each session. Neither value belongs in web or
mobile environment variables, logs, Hume tool parameters, or API responses.

## Fail-closed behavior

- Non-loopback Helmian binds refuse to start without both the CLM connection
  token and the AimForge bridge verification secret.
- Cloud turns without an exact `helmion:` signed envelope, with a bad HMAC,
  wrong issuer/audience/surface, excessive lifetime, future issue time, or an
  expired lifetime are refused before the provider or any tool runs.
- A receipt binds to one signed session and one WebSocket connection. Reuse on
  the owner connection is idempotent; replay from another connection is
  refused for the signed lifetime.
- The durable activity ledger records the receipt and verified context once.
  It never records the signed `custom_session_id` or either secret.

Local loopback development retains the old `helmion:*` marker for existing
self-tests. That compatibility path does not exist on the Fly/non-loopback
production bind.

## Bounded AimForge action catalog

A verified AimForge session receives exactly three fixed actions: aggregate
dispatch-board summary, prepare-only driver-message proposal, and internal
department handoff. There is no generic HTTP, shell, workspace, provider-send,
or approval tool.

`aimforge_create_department_handoff` accepts only recipient role, subject, body,
priority, and an explicit confirmation state. The recipient role is restricted
to safety, payroll, director, or dispatcher. Tenant and sender identity and role
come only from the signed bridge and are revalidated by AimForge immediately
before the write.

The first exact handoff call stages its content and returns a confirmation
request without network access. A matching `confirmed: true` call is accepted
only after a later user turn. Changed content, same-turn confirmation, or a new
recipient restarts confirmation. AimForge then applies canonical request HMAC,
timestamp and nonce replay protection, current membership/module checks, and a
stable request-digest-bound idempotency key before persisting one internal
`cora_messages` row. The model receives only a bounded persisted-message receipt,
not tenant IDs, recipient people, phone numbers, provider fields, or message
content echoed by the API.

