# Entry points and hooks

Where each program starts, what starts it, and where it usually runs.
Checked against the tree on 2026-11-26. Environment variables for each
one are in [CONFIGURATION.md](CONFIGURATION.md).

Names: the product is **Helmian**. The CLI, npm bins, `HELMION_*`
variables, the `.helmion/` folder and the .NET projects (`Helmion.*`)
keep the original spelling `helmion`. Both spellings mean the same thing.

## 1. Command-line tools (root `package.json` → `bin`)

| Command | File | What it is |
|---|---|---|
| `helmian` / `helmion` | `bin/helmion.mjs` | The main CLI. `helmion --help` prints every subcommand. |
| `mcp-helmion-context` | `bin/mcp-helmion-context.mjs` | MCP server (stdio) that serves project context to a coding agent. |
| `mcp-helmion-flywheel` | `bin/mcp-helmion-flywheel.mjs` | MCP server for the learning loop (lessons, candidates). |
| `mcp-helmion-advisory` | `bin/mcp-helmion-advisory.mjs` | MCP server for the advisory lane (low-trust model output awaiting human review). |
| `mcp-helmion-codex` | `bin/mcp-helmion-codex.mjs` | Codex MCP adapter. Read-only unless `HELMION_CODEX_MODE` says otherwise. |

Run `npm link` in the repo root to put these on your PATH.

### Main `helmion` subcommands

| Subcommand | Does |
|---|---|
| `agent` / `chat` / `code` | Interactive coding agent with tools on disk (`--provider grok`, `--workspace <dir>`, `-p "<task>"`). |
| `agent-os install [--target claude,codex,gemini] [--yes]` | Installs the rules, lessons and hooks pack from `templates/agent-os/` into each agent's home. Dry run unless `--yes`; never overwrites a file. |
| `project init "<Name>" [--yes]` | Writes a planning folder (PROJECT.md, planning/, sprints/, docs/, prompts/). Dry run unless `--yes`. |
| `init [workspace]` | Writes `.helmion/` into a workspace: `config.json`, `autonomy_rules.json`, and `hooks/pretooluse.ps1`. |
| `guard` | The governance check. Reads a tool-call JSON payload on stdin (Claude Code PreToolUse shape). Exit 0 = allow, exit 2 = block. |
| `audit [list\|summary]` | Reads the block ledger in `.helmion/audit/*.jsonl`. |
| `provenance [last\|list\|summary]` | Reads the provenance ledger (which model answered). |
| `advisory list\|show\|promote\|reject` | Human review of advisory-lane output. |
| `plugin list\|add\|remove\|commands` | Local plugins (a folder with `commands/` and optional `.mcp.json`). |
| `mcp-install discover\|audit\|sandbox\|review\|drift` | Five-stage review before installing a third-party MCP server. |
| `db-inspect`, `migration-plan`, `migrate`, `phase-two-switch-test` | Database commands. Each refuses to run without `--expect-endpoint <ep-id>` matching `HELMION_EXPECTED_ENDPOINT_ID`. |
| `validate-proof`, `consensus`, `distill`, `confirmation-action-hash`, `pilot-policy`, `owner-key`, `blockers`, `maestro-state`, `maestro-handoff` | Governance kernel and Maestro (coordinator) tools. See [REFERENCE.md](REFERENCE.md). |

## 2. Other `bin/` programs (run with `node bin/<file>`)

| File | What it is | Usually runs on |
|---|---|---|
| `pc-bridge.mjs` | The bridge: polls the cloud chat and puts a real agent behind it. `deploy/helmian-bridge.service` runs it under systemd. | The owner's PC or a runner box |
| `hands-spoke.mjs` | The PC spoke for Hands: `pair` once, then it dials out to the Hands hub and runs approved jobs. | The owner's Windows PC |
| `hands-grant-signer.mjs` | Signs a root grant with the Executive Guard key. Not for the PC. | Executive Guard side |
| `helmion-cloud-worker.mjs` | Cloud console worker (`--once` for one pass). Needs `HELMION_DATABASE_URL`. | Hetzner box (`deploy/hetzner/docker-compose.yml`, service `worker`) |
| `helmion-cloud-admin.mjs`, `helmion-admin-bootstrap.mjs` | Self-hosted admin server and its first-owner bootstrap. | Self-hosted VPS (`deploy/vps/`) |
| `helmion-cloud-preflight.mjs`, `helmion-release-preflight.mjs` | Checks a deployment's settings before release. | CI or operator |
| `helmion-credential-service.mjs` | Credential service entry point. | Hetzner box |
| `helmion-cora.mjs` | Local Cora backend (voice agent). | Owner's PC |
| `helmion-jobs.mjs start\|stop\|status` | The four local background jobs (`src/jobs/`). | Owner's PC |
| `mcp-helmion-local.mjs` | Local-execution MCP server: PowerShell and file tools behind a human approval. Off by default. | Owner's PC |
| `provision-tenant.mjs` | Creates a tenant sandbox on a Linux runner. Run as root. | Runner box |
| `runner-vault.mjs` | Per-user encrypted credential vault on a runner. | Runner box |
| `mint-muse-connector-key.mjs` | Operator tool: mint or disable a Muse connector key. | Operator |
| `provenance-investigate.mjs` | Builds a provenance dossier for one claim. | Operator |

## 3. Services in their own folders

| Folder | Start | What it is |
|---|---|---|
| `executive-guard/` | `node executive-guard/bin/executive-guard.mjs` | Executive Guard server: signed decisions, approvals, grants, hash-chained audit. Docker: `executive-guard/deploy/Dockerfile`. |
| `hands-mcp/` | `npm --prefix hands-mcp start` (`src/index.mjs`) | Hands MCP hub: the remote MCP connector that lets an approved AI client act on the owner's PC through the spoke. Docker: `hands-mcp/Dockerfile`. |
| `door/` | `npm --prefix door start` (`src/index.mjs`) | OAuth door for Hands (door.helmian.cloud) plus the owner's approvals page. |
| `discord-bridge/` | `node discord-bridge/index.mjs` | Two-way Discord mirror. `mcp-server.mjs` serves the mirror as MCP tools. |
| `slack-bridge/` | `node slack-bridge/index.mjs` | Two-way Slack mirror over Socket Mode. |
| `web/marketing/` | Vercel (`vercel.json`; build step `scripts/bundle-admin.mjs`) | helmian.cloud: the public site, the web app at `/app`, Herald at `/herald`, and the API under `api/` (`api/[...path].js` routes into `server/` and the bundled `helmian-admin`). |
| `extension/` | Load unpacked (see below) | Helmian Guard browser extension. |
| `desktop/` | `npm run desktop:run` (Windows, .NET SDK) | Windows desktop app (`Helmion.Desktop`), local service (`Helmion.LocalService`), bridge service, smoke tests. |
| `spoke-installer/` | Built by Inno Setup (`HelmianSpoke.iss`) | Windows installer for the PC spoke; `install-pair.mjs` pairs the PC during setup. |
| `src/herald/` | `src/herald/server.mjs` | Herald phone companion server (on hold as a product push). |
| `src/mcp/` | via the `mcp-helmion-*` bins | MCP server implementations. |

## 4. Executive Guard HTTP endpoints (`executive-guard/src/server.mjs`)

| Method and path | Caller | Purpose |
|---|---|---|
| `GET /healthz` | anyone | Liveness. |
| `GET /v1/keys` | anyone | The Ed25519 public key decisions are signed with, so clients verify offline. |
| `POST /v1/decisions` | device | Ask for a decision on one action. Returns a signed allow / deny / ask. |
| `GET /v1/approvals/:id` | device | Poll a pending approval (own device only). |
| `GET /v1/approvals` | approver | List approvals (`?status=pending`). |
| `POST /v1/approvals/:id/decide` | approver | Approve or deny a pending approval. |
| `GET /v1/grants` | device | This device's standing grants for routine work. |
| `POST /v1/grants/:id/revoke` | approver | Revoke a standing grant. |
| `GET /v1/audit` | approver | The hash-chained audit trail. |
| `GET /v1/audit/verify` | approver | Re-verify the chain end to end. |
| `POST /v1/audit/outcomes` | device | Report what happened after a decision. |
| `GET /v1/provenance/policy`, `POST /v1/provenance/evaluate` | device | Package/source provenance rules and checks. |

Device callers authenticate with `EXEC_GUARD_DEVICE_TOKENS`; human approvers with `EXEC_GUARD_APPROVER_TOKENS`. Tokens are compared as SHA-256 digests. Every decision and approval is written to the audit trail before the response goes out. No CORS headers are sent, so an ordinary web page cannot read responses. Default bind is `127.0.0.1:8787`.

## 5. Hooks

| Hook | File | Fires on | Effect |
|---|---|---|---|
| PreToolUse governance hook | `hooks/pretooluse.ps1` (copied to `<workspace>/.helmion/hooks/` by `helmion init`) | Every tool call by a coding agent that is configured to run it (Claude Code PreToolUse) | Pipes the payload into `helmion guard`. Exit 2 blocks the call. If the `helmion` CLI is not on PATH, the hook itself blocks (exit 2) rather than letting calls through. |
| Agent OS SessionStart hook | `templates/agent-os/hooks/session-start-context.mjs` | Agent session start | Prints the current loop state (what is blocked, what was learned, which files another session holds) into the new session. Never blocks; exits 0 on any failure. |
| Agent OS Stop hook | `templates/agent-os/hooks/stop-capture.mjs` | End of an agent turn (Stop; AfterAgent on Gemini) | Appends one JSON line to `agent-os/journal/YYYY-MM-DD.jsonl`. A later step drafts candidate lessons; a human promotes them. Never blocks the agent from stopping. |
| Per-agent hook settings | `templates/agent-os/targets/<agent>/` (`settings.hooks.json`, `hooks.json`, `hooks.toml`) | Installed by `helmion agent-os install` | Merged into the agent's own settings by `src/core/agent-os.mjs` (`mergeHookSettings`), between marker lines so they can be removed cleanly. |
| Rule gates (not installed by default) | listed in `templates/agent-os/rules/RULES.json` with `"installed": false` | Stop / PreToolUse / PostToolUse | Described rules whose gate scripts are not shipped yet. |
| Browser send-time check | `extension/content/` | Pressing send in claude.ai, ChatGPT, Gemini, Grok | Stops an explicit request to erase a whole computer, drive or data set; hides destructive code blocks behind a warning. |
| Site Guard intake screen | `src/cloud/site-guard.mjs`, called from `src/cloud/envoy-mesh.mjs` | Every channel message about to be handed to a seat | Blocks destructive commands, prompt injection, secret-fishing and data-exfiltration asks (rules in `src/cloud/site-guard-rules.mjs`, per-rule block/flag/off via `HELMIAN_SITE_GUARD_RULES`); flags weak markers; stops floods. See the README. |
| Site Guard outbound redaction | `src/cloud/site-guard-outbound.mjs`, called from `postAsAgent` in `src/cloud/envoy-mesh.mjs` | Every seat reply, before it is stored | Replaces keys, tokens, passwords, URL credentials and public server addresses with `[REDACTED]`; records kinds and counts as a finding. |
| Site Guard HTTP layer | `src/cloud/http-guard.mjs`, called first in `web/marketing/api/helmian-admin.js` | Every request to the cloud function | Per-credential / per-IP rate limits (429), 4 MB ceiling (413), HTTPS-only (308 / 403), security headers. |

**Wiring the PreToolUse hook yourself.** `helmion init` copies the hook
script into the workspace but does not edit any agent's settings file.
Point your agent's PreToolUse hook at
`powershell -NoProfile -File <workspace>/.helmion/hooks/pretooluse.ps1`.
The hook is PowerShell, so it targets Windows (or PowerShell 7 elsewhere).

## 6. Where the big pieces live in code

| Piece | Code |
|---|---|
| Write lease (one writer per project) | `src/core/lease.mjs` (local lease file `.helmion/lease.json`, exclusive create, fails closed, 90 s default TTL); `src/adapters/neon.mjs` `requireActiveLease` for Helmian's own database writes |
| Signed approvals | `executive-guard/src/signing.mjs` (Ed25519), `executive-guard/src/canonical.mjs` (canonical JSON), mirrored for offline checks in `extension/background/verify.js` |
| Allow / deny / ask policy | `executive-guard/src/policy.mjs` (default deny), mirrored in `extension/background/local-policy.js` |
| Audit trail (hash chain) | `executive-guard/src/audit.mjs` |
| Block log (local ledger) | `src/core/audit-log.mjs` → `.helmion/audit/*.jsonl`, read by `helmion audit` |
| Destructive-command kernel | `src/core/governance.mjs` (`detectDestructiveOperation`), `src/core/governance-gate.mjs` |
| Rules baked into agents | `templates/agent-os/`, `src/core/agent-os.mjs` (profile sync) |
| ABAC (attribute rules) | `src/cloud/attribute-policy.mjs`, `src/cloud/tenant-action-authorization.mjs`, receipts via `src/cloud/audit-event-repository.mjs` |
| Package provenance gate | `src/core/package-provenance.mjs` |
| Secret redaction | `src/agent/redact.mjs` (agent runtime); `redactForAudit` in `src/core/audit-log.mjs` for the block log |
| Database schema | `sql/` (numbered migrations, applied by `helmion migrate`) |
