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

**To finish it, Troy needs to hand over three things:**

| # | What | Why |
|---|---|---|
| 1 | A **Hume API key**, and *which account* it belongs to | There are at least two Hume-adjacent products in play. `MEMORY.md` records that Gauge's fatigue scoring rides Cora's Hume socket (`gaugeContext.tsx:330` → `humeClient.ts:3367`), so pointing the wrong account's config at this server would change behaviour in a shipping product. |
| 2 | **Which EVI config** to modify, or permission to create a new one | Same reason. A new config dedicated to Helmion is the safer option and keeps Cora's existing config untouched. |
| 3 | A decision on **how Hume reaches this machine** | A tunnel for testing, or a small hosted relay. This is the first thing in this feature that stops being local, so it is Troy's call, not an implementation detail. |

Once those exist, the remaining work is: set the config's CLM URL to the
tunnelled address, set `custom_session_id` to `helmion:<something>` when starting
the chat, and run `npm run cora --token <secret> --host 0.0.0.0`. No code change
is expected — but "no code change is expected" is a prediction, and it will be
verified against a live socket before anyone says it works.

## Out of scope, explicitly

Cloud, multi-tenant, hosted deployment, and any change to the relay or Herald
paths. None of it was touched.
