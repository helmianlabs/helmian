# Configuration and environment variables

Every environment variable the code reads, grouped by the part of the repo that reads it. **Example values only** — no real value appears here. Real values live in each host's secret store (Vercel, Fly, the server's `.env`), never in git.

How this list was made (2026-11-26): a scan of non-test source for `process.env.X`, `env.X`, `env['X']`, `$env:X` (PowerShell), `Environment.GetEnvironmentVariable("X")` (C#) and `os.environ` (Python), merged with the five checked-in example files below. Operating-system variables (`PATH`, `USERPROFILE`, `LOCALAPPDATA`, …) are left out. A variable read through a computed name will not show up; when in doubt, search the source for the name.

222 variables are listed.

## Example files in the repo

| File | For |
|---|---|
| [`.env.example`](../.env.example) | CLI, database commands, cloud admin, Cora, bridges, GitHub webhook |
| [`executive-guard/deploy/executive-guard.env.example`](../executive-guard/deploy/executive-guard.env.example) | Executive Guard server |
| [`hands-mcp/.env.example`](../hands-mcp/.env.example) | Hands MCP hub |
| [`deploy/hetzner/.env.example`](../deploy/hetzner/.env.example) | Hetzner box: voice TTS, relay, cloud worker |
| [`deploy/vps/.env.example`](../deploy/vps/.env.example) | Self-hosted VPS admin stack |

Copy an example to `.env` (or the name its header says), fill it in, and keep the copy out of git. `.gitignore` already ignores `.env`.

## Naming

Most variables use the original spelling `HELMION_*`; newer ones use `HELMIAN_*`. Both are live. Do not rename either — deployed hosts set them by these exact names.

## CLI and root services (bin/, src/)

| Variable | Example value | Read in |
|---|---|---|
| `ABLY_API_KEY` | `<secret — set in your secret store>` | `src/cloud/envoy-ably.mjs`, `src/cloud/envoy-reactions.mjs` (+2 more) |
| `AGENT_OS_ROOT` | `/path/to/root` | `templates/agent-os/hooks/session-start-context.mjs`, `templates/agent-os/hooks/stop-capture.mjs` |
| `BIGSISTER_DATABASE_URL` | `postgresql://user:password@host/db?sslmode=require` | `bin/helmion.mjs` |
| `CLERK_SECRET_KEY` | `<secret — set in your secret store>` | `src/cloud/envoy-mesh.mjs`, `src/cloud/signup.mjs` |
| `ELEVENLABS_API_KEY` | `<secret — set in your secret store>` | `cora/elevenlabs/scripts/sync-elevenlabs-agent.mjs` |
| `EXA_API_KEY` | `<secret — set in your secret store>` | `src/cloud/helm-search.mjs` |
| `GITHUB_TOKEN` | `<secret — set in your secret store>` | `bin/helmion.mjs`, `desktop/Helmion.LocalService.Security/TeamProviderAdapters.cs` (+2 more) |
| `HELMIAN_DISCORD_CLIENT_ID` | `example-id` | `src/cloud/bot-status.mjs` |
| `HELMIAN_GUARD_APPROVER_SUBJECTS` | `(see source)` | `src/cloud/guard-pc-approvals.mjs` |
| `HELMIAN_GUARD_APPROVER_TOKEN` | `<secret — set in your secret store>` | `src/cloud/guard-pc-approvals.mjs` |
| `HELMIAN_GUARD_URL` | `https://example.com` | `src/cloud/guard-pc-approvals.mjs` |
| `HELMIAN_HANDS_DISABLED` | `true` | `bin/pc-bridge.mjs` |
| `HELMIAN_HANDS_PASSPHRASE` | `<secret — set in your secret store>` | `bin/hands-spoke.mjs`, `spoke-installer/install-pair.mjs` |
| `HELMIAN_HANDS_URL` | `https://example.com` | `src/cloud/spoke-setup.mjs` |
| `HELMIAN_PAIR_CODE` | `ABCD-1234` | `bin/hands-spoke.mjs` |
| `HELMIAN_PAIR_CODE_ISSUER_TOKEN` | `<secret — set in your secret store>` | `src/cloud/spoke-setup.mjs` |
| `HELMIAN_ROOT` | `/path/to/root` | `bin/hands-spoke.mjs`, `desktop/Helmion.BridgeService/BridgeSupervisor.cs` (+1 more) |
| `HELMION_ADMIN_ACCOUNT_PORTAL_URL` | `(empty)` | `src/cloud/identity-gateway.mjs` |
| `HELMION_ADMIN_BOOTSTRAP_TENANT` | `example-tenant` | `src/cloud/owner-claim.mjs` |
| `HELMION_ADMIN_BOOTSTRAP_TENANT_NAME` | `Example` | `src/cloud/owner-claim.mjs` |
| `HELMION_ADMIN_CLIENT_ID` | `(empty)` | `src/cloud/deployment-contract.mjs`, `src/cloud/identity-gateway.mjs` (+1 more) |
| `HELMION_ADMIN_COOKIE_SECURE` | `true` | `.env.example` |
| `HELMION_ADMIN_ISSUER` | `(empty)` | `src/cloud/deployment-contract.mjs`, `src/cloud/identity-gateway.mjs` (+1 more) |
| `HELMION_ADMIN_ORIGIN` | `https://admin.helmian.cloud` | `src/cloud/live-admin.mjs` |
| `HELMION_ADMIN_OWNER_EMAIL` | `owner@example.com` | `src/cloud/owner-claim.mjs` |
| `HELMION_ADMIN_REDIRECT_URI` | `(empty)` | `src/cloud/deployment-contract.mjs`, `src/cloud/identity-gateway.mjs` (+1 more) |
| `HELMION_ADMIN_ROLE_CLAIM` | `role` | `.env.example` |
| `HELMION_ADMIN_SESSION_SECRET` | `<secret — set in your secret store>` | `src/cloud/deployment-contract.mjs`, `src/cloud/identity-gateway.mjs` (+1 more) |
| `HELMION_ADMIN_TENANT_CLAIM` | `tenant_id` | `.env.example` |
| `HELMION_AIMFORGE_ACTION_SECRET` | `<secret — set in your secret store>` | `src/cloud/deployment-contract.mjs`, `src/cora/aimforge-board-action.mjs` (+1 more) |
| `HELMION_AIMFORGE_API_BASE_URL` | `https://example.com` | `src/cloud/deployment-contract.mjs`, `src/cora/aimforge-board-action.mjs` (+1 more) |
| `HELMION_AIMFORGE_BRIDGE_SECRET` | `<secret — set in your secret store>` | `src/cloud/deployment-contract.mjs`, `src/cora/clm-server.mjs` |
| `HELMION_APP_ORIGIN` | `https://example.com` | `src/cloud/user-oauth.mjs` |
| `HELMION_ASK_TIMEOUT_MS` | `(number)` | `src/agent/approval.mjs`, `src/agent/tools.mjs` |
| `HELMION_BRIDGE_AGENTS` | `(see source)` | `bin/pc-bridge.mjs` |
| `HELMION_BRIDGE_AGENT_TOOLS` | `(see source)` | `bin/pc-bridge.mjs` |
| `HELMION_BRIDGE_CHANNEL_SLUGS` | `(see source)` | `bin/pc-bridge.mjs` |
| `HELMION_BRIDGE_NO_ABLY` | `(see source)` | `bin/pc-bridge.mjs` |
| `HELMION_BRIDGE_PAIRING_CODE` | `ABCD-1234` | `bin/pc-bridge.mjs` |
| `HELMION_BRIDGE_PROVIDER` | `claude` | `bin/pc-bridge.mjs` |
| `HELMION_BRIDGE_TENANT_SLUG` | `(see source)` | `bin/pc-bridge.mjs` |
| `HELMION_BRIDGE_TOKEN_PATH` | `<secret — set in your secret store>` | `src/mcp/local-exec-server.mjs` |
| `HELMION_BRIDGE_TOOLS` | `(see source)` | `bin/pc-bridge.mjs` |
| `HELMION_BRIDGE_WORKSPACE` | `(see source)` | `bin/pc-bridge.mjs` |
| `HELMION_BUILD_VERSION` | `(see source)` | `src/cloud/live-admin.mjs` |
| `HELMION_CATALOG_PROBE` | `(see source)` | `src/jobs/connector-catalog-sync.mjs` |
| `HELMION_CLERK_INSTANCE` | `(see source)` | `src/cloud/live-admin.mjs` |
| `HELMION_CLOUD_ENVIRONMENT` | `staging` | `src/cloud/deployment-contract.mjs`, `src/cloud/live-admin.mjs` |
| `HELMION_CLOUD_URL` | `https://example.com` | `src/mcp/local-exec-server.mjs` |
| `HELMION_CONFIG_STORE` | `(see source)` | `src/cloud/envoy-config-store.mjs` |
| `HELMION_CONSOLE_WORKER` | `(see source)` | `bin/helmion-cora.mjs`, `src/cloud/live-admin.mjs` |
| `HELMION_CORA_PERMISSION` | `ask` | `.env.example` |
| `HELMION_CORA_PROVIDER` | `claude` | `src/cloud/deployment-contract.mjs`, `src/cloud/live-admin.mjs` |
| `HELMION_CORA_TIER` | `standard` | `.env.example` |
| `HELMION_CORA_TOKEN` | `(empty)` | `bin/helmion-cora.mjs`, `src/cloud/deployment-contract.mjs` |
| `HELMION_CREDENTIAL_AUDIT_PATH` | `/path/to/path` | `bin/helmion-credential-service.mjs`, `credential-service-image/bin/helmion-credential-service.mjs` |
| `HELMION_CREDENTIAL_SERVICE_HOST` | `example.com` | `bin/helmion-credential-service.mjs`, `credential-service-image/bin/helmion-credential-service.mjs` |
| `HELMION_CREDENTIAL_SERVICE_PORT` | `8080` | `bin/helmion-credential-service.mjs`, `credential-service-image/bin/helmion-credential-service.mjs` |
| `HELMION_CREDENTIAL_SERVICE_TOKEN` | `<secret — set in your secret store>` | `bin/helmion-credential-service.mjs`, `credential-service-image/bin/helmion-credential-service.mjs` (+1 more) |
| `HELMION_CREDENTIAL_SERVICE_URL` | `https://example.com` | `src/cloud/credential-connect.mjs` |
| `HELMION_CREDENTIAL_VAULT_KEY` | `<secret — set in your secret store>` | `bin/helmion-credential-service.mjs`, `credential-service-image/bin/helmion-credential-service.mjs` |
| `HELMION_DATABASE_URL` | `postgresql://user:password@host/database?sslmode=require` | `bin/helmion-cloud-worker.mjs`, `bin/helmion-credential-service.mjs` (+95 more) |
| `HELMION_DISCORD_APPLICATION_PUBLIC_KEY` | `(empty)` | `src/cloud/communication-connectors.mjs` |
| `HELMION_DISCORD_CLIENT_ID` | `example-id` | `tools/Start-Demo-Desk.ps1` |
| `HELMION_DISCORD_WEBHOOK_URL` | `(empty)` | `src/cloud/communication-connectors.mjs` |
| `HELMION_ENDPOINT_ID` | `example-id` | `src/core/schema-provisioner.mjs` |
| `HELMION_EXPECTED_ENDPOINT_ID` | `ep-example-a1b2c3d4` | `bin/helmion.mjs`, `desktop/Helmion.Desktop.Core/EnvironmentSettingsStore.cs` (+5 more) |
| `HELMION_GEMINI_OAUTH_CLIENT_ID` | `example-id` | `src/cloud/provider-oauth-config.mjs` |
| `HELMION_GEMINI_OAUTH_REDIRECT_URI` | `https://example.com` | `src/cloud/provider-oauth-config.mjs` |
| `HELMION_GEMINI_USER_OAUTH_REDIRECT_URI` | `https://example.com` | `src/cloud/provider-oauth-config.mjs` |
| `HELMION_GITHUB_REPO_CHANNEL_MAP` | `(empty)` | `.env.example` |
| `HELMION_GITHUB_WEBHOOK_SECRET` | `(empty)` | `.env.example` |
| `HELMION_GUARD_DEVICE_TOKEN` | `<secret — set in your secret store>` | `bin/helmion-credential-service.mjs`, `bin/helmion.mjs` (+1 more) |
| `HELMION_GUARD_URL` | `https://example.com` | `bin/helmion-credential-service.mjs`, `bin/helmion.mjs` (+1 more) |
| `HELMION_HERALD_CLERK_AUTHORIZED_PARTIES` | `(see source)` | `src/cloud/signup.mjs` |
| `HELMION_HERALD_ORIGIN` | `https://example.com` | `bin/helmion.mjs` |
| `HELMION_HUME_CONFIG_ID` | `example-id` | `src/cora/clm-server.mjs` |
| `HELMION_LOCAL_ENABLED` | `true` | `src/agent/local-provider.mjs` |
| `HELMION_LOCAL_MCP` | `(see source)` | `bin/mcp-helmion-local.mjs` |
| `HELMION_LOCAL_MCP_APPROVAL_CHANNEL` | `(see source)` | `src/mcp/local-exec-server.mjs` |
| `HELMION_LOCAL_MCP_BIND` | `(see source)` | `bin/mcp-helmion-local.mjs`, `src/mcp/local-exec-server.mjs` |
| `HELMION_LOCAL_MCP_DRY_RUN` | `true` | `bin/mcp-helmion-local.mjs` |
| `HELMION_LOCAL_MCP_ENVOY_NOTIFY` | `(see source)` | `src/mcp/local-exec-server.mjs` |
| `HELMION_LOCAL_MCP_HTTP` | `(see source)` | `bin/mcp-helmion-local.mjs` |
| `HELMION_LOCAL_MCP_PORT` | `8080` | `bin/mcp-helmion-local.mjs`, `src/mcp/local-exec-server.mjs` |
| `HELMION_LOCAL_MCP_ROOTS` | `(see source)` | `src/mcp/local-exec-server.mjs` |
| `HELMION_LOCAL_MCP_SUBJECT` | `(see source)` | `src/mcp/local-exec-server.mjs` |
| `HELMION_LOCAL_MCP_TOKEN` | `<secret — set in your secret store>` | `src/mcp/local-exec-server.mjs` |
| `HELMION_LOCAL_MODEL` | `model-name` | `src/agent/local-provider.mjs` |
| `HELMION_LOCAL_TIMEOUT_MS` | `(number)` | `src/agent/local-provider.mjs` |
| `HELMION_LOCAL_URL` | `https://example.com` | `src/agent/local-provider.mjs` |
| `HELMION_MAX_TOOL_ROUNDS` | `(see source)` | `src/agent/loop.mjs` |
| `HELMION_OAUTH_VAULT_KEY` | `<secret — set in your secret store>` | `bin/helmion-credential-service.mjs`, `credential-service-image/bin/helmion-credential-service.mjs` (+1 more) |
| `HELMION_OLLAMA_MODEL` | `model-name` | `src/agent/env.mjs` |
| `HELMION_POWERSHELL_BIN` | `(see source)` | `src/mcp/local-exec-server.mjs` |
| `HELMION_RELAY_CHANNEL` | `(see source)` | `bin/helmion.mjs` |
| `HELMION_RELAY_KEY` | `<secret — set in your secret store>` | `bin/helmion.mjs` |
| `HELMION_RELAY_URL` | `https://example.com` | `bin/helmion.mjs` |
| `HELMION_RULES_PATH` | `(empty)` | `src/core/governance-gate.mjs` |
| `HELMION_SANDBOX_CANARY_TOKEN` | `<secret — set in your secret store>` | `src/core/mcp-sandbox-observer.mjs`, `src/core/mcp-sandbox.mjs` |
| `HELMION_SANDBOX_EVENT_LOG` | `(see source)` | `src/core/mcp-sandbox-observer.mjs`, `src/core/mcp-sandbox.mjs` |
| `HELMION_SANDBOX_POLICY` | `(see source)` | `src/core/mcp-sandbox-observer.mjs`, `src/core/mcp-sandbox.mjs` |
| `HELMION_SANDBOX_RUN_ID` | `example-id` | `src/core/mcp-sandbox.mjs` |
| `HELMION_SLACK_APP_ID` | `(empty)` | `src/cloud/bot-status.mjs` |
| `HELMION_SLACK_CLIENT_ID` | `example-id` | `tools/Start-Demo-Desk.ps1` |
| `HELMION_SLACK_SIGNING_SECRET` | `(empty)` | `src/cloud/communication-connectors.mjs` |
| `HELMION_SLACK_WEBHOOK_URL` | `(empty)` | `src/cloud/communication-connectors.mjs` |
| `HELMION_SPEAK_VOICE` | `(see source)` | `tools/voice-dictation/Helmion.VoiceSpeak/Program.cs` |
| `HELMION_SQL_DIR` | `/path/to/dir` | `src/core/schema-provisioner.mjs` |
| `HELMION_UI_FIXTURE_PORT` | `8080` | `qa/browser/fixture-server.mjs` |
| `HELMION_UNITY_PROJECTS` | `(see source)` | `bin/helmion-jobs.mjs` |
| `HELMION_VET_TOKEN` | `<secret — set in your secret store>` | `bin/helmion.mjs` |
| `HELMION_VET_URL` | `https://example.com` | `bin/helmion.mjs` |
| `HELMION_VOICE_MODELS` | `(see source)` | `tools/voice-dictation/Helmion.VoiceDictation/Program.cs`, `tools/voice-dictation/Helmion.VoiceDictation/VocabularyTranscriber.cs` |
| `HELMION_WORKER_ID` | `worker:hetzner` | `bin/helmion-cloud-worker.mjs` |
| `HELMION_WORKER_INTERVAL_MS` | `5000` | `bin/helmion-cloud-worker.mjs`, `bin/helmion-cora.mjs` |
| `MAPBOX_ACCESS_TOKEN` | `(empty)` | `.env.example` |
| `MISTRAL_API_KEY` | `<secret — set in your secret store>` | `src/agent/env.mjs` |
| `TAVILY_API_KEY` | `<secret — set in your secret store>` | `src/cloud/helm-search.mjs` |

## Executive Guard server (executive-guard/)

| Variable | Example value | Read in |
|---|---|---|
| `AUTO_APPROVE_DEVICE` | `(see source)` | `executive-guard/bin/auto-approve.mjs` |
| `AUTO_APPROVE_POLL_MS` | `(number)` | `executive-guard/bin/auto-approve.mjs` |
| `AUTO_APPROVE_PRINCIPAL` | `(see source)` | `executive-guard/bin/auto-approve.mjs` |
| `AUTO_APPROVE_REASON` | `(see source)` | `executive-guard/bin/auto-approve.mjs` |
| `EXEC_GUARD_APPROVAL_TTL_SECONDS` | `(number)` | `executive-guard/bin/executive-guard.mjs` |
| `EXEC_GUARD_APPROVER_TOKENS` | `owner=CHANGE_ME_approver_token` | `executive-guard/bin/executive-guard.mjs` |
| `EXEC_GUARD_AUDIT_PATH` | `/var/lib/executive-guard/audit/audit.jsonl` | `executive-guard/bin/executive-guard.mjs` |
| `EXEC_GUARD_CANDIDATES_PATH` | `/path/to/path` | `executive-guard/bin/executive-guard.mjs` |
| `EXEC_GUARD_DATA_DIR` | `/path/to/dir` | `executive-guard/bin/executive-guard.mjs` |
| `EXEC_GUARD_DEVICE_TOKENS` | `hands-mcp=CHANGE_ME_device_token` | `executive-guard/bin/executive-guard.mjs` |
| `EXEC_GUARD_HOST` | `0.0.0.0` | `executive-guard/bin/executive-guard.mjs` |
| `EXEC_GUARD_KEY_PATH` | `/var/lib/executive-guard/keys/signing-key.pem` | `executive-guard/bin/executive-guard.mjs` |
| `EXEC_GUARD_POLICY` | `(see source)` | `executive-guard/bin/executive-guard.mjs` |
| `EXEC_GUARD_PORT` | `8787` | `executive-guard/bin/executive-guard.mjs` |
| `EXEC_GUARD_STATE_PATH` | `/path/to/path` | `executive-guard/bin/executive-guard.mjs` |

## Hands MCP hub (hands-mcp/)

| Variable | Example value | Read in |
|---|---|---|
| `AUTH_PASSPHRASE` | `same-passphrase-as-the-memory-connector` | `hands-mcp/.env.example` |
| `GUARD_APPROVAL_WAIT_MS` | `(number)` | `hands-mcp/src/config.mjs` |
| `GUARD_DEVICE_ID` | `example-id` | `hands-mcp/src/config.mjs` |
| `GUARD_DEVICE_TOKEN` | `<secret — set in your secret store>` | `hands-mcp/src/config.mjs` |
| `GUARD_PUBLIC_KEY_X` | `(see source)` | `hands-mcp/src/config.mjs` |
| `GUARD_TIMEOUT_MS` | `(number)` | `hands-mcp/src/config.mjs` |
| `HANDS_ENABLED` | `true` | `hands-mcp/src/config.mjs` |
| `HANDS_HOLD_OPEN_WAIT_MS` | `(number)` | `hands-mcp/src/config.mjs` |
| `HANDS_MAIL_CC_PAUL` | `(see source)` | `hands-mcp/src/config.mjs` |
| `HANDS_PENDING_TTL_MS` | `(number)` | `hands-mcp/src/config.mjs` |
| `HANDS_PENDING_WATCH_MS` | `(number)` | `hands-mcp/src/config.mjs` |
| `PAIR_CODE_ISSUER_TOKEN` | `<secret — set in your secret store>` | `hands-mcp/src/config.mjs` |
| `PUBLIC_URL` | `https://<hands-host>` | `hands-mcp/.env.example` |
| `SCRIBE_CLIENT_ID` | `example-id` | `hands-mcp/src/config.mjs` |
| `SCRIBE_MAIL_FROM` | `(see source)` | `hands-mcp/src/config.mjs` |
| `SCRIBE_MAIL_TOKEN` | `<secret — set in your secret store>` | `hands-mcp/src/config.mjs` |
| `SCRIBE_MCP_URL` | `https://example.com` | `hands-mcp/src/config.mjs` |
| `SCRIBE_REFRESH_TOKEN` | `<secret — set in your secret store>` | `hands-mcp/src/config.mjs` |
| `SPOKE_TOKEN` | `<secret — set in your secret store>` | `hands-mcp/src/config.mjs` |

## OAuth door (door/)

| Variable | Example value | Read in |
|---|---|---|
| `DOOR_FLAVOUR` | `(see source)` | `door/src/config.mjs` |
| `GUARD_APPROVER_TOKEN` | `<secret — set in your secret store>` | `door/src/config.mjs` |
| `GUARD_URL` | `https://example.com` | `door/src/config.mjs`, `executive-guard/bin/auto-approve.mjs` (+1 more) |
| `HANDS_BACKEND_BASE` | `(see source)` | `door/src/config.mjs` |
| `MEMORY_BACKEND_BASE` | `(see source)` | `door/src/config.mjs` |
| `PORT` | `8090` | `door/src/config.mjs`, `hands-mcp/src/config.mjs` |

## Web app and API (web/, Vercel)

| Variable | Example value | Read in |
|---|---|---|
| `CLERK_PUBLISHABLE_KEY` | `<secret — set in your secret store>` | `web/marketing/server/herald-config.js` |
| `HELMIAN_PAID_CHECKOUT` | `(see source)` | `web/marketing/server/billing/checkout.js` |
| `HELMION_ARTIFACT_HELMIAN_BUNDLE_URL` | `https://example.com` | `web/marketing/server/billing/entitlement-store.js` |
| `HELMION_ARTIFACT_HELMIAN_GUARD_URL` | `https://example.com` | `web/marketing/server/billing/entitlement-store.js` |
| `HELMION_ARTIFACT_HELMIAN_INDIVIDUAL_URL` | `https://example.com` | `web/marketing/server/billing/entitlement-store.js` |
| `HELMION_BILLING_DATABASE_URL` | `postgresql://user:password@host/db?sslmode=require` | `web/marketing/server/billing/entitlement-store.js` |
| `HELMION_HERALD_DATABASE_URL` | `postgresql://user:password@host/db?sslmode=require` | `web/marketing/api/_herald-store.js`, `web/marketing/scripts/apply-herald-account-migration.mjs` |
| `HELMION_HERALD_ENROLLMENT_PEPPER` | `(see source)` | `web/marketing/server/herald-config.js` |
| `HELMION_SITE_ORIGIN` | `https://example.com` | `web/marketing/server/billing/stripe-contract.js` |
| `HELMION_TEAM_OAUTH_DATABASE_URL` | `postgresql://user:password@host/db?sslmode=require` | `web/marketing/api/_team-oauth-store.js` |
| `STRIPE_RESTRICTED_KEY` | `<secret — set in your secret store>` | `web/marketing/server/billing/stripe-contract.js` |
| `STRIPE_SECRET_KEY` | `<secret — set in your secret store>` | `web/marketing/server/billing/checkout.js`, `web/marketing/server/billing/stripe-contract.js` |
| `STRIPE_WEBHOOK_SECRET` | `<secret — set in your secret store>` | `web/marketing/server/billing/stripe-contract.js` |

## Discord bridge (discord-bridge/)

| Variable | Example value | Read in |
|---|---|---|
| `DISCORD_BOT_TOKEN` | `<secret — set in your secret store>` | `discord-bridge/index.mjs` |
| `HEALTH_HOST` | `example.com` | `discord-bridge/index.mjs`, `slack-bridge/index.mjs` |
| `HEALTH_PORT` | `8080` | `discord-bridge/index.mjs`, `slack-bridge/index.mjs` |
| `HELMIAN_CLOUD` | `(see source)` | `discord-bridge/index.mjs`, `slack-bridge/index.mjs` |
| `HELMIAN_ENVOY_BRIDGE_TOKEN` | `<secret — set in your secret store>` | `discord-bridge/bridge-core.mjs`, `slack-bridge/bridge-core.mjs` (+2 more) |
| `HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD` | `<secret — set in your secret store>` | `discord-bridge/bridge-core.mjs` |
| `STATE_DIR` | `/data` | `discord-bridge/index.mjs`, `door/src/config.mjs` (+1 more) |

## Slack bridge (slack-bridge/)

| Variable | Example value | Read in |
|---|---|---|
| `HELMIAN_ENVOY_BRIDGE_TOKEN_SLACK` | `<secret — set in your secret store>` | `slack-bridge/bridge-core.mjs` |
| `SLACK_APP_TOKEN` | `<secret — set in your secret store>` | `slack-bridge/index.mjs` |
| `SLACK_BOT_TOKEN` | `<secret — set in your secret store>` | `slack-bridge/index.mjs` |

## Credential service (credential-service-image/)

| Variable | Example value | Read in |
|---|---|---|
| `DATABASE_URL` | `postgresql://user:password@host/db?sslmode=require` | `credential-service-image/dbpeek.mjs`, `credential-service-image/dbpeek2.mjs` (+14 more) |
| `MIG_SQL_B64` | `(see source)` | `credential-service-image/neon-apply-069.mjs`, `credential-service-image/neon-apply-070.mjs` |

## Spoke installer (spoke-installer/)

| Variable | Example value | Read in |
|---|---|---|
| `HELMIAN_SPOKE_ROOTS` | `(see source)` | `spoke-installer/install-pair.mjs` |

## Deploy recipes (deploy/)

| Variable | Example value | Read in |
|---|---|---|
| `HELMIAN_ADMIN_HOST` | `admin.helmian.cloud` | `deploy/vps/.env.example` |
| `HELMION_COMMANDS_MODULE` | `(see source)` | `deploy/hetzner/agent-worker/original/worker-attachments.mjs`, `deploy/hetzner/agent-worker/worker-attachments.mjs` |
| `HELMION_WORKER_BATCH_AWAIT` | `(see source)` | `deploy/hetzner/agent-worker/agent-worker.mjs` |
| `HELMION_WORKER_JOB_CONCURRENCY` | `(see source)` | `deploy/hetzner/agent-worker/agent-worker.mjs` |
| `POSTGRES_PASSWORD` | `change-me-long-random` | `deploy/vps/.env.example` |
| `RELAY_HOST` | `relay.helmian.cloud` | `deploy/hetzner/.env.example` |
| `VOICE_HOST` | `voice.helmian.cloud` | `deploy/hetzner/.env.example` |
| `VOICE_TOKEN` | `change-me-long-random` | `deploy/hetzner/.env.example` |
| `VOICE_TTS_CACHE` | `(see source)` | `deploy/hetzner/voice-tts/voice-tts-server.py` |
| `VOICE_TTS_MODEL` | `model-name` | `deploy/hetzner/voice-tts/voice-tts-server.py` |
| `VOICE_TTS_ORIGIN` | `https://example.com` | `deploy/hetzner/voice-tts/voice-tts-server.py` |
| `VOICE_TTS_PORT` | `8080` | `deploy/hetzner/voice-tts/voice-tts-server.py` |
| `VOICE_TTS_TOKEN` | `<secret — set in your secret store>` | `deploy/hetzner/voice-tts/voice-tts-server.py` |
| `VOICE_TTS_VOICES` | `(see source)` | `deploy/hetzner/voice-tts/voice-tts-server.py` |
| `WORKER_PARK_FALLBACK_MS` | `(number)` | `deploy/hetzner/agent-worker/worker-park.mjs` |
| `WORKER_PARK_FILE` | `/path/to/file` | `deploy/hetzner/agent-worker/worker-park.mjs` |

## Windows desktop (desktop/, .NET)

| Variable | Example value | Read in |
|---|---|---|
| `ANTHROPIC_API_KEY` | `(empty)` | `desktop/Helmion.Desktop.Core/EnvironmentSettingsStore.cs` |
| `GEMINI_API_KEY` | `<secret — set in your secret store>` | `desktop/Helmion.Desktop.Core/EnvironmentSettingsStore.cs` |
| `GROK_API_KEY` | `<secret — set in your secret store>` | `desktop/Helmion.Desktop.Core/EnvironmentSettingsStore.cs`, `desktop/Helmion.Desktop.Core/ProfileSyncEngine.cs` |
| `HELMIAN_NODE` | `(see source)` | `desktop/Helmion.BridgeService/BridgeSupervisor.cs` |
| `HELMION_CLOUD_ORIGIN` | `https://example.com` | `desktop/Helmion.Desktop.Core/EnvoyCloudChat.cs` |
| `HELMION_CODEX_INSTANCE_ID` | `(empty)` | `desktop/Helmion.Desktop.Core/EnvironmentSettingsStore.cs`, `desktop/Helmion.Desktop.Core/ProfileSyncEngine.cs` (+1 more) |
| `HELMION_CODEX_MODE` | `read-only` | `desktop/Helmion.Desktop.Core/EnvironmentSettingsStore.cs`, `desktop/Helmion.Desktop.Core/ProfileSyncEngine.cs` (+1 more) |
| `HELMION_ENV_ROOT` | `/path/to/root` | `desktop/Helmion.Desktop.Core/EnvironmentSettingsStore.cs` |
| `HELMION_GITHUB_HANDOFF_BASE_URI` | `https://example.com` | `desktop/Helmion.LocalService.Security/TeamProviderAdapters.cs` |
| `HELMION_GITHUB_HANDOFF_TOKEN` | `<secret — set in your secret store>` | `desktop/Helmion.LocalService.Security/TeamProviderAdapters.cs` |
| `HELMION_GITHUB_TOKEN` | `<secret — set in your secret store>` | `desktop/Helmion.LocalService.Security/TeamProviderAdapters.cs`, `tools/Start-Demo-Desk.ps1` |
| `HELMION_MAESTRO_COORDINATOR` | `(see source)` | `desktop/Helmion.Desktop.Core/EnvironmentSettingsStore.cs` |
| `HELMION_PERMISSION_MODE` | `read-only` | `desktop/Helmion.Desktop.Core/AgentBridge.cs`, `src/agent/bridge.mjs` |
| `HELMION_REMOTE_CONTROL_ORIGIN` | `https://example.com` | `desktop/Helmion.Desktop/MainWindow.Herald.cs`, `desktop/Helmion.LocalService/Program.cs` |
| `HELMION_SMOKE_TRACE_PATH` | `/path/to/path` | `desktop/Helmion.Desktop/App.xaml.cs`, `desktop/scripts/publish.ps1` |
| `HELMION_TEAM_OAUTH_HANDOFF_TOKEN` | `<secret — set in your secret store>` | `desktop/Helmion.LocalService.Security/TeamProviderAdapters.cs` |
| `HELMION_WORKSPACE_PATH` | `/path/to/path` | `desktop/Helmion.Desktop.Core/AgentBridge.cs`, `desktop/Helmion.Desktop.Core/EnvironmentSettingsStore.cs` (+2 more) |
| `OPENAI_API_KEY` | `<secret — set in your secret store>` | `desktop/Helmion.Desktop.Core/EnvironmentSettingsStore.cs` |
| `USERDOMAIN` | `(see source)` | `desktop/Helmion.BridgeService/scripts/Install-HelmianBridge.ps1`, `spoke-installer/install-pair.mjs` |
| `WORKSPACE_PATH` | `/path/to/path` | `desktop/Helmion.Desktop.Core/AgentBridge.cs`, `desktop/Helmion.Desktop.Core/EnvironmentSettingsStore.cs` |
| `XAI_API_KEY` | `<secret — set in your secret store>` | `desktop/Helmion.Desktop.Core/EnvironmentSettingsStore.cs` |

