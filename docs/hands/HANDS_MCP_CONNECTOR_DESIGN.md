# Hands MCP connector: design + Executive Guard interface

Status (2026-10-22): **implemented and deployed** after Troy's "Go yes" (bridge service + remote PC control).
Code: `hands-mcp/` (server) and `src/hands/pc-spoke.mjs` + `bin/hands-spoke.mjs` (PC). Live at
`https://hands.5-78-222-178.sslip.io/mcp`. Executive Guard is not live yet, so every mutating tool is denied; read-only
tools work once the PC is paired.

Implementation differences from the draft below:
- Guard API: the hands server talks to the real Executive Guard from PR #53 (`POST /v1/decisions`, `GET /v1/approvals/:id`,
  envelope `{payload, signature, keyId}`), not the `/guard/v1/*` sketch in section 5. Mutating calls are sent as
  `kind: agent.tool` with the `destructive-intent` signal so Guard asks a human; an automatic allow is rejected.
- PC channel: the PC spoke long-polls the hands server over HTTPS (`/spoke/v1/poll`, `/spoke/v1/result`) instead of Ably.
  Still outbound-only. The PC pairs by typing the hands passphrase locally (`hands-spoke pair`); no token goes through chat.
- Runner spoke: not built yet; all v1 tools are PC tools.

## 1. What it is
An MCP server ("hands") that lets an approved AI client (Claude.ai, Grok, ChatGPT, Helmian's own Maestro) ask for
actions on Troy's PC or on the Hetzner runner: read a file, run an allow-listed PowerShell command, query local Ollama,
open a page in the PC browser. Every call is decided by Executive Guard before anything runs.

## 2. Placement (mirrors the shared-memory server, spec 2.2/2.6)
- Host: Hetzner box 5.78.222.178, next to `claude-memory-mcp`. New container `helmian-hands-mcp`, behind the same Caddy
  (new site block, e.g. `hands.<sslip host>`), listening only on the Docker network. No new public ports beyond 443.
- Auth: OAuth 2.1 + PKCE + dynamic client registration, consent page on Troy's own server with a passphrase, exactly
  like the memory server. Scopes: `hands.read` (read-only tools) and `hands.act` (state-changing tools). A `hands.act`
  token still cannot bypass Guard.
- Secrets: in `/opt/helmian-hands-mcp/app.env` (600). **No provider API keys** (019 contract). The server holds only its
  OAuth signing key, the passphrase hash, and the relay credential for the bridge channel.

## 3. Data path
```
AI client --MCP/HTTPS--> hands MCP (Hetzner) --decide()--> Executive Guard
                                   |  allow / approved
                                   v
                    compute routing (src/core/compute-routing.mjs)
                       |                                   |
            Ably channel to PC bridge              local call on runner
          (HelmianBridge service, PR #51)          (helmian-bridge systemd)
                       |                                   |
                 result + audit  <-----------------  result + audit
```
- Routing uses `decideComputeRoute` (PR #50): PC-only tools (`local-files`, `powershell`, `ollama`, `pc-browser`) go to
  the PC or queue while it is off; never silently to the runner.
- The PC bridge stays outbound-only (Ably subscription). Nothing on the PC listens on a port.
- Results are size-capped (64 KB) and redacted with the Guard extension's redaction rules before they leave the spoke.

## 4. Tool surface v1 (all go through Guard)
| Tool | Scope | Spoke | Default Guard posture |
|---|---|---|---|
| `hands.list_files(path, glob)` | read | pc/runner | allow inside workspace roots, deny elsewhere |
| `hands.read_file(path, maxBytes)` | read | pc/runner | allow inside workspace roots; deny secrets paths (`.env`, `*.pem`, `%APPDATA%\Helmian`) |
| `hands.ollama_generate(model, prompt)` | read | pc | allow |
| `hands.run_powershell(commandId, args)` | act | pc | **require human approval**; only allow-listed command ids, never free text |
| `hands.open_url(url)` | act | pc | require approval unless host on allow-list |
| `hands.write_file(path, content)` | act | pc/runner | require approval; workspace roots only; write lease required |

## 5. Executive Guard interface (for the Guard teammate to implement — not built here)
The hands server is a **client** of Guard. It calls Guard; Guard owns policy, approvals, and the audit trail.

### 5.1 `POST /guard/v1/decide`
Request:
```json
{
  "requestId": "hreq_…",            // unique, idempotency key
  "actor": { "kind": "ai-client", "clientId": "…", "subject": "user_…", "scopes": ["hands.read","hands.act"] },
  "tool": "hands.run_powershell",
  "target": { "spoke": "pc", "deviceId": "desktop_…" },
  "arguments": { "commandId": "git-status", "args": { "repo": "E:\\Helmion" } },
  "argumentsDigest": "sha256:…",     // digest of canonical JSON; Guard signs over this
  "context": { "sessionId": "…", "routeReason": "Needs powershell, which only the PC has." },
  "requestedAt": "2026-10-22T09:00:00Z"
}
```
Response:
```json
{ "decision": "allow" | "deny" | "pending_approval",
  "decisionId": "gdec_…",
  "reason": "plain-language reason shown to the human",
  "approval": { "approvalId": "gapr_…", "expiresAt": "…", "channel": "herald|app|envoy" },   // only when pending
  "constraints": { "maxRuntimeMs": 30000, "maxOutputBytes": 65536, "readOnly": false },
  "signature": "ed25519:…"           // over decisionId + requestId + argumentsDigest + decision + expiresAt
}
```
### 5.2 `GET /guard/v1/approvals/{approvalId}` → `{ state: pending|approved|denied|expired, decidedBy, decidedAt, signature }`
Long-poll or webhook; the human approves on Herald (phone), /app Approvals, or Envoy.

### 5.3 `POST /guard/v1/audit` (append-only)
`{ decisionId, requestId, outcome: "executed"|"failed"|"refused_by_spoke", spoke, startedAt, finishedAt, outputDigest, error? }`

### 5.4 Rules the hands server enforces regardless of Guard
1. No decision, an unverifiable signature, or a Guard timeout → **deny** (fail closed).
2. The spoke re-verifies the Guard signature and the `argumentsDigest` before executing (the PC never trusts the
   Hetzner box alone).
3. Approvals are single-use and bound to the exact arguments digest; changed arguments need a new approval.
4. Every executed or refused call is audited, including denials.
5. Kill switch: `HANDS_ENABLED=false` in app.env (default) makes every tool return "hands are off".

## 6. Rollout gates
1. Guard decide/approval/audit endpoints exist (Guard teammate).
2. PC bridge service installed with consent (PR #51) — Troy's direct OK.
3. Read-only tools on the runner only, then PC read-only, then `hands.act` with approvals.
4. Deploy on Hetzner behind Caddy — Troy's direct OK. Until then nothing is deployed and `HANDS_ENABLED` defaults false.
