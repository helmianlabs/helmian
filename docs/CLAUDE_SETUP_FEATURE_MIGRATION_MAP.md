# Claude setup to Helmion feature migration map

## Scope and handling

This is an internal, read-only feature inventory of the current Claude Code
setup. It records behavior and migration decisions, not private content.
Nothing under `~/.claude`, `~/.claude.json`, any provider configuration, or any
database was changed or copied.

The inventory deliberately did not read credential values, session
transcripts, shell snapshots, provider caches, project transcripts, screenshots,
audio, personal memory bodies, or database connection material. Sensitive
artifacts were classified by metadata only. No profile package or
provider-native artifact was created.

The source tree is a mixed working directory, not a package boundary. It
contains control files alongside session state, caches, dependencies, large
artifacts, logs, private project material, and credential-bearing files. A
whole-folder copy is therefore prohibited.

## Inventory summary

| Surface | Read-only finding | Migration consequence |
|---|---|---|
| Claude hook registry | 13 active hook registrations across `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, and `SessionEnd`; 12 distinct scripts (`settings.json:54-169`) | Translate lifecycle intent through a Claude adapter. Do not copy hook JSON or commands. |
| Permissions and plugins | 29 allow entries, 9 ask entries, 3 additional directories, and 28 enabled plugins (`settings.json:2-52`, `settings.json:171-206`) | Import only reviewed capability intent and declared dependencies. Never import broad paths or plugin state as authority. |
| Rules and evidence guidance | Global source-of-truth tracing, citation, handoff verification, completion, cancellation, advisory-lane, learning-evidence, and release rules (`CLAUDE.md:46`, `:73`, `:141`, `:187`, `:208`, `:221`, `:259`, `:305`, `:336`) | Strong candidates for a provider-neutral Policy Pack after normalization and conflict review. |
| Learning corpus | 41 global lesson entries, 7 topic documents, 73 `SKILL.md` packages, 6 proposed-learning files, and 2 proposed-skill-update files | Inventory as individual cards. Private content stays local; shareable templates receive new generic wording and provenance. |
| Rule flywheel | Resolved blockers append lessons and create warning-level regex candidates; 2 current promoted rules are both `flag`, not `block` (`scripts/neon/distill.mjs:180-234`) | Preserve proposal, evidence, canary, and human-review stages. Do not auto-activate a generated rule. |
| Provider/MCP setup | Five Claude MCP server declarations and 16 project configuration entries exist in `~/.claude.json`; several declarations carry secret-valued environment fields | Record adapter/dependency names only. Never read, copy, export, or reuse existing secret values or auth files. |
| Voice | Stop-hook TTS, cancellation sentinel, local microphone capture, STT/LLM/TTS experiments, and voice-specific guidance exist | Rebuild as a Helmion-owned, consented voice pipeline. Do not commandeer a provider voice session or reuse current credentials. |
| Manager/session utilities | One custom manager command, nine scheduled-task definitions, fleet/session scripts, and Neon-backed blocker/learning utilities exist | Treat as design inputs. OS/process control and database actions require separate, least-privilege Helmion modules. |

Counts describe discovered files and configuration, not verified runtime health
or activation. Scheduled-task definition files, for example, are not proof that
Windows tasks are installed or running.

## Reusable portable behavior

| Portable behavior | Source evidence | Helmion target |
|---|---|---|
| Evidence before claims | Claims require primary-source evidence and explicit end-to-end trace links (`BASE_RULES.md:1-75`, `CLAUDE.md:46-82`) | `PolicyPack.Evidence`: typed claims, evidence references, provenance, observed/inferred status, and completeness checks. |
| Handoff verification | Inherited claims are untrusted until reverified, and incomplete chains must be surfaced (`CLAUDE.md:141-160`, `:208-219`) | Existing Maestro handoffs plus a preflight verifier and Live Activity evidence links. |
| Honest completion state | Submitted, pending, written, and deployed are separate states (`CLAUDE.md:187-195`) | Operation state machine with exact current stage, remaining actor, and terminal evidence. |
| Stop and cancellation | User cancellation must remain immediate and voice cancellation is separate from background work (`CLAUDE.md:221-230`) | Service-brokered cancellation tokens, CLI process-tree termination, and independent voice playback cancellation. |
| Risk-aware execution | Routine bounded work may proceed; schema, auth, production, cross-project, and destructive actions are identified as higher risk (`scripts/hook_autonomy_boundary.ps1:1-23`) | Existing provider-neutral risk tier and exact-action confirmation. Detection produces a decision request; it never grants approval. |
| Destructive-operation classification | The current hook recognizes destructive shell, Git, SQL, filesystem, and device patterns (`scripts/hook_block_destructive.ps1:83-115`) | Structured operation classifier over typed actions and parsed invocations, backed by adversarial tests. |
| Commit evidence gate | Commit messages are expected to name actual QA; deletions require an explicit acknowledgement (`scripts/hook_block_commit_qa.ps1:154-189`) | GitHub/Git adapter preflight using test evidence objects and changed-file inventory, not commit-message magic text. |
| Single-writer awareness | Branch identity, shared claim files, and cross-session conflicts are surfaced before commit (`scripts/hook_autonomy_boundary.ps1:245-282`) | Maestro lease and workspace ownership display. Branch is evidence, not the authority. |
| Blocker lifecycle | Blockers have identity; resolution requires outcome, citation, root cause, lesson, and a useful remediation snippet (`scripts/neon/bigsister_neon_log.mjs:103-151`) | Provider-neutral blocker aggregate, resolution criteria, evidence bundle, acknowledgement, and timeline events. |
| Advisory isolation | External model output is input for review and must not directly become trusted state (`CLAUDE.md:259-270`) | Existing Tier B advisory-only consensus. All providers use the same Maestro authority. |
| Learning proposal loop | Resolved work can produce lesson and rule candidates; regex canaries try to reject broad candidates (`scripts/neon/distill.mjs:39-157`) | `LearningWorkbench`: candidate extraction, source evidence, redaction, counterexamples, simulation, owner review, and versioned activation. |
| Skill/profile cards | Skills consistently declare a name and description; most richer skills add when-to-use, steps, hard rules, gotchas, and sources | Profile catalog cards with purpose, effect, compatibility, dependencies, safety, provenance, files/actions, and install toggle. |
| Visual proof discipline | UI proof should target the relevant application/result, not unrelated desktop content (`scripts/inject_core_directive.ps1:1-9`) | Evidence capture request with exact target/window, consent, privacy mask, and artifact retention policy. No automatic desktop capture. |
| Voice interaction intent | Mic input, STT, a selected model, TTS, barge-in, and short spoken responses are represented in the current experiments | Configurable Helmion Voice Interaction Layer: mic permission, STT adapter, selected provider adapter, streamed response, TTS adapter, and cancel control. |

Portable behavior is rewritten as declarative Helmion policy. Personal names,
project facts, machine paths, provider event names, database table names, and
historical anecdotes are not portable policy.

## Claude-specific behavior requiring an adapter

| Claude-specific surface | Why it is not portable | Required adapter behavior |
|---|---|---|
| Hook event names and payloads | `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, and `SessionEnd`, their matchers, JSON payloads, stdout context injection, timeouts, and exit-code blocking are Claude Code contracts | Map a supported Policy Pack lifecycle event to the current documented Claude hook schema and report unmapped semantics before installation. |
| Permission and plugin syntax | Claude allow/ask entries, additional directories, enabled-plugin IDs, and MCP declarations have provider-specific schemas | Convert only selected generic capabilities into a versioned Claude mapping. Require dependency checks and a preview. |
| Commands and skills | Claude command Markdown and `SKILL.md` frontmatter are native discovery formats | Generate a staged Claude artifact only from selected generic content. Keep original private skills local unless individually approved for a Private Personal Profile. |
| Transcript-based Stop hook | The hook reads a Claude transcript path and extracts the last assistant turn (`scripts/stop_hook_speak.py:74-174`) | Prefer Helmion's own streamed response as the voice source. Transcript import is optional, adapter-scoped, redacted, and separately consented. |
| Context injection | Session-start scripts print local learnings, lesson filenames, and Neon context to Claude stdout (`scripts/session_start_inject.sh:1-43`) | Build a bounded context packet from the active Helmion profile, with explicit source cards and a byte/token budget. |
| Session-end learning | Current hooks create files, write logs, contact Neon, and run distillation (`scripts/session_end_safe.sh:1-30`, `scripts/hook_distill_on_session_end.ps1:1-81`) | Emit neutral lifecycle events first. Learning extraction remains a proposal workflow, not a provider hook side effect. |
| Claude manager/session control | Current scripts rely on Claude transcripts, PID registries, WSL/tmux panes, and provider-specific session assumptions | A future CLI broker owns processes it starts and exposes typed status/cancel operations. Helmion must not scrape or steer unrelated existing sessions. |
| Claude-specific provider selection | Claude configuration currently points to MCP helpers and provider-specific environment fields | Use the Helmion adapter registry and protected service profiles. Never copy Claude auth or MCP secret values. |

An adapter is eligible only when the provider offers a supported documented API,
CLI, or local endpoint. Helmion does not screen-drive or scrape consumer
interfaces and does not claim control of existing ChatGPT, Codex, Claude,
Gemini, or Grok voice sessions.

## Unsafe or nonportable items

These items are inventory findings, not migration candidates:

- Credential-, token-, key-, and connection-bearing files are present beside
  ordinary content. Their values were not read. They are excluded from every
  inventory preview, profile, export, transcript, log, argument, and provider
  mapping.
- The standalone voice loop searches `~/.claude.json` for an API key and places
  it in a process environment (`voiceloop.py:61-72`, `:185`). Helmion must never
  use this technique; service-only protected profiles are the credential
  boundary.
- `QA-APPROVED:` and `TROY-APPROVED:` strings authorize operations in current
  hooks (`scripts/hook_block_destructive.ps1:77`,
  `scripts/hook_autonomy_boundary.ps1:190`). These are unverified magic text and
  must not migrate. Helmion already has identity-backed, expiring, one-time,
  exact-action confirmation.
- Current learning code can append the global lesson file, update the global
  rule file, and generate `SKILL.md` directly
  (`scripts/neon/distill.mjs:233-234`,
  `scripts/neon/manager_skill_from_learning.mjs:47-51`). Helmion uses
  immutable candidates and explicit activation; Tier B consensus remains
  advisory-only.
- The session hooks write into project/global paths and contact a database on
  lifecycle events. Provider hooks may emit a bounded event to Helmion but may
  not silently create project files, mutate policy, or perform shared writes.
- The blocker helper uses one general database connection and treats script
  reachability/commented lanes as role separation. It can also auto-register a
  project (`scripts/neon/bigsister_neon_log.mjs:67-81`). Helmion requires
  service custody, exact target binding, least-privilege roles, transactions,
  leases, idempotency, and durable audit.
- The semantic extractor can send selected file text and its absolute path to a
  provider (`scripts/neon/manager_llm_extract.mjs:24-44`). Private content
  requires per-item preview, redaction, explicit provider consent, and a
  disclosed retention boundary. Shareable templates never contain it.
- Automatic window focus, simulated key input, and screenshot capture on edits
  (`scripts/hook_app_screenshot_verification.ps1`) can capture unrelated private
  content. Helmion evidence capture is user-visible, target-bound, and
  opt-in.
- Voice experiments send audio/text to external STT, LLM, or TTS services and
  use machine-specific executables. Each hop needs a separate adapter,
  disclosure, connection test, cancellation behavior, and privacy control.
- Fixed user paths, project slugs, schema/table names, application names,
  account identities, historical screenshots/audio/logs, personal memories,
  and project canon are never placed in a Shareable Template Profile.
- Broad auto-push/deploy behavior, raw shell pattern matching, fail-open network
  gates, direct provider-file writes, process steering, and generated regexes
  cannot substitute for Maestro leases, exact targets, and confirmations.

## Two profile modes

The profile catalog has a hard type boundary; a profile cannot switch types
after creation.

### Private Personal Profile

- Purpose: run the user's own local workflows with explicitly selected project
  knowledge, rules, task guidance, and adapter mappings.
- Default data shape: references to user-selected local items by canonical path,
  category, hash, consent state, and last-verified time. Content is not copied
  merely because its folder was selected.
- Storage: Helmion-owned current-user storage. Sensitive snapshots, if the user
  explicitly chooses to make one later, require service-only encryption at
  rest and are never returned as profile exports.
- Scope: `private`, `local-only`, `non-exportable`, and machine/user-bound.
- Provider behavior: nothing is silently installed into Claude, Codex, Gemini,
  Grok, GitHub, IDE, or global configuration. A selected provider mapping
  produces a staged diff/plan and requires an explicit install decision.
- Deletion/revocation: removing a profile removes only Helmion-owned material;
  referenced source files remain untouched.

### Shareable Template Profile

- Purpose: ship safe, generic workflow structure to testers or other users.
- Allowed content: anonymized generic rules, hook/policy descriptions, setup
  guidance, dependency declarations, safe templates, and reviewed
  provider-mapping templates.
- Prohibited content: real project canon/data, screenshots, audio, logs, private
  paths, account/organization identifiers, credentials, connection material,
  private memory, personal learning narratives, provider session state, and
  unsafe commands.
- Creation: a separate authored/redacted item is created from portable intent.
  A private source item is never relabeled shareable in place.
- Export: deterministic, versioned, hashed, previewed, and optionally signed.
  Secret and personal-data findings are fail-closed exclusions, not toggles.

### Required profile card and install plan

Every policy item, Markdown item, hook mapping, dependency, task profile, and
template has a plain-English card showing:

- purpose and why it is included;
- provider compatibility and unsupported providers;
- files, tools, connectors, lifecycle events, and permissions it can affect;
- dependencies and current availability;
- risk/safety level and whether governed writes could ever be requested;
- private/shareable classification, provenance, redactions, and unresolved
  mappings;
- exact files/directories the install would create, modify, leave alone, or
  remove on rollback; and
- an independent include/install toggle with a non-destructive default.

Selecting a card opens a reviewable diff and action plan. Helmion-owned
versioned targets are the default. For Claude Code, selected generic policy is
first compiled into a Helmion staging target. Writing a project-local Claude
artifact requires a second explicit confirmation of the exact target and diff.
Global `CLAUDE.md`, hooks, settings, and existing provider files are never
blindly overwritten. Unsupported merges remain staged.

Every task-specific profile inherits the immutable base safety policy. It may
narrow authority or add evidence requirements; it cannot weaken lease,
confirmation, exact-target, secret, audit, or provider-isolation rules.

## Missing dependencies and Helmion modules

| Module/gap | Current Helmion state | Required next result |
|---|---|---|
| Policy Pack schema and evaluator | Architecture documented; not implemented | Versioned neutral lifecycle, evidence, risk, permission, connector, learning, and voice-policy schemas with monotonic base-policy inheritance. |
| Profile catalog and two-mode store | Package architecture documented; mode split now specified | Typed catalog records, local-only/private enforcement, shareable-content enforcement, item cards, and no-content inventory mode. |
| Safe inventory/classification | Not implemented | User-selected-root containment, no reparse traversal, size limits, secret/private/path/unsafe-command classifiers, hashes, and adversarial tests. |
| Diff/plan/install engine | Not implemented | Helmion-owned staging, exact target plan, per-item decision, atomic receipt, rollback, conflict handling, and provider-file no-overwrite default. |
| Learning workbench | Not implemented | Candidate queue, evidence and counterexamples, duplicate/conflict detection, redaction, dry simulation, owner review, versioning, and rollback. No automatic rule activation. |
| Provider translators | Contract registry implemented; translators not implemented | Offline Claude translator first, with source-event mappings, unsupported semantics, generated diff, and conformance fixtures. Other providers follow documented surfaces. |
| Embedded provider CLI | Console shell exists; execution is off | Service-owned process broker, allowlisted environment, separate CLI account/API profiles, PTY/streaming, cancellation, redaction, evidence, and no reuse of unrelated sessions. |
| Live provider adapters | Registry and protected-store prerequisite exist; no invocation | Redacted non-mutating connection test and one read-only canary per adapter before any governed action. |
| Neon/GitHub integrations | Exact isolated Neon profile contract exists; neither integration is live in the desktop | Least-privilege service profiles, exact target/repository display, read-only connection tests, and canary evidence. No existing system/config import. |
| Voice Interaction Layer | Architecture/mock only | Device consent, mic state, STT adapter, selected-provider stream, TTS adapter, playback cancellation, privacy/retention controls, and local/offline options where supported. |
| Activity/evidence stream | Demo timeline only | Versioned events, redaction, causal/evidence links, durable Maestro state, bounded subscriptions, recording mode, and no raw secret/private payloads. |
| Dependency resolver | Filename-only CLI detection exists | Card-level dependency declarations and safe read-only checks for PowerShell, Git, Node, Python, WSL/bash, provider CLIs/APIs, audio stack, MCP servers, and adapter versions. Detection never grants capability. |

## Recommended implementation order

1. **Lock the normalized schemas.** Add Policy Pack, profile/card, inventory
   finding, install plan, learning candidate, and provider-mapping schemas.
2. **Implement the two-mode local catalog.** Enforce `private-local` versus
   `shareable-template` at creation, storage, export, and UI boundaries.
3. **Build read-only inventory and classifiers.** Operate only on a
   user-selected root; return cards and findings, not an automatic package.
4. **Build preview, diff, receipt, and rollback.** Install only Helmion-owned
   files first.
5. **Add the learning workbench.** Convert evidence into inactive candidates;
   require review for any policy/profile activation.
6. **Add the offline Claude translator.** Compile selected generic policies to a
   staging artifact, report unsupported mappings, and require exact diff
   confirmation before any project-local install.
7. **Add the service-brokered embedded CLI read path.** Start only Helmion-owned
   sessions with cancellation, redaction, and activity events.
8. **Activate one provider and integration at a time.** Redacted connection
   test, exact target, read-only canary, then evidence display. Neon Development
   and GitHub remain separate profiles.
9. **Implement the Helmion-owned voice layer.** Use the selected adapter; never
   treat MCP or an existing provider voice session as voice transport.
10. **Expose governed writes only after the read-only chain is proven.** All
    vendors remain under the same Maestro lease, risk, one-time confirmation,
    and audit path.

## Implemented versus mapped

Implemented in Helmion today: deterministic Maestro leases/handoffs,
identity-backed one-time exact-action confirmation, advisory-only consensus,
native WPF shell, read-only local service/workspace inventory, provider
contract registry, protected-profile store prerequisite, exact isolated Neon
Development binding, and demo-only orchestration/console/profile UI
foundations.

Mapped but not implemented by this inventory: private/shareable profile catalog,
source inventory, classifiers, Policy Pack runtime, learning workbench,
provider translators, provider-file install, embedded provider CLI execution,
live Neon/GitHub connection tests, live provider invocation, voice pipeline,
and live orchestration events.

