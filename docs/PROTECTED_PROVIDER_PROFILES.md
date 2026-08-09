# Protected provider profiles and connection tests

## Implemented prerequisite

Helmion now has a Windows-only, local-service security assembly for future
provider material:

- `Helmion.LocalService.Security` is referenced by the local service and tests,
  not by the WPF renderer;
- sensitive payload bytes are encrypted with Windows DPAPI in CurrentUser scope;
- profile-specific optional entropy prevents ciphertext from being moved
  between profile IDs;
- plaintext and temporary buffers are zeroed where the managed/runtime
  boundary permits;
- only a redacted manifest/descriptor can be returned to presentation code;
- profile IDs and paths are contained under the Helmion current-user root and
  reparse-point profile directories are rejected; and
- a Neon Development manifest cannot be saved with another target.

The default future storage root is:

```text
%LOCALAPPDATA%\Helmion\provider-profiles\
```

The desktop renderer does not instantiate the store or create this directory.
The Helmion Local Service now instantiates it for the OpenAI Images status and
approved-generation path, and owns a one-time redirected-standard-input
enrollment command. No renderer form, pipe credential payload, environment
lookup, or unapproved provider invocation has been added.

Tests use disposable fixture bytes in a temporary directory and prove that the
fixture plaintext is absent from stored files and can round-trip only through
CurrentUser DPAPI.

## Authentication classes are separate

Helmion does not treat a CLI account session and an API credential as the same
profile.

| Helmion profile | Authentication class | Current status |
|---|---|---|
| Codex CLI | provider-owned ChatGPT/account browser sign-in | documented; detection/status test not implemented |
| OpenAI Images API | bearer API key or future supported short-lived server credential | protected adapter and one-time enrollment ready; no key or provider access is claimed by source state |
| Claude Code CLI | not yet verified for this slice | documentation/isolation gate |
| Gemini CLI | provider-owned Google account browser sign-in | documented; detection/status test not implemented |
| Gemini API | Gemini authorization API key | protected store ready; no key enrolled |
| Grok | no supported surface selected | documentation gate; no parity claim |
| Neon Development | direct PostgreSQL database credential | exact target bound; no credential enrolled |
| GitHub | not yet verified for this slice | documentation/least-privilege gate |

CLI profiles may eventually ask the provider executable for a redacted sign-in
status through a documented, non-mutating command. Helmion does not read or
copy existing auth/config files and never receives the user's provider
password.

API/database profiles will eventually use a dedicated local-service enrollment
surface that sends material directly into DPAPI protection. Secrets must never
appear in the desktop renderer, embedded console, chat, activity history, logs,
command arguments, source control, or test fixtures.

## Official documentation basis

The July 2026 design was checked against current official documentation:

- Codex supports ChatGPT browser sign-in for the CLI (`codex login`) and
  separately supports API-key login. Helmion deliberately models its Codex CLI
  account profile separately from the direct OpenAI API adapter:
  <https://learn.chatgpt.com/docs/auth>
- OpenAI API requests use bearer credentials; API keys are secrets and belong
  in server-side environment/key-management boundaries:
  <https://developers.openai.com/api/reference/overview#authentication>
- Gemini CLI recommends Google account browser sign-in for local individual
  users and also documents other auth modes. Helmion's Gemini CLI account
  profile is separate from its Gemini API profile:
  <https://geminicli.com/docs/get-started/authentication/>
- The Gemini API documents standard and authorization API keys, with new keys
  defaulting to authorization keys and a September 2026 standard-key
  transition. Helmion therefore labels the direct API profile specifically and
  does not infer CLI parity:
  <https://ai.google.dev/gemini-api/docs/api-key>
- Neon direct connection hosts use the endpoint ID without the `-pooler`
  suffix, and Neon recommends direct connections for migrations/admin-style
  work:
  <https://neon.com/docs/connect/connection-pooling>

Provider documentation can change. Every future activation repeats the
documentation check and connection test; a static profile label is not proof
of current availability or capability.

## Typed connection-test contract

`Helmion.LocalService.Protocol` now defines a versioned plan/result boundary:

- authentication class and secret-input boundary;
- exact non-secret target binding;
- individually named probes and expected evidence;
- redacted provider identity;
- observed capabilities and structured findings;
- explicit mutation and secret-return flags; and
- validation that rejects mutation, renderer credential input, result/plan
  mismatch, or target drift.

No connection-test named-pipe command is exposed yet. The implemented contract
supports `not-run`, `passed`, `failed`, `target-mismatch`, and
`credential-unavailable` results without raw provider responses or secrets.

## Neon Development hard binding

The built-in Neon profile and its read-only plan are fixed to:

```text
Profile:  neon-development
Project:  Helmion Development
Endpoint: ep-divine-leaf-ay38p1af
Database: neondb
Mode:     postgresql-direct
```

The binding is exact, isolated-development-only, and non-pooled. Both the
protected store and connection-test validator reject a changed endpoint,
database, project, or transport.

The future first test has two read-only probes:

1. confirm the direct endpoint, database, server identity, and exact target;
2. read migration/schema readiness without applying changes.

No Neon connection or canary was run in this slice.

## OpenAI Images activation

Artifact Studio image generation now uses the official OpenAI Images HTTPS
endpoint through the Helmion Local Service. The desktop sends only the selected
project path, request ID, and approval evidence hash over the current-user pipe.
The service rereads the project ledger, rechecks the exact approval and evidence,
loads the `openai-images` DPAPI profile, and keeps the bearer credential out of
the desktop process and pipe payload.

One-time enrollment is deliberately outside the desktop UI. Build the local
service, then run:

```powershell
& .\desktop\scripts\enroll-openai-images.ps1
```

The script uses a hidden secure prompt and streams the credential only to the
local service's standard input. The key is not placed in command arguments,
PowerShell history, project files, `.env`, Helmion settings, logs, or request
history. The service validates it and stores only CurrentUser-DPAPI ciphertext
under `%LOCALAPPDATA%\Helmion\provider-profiles\openai-images\`.

Generation is a separate action that appears only after local approval. The
adapter fixes one low-quality 1024×1024 output per request, bounds response and
decoded media sizes, verifies PNG/JPEG signatures, atomically replaces the
approved destination under `.helmion/artifacts`, and records the output SHA-256,
provider request ID, model, media type, size, activity event, and Preview entry.
A durable delivered state is idempotent; repeating the action returns the stored
receipt without another provider call.

The Integrations status contract keeps image and video generation separate from
chat providers and from each other. A protected image credential is reported as
`configured-not-tested`, not as provider availability. Positive availability
requires provider-test evidence. Video reports `provider-not-selected` in this
build: there is no video adapter, model, credential, test, or availability
claim. Both lanes require an explicit approval policy and cost boundary.

OpenAI may require API Organization Verification before GPT Image models can be
used. The enrolled API key must belong to an OpenAI API project permitted to
call `POST /v1/images/generations`, with `gpt-image-2` access and sufficient
billing/quota. Enrollment validates only the local credential shape; it does
not test those external account conditions and does not incur a provider call.

The request shape and current `gpt-image-2` route were verified against the
official [image generation guide](https://developers.openai.com/api/docs/guides/image-generation)
and [Images API reference](https://developers.openai.com/api/reference/resources/images).

## Next implementation gate

Before a provider canary or wider activation:

1. threat-model the local enrollment IPC, screen privacy, crash handling, and
   same-user process risks;
2. add per-profile revocation and replacement without returning the old value;
3. implement the typed non-mutating status/connection test for exactly one
   adapter;
4. bind the result to evidence and display only redacted fields; and
5. run an isolated read-only canary before claiming provider availability.
