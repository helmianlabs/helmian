# Helmion Personal Pilot activation architecture

## Product target

The Personal Pilot is a one-user Windows control center for the user's own AI
development system. Its target loop is:

```text
Windows desktop
    ↕ current-user authenticated, typed named pipe
Helmion local service
    ├─ selected local workspace
    ├─ protected provider profiles
    ├─ provider adapters and connection tests
    └─ Helmion Maestro
          ├─ deterministic policy and risk classification
          ├─ lease authority
          ├─ evidence and handoff rules
          └─ exact-action approval checks
```

A selected provider coordinates a session. It does not become a second safety
authority. Codex, Claude Code, Gemini, and Grok must all operate under the same
Maestro policy, lease, confirmation, and audit decisions.

This Personal Pilot is distinct from the later multi-user commercial release.
The pilot uses one Windows identity and an isolated development target. The
commercial product additionally needs tenant isolation, authenticated roles,
invitations, hosted audit durability, enterprise integration custody, signed
installation, and managed updates.

## Implemented now

- A native WPF dashboard with explicit demo versus live-local provenance.
- A current-user-only named-pipe service with a versioned, typed contract.
- Client verification that the named-pipe server is the expected local-service
  executable.
- A local folder picker and persisted non-secret workspace path.
- Read-only workspace inspection for project name/path, Git branch, local SQL
  migration source hashes, and local evidence-source inventory.
- Honest lease posture: durable state is reported unavailable until its
  provider is deliberately connected. No database is inferred or queried.
- A fail-closed service command surface: unknown/write commands are rejected.
- Filename-only local availability checks for Codex CLI, Claude Code CLI,
  Gemini CLI, Grok CLI, Git, and GitHub CLI. Detection does not launch a tool,
  inspect provider configuration, or authenticate.
- An unconfigured provider registry with distinct Codex CLI/OpenAI API and
  Gemini CLI/Gemini API profiles, plus Claude Code CLI, Grok, Neon Development,
  and GitHub documentation gates.
- A visible Console foundation and interaction-mode map. The console does not
  start a shell in this read-only slice.
- A first-class Live Activity Stream / Orchestration Timeline design mock with
  explicit demo provenance, evidence requirements, expandable redacted detail,
  and no live provider events.

The service has a CurrentUser-DPAPI profile store implementation but no
enrollment or connection command invokes it in normal operation. It does not
currently collect credentials, connect to Neon, contact a provider, launch an
agent, or make project writes.

## Tomorrow's activation sequence

Activation must remain incremental and reversible.

1. **Local baseline**
   - Launch the packaged desktop and its paired local service.
   - Select the intended local project directory.
   - Confirm the UI displays the exact path, branch, migration source hashes,
     evidence inventory, and `project modified: no`.
2. **Protected profile enrollment**
   - Threat-model and add a one-time service-owned profile-enrollment command
     or owner interaction; the DPAPI store itself is implemented.
   - Encrypt profile material for the current Windows user with Windows DPAPI.
   - Keep plaintext only in service memory for the shortest operation needed.
   - Never return secret values over the desktop protocol or place them in
     renderer fields, logs, crash text, command arguments, source control, test
     fixtures, or chat.
3. **Exact development target**
   - Display and require an exact match for:
     - project: `helmion development`;
     - endpoint: `ep-divine-leaf-ay38p1af`;
     - database: `neondb`.
   - Reject a pooled or unexpected endpoint when a direct guarded operation is
     required.
   - Run the existing guarded inspection before any database activation.
4. **One provider profile**
   - The user selects the active coordinator.
   - The service validates tool/profile availability and provider identity
     without reading unrelated provider configuration.
   - Run a connection test that displays identity, account/project target,
     granted scopes, and write capability without printing secret material.
5. **Read-only canary**
   - Read the smallest known object/state through the selected adapter.
   - Record the target, adapter, policy decision, and result.
   - Prove no workspace, database, provider, or repository mutation occurred.
6. **Governed action canary**
   - Add only after the read-only canary passes.
   - Use a reserved isolated-development action, exact Maestro lease,
     operation policy, evidence, and rollback.
   - High-risk or incomplete work still requires the configured exact-action
     owner decision; absence of advanced signing grants no authority.

Each integration remains independently disabled until its own connection test
and canary pass. Passing one provider test must not activate another provider.

## Provider profiles and least privilege

| Profile | Pilot role | First connection test | Initial authority |
|---|---|---|---|
| Codex CLI | Selectable coordinator | detect executable; verify provider-owned account sign-in status without reading auth files | read-only local canary |
| OpenAI API | Selectable coordinator | protected API credential enrollment; redacted project/identity test | read-only API canary |
| Claude Code CLI | Selectable coordinator | detect executable; use an explicitly created Helmion profile only | read-only local canary |
| Gemini CLI | Selectable coordinator | detect executable; verify provider-owned Google sign-in status without reading auth files | read-only local canary |
| Gemini API | Selectable coordinator | protected authorization-key enrollment; redacted project test | read-only API canary |
| Grok API/CLI | Selectable coordinator | verify selected API identity or isolated CLI profile and scopes | read-only canary |
| Neon development | durable pilot state | guarded exact project/endpoint/database inspection | read-only inspection |
| GitHub | source/review adapter | verify account, selected repository, and granted scopes | metadata/read-only repository canary |

Provider authentication must use a provider-owned flow or an interactive
service-owned enrollment surface. A provider profile is never a renderer text
field. If a CLI cannot support an isolated Helmion profile without consuming
an existing user configuration, that adapter stays disabled until a safe
profile boundary exists.

In particular, existing Claude Code hooks and configuration are not read,
modified, copied, or inferred automatically. The same non-interference rule
applies to existing Gemini configuration.

All AI providers must satisfy the repeatable
[provider-adapter contract](PROVIDER_ADAPTER_CONTRACT.md). An adapter can be
added only when the provider offers a supported, documented API, CLI, or local
endpoint. Local executable detection alone is not an integration. Consumer UI
scraping or screen-driving is not a supported adapter surface.

The implemented DPAPI store, auth-mode separation, official documentation
basis, typed test contract, and exact Neon binding are detailed in
[PROTECTED_PROVIDER_PROFILES.md](PROTECTED_PROVIDER_PROFILES.md).

## Provider-neutral Policy Pack

The planned Policy Pack represents portable Helmion intent, not a copy of any
provider's hook files. Its reviewable model covers:

- evidence and uncertainty requirements;
- risk guardrails and stop conditions;
- tool permissions and boundaries;
- lifecycle events such as session start, checkpoint, handoff, and completion;
- connector access and target restrictions.

A future import is explicit and review-driven:

1. the user chooses a policy source or export;
2. Helmion parses only that chosen input into a draft portable mapping;
3. the UI shows mapped, unmapped, and provider-specific behavior;
4. the user reviews a diff and resolves ambiguity;
5. Helmion validates the draft against the Maestro policy schema; and
6. only an explicit install action activates the Policy Pack.

Proprietary hook syntax and runtime events remain adapter-specific. No automatic
Claude hook/config discovery is part of the import. A Policy Pack cannot replace
Maestro, grant leases, or promote advisory consensus into authority.

The portable packaging and safe install contract is defined in
[HELMION_PROFILE_PACKAGE.md](HELMION_PROFILE_PACKAGE.md). A Helmion Profile
Package adds explicitly approved learning content, adapter mapping drafts,
task-specific profiles, optional workspace templates, manifest versioning,
integrity hashes, plain-English per-item cards/toggles, preview, and rollback
around the provider-neutral Policy Pack. Every task profile inherits the base
safety policy. The package does not back up or install provider configuration.

## Interaction surfaces

| Surface | Status | Boundary |
|---|---|---|
| Windows desktop dashboard | implemented | status, setup, evidence, and owner interaction |
| Local service | implemented read-only slice | current-user IPC, workspace/capability reads, write rejection |
| Helmion CLI entry point | existing | deterministic local commands and current guarded workflows |
| Embedded terminal/CLI console | UI foundation only | future service-brokered process session; no renderer-owned secret or shell |
| Live Activity Stream | design mock only | future typed provider/Maestro events with evidence links and redaction |
| IDE/Codex/Claude adapters | later | explicit tool/context adapters under Maestro |
| Custom in-app voice layer | architecture only | one Helmion-owned interaction pipeline |

The planned voice pipeline is:

```text
microphone → speech-to-text → selected provider adapter
           → streamed response → text-to-speech
```

It needs explicit microphone permission, a visible recording state, transcript
review for high-risk requests, interruption/cancel controls, and the same
Maestro authorization as typed input. It does not commandeer current
ChatGPT/Codex/Claude voice sessions and does not make every provider CLI
voice-capable.

MCP connects tools and context. MCP is not voice transport and is not Maestro.

The live orchestration event/evidence/privacy contract is defined in
[LIVE_ACTIVITY_STREAM.md](LIVE_ACTIVITY_STREAM.md).

## Inputs the user supplies tomorrow

No secret should be sent in chat. The user supplies only through the eventual
local protected enrollment or provider-owned authentication flow:

- the local workspace directory chosen in the Windows folder picker;
- the desired active coordinator for the first canary;
- approval of an isolated Helmion provider profile when the adapter requires
  one;
- provider authentication locally, after the service-owned protected profile
  path exists;
- confirmation that the displayed Neon target exactly matches the isolated
  development project above;
- the GitHub account and repository to scope, only if GitHub is activated; and
- optional voice input/output preferences later, when the voice layer exists.

The user does not supply existing Claude/Gemini configuration, hook files,
provider secrets in the desktop renderer, or any current ChatGPT/Codex voice
session.

## Remaining gates

- Threat-model and implement the service-owned enrollment surface around the
  existing Windows-protected provider store.
- Add one typed, redacted connection-test contract per provider.
- Add exact target profiles and canary evidence records.
- Broker an embedded CLI process through the service with cancellation,
  transcript redaction, allowlisted environment construction, and audit.
- Bind all write endpoints to Maestro policy, leases, and confirmation.
- Add service lifecycle/reconnect handling, schema compatibility, recovery,
  signed installer, and clean-machine tests.
- Implement Policy Pack schema, mapping review, and adapter-specific
  translators.
- Implement the Helmion Profile Package inventory, redaction, deterministic
  export, previewed Helmion-only install, signing, and rollback flow.
- Implement the optional in-app voice pipeline independently of MCP and
  provider voice products.
