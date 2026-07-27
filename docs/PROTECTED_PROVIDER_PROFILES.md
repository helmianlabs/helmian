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

The normal application does not instantiate the store or create this directory
in this slice. No enrollment command, renderer form, named-pipe command, CLI
argument, environment lookup, or provider invocation has been added.

Tests use disposable fixture bytes in a temporary directory and prove that the
fixture plaintext is absent from stored files and can round-trip only through
CurrentUser DPAPI.

## Authentication classes are separate

Helmion does not treat a CLI account session and an API credential as the same
profile.

| Helmion profile | Authentication class | Current status |
|---|---|---|
| Codex CLI | provider-owned ChatGPT/account browser sign-in | documented; detection/status test not implemented |
| OpenAI API | bearer API key or future supported short-lived server credential | protected store ready; no key enrolled |
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

## Next implementation gate

Before credential enrollment or a canary:

1. threat-model the local enrollment IPC, screen privacy, crash handling, and
   same-user process risks;
2. add one-time service-owned enrollment with no echo/history/logging and
   explicit profile/target review;
3. add per-profile revocation and replacement without returning the old value;
4. implement the typed non-mutating status/connection test for exactly one
   adapter;
5. bind the result to evidence and display only redacted fields; and
6. run an isolated read-only canary before exposing any governed write.
