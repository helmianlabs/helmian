# helmian.cloud/admin — what is real vs mocked (2026-10-14)

**Live path:** Vercel (`web/marketing/vercel.json`) rewrites `/admin`, `/admin/*`, `/api/admin/*` to
`helmian-cloud.fly.dev`, which is **up** and serving `bin/helmion-cora.mjs` with the live admin mounted.
`/admin` returns the real workspace page; every `/api/admin/*` call returns `403 ADMIN_MEMBERSHIP_REQUIRED`
until an OIDC-signed-in member exists. The Fly root still says "Point a Hume EVI config at /llm" (Hume-era).

**Working (server + Postgres-backed, tenant-scoped, audited):** OIDC login/session, control surface,
audit events + export, Envoy org chat (SSE), Cora config/knowledge/usage budgets, agent-task intents,
approvals inbox with durable decisions, connector registration metadata, provider-connection
references (vault refs only), workspace layout, people/role plans, Artifact Studio intents.

**Mocked / receipt-only** (see `src/cloud/desktop-parity.mjs`, served at `/api/admin/desktop-parity`):
- Console records intents; does not execute commands, MCP audits, filesystem tools or provider turns.
- Agents: task intents never start a worker. Approvals record decisions but don't invoke desktop workers.
- Connectors: no OAuth/secret exchange/outbound delivery from the cloud (Slack/Discord OAuth handoff
  lives on the Vercel side).
- Artifact Studio: preflight receipts only.
- No hosted Overview, Settings, project-folder Workspace, Evidence, Release pages; Guard doesn't receive
  browser events. Load-board search uses sample loads.
- Subscriptions: provider subscriptions are references; no cloud-side Claude/ChatGPT/Gemini/Grok session.

**Missing to reach EXE parity:** a cloud worker that claims `cora_agent_task` / console intents and
executes them (on the VPS, under the same governance gate as the desktop), then the relay from Herald
to that worker. That is the next build step on the VPS.
