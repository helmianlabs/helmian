# Live Activity Stream / Orchestration Timeline

## Product requirement

The Live Activity Stream is Helmion's first-class GUI view of multi-provider
orchestration. It sits alongside the embedded CLI console; it does not replace
the console or Maestro.

The stream must make it easy to see:

- the selected coordinator/provider and its verified profile identity;
- Maestro as the provider-neutral policy and lease authority;
- task creation, assignment, routing, rerouting, and cancellation;
- blockers, proposed resolutions, and durable resolution outcomes;
- review findings and their disposition;
- test and evidence results;
- checkpoints and acknowledgement state; and
- handoff source, target, completeness, and lease posture.

## Implemented now

The WPF application has a first-class **Live activity** destination and an
Orchestration Timeline screen. It includes:

- explicit selected-coordinator, Maestro, and recording/redaction posture;
- concise cards for route, policy, finding, blocker, test evidence, checkpoint,
  and handoff-shaped events;
- expandable evidence/redacted-detail regions; and
- a visible evidence rule for strong claims.

All current cards are design fixtures marked `DEMO EVENT`, `DESIGN MOCK`, and
not evidence-backed. No provider, database, workspace command, recording, or
external stream supplies them.

## Live event contract

A future typed event includes:

- event ID and schema version;
- observed time plus ingestion time;
- tenant/workspace/project/session/task IDs as applicable;
- provider adapter ID and redacted verified provider identity;
- actor role and selected coordinator;
- Maestro operation fingerprint, decision, risk tier, and lease identity;
- event kind and concise summary;
- provenance: observed provider event, deterministic Helmion event, imported
  evidence, or explicit inference;
- evidence references and verification state;
- parent/causal event IDs;
- redaction classification;
- optional raw transcript/log artifact reference; and
- durability/acknowledgement state.

Raw material is not embedded in the timeline event. A link resolves through
the local service to a separately controlled artifact, subject to access,
redaction, size, retention, and availability checks.

## Evidence-bound claims

The UI must not present provider prose as proof. Strong claims require:

| Claim | Minimum evidence |
|---|---|
| Bug caught | exact file/diff identity plus failing test or deterministic reproduction |
| Review finding resolved | finding identity, changed diff, and verification result |
| Test passed | command identity, scope, exit result, time, and redacted output artifact |
| Blocker resolved | blocker identity, empirical proof matching its resolution criteria, and durable acknowledgement |
| Checkpoint committed | durable checkpoint ID and commit acknowledgement |
| Handoff complete | checkpoint reference, handoff acknowledgement, and current lease state |

Events without this proof remain `PROPOSED`, `UNVERIFIED`, or
`EVIDENCE REQUIRED`.

## Recording and privacy

Recording mode defaults to redacted metadata. It must exclude:

- credentials, connection material, authorization headers, and environment
  values;
- private prompts, personal memory, unrelated file content, and full home
  paths;
- raw provider logs unless separately opted in for one session;
- clipboard content; and
- audio unless the user explicitly starts the future Voice Interaction Layer.

The UI shows recording state continuously. Raw transcript/log links are
optional, separately protected, revocable, and retention-limited. A missing or
redacted raw artifact does not become evidence merely because a provider
summary describes it.

## Live implementation gates

- Define the versioned event/envelope schema.
- Add a bounded service subscription protocol with reconnect cursors,
  backpressure, ordering, and deduplication.
- Map each verified provider adapter's documented events into the neutral
  envelope.
- Emit deterministic Maestro events directly from committed state transitions.
- Add evidence-artifact custody, redaction, retention, and access controls.
- Correlate tasks, findings, tests, blockers, checkpoints, and handoffs.
- Visually distinguish observed, inferred, proposed, verified, durable, demo,
  disconnected, and stale states.
- Test long sessions, provider disconnects, duplicate/out-of-order events,
  secret leakage, and timeline performance.

No live provider stream should be enabled before its adapter contract,
connection test, read-only canary, provenance mapping, and redaction tests pass.
