# Helmion Profile Package

## Requirement

A Helmion Profile Package is the portable, reviewable setup bundle for moving a
safe subset of accumulated development guidance to another Helmion user or
machine. It is not a raw home-directory backup and it never silently clones a
provider configuration.

Helmion has two distinct profile modes:

- **Private Personal Profiles** are local-only, current-user profiles for the
  user's own work. They may reference individually selected local project
  knowledge, rules, or learning, but they are non-exportable and do not silently
  install anything into provider configuration.
- **Shareable Template Profiles** are the only profiles eligible for a Helmion
  Profile Package. They contain anonymized generic structure, policy/hook
  descriptions, setup guidance, dependency declarations, reviewed mappings,
  and safe templates. They never contain real project canon, project data,
  screenshots, audio, private paths, account details, credentials, private
  memory, or personal learning narratives.

A private item cannot become shareable by changing a label. Shareable content
is separately authored or rewritten, classified, previewed, and approved.

The package contains:

- a provider-neutral Policy Pack;
- approved Markdown learning and rules content;
- reviewed provider-adapter mappings;
- task-specific Helmion profiles;
- optional Helmion workspace templates; and
- a manifest with package identity, schema version, content hashes, provenance,
  compatibility, and declared capabilities.

This document is an architecture and installer contract. The separate
read-only Claude feature inventory is recorded in
`CLAUDE_SETUP_FEATURE_MIGRATION_MAP.md`; it did not create a profile, transfer
content, or write a provider file.

## Private Personal Profile boundary

A Private Personal Profile defaults to references to user-selected local items
by canonical path, category, content hash, consent state, and last-verified
time. Selecting a folder does not copy all of its content. Helmion-owned
metadata lives in current-user storage; a future explicitly requested private
snapshot requires service-only encryption at rest.

Private profiles are marked `private`, `local-only`, `non-exportable`, and
machine/user-bound. Removing one removes only Helmion-owned metadata or
snapshots, never the referenced source files.

Provider mappings from a private profile remain inactive until the user opens
the exact generated diff/plan and confirms the exact target. Helmion does not
silently edit `CLAUDE.md`, hooks, settings, MCP configuration, skills, IDE
configuration, or any other provider/global file.

## Package shape

The proposed portable artifact is a deterministic archive with a dedicated
extension such as `.helmion-profile`:

```text
manifest.json
policy/
  policy-pack.json
learning/
  *.md
mappings/
  codex.json
  claude-code.json
  gemini.json
  grok.json
profiles/
  base.json
  task-specific/
    *.json
templates/
  workspace/
    ...
notices/
  provenance.md
```

`manifest.json` must include:

- a stable package ID, display name, publisher label, and semantic version;
- Helmion package-schema and minimum application versions;
- a SHA-256 digest, media type, category, and sensitivity classification for
  every file;
- the source category and explicit inclusion decision for every item;
- declared Policy Pack capabilities and required adapter versions;
- excluded-item counts by reason, without copying excluded content;
- creation time and platform; and
- an optional package signature plus signer identity.

The archive contains declarative Helmion data. It must not contain an installer
script, arbitrary executable, provider token, opaque binary hook, or
auto-running command.

## Export flow

Export requires a deliberate local interaction:

1. **Select source folder.** The user chooses one exact local folder. Helmion
   does not discover home folders, `.claude`, provider directories, global
   settings, or sibling trees.
2. **Read-only inventory.** The local service inventories ordinary files
   without following reparse points or crossing the selected root. It
   categorizes likely learning, rules, policies, memory guidance, hook
   definitions, and folder templates. Inventory itself makes no source writes.
3. **Safety classification.** The service flags secrets, account identifiers,
   personal/private memory, absolute machine paths, unsafe commands,
   executable payloads, and provider-specific syntax.
4. **Preview and redaction.** The desktop shows included, excluded, redacted,
   unmapped, and unsupported items. Original content stays unchanged.
   Secret/token material, personal memory, machine-specific absolute paths,
   and unsafe commands default to exclusion and cannot be packaged merely by
   accepting a broad folder.
5. **Mapping review.** Portable intent is translated into the Policy Pack
   schema. Provider hook formats remain adapter-specific draft mappings.
   Nothing is blindly cloned.
6. **Explicit export.** The user selects the output file and confirms the exact
   manifest. The service writes only that new package and an optional local
   export report.

Export must never auto-edit or normalize the selected source files.

### Plain-English item cards

Every Markdown item, hook, adapter mapping, and task-specific profile must be
represented by its own review card before export and again before install. Each
card states:

- its plain-English purpose;
- what local files, tools, connectors, providers, or lifecycle behavior it can
  affect;
- compatible providers and explicitly incompatible or untested providers;
- required Helmion, adapter, CLI, MCP-server, or workspace dependencies;
- safety level and whether activation could request governed writes;
- why the exporter proposes including it;
- redactions, unresolved mappings, and exclusions; and
- an independent include/install toggle.

The card also lists the exact files/directories that installation would create,
modify, leave untouched, and remove on rollback. Selecting a card opens the
generated diff and action plan before the install toggle can authorize a
provider-local change.

The toggle defaults to off for provider-specific hooks, unsafe or ambiguous
content, missing dependencies, personal content, and anything with external or
write effects. Secret-bearing content is excluded before the card stage and
cannot be toggled on. A broad “select all” cannot override exclusions or safety
gates.

## Import and installation flow

On the target machine:

1. the user selects one `.helmion-profile` artifact;
2. Helmion verifies archive structure, file hashes, schema compatibility,
   size/count limits, path traversal protection, and signature status;
3. the desktop previews every proposed Helmion-owned target and highlights
   policy capabilities, adapter mappings, templates, conflicts, and unsigned
   provenance;
4. the user reviews the plain-English card and install toggle for every item,
   then explicitly chooses install, side-by-side install, or cancel;
5. the local service installs atomically into a versioned Helmion profile
   directory for the current Windows user;
6. adapters remain disabled until their mappings pass provider-specific review
   and a separate connection test; and
7. Helmion records a local install receipt and supports rollback to the prior
   profile version.

The initial safe target is:

```text
%LOCALAPPDATA%\Helmion\Profiles\<package-id>\<version>\
```

Optional workspace templates may be copied only into a separately
user-selected Helmion workspace/template destination shown in the preview.
Installation must not write to `~/.claude`, Codex, Gemini, Grok, GitHub,
shell-profile, IDE-global, or other provider/global configuration locations.

For a provider such as Claude Code, Helmion first compiles selected generic
policy into a Helmion-owned staging target. A project-local provider artifact
may be proposed only after adapter validation, and requires a separate explicit
confirmation of the exact target and diff. Existing global or project files are
not blindly overwritten; unsupported merges remain staged.

## Provider hook translation

Hooks encode provider-specific events, schemas, environment, and tool
semantics. A package therefore carries:

- portable lifecycle intent, permissions, evidence requirements, and
  guardrails in the Policy Pack; and
- optional declarative adapter mapping drafts that state the source provider,
  supported events, unmapped behavior, and minimum adapter version.

The target adapter renders or applies its native format only after the user
reviews the mapping and explicitly enables that adapter. Unsupported or
ambiguous behavior remains disabled. Provider hook files are never blindly
copied into provider directories.

## Base and task-specific profiles

Helmion supports task-specific profiles analogous to profiles on a gaming
mouse: a user can deliberately select a coding, animation, QA, documentation,
or other workflow profile with its own portable learning, tool preferences,
adapter mappings, and workspace templates.

Every task-specific profile inherits one base safety policy. A task profile may
narrow permissions, add evidence requirements, select preferred tools, and add
domain guidance. It may not weaken, shadow, or remove the base policy's lease,
risk, confirmation, secret-handling, target-isolation, or audit rules.
Conflicts resolve in favor of the base safety policy and are shown in the
preview.

Profile selection changes working guidance and tool configuration; it does not
change Maestro into a different authority or silently activate a provider.
Each task profile declares its dependencies and provider compatibility in the
manifest and on its plain-English profile card.

## Mandatory exclusions

The exporter must exclude:

- passwords, API keys, tokens, cookies, certificates with private keys, and
  connection strings;
- personal/private memory not explicitly rewritten as shareable guidance;
- user, account, tenant, machine, repository, or organization identifiers that
  are not required portable metadata;
- absolute local, UNC, or home-directory paths;
- shell history, logs, caches, databases, and provider session state;
- commands with destructive, persistence, credential, or remote-execution
  behavior;
- executables, scripts that auto-run, symlinks/reparse points, and archives
  nested as opaque payloads; and
- existing provider configuration or global settings.

Detection is defense in depth, not permission to package sensitive material.
When classification is uncertain, the item stays excluded pending an explicit
content rewrite and new review.

## One-click meaning

“One click” means one explicit install decision after a complete preview for a
previously validated package. It does not mean silent discovery, acceptance of
all source content, bypassing per-item choices, provider-config mutation,
adapter activation, credential enrollment, or bypass of Maestro policy.

## Implementation gates

- Define and version the manifest and Policy Pack JSON schemas.
- Build a path-contained, reparse-safe read-only inventory endpoint.
- Add secret/personal-data/unsafe-command classifiers with adversarial tests.
- Add deterministic export, hash verification, zip-bomb/path-traversal limits,
  and optional signing.
- Add preview, per-item decisions, redaction diffs, and provenance UI.
- Add plain-English item cards and safe per-item export/install toggles.
- Add inherited base-policy validation and task-specific profile selection.
- Install atomically into Helmion-owned versioned storage with receipt and
  rollback.
- Build adapter-specific mapping validators; never write provider config from
  generic package installation.
- Test on a clean Windows user with no provider configuration.
