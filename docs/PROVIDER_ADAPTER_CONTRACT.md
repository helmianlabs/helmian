# Helmion provider-adapter contract

## Purpose

The provider-adapter contract makes a new AI integration a registry addition
with verified boundaries instead of a rewrite of Maestro. The contract and its
local validator are implemented in
`src/core/provider-adapter-contract.mjs`. Codex CLI and OpenAI API are distinct
declarations, as are Gemini CLI and Gemini API; Claude Code CLI and Grok remain
separate documentation-gated declarations. All six are design-only and are not
activation-eligible.

No declaration stores credentials, invokes a provider, or grants authority.

## Required declaration

Every adapter declares:

- **identity:** the provider/local-profile identity kind and how a connection
  test returns a redacted user-reviewable identity;
- **authentication:** the auth type and whether custody is provider-owned or
  Windows-protected inside the Helmion local service;
- **invocation:** one or more documented `cli`, `api`, or `local_endpoint`
  transports;
- **capabilities:** explicit `supported`, `unsupported`, or `unknown` states for
  read-only operations, workspace writes, tool use, streaming, and voice;
- **evidence:** `helmion.adapter-evidence.v1` plus required result fields;
- **safety:** shared Maestro authority, lease requirement for workspace writes,
  provider inability to grant approvals, secret boundaries, and target
  restrictions; and
- **health check:** a named, non-mutating identity/scope/target/capability
  probe.

Unknown is a first-class capability state. A CLI presence check must not be
treated as proof that tool use, streaming, workspace writes, or voice is
supported.

## Activation gate

An adapter may become activation-eligible only when:

1. its provider has a supported, current, documented API, CLI, or local
   endpoint;
2. every invocation surface is marked `verified_documented` against the
   reviewed provider documentation;
3. its provider identity and least-privilege auth profile can be verified
   without exposing a credential;
4. its health check is non-mutating;
5. the connection test shows the exact account/profile, target, scopes, and
   declared capabilities;
6. a read-only canary succeeds with Helmion evidence; and
7. any write capability is bound to the existing Maestro lease, policy,
   confirmation, and audit path.

Filename detection in the Windows local service reports only whether a known
executable name is present on `PATH`. It does not satisfy the documentation,
authentication, health, or canary gates.

## Authority boundary

Maestro policy, leases, exact-action confirmations, and audit semantics remain
provider-neutral. An adapter translates operations and evidence; it does not
reimplement or weaken safety per vendor. A provider cannot approve its own
action.

MCP may supply provider tools or context. MCP is not Maestro and is not voice
transport.

## Unsupported surfaces

The product UI must use this language:

> An adapter can be added only when the provider offers a supported,
> documented API, CLI, or local endpoint.

Helmion must not scrape, automate, screen-drive, or claim integration with a
consumer chat/voice UI that lacks such a surface. This includes no claim that
an existing ChatGPT, Codex, Claude, Gemini, or Grok voice session can be
commandeered.

The contract may declare `voice: supported` only for a documented adapter
capability used by Helmion's own in-app Voice Interaction Layer. A provider CLI
does not become voice-capable merely because Helmion can invoke it.

## Evidence format

The base evidence fields are:

- adapter ID;
- redacted provider identity;
- exact target;
- operation class;
- Maestro decision;
- result; and
- observation time.

Adapter-specific evidence may add fields but may not remove the base fields or
include secrets. All results must distinguish observed facts from inferred
capabilities.

## Implemented versus designed

Implemented:

- schema-like runtime validation;
- immutable contract objects;
- duplicate-ID rejection;
- forbidden consumer-UI transports;
- explicit capability states;
- shared Maestro authority checks;
- lease enforcement declaration for supported workspace writes;
- provider self-approval rejection;
- non-mutating health-check enforcement;
- secret-bearing contract-field rejection; and
- six design-only registry declarations plus unit tests; four invocation
  surfaces have current official-documentation references while Claude Code
  and Grok remain documentation-gated.

Implemented as a safe prerequisite but not activated:

- service-only CurrentUser-DPAPI profile store;
- typed redacted non-mutating connection-test plan/result contract; and
- exact direct Neon Development target binding.

Designed but not implemented:

- current provider-documentation verification;
- credential enrollment and profile lifecycle UI;
- live connection and health tests;
- provider invocation;
- streaming;
- adapter-specific evidence collectors;
- write capability; and
- voice capability.
