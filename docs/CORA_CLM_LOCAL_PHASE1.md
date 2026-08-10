# Cora → Helmion, Phase 1: local voice, no cloud

**Status: the server is built and proven against a simulated Hume client. A live
Hume EVI config has NOT been connected, because no Hume API key exists in this
environment.** What each half of that sentence means is spelled out below, with
the command that produces the evidence.

Phase 1 is deliberately local and single-user. There is no multi-tenant
anything here, no relay change, no cloud deployment. That was out of scope and
stayed out of scope.

---

## What this is

Hume EVI can be pointed at your own server instead of a hosted model. EVI dials
a WebSocket, sends the conversation plus its prosody reading of *how* the person
sounded, and waits for `assistant_input` chunks followed by `assistant_end`.
That is the "Custom Language Model" (CLM) transport.

The words this server returns do not come from a raw model call. They come from
`runAgentTurn` — the same orchestration the CLI REPL (`src/agent/session.mjs:419`)
and the desktop EXE bridge (`src/agent/bridge.mjs:419`) already use. So a spoken
sentence runs the real tool loop, against the real workspace, under the real
permission gate, and the real provenance ledger records which model answered.
Voice gets no softer path than typing. That is the whole point of the exercise.

```
Troy speaks
   → Hume EVI (STT + prosody + TTS)
       → ws://127.0.0.1:7421/llm          src/cora/ws-server.mjs   (RFC 6455, no deps)
           → parse + prosody               src/cora/clm-protocol.mjs
               → runAgentTurn              src/agent/loop.mjs       (UNCHANGED)
                   → real tools            src/agent/tools.mjs      (UNCHANGED)
               → assistant_input × N
               → assistant_end
           → activity row                  src/cora/activity.mjs
   → Troy hears the answer, and reads the same turn in the Activity Centre
```

## Files

| File | What it is |
|---|---|
| `src/cora/ws-server.mjs` | A WebSocket **server**, RFC 6455, zero dependencies. Node ships a client, not a server, and `ws` is not installed on this machine. |
| `src/cora/clm-protocol.mjs` | Hume's wire contract as pure functions, with its primary sources cited in the header. |
| `src/cora/clm-server.mjs` | The CLM backend: sessions, Helmion-mode gating, the turn lifecycle, access control. |
| `src/cora/activity.mjs` | Writes a voice turn into the ledger the desktop already reads. |
| `src/cora/capability-manifest.mjs` | A generic, local-only role/action contract; it is advisory and does not dispatch or authorize actions. |
| `src/cora/action-intent-compat.mjs` | A local-only translation from Cora's four action classes to Helmian's canonical intent categories; it preserves disabled execution and confirmation/approval markers without dispatch. |
| `src/cora/capability-summary.mjs` | A deterministic plain-language summary of role-scoped capability classes and their confirmation/approval requirements; it is informational only. |
| `src/cora/request-preview.mjs` | A bounded, local-only preview for one known Cora action class; it reports the request shape, gates, and unwired execution without accepting request details. |
| `src/cora/role-action-matrix.mjs` | A frozen role×action posture matrix for future help/UI consumers; it exposes only known scopes, classes, and fixed request/gate/wired status. |
| `src/cora/approval-request-projection.mjs` | A local-only projection from the exact Cora approval-required preview toward Helmian's approval-request shape; it omits identity and request details and cannot create an approval. |
| `src/cora/role-help.mjs` | A bounded role help/selection projection for a future voice operator surface; it composes only the matrix and request previews and states that selection grants no authority. |
| `src/cora/operator-surface-projection.mjs` | A pure consumer projection that composes role help with the approval-request projection for consistent future operator display; it is non-authorizing and non-invoking. |
| `src/cora/demo-command-planner.mjs` | A strict local demo intent catalog and deterministic non-executing planner for navigation, mocked ELD trucks, mocked load-board opportunities, and payroll approval preparation. |
| `src/cora/operations-command-envelope.mjs` | A tenant/role-scoped Cora consumer envelope that translates the four demo intents to stable Aim Forge page IDs or Helmian mock-service contracts and returns bounded responses without dispatch. |
| `bin/helmion-cora.mjs` | `npm run cora` — foreground, loopback, Ctrl-C. |
| `test/cora-clm.test.mjs` | 34 tests. Real sockets, real frames, real agent loop. |

## Running it

```
npm run cora
npm run cora -- --workspace E:\Helmion --permission read-tools
```

It binds `127.0.0.1:7421` and prints the socket URL. Ctrl-C stops it. Nothing
autostarts it: no service, no login hook, no detach.

Not `8788` on purpose — a ws server on that port that spawned a coding agent
with permissions off is a known finding on this machine (2026-07-29 security
audit), and reusing the port would make this indistinguishable from it in a
`netstat`.

## The two rules that are not negotiable

**1. Exactly one `assistant_end` per turn.** EVI hands the conversational turn
to the CLM and does not take it back until `assistant_end` arrives. Miss it once
— a thrown error, a provider timeout, a malformed frame — and the microphone is
dead for the rest of the chat with no error message anywhere. Every path out of
`handleTurn` goes through one `finally`, `endTurn` is idempotent, and the
throwing path is tested directly.

**2. Helmion mode is marked on `custom_session_id`, and it fails closed.** A
chat whose `custom_session_id` starts with `helmion` gets the tool-enabled
agent. Anything else — a different product's session, or no id at all — is built
`read-only`, which produces an empty tool catalog. An unmarked session is one
where nobody stated an intent, and "nobody stated an intent" must never mean
"may run commands by voice".

The label is not treated as authority by itself. It is limited to 128
characters, rejects control characters, and is bound to the WebSocket
connection that first presents it. A second connection cannot guess the label
and join the first connection's conversation history or tool runtime. This
keeps the short-lived context and its audit trail connection-scoped even when
the socket has already passed the configured token/origin checks.

There is a positive control for this: the same scripted model that successfully
lists a directory in one test is given an unmarked session in the next, at
`permission: full`, and is handed no tools at all.

## Access control

`resolveAccess()` refuses at **startup** to bind a non-loopback address without
a token. This socket can reach `run_command`; binding it to `0.0.0.0` with no
credential would be an unauthenticated remote shell on the LAN. That is a
throw, not a warning in a doc.

## Design decisions worth knowing

**Helmion's conversation history wins, not Hume's.** Hume re-sends the whole
conversation every turn, and `runAgentTurn` keeps its own `messages` array.
Feeding both in would double every utterance. Helmion's copy is kept because it
is strictly richer — it holds the tool calls and tool results, which Hume never
sees and which are most of what makes the next turn correct. Only the newest
user utterance is taken from the incoming payload.

**Prosody reaches the model.** It is folded into the utterance in the same
bracketed form Hume's own example uses: `ship it [Prosody: a lot of
Determination and Interest]`. Drop this and the whole detour through Hume buys
nothing a text box could not.

**Markdown is made speakable.** A coding agent answers in fenced code and
backticked paths. Fed to a synthesiser that becomes "backtick src slash agent
slash loop dot m j s backtick". Code blocks are replaced with a spoken
placeholder rather than deleted, so the listener is *told* code exists.

**A spoken answer is capped (900 chars) and the cap is announced.** A voice
assistant reading a 900-word answer cannot be interrupted usefully. The full
answer is never lost — it is in the activity ledger — so the spoken form is the
summary and the ledger is the record. Going quiet mid-answer without saying so
is indistinguishable from a crash.

**One progress line per turn, not a running commentary.** The first tool call
says "Working on that now." and nothing after that speaks until the answer.

**Turns on one session are serialized.** Two overlapping agent turns on one tool
runtime would interleave their tool calls into a single history and produce an
answer neither question asked.

## Voice turns in the activity log

They land in `.helmion/audit/project-activity.jsonl` — the ledger
`ProjectWorkbenchStore` already owns (`desktop/Helmion.Desktop.Core/ProjectWorkbenchStore.cs:37`)
and `ReadActivity` already reads (`:242-280`). Same `kind` (`agent`) as a typed
agent turn so it renders identically, with `source: "Helmian Cora (voice)"` so a
reader can still tell it was spoken. **No C# change was needed.**

A row records what was heard, what was said, which tools ran, which model
answered, and the Hume `custom_session_id`.

---

## What is proven, and how to reproduce it

```
npm test                                   # whole repo
node --test test/cora-clm.test.mjs         # this feature: 34 pass, 0 fail, ~1s
node bin/helmion-cora.mjs --self-test      # real local socket + policy smoke test, no provider key
node bin/helmion-cora.mjs --provider-status --provider claude  # read-only readiness, no server or provider call
curl http://127.0.0.1:7421/healthz?detail=1  # opt-in redacted local diagnostics
```

| Claim | Evidence |
|---|---|
| A real Hume-shaped client can hold a real conversation with this server | `A REAL SOCKET, A REAL TURN` — Node's own global `WebSocket` (the client `src/relay/client.mjs` uses in production) does a genuine handshake and genuine masked frames against the real server |
| The outgoing shapes are Hume's, exactly | `assistant_end` is asserted as the literal bytes `{"type":"assistant_end"}`, matching Hume's example, which puts nothing on it |
| A spoken command runs a REAL tool on REAL disk | `AN END-TO-END VOICE TURN RUNS A REAL TOOL ON REAL DISK` — real `runAgentTurn` → real `createToolRuntime` → real `list_dir`, and the assertion is on the actual directory listing coming back in the second provider request |
| Prosody survives all the way to the provider | Same test asserts `[Prosody: a lot of Interest]` in the outbound request body |
| The tool catalog is gated | Same test asserts the advertised tools are exactly `list_dir, read_file, search_text, workspace_context` — no `create_file`, no `run_project_task` |
| An unmarked session gets nothing, even at `permission: full` | `AN UNMARKED SESSION CANNOT REACH A TOOL EVEN IF THE MODEL ASKS FOR ONE` |
| A crash still yields the microphone | `A THROWN TURN STILL YIELDS THE MICROPHONE` |
| Framing is correct on a real network, not just loopback | fragmentation, 16- and 64-bit lengths, TCP re-framing, unmasked-client refusal, the §5.5 control-frame rules, and an assembled-message size cap |
| The shipped CLI can prove its local wiring without Hume | `node bin/helmion-cora.mjs --self-test` starts the real server, drives a real WebSocket client, checks both `helmion:*` and chat-only policy sessions, and exits without a provider key or activity-ledger write |
| Live-turn detail stays bounded and non-authoritative | `GET /healthz?detail=1` adds a read-only schema version plus policy mode, turn count, active-turn count, server-owned phase (`queued`, `running`, or `timed-out`), aggregate and per-policy-mode phase counts capped independently at 100 per phase, explicit aggregate/per-mode truncation flags, bounded age, and session-list truncation status; the schema fixture and provider-free consumer assertion negotiate supported versions and reject extra fields or invalid cap semantics; it omits session/connection IDs, user text, workspace paths, and credentials, and uses the same bearer boundary as health |
| Provider readiness stays local and fail-closed | The health projection reports only `local-mock` readiness or secret-free `live-provider` states (`ready`, `missing-credential`, `invalid-configuration`); tests validate built-in and keyless local-compatible configuration shape without contacting Hume or echoing credentials, endpoints, or model details |
| Invalid provider status is a stable local contract | `--provider-status` returns exactly `{"schemaVersion":1,"mode":"live-provider","state":"invalid-configuration","ready":false,"providerRequired":true}` plus one newline for malformed or unknown live-provider selection; it emits no selection, credential, endpoint, or error detail and exits with status 1 |
| Voice action classes are role-scoped but not wired | `src/cora/capability-manifest.mjs` defines generic `search`, `draft`, `notify`, and `approval-required-execute` classes for observer/drafter/notifier/approver roles; all remain `execution: "not-wired"`, external classes require confirmation/approval, and the contract is explicitly non-authoritative |
| Cora-to-Helmian action compatibility is bounded and non-invoking | `src/cora/action-intent-compat.mjs` maps those four classes exactly to `read_search`, `draft`, `notify`, and `execute`; every projection retains `enabled: false`, `execution: "not-wired"`, Cora confirmation/approval markers, and Helmian `authorization: "not_evaluated"` / `invocation: "not_performed"` |
| Capability explanations are user-facing but non-authoritative | `summarizeCoraVoiceCapabilitiesForRole()` accepts only an allowlisted role and returns fixed plain language for its scoped classes, including confirmation/approval requirements; malformed or unknown roles return a fixed no-capabilities message, and no payload, tenant, session, credential, or path data is accepted or returned |
| Request previews are bounded and never become actions | `previewCoraVoiceRequest()` accepts only one of the four known action ids and returns a frozen `cora.request-preview.v1` shape with fixed plain-language wording, explicit confirmation/approval flags, canonical intent, `enabled: false`, `execution: "not-wired"`, and no payload, identity, credential, endpoint, or path fields; unknown input returns `null` |
| Role/action display data is closed and non-runtime | `CORA_ROLE_ACTION_MATRIX` contains exactly the four known roles × four known action classes, with fixed `requestable`, confirmation, approval, enabled, and wired status; the role filter returns only known rows or an empty result for malformed/unknown input, and the serialized matrix contains no identity, payload, secret, provider, endpoint, or path fields |
| Cora approval projection preserves gates without authorizing | `projectCoraApprovalPreviewToHelmianRequest()` accepts only the exact `approval-required-execute` preview and returns a frozen `cora.helmion-approval-projection.v1` with execute/pending/non-authorizing markers, confirmation and approval required, and disabled/unwired execution; it contains no tenant, actor, request, policy, payload, target, credential, endpoint, path, or provider fields and never calls Helmian's approval builder |
| Role help/selection stays local and fail-closed | `getCoraRoleHelp()` composes one known role's four matrix rows with the fixed request previews, exposes only requestability, confirmation/approval requirements, and disabled/not-wired status, and says selecting a role grants no authority; malformed/unknown roles return `null`, with no tenant/session, payload, target, secret, provider, network, or configuration data |
| Consumer operator projection is consistent and non-authorizing | `projectCoraOperatorSurface()` accepts only exact outputs of the role-help and approval-projection contracts, then returns frozen capability posture plus a pending approval handoff view; extra or altered fields fail closed, and the output contains no identity, request detail, credential, provider, endpoint, path, network, messaging, UI, or runtime fields |
| Cora demo command plans are strict and local-only | `planCoraDemoCommand()` recognizes only `switch-dashboard`, `locate-trucks`, `search-loads`, and `prepare-payroll-work`; navigation is descriptive, ELD/load-board results come from fixed mock records, payroll uses the existing pending approval projection, and unknown/incomplete/extra-field/invalid requests return fixed clarification plans without echoing input or executing anything |
| Cora consumes stable operations contracts without becoming an executor | `createCoraOperationsEnvelope()` requires exact tenant/role/intent/request keys, translates Aim Forge dashboard aliases to stable `desk`/`board`/`dispatch`/`fleet`/`money`/`docs`/`connect`/`settings` IDs, delegates only to the deterministic Helmian fleet/load/payroll mock contracts, preserves audit IDs and payroll approval gates, and returns frozen `cora.operations-command-envelope.v1` data with execution disabled |

Two real defects were found by these tests and fixed before anything was
committed:

1. `splitForSpeech` floored `maxChars` at 40 and therefore silently ignored any
   smaller value the caller passed — a parameter accepted and disregarded.
2. The turn-timeout `setTimeout` was cleared *after* the `await` instead of in a
   `finally`, so a **rejected** turn leaked a 120-second timer. Symptom: the
   test process stayed alive for exactly `turnTimeoutMs`. The suite went from
   120.2s to 1.0s once it was fixed.

---

## What is BLOCKED, and exactly what unblocks it

**Blocked: pointing a live Hume EVI config at this server.**

Not attempted, not worked around, not faked. Two things are missing and neither
can be invented from here:

1. **A Hume API key.** No `HUME_API_KEY` exists in `E:\Helmion\.env` (verified by
   listing the key names in that file). Reading Fly secrets to hunt for one was
   correctly refused earlier tonight as a Tier-B action, and that refusal is
   respected here rather than routed around.
2. **A reachable URL.** An EVI config holds a URL that Hume's servers dial. A
   loopback address is not reachable from Hume. Phase 1 is local by definition,
   so no tunnel or public endpoint was set up.

### The target config has been identified — but not its ID

Troy has a config named **"Big Sister (Troy desktop)"** in his Hume dashboard
(Claude Sonnet 4.5, "Warm Female Assistant" voice, EVI 4-mini). Searching the
machine found what created it:

**`C:\Users\troyh\gauge-sandbox\scripts\_create_bigsister_config.mjs`** — every
attribute matches, four for four:

| Dashboard shows | Script line |
|---|---|
| name "Big Sister (Troy desktop)" | `:30 name: "Big Sister (Troy desktop)"` |
| EVI 4-mini | `:29 evi_version: "4-mini"` |
| "Warm Female Assistant" voice | `:32 voice: { provider: "HUME_AI", name: "Warm Female Assistant Voice" }` |
| Claude Sonnet 4.5 | `:33 language_model: { model_provider: "ANTHROPIC", model_resource: "claude-sonnet-4-5-20250929", temperature: 0.6 }` |

Three things follow, and each one is a decision rather than a detail.

**1. This is not a CLM config, and pointing it here is not a URL tweak.** Line 33
gives it a *hosted* Anthropic brain — Hume calls Anthropic itself. Using this
server means **replacing** that `language_model` field with Hume's
custom-language-model setting. The config's brain gets swapped, not extended.

**2. The config ID is recorded nowhere on this machine.** The script prints it
(`:36 console.log("BIGSISTER_CONFIG_ID=" + cfg.id)`) and never saves it.
`BIGSISTER_CONFIG_ID` appears in exactly one place across `gauge-sandbox`,
`aimforge`, `aimforge-mobile` and `E:\Helmion`: that `console.log`. Every UUID
recorded in the planning docs and scripts was enumerated and identified —
`8ef07029` (dairy driver), `9dd7f607` (freight mobile), `7f5aaef6` (a conflicting
freight claim), and four others that turned out to be EAS build IDs and Claude
session IDs. None is Big Sister. The canonical planning doc admits the same gap
in its own matrix: *"(id not re-verified this session)"*. **No ID is guessed
here.**

**3. There is already a governance doc for exactly this question**, and it
constrains the answer:
`C:\Users\troyh\aimforge\planning\CORA_DESKTOP_VS_MOBILE_SPLIT.md` (365 lines)
holds a four-config matrix. Big Sister is row **D**: *"Troy personal / separate
use · Local voice tooling only — **not** product env · Tools: **None** · temp
0.6"*. And §6 rules that *"if a Helmion voice surface exists later, it either
uses Cora Desktop or a fifth named config — never config B."*

Row D matches this Phase 1 brief exactly — Troy's own desk, not a product
surface. But the matrix says row D has **no tools**, and this server gives it
real tools on his disk. The `helmion:` session marking is the lever that keeps
that opt-in, but the line in that matrix is Troy's to move, not mine.

### What Troy needs to hand over

| # | What | Why |
|---|---|---|
| 1 | A **Hume API key for the account that owns "Big Sister (Troy desktop)"** | Then `GET https://api.hume.ai/v0/evi/configs` returns the ID in one call and nobody has to guess it. The key already in play is scoped to the AimForge freight project and confirmed unable to see this config, so it is a *different* key. The creator script takes `HUME_API_KEY` from the environment at run time and `gauge-sandbox/.env.local` declares only `EXPO_PUBLIC_HUME_CONFIG_ID` — so the key used was passed inline and is not recorded anywhere. Which account owns row D is therefore **unknown from disk**, and is not assumed here. |
| 2 | **Yes or no: swap row D's hosted Anthropic brain for this CLM** | It is a replacement, not an addition (see 1 above). Creating a fifth config instead leaves Big Sister exactly as it is today, which is the safer option. |
| 3 | **Yes or no: row D gains tools** | The matrix currently says None. |
| 4 | A decision on **how Hume reaches this machine** | A loopback URL is not dialable from Hume's servers. A tunnel for testing, or a small hosted relay. This is the first thing in this feature that stops being local, so it is Troy's call. |

Why the account question is not pedantry: `docs/VOICE_VENDOR_REPLACEMENT_PLAN.md:14-34`
proves, A→H with no uncited gap, that **Gauge's fatigue scoring rides Cora's Hume
socket** (`gaugeContext.tsx:330` → `humeClient.ts:3286, 3346, 3367`). That is
config **A**, not D, so nothing in this feature touches it — but it is why
"which account" gets answered before anyone edits a config.

Once those are settled the remaining work is: point the config's CLM URL at the
tunnelled address, set `custom_session_id` to `helmion:<something>` when starting
the chat, and run `npm run cora -- --token <secret> --host 0.0.0.0`. No code
change is expected — but "no code change is expected" is a prediction, and it
gets verified against a live socket before anyone says it works.

### Helmion already has a second, unrelated voice path

`docs/archive/VOICE_PHASE1_WIRING_TODO.md` is about a **different** stack: a
local Whisper + Kokoro engine behind `ISpeechEngine` in the WPF desktop app,
which replaced SAPI. No Hume, no EVI, no config. Its engine layer is done and
proven headlessly; its remaining work is MainWindow UI wiring.

So the desktop already has a working local voice front door — mic button →
Whisper → agent → Kokoro. Cora-via-Hume is a **parallel** path, not a
continuation of that one. Whether Hume replaces it, or the two coexist (local
for offline and dictation, Hume when prosody and a natural interrupt matter), is
an open product question nobody has answered. It is not answered here either.

## Out of scope, explicitly

Cloud, multi-tenant, hosted deployment, and any change to the relay or Herald
paths. None of it was touched.
