# Helmion Guarded AI Contract

Status: living policy document. Written 2026-08-01 from direct source-code
inspection (cited below), not from names or assumptions. Applies to every AI
or automation surface across every product — AimForge, DairyForge, Cora
(voice/chat), Helmion's own desktop Pilot and Node agent, browser extensions,
and any future integration. No exceptions carved out per-product; a product
that needs an exception must change this contract, not quietly bypass it.

---

## 0. The one-paragraph honest summary

The system literally named "Guard" (the WPF desktop panel: `GuardAuditLog.cs`,
`GuardFeed.cs`, `ExecutionGuardProbe.cs`, `GuardFreshness.cs`, plus the browser
extension's `guard.js`/`ledger.js`) **is not an enforcement system. It detects
nothing itself** — this is stated in its own source comments, repeatedly, by
its own authors. It is a dashboard that displays state handed to it by other
systems, plus one local browser-side pattern-matcher that can mask a
dangerous-looking code block on four AI-chat websites but cannot block, click,
submit, or prevent anything. **The real enforcement lives in three separate
mechanisms that are not named "Guard" at all**: (1) a fail-closed governance
kernel in the Node agent (`governance-gate.mjs`) that runs before every tool
call and cannot be overridden by a human clicking "allow," (2) a risk-tiering
policy (`pilot-policy.mjs`) that sorts any described action into
auto-run/pause-for-owner/hard-block, and (3) a cryptographic one-time human
confirmation protocol (`human-confirmation.mjs`) for the highest-risk actions,
using Ed25519 signatures bound to an exact action hash with a 15-minute
maximum lifetime. This document treats those three as "Guard" in the
functional sense Troy means, and treats the C#/browser system literally named
Guard as what it actually is: a dashboard and a local advisory scanner, useful
but not a safety boundary.

---

## Part A — What exists today, verified against source (not docs, not names)

### A1. The literal "Guard" system — dashboard + local advisory only

| Component | File | What it verifiably does | What it CANNOT do |
|---|---|---|---|
| `GuardAuditLog` | `desktop/Helmion.Desktop.Core/GuardAuditLog.cs` | Reads/parses a JSONL ledger (`.helmion/audit/blocks-*.jsonl`) if one exists | Write to the ledger itself (only `EnsureLedger()` creates the folder); block anything |
| `GuardFeed` | `desktop/Helmion.Desktop.Core/GuardFeed.cs` | In-memory dashboard model — dedups, retains, escalates cards it's handed | Detect anything on its own — its own docstring: "It detects nothing" |
| `ExecutionGuardProbe` | `desktop/Helmion.Desktop.Core/ExecutionGuardProbe.cs` | Health-checks the REAL gate (below) by feeding it one destructive and one harmless test command | Block a real user action — it only tests, in a throwaway temp dir |
| `GuardFreshness` | `desktop/Helmion.Desktop.Core/GuardFreshness.cs` | Formats "checked at X, not re-checked automatically" | Any check itself — pure caption text |
| `MainWindow.GuardPanel.cs` | desktop UI | Publishes posture cards, surfaces a PRE-EXISTING ask-mode approval question (mirror, not source), deletes a lock file it re-verifies as stale | Detect or block anything itself |
| Browser `guard.js`/`ledger.js` | `extension/content/guard.js`, `extension/background/ledger.js` | Reads code blocks + prose text on 4 hardcoded domains (claude.ai, chatgpt.com, gemini.google.com, grok.com), masks a flagged code block behind an extra click, logs to local `chrome.storage.local` | Click, fill, submit, or act on the page in any way; reach the network (enforced by its own build test); block anything server-side |

**Known live gap, stated plainly:** the ledger `GuardAuditLog` reads is, per the
code's own header comment, largely unwritten-to in production — the in-agent
governance gate (A2 below) doesn't pass it a workspace to write to, the
browser extension is architecturally forbidden from writing anywhere but its
own local storage, and the only real writer is the `helmion guard` CLI
subcommand, writing to its own `cwd`. **This means the desktop "block ledger"
dashboard is currently an unreliable picture of what the real gate is doing.**
This is a defect to fix (wire `auditWorkspace` through at the real call site),
not a design intended to work this way.

### A2. The real enforcement — Node agent governance kernel

File: `src/core/governance-gate.mjs`, called from `src/agent/tools.mjs:522`,
**before** every tool executes, per the code's own comment: *"Every tool goes
through this, not just run_command."*

- Deterministically hard-blocks destructive patterns (e.g. `rm -rf`-style
  commands). **No human approval can override this** — the code enforces
  ask-mode approval only runs AFTER this check, specifically so a human can
  never click "allow" on something the kernel already forbade.
- Fails closed on any internal error (unreadable rule file, bad regex,
  exception) — always a refusal, never a silent allow.
- Separately gated: `run_command` runs in the workspace `cwd` only, with a
  stripped allow-listed environment (~40 named-safe vars, explicitly
  excluding all credentials), truncated + secret-redacted output, and a
  120-second timeout with kill-on-expiry. File tools (`read_file`,
  `write_file`, `list_dir`, `search_text`) are workspace-confined —
  `resolveInWorkspace()` rejects any path, including an absolute one, that
  escapes the workspace root.

**Current default posture (a real, present-day risk, not hypothetical):** the
CLI's default permission mode is `full` — `write_file` and `run_command` run
without asking a human at all (`session.mjs:86-89`). This is compensated by
the governance kernel above (hard blocks apply regardless of mode) and by
sandboxing, but it is not equivalent to "ask by default." A stricter default
is a real, buildable change (four tiers already exist: `read-only`,
`read-tools`, `ask`, `full` — switching the CLI default to `ask` is a config
change, not new engineering).

In `ask` mode: fail-closed by design — no approver connected, non-TTY stdin
(piped/CI), or a timeout all deny. There is deliberately no environment
variable, argument, or event an agent can emit to approve its own call.

### A3. The real enforcement — risk tiering (`pilot-policy.mjs`)

`evaluatePilotAction(operation, guardState)` returns exactly one of:

- **`AUTO_RUN`** — only when the operation explicitly states
  `pilotScope: "local-workspace"`, `wellBounded: true`, `reversible: true`,
  `sensitiveData: false`, and no protected-boundary/hard-block flag is set.
  **Missing or ambiguous fields do not default to low-risk — they default to
  `PAUSE_FOR_OWNER`.**
- **`PAUSE_FOR_OWNER`** — any of a named high-risk flag list: `destructive`,
  `externalWrite`, `productionDeploy`, `credentialAccess`, `permissionChange`,
  `identityTrustChange`, `securityControlChange`, `irreversible`, or any scope
  other than `local-workspace`.
- **`BLOCK`** — a hard, non-approval-bypassable condition: a deterministic
  guard block, an active block-severity rule, an active scoped blocker, a
  write-lease conflict, or unverifiable shared governance state. **Human
  approval cannot override a BLOCK — the underlying condition must change
  first.**

Advisor/model consensus is explicitly wired to **never** authorize `AUTO_RUN`
or a Tier-B pause (`advisor_consensus_can_authorize: false` is hardcoded into
every result).

### A4. The real enforcement — cryptographic one-time human confirmation

File: `src/core/human-confirmation.mjs`, backed by `sql/003_human_confirmations.sql`
(`human_identity_keys`, `human_handoff_confirmations` tables).

- Assertion is Ed25519-signed over a canonical JSON envelope binding
  `audience + project_slug + handoff_id + operation` into one SHA-256 hash —
  changing anything about the action invalidates the signature.
- **Maximum lifetime 15 minutes** (`MAX_CONFIRMATION_TTL_SECONDS = 900`),
  clock-skew tolerance 60s, hard-rejected if expired or issued in the future.
- **One-time use**: the confirmation is atomically consumed by the exact
  handoff/lease target; a retry with the same idempotency key replays the
  original result rather than re-consuming; a different key cannot consume it
  again.
- **No self-enrollment path**: there is deliberately no MCP/coordinator method
  to enroll a trusted identity key — otherwise an agent could mint its own
  trust root and approve its own action. Enrollment is an explicit,
  undecided product-level control (owner/admin session, enterprise IdP, or a
  hardware-backed key ceremony) — **not yet chosen, called out honestly as an
  open decision in the doc itself.**
- Fail-closed on operational failure: if the downstream Tier-B operation
  fails after a confirmation is consumed, a **new** confirmation is required —
  consumption is not "credit" that can be reused on retry.

**Current scope limitation, stated honestly:** the schema (`handoff_id`,
`project_slug`) is Maestro-multi-agent-handoff shaped. The mechanism (signed,
hashed, TTL'd, one-time-use, non-self-enrollable) is generically reusable; the
field names are not yet generalized for a non-handoff action like "AI proposes
to book load #4821 in AimForge." Section C4 below specifies the
generalization needed.

### A5. What does NOT exist today (do not claim otherwise)

- **No tenant/user/role boundary anywhere in shipped code.** Today's scoping
  is project/workspace (a single-writer lease per project slug) and, on the
  desktop, per-conversation-session UI isolation for one human operator on
  one machine. `MULTI_USER_RELEASE_ROADMAP.md` states this candidly: *"It is
  not yet a multi-user release."* Tenant identity, RLS, and per-role auth are
  target architecture, explicitly not implemented.
- **No enforced concurrency lock.** `SESSION_BOARD.md` is a voluntary,
  hand-edited markdown convention — it exists because two sessions already
  collided once, and its own text documents a SECOND near-miss (the
  git-index race) that the recommended mitigation does not fully close: *"The
  check is not wrong; it is just not a lock."*
- **No remote/phone action-taking today.** `MARK_REMOTE_CONTROL_SPEC.md`'s
  action-lane (Layer 3+) is marked **SPEC ONLY** — read-back voice control
  exists (Layer 1, built-unverified), remote WRITE actions do not, and the
  doc is explicit that reaching this phase requires the same tenant-scope +
  human-approval-gate + immutable-audit-trail work described here, not yet built.
- **The Guard ledger is not a reliable audit trail today** (A1 above) — this
  is the single highest-priority near-term fix: wire `auditWorkspace` through
  the real call site in `governance-gate.mjs` so every real refusal is
  actually recorded where the dashboard reads from.

---

## Part B — The Helmion Guarded AI Contract (binding policy, every product)

This section is the actual "Guard" every product must build to — a contract,
not a specific file. Where Helmion already has a working mechanism for a rule,
it is named; where it does not, that is stated as a gap to close before the
corresponding action is allowed in production.

**C1. Default-deny scope of read.** An AI component may read only data it is
explicitly authorized and scoped to see (project/workspace boundary today;
tenant/role boundary once A5 ships). No AI surface reads across a project or
tenant boundary because it happened to be reachable.

**C2. Cognitive actions are unrestricted within scope.** Summarizing,
classifying, ranking, explaining, drafting, and recommending are always
allowed within the read scope above — this is the entire value of the AI
layer and is never gated. (This matches the AimForge Cora NL-search plan
already written: Cora converts language to filters/ranking, nothing more,
and that's exactly a C2-class action.)

**C3. No arbitrary text becomes a command.** Every write or external action
must be a named, typed, schema-validated action (a function with a fixed
argument shape), never "whatever string the model produced, run as a
command." This is already true for the five-tool agent runtime
(`read_file`/`write_file`/`list_dir`/`run_command`/`search_text` — a closed
set, not an open shell) and must be true for every future product surface:
an AimForge "book this load" action is a typed `{loadId, tenantId, rate}`
call, never a parsed sentence executed directly.

**C4. Every write/external action is bound to tenant, role, and session —
generalize the confirmation schema.** Today's `human-confirmation.mjs`
binds `project_slug + handoff_id + operation`. The reusable version needed
for AimForge/DairyForge/Cora replaces `handoff_id` with a generic
`{tenant_id, actor_session_id, resource_id}` triple, keeping every other
property (Ed25519 signature, exact action hash, 15-min max TTL, one-time
consumption, no self-enrollment). This is a schema generalization of working
code, not new cryptographic design.

**C5. High-risk action review screen shows the real thing, not a summary.**
Per `PILOT_RISK_POLICY.md`'s existing pattern: the human sees the exact
operation JSON, the structured risk reasons that triggered review, and the
project/session/handoff (or tenant/resource, per C4) context — never just an
"approve?" button with no evidence.

**C6. The following always require human approval — no product gets to
mark them auto-run,** matching `pilot-policy.mjs`'s existing `HIGH_RISK_FLAGS`
plus Troy's explicit list: commits, pushes, pull requests, deployments,
production configuration changes, external messages (email/SMS/chat send),
bookings, tender acceptance, rate changes, financial actions, record
deletion, and permission/identity-trust/security-control changes. Missing or
ambiguous risk classification on any action defaults to review, never to
auto-run (already the coded behavior in `pilot-policy.mjs` — carry it
forward everywhere, do not let a new product silently default to permissive).

**C7. Approval is exact and short-lived, never blanket.** An approval
authorizes the one exact action (bound by hash, per C4) for at most 15
minutes and is consumed exactly once. "Approve this session" or "trust this
agent going forward" is not a supported approval shape anywhere in this
contract.

**C8. Hard blocks are not approval-bypassable.** A deterministic destructive
pattern, an active blocking rule, a lease/lock conflict, or unverifiable
shared state is a `BLOCK`, not a `PAUSE_FOR_OWNER` — no human click
overrides it; the underlying condition must change first (already the coded
behavior in both `governance-gate.mjs` and `pilot-policy.mjs`).

**C9. Every attempted, denied, approved, executed, failed, or revoked
action has durable audit evidence.** This is the one place the current
implementation has a real, known gap (A1/A5) — close it before any product
depends on the audit trail for a compliance or safety claim.

**C10. Idempotency, replay protection, rate limits, timeouts, and safe
failure are non-negotiable per action.** Already real for tool calls
(timeout+kill on `run_command`) and for confirmations (one-time consumption,
idempotency-key replay of the original result). Any new action type
(AimForge booking, Cora voice tool-call, a future integration) must specify
all five before it ships, not retrofit them after an incident.

**C11. No client-side AI provider key.** No product embeds an LLM/API key in
a browser bundle, mobile app, or any client the user's device controls.
Server-mediated only, same as today's Hume EVI token-vend pattern already in
use on AimForge (`dispatch-hume-token.ts`, `browser-hume-token.ts`).

**C12. No hidden browser automation.** A browser extension may read the page
and render its own UI (per A1's confirmed guard.js behavior) but may never
click, fill, submit, or otherwise act on a page on the user's behalf without
that being the extension's stated, reviewed purpose — matches the existing
AimForge architecture ruling that a browser-companion connector must never be
"a hidden server scraper."

**C13. No arbitrary shell command from an untyped source.** The closed
five-tool set (C3) with workspace confinement and env-stripping is the
pattern — a new product's automation surface does not get a bigger hammer
than the Node agent already uses.

**C14. No unrestricted file access.** Workspace/tenant-root confinement
(`resolveInWorkspace`-equivalent) is mandatory for every new file-touching
action, in every product.

**C15. No unrestricted provider tool access.** A model is given the specific
named tools its task needs, never "all tools," and every tool call passes
through the governance kernel (A2) regardless of which product invoked it.

---

## Part C — Decision table: risk tier → what happens

| Action example | Tier | What happens | Why (contract clause) |
|---|---|---|---|
| Read own-tenant data, summarize, rank, explain, draft a reply | **Low** | **Allowed automatically** | C1 (in-scope read) + C2 (cognitive actions unrestricted) |
| Local code edit, local test run, read-only inspection, reversible workspace file change | **Low** | **Allowed automatically**, IF explicitly tagged `local-workspace` + `wellBounded` + `reversible` + not `sensitiveData` | A3 (`AUTO_RUN` criteria) — missing/ambiguous tags escalate to Medium, not auto-run |
| AI drafts a broker email / rate counter-offer for human review | **Low-Medium** | **Allowed automatically to draft; sending requires review** | C2 (draft always allowed) + C6 (external message requires approval) |
| Cora converts a spoken/typed query into load-board filters and shows ranked results | **Low** | **Allowed automatically** | C2 — this is the entire scope of the AimForge Cora NL-search plan; no booking authority attached |
| Schema/migration change | **Medium-High** | **Requires human review**, exact operation shown | C6, A3 (`PAUSE_FOR_OWNER` flag list) |
| Production-data access or write | **High** | **Requires human review** (or `BLOCK` if it also trips a hard-block condition) | C6, A3 |
| Authentication / permission / identity-trust / security-control change | **High** | **Requires human review**, cryptographic confirmation (C4/C7) once schema is generalized | C6, A4 |
| Cross-project/cross-tenant contract or data access | **High** | **Requires human review** today; **prohibited automatically** once tenant boundary (A5) ships, i.e. structurally impossible, not just gated | C1, C6 |
| External message send (email/SMS/chat) on the user's behalf | **High** | **Requires human review** | C6, matches Troy's explicit list |
| Booking / tender acceptance / rate change (financial commitment) | **High** | **Requires human review** — matches AimForge's own architecture ruling that Cora never gets direct booking authority | C6, existing AimForge memory-file ruling |
| Record deletion | **High** | **Requires human review** | C6 |
| Commit / push / pull request / deployment / production config change | **High** | **Requires human review** | C6, matches Troy's explicit list |
| Deterministic destructive shell pattern (e.g. `rm -rf`-class) | **Hard block** | **Prohibited — not reviewable**, condition must change first | C8, A2, A3 |
| Active write-lease conflict / unverifiable shared governance state | **Hard block** | **Prohibited — not reviewable** until the conflict resolves | C8, A3 |
| Agent attempting to self-approve (forged approval text, model-vote-as-consent) | **Prohibited always** | **Rejected outright**, not merely un-reviewed | A4 ("no self-enrollment"), A3 ("advisor consensus can never authorize") |
| Employment/discipline/compensation/termination decision, or reducing a safety signal to an opaque score | **Prohibited always** | **Never automatable by any AI capability, any tier** | Explicit absolute prohibition already stated in `MULTI_USER_RELEASE_ROADMAP.md` and `MARK_REMOTE_CONTROL_SPEC.md`, carried into this contract as universal |
| Client embeds a provider API key, or a hidden browser action fires without user-visible purpose | **Prohibited always** | **Never allowed, no tier applies** | C11, C12 |

---

## Part D — What must change before this contract is fully enforceable

Stated as engineering gaps, not aspirations, in priority order:

1. **Wire `auditWorkspace` through the real call site** in `governance-gate.mjs`
   (`tools.mjs:522`) so every refusal/allow is actually recorded where
   `GuardAuditLog` reads from. Today the dashboard can show a clean ledger
   while the real gate is (correctly) blocking things — that gap must close
   before anyone treats the Guard panel as a compliance-grade audit trail.
2. **Generalize `human-confirmation.mjs`'s schema** from
   `{project_slug, handoff_id}` to `{tenant_id, actor_session_id,
   resource_id}` (C4) so AimForge/DairyForge/Cora can bind a confirmation to
   "book load #4821 for tenant X" the same way Helmion binds one to "confirm
   handoff #42 for project A" — same cryptography, generalized subject.
3. **Choose a trusted-identity enrollment authority** (A4's stated open
   decision) before any Tier-B/high-risk action goes live anywhere — an
   unenrolled Guard is a Guard that cannot confirm anything.
4. **Build the tenant/role boundary** (A5, already scoped in
   `MULTI_USER_RELEASE_ROADMAP.md`) before any product claims cross-tenant
   safety — until then, C1's "in scope" is project/workspace-only, and any
   multi-tenant product (AimForge, DairyForge) must add its own tenant check
   at the application layer (already true today — e.g. AimForge's
   `requireAuth()` + `getDatCredentials(tenantId)` pattern) rather than
   relying on Helmion for it.
5. **Decide the CLI's default permission mode** — `full` is defensible given
   the governance kernel and sandboxing, but `ask`-by-default is a one-line
   config change if the risk tolerance should be lower; this is a decision
   to make explicitly, not leave as an unexamined default.
