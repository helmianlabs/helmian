# Local model routing

Written 2026-07-28 by `f3673e34/agent-O-local-model-routing`.

Goal: stop paying a frontier API for turns a model on this machine can answer.

Every number below was measured on this box today. Nothing here is inherited
from a prior session or reasoned from a spec sheet. Where I could not measure
something, it says so in [§8](#8-what-i-could-not-verify).

---

## 1. The model — and the name correction

**Troy asked for "Qwen 3.5 7B". There is no 7B in Qwen 3.5.** I did not silently
substitute; here is the actual lineup and why I picked what I picked.

Qwen 3.5 is real and current — released 2026-02-16 as a sparse-MoE
vision-language series, with the small dense line following on 2026-03-02 at
**0.8B / 2B / 4B / 9B**
([MarkTechPost, 2026-03-02](https://www.marktechpost.com/2026/03/02/alibaba-just-released-qwen-3-5-small-models-a-family-of-0-8b-to-9b-parameters-built-for-on-device-applications/)).
Ollama serves it officially as `qwen3.5`
([ollama.com/library/qwen3.5](https://ollama.com/library/qwen3.5), 16.5M pulls).

| Tag | Download size | Fits 6 GiB card? |
|---|---|---|
| `qwen3.5:9b` | 6.6 GB | **No** — larger than the whole card before any context |
| `qwen3.5:4b` | 3.4 GB | **Yes** — chosen |
| `qwen3.5:2b` | 2.7 GB | Yes, fallback if 4B ever stops fitting |

The nearest neighbours to a hypothetical 7B are 4B and 9B. 9B is disqualified by
arithmetic: 6.6 GB of weights cannot fit in a 6.00 GiB card, and only ~4.1 GiB
of that card is actually free (see §3). **`qwen3.5:4b` is the choice**, and it
reports as 4.7B parameters once loaded — genuinely close to the 7B Troy asked
for, not a token substitute.

## 2. Quantization

Shipped on **Q4_K_M**, which is what the plain `qwen3.5:4b` tag already is
(verified after pull: `/api/tags` reports `quantization_level: Q4_K_M`).

Ollama publishes only `q4_K_M`, `q8_0` and `bf16` for this model — there is no
`q4_0` or `q5_K_M` variant to choose from
([tags](https://ollama.com/library/qwen3.5/tags)). So the real choice was
Q4_K_M (3.4 GB) vs Q8_0 (5.3 GB), and Q8_0 cannot fit alongside a KV cache in
~4.1 GiB of free VRAM.

That the remaining option is also the *right* one is well supported. A unified
evaluation of llama.cpp quantization on Llama-3.1-8B-Instruct
([arXiv:2601.14277](https://arxiv.org/html/2601.14277v1)) measures:

| Scheme | Avg benchmark | Δ vs F16 baseline (69.47) |
|---|---|---|
| Q4_0 | 67.98 | −2.49 |
| **Q4_K_M** | **69.15** | **−0.32** |
| Q8_0 | 69.41 | −0.06 |

The format matters far more than the nominal bit width: Q4_K_M and Q4_0 are both
"4-bit" yet differ by 2.2 points. The gap concentrates in math/multi-step
reasoning (GSM8K: Q4_0 drops 2.0 points, Q4_K_M lands within 0.22 of baseline),
while knowledge and commonsense tasks are robust to quantization — which is
another reason the routing criteria in §5 keep reasoning on the frontier.
Q8_0 buys 0.26 points for 56% more VRAM and ~29% slower generation, and it does
not fit. Q4_K_M is the correct pick on both counts.

## 3. Proof it fits — no CPU spill

This is the acceptance test. "It loaded" is not proof: Windows WDDM will
silently spill an oversized allocation into system RAM instead of failing.

**Hardware:** GTX 1660 Ti, 6144 MiB total, driver 566.36, compute capability 7.5.

**Note the real budget.** The card is nominally 6 GiB, but the desktop was
already holding ~1.6 GiB before anything was loaded, so the usable budget is
**~4.2 GiB, not 6**:

```
=== BASELINE (model not loaded) ===
6144 MiB total, 1595 MiB used, 4372 MiB free
=== AFTER LOAD + GENERATION ===
6144 MiB total, 5442 MiB used,  525 MiB free
```

`ollama ps` — the PROCESSOR column is the thing that matters, and it is **not** a
CPU/GPU split:

```
NAME          ID              SIZE      PROCESSOR    CONTEXT    UNTIL
qwen3.5:4b    2a654d98e6fb    3.2 GB    100% GPU     4096       4 minutes from now
```

`/api/ps` in exact bytes — resident VRAM equals total size, so nothing spilled:

```
size_total_bytes = 3202676161
size_vram_bytes  = 3202676161
FULLY_ON_GPU     = True
```

**Throughput: 57.87 tokens/sec** (685 generated tokens in 11.838 s, from
`eval_count / eval_duration` on a real prompt).

### Context length vs headroom

| Context | VRAM resident | 100% GPU? | Free VRAM left | tok/s |
|---|---|---|---|---|
| 4096 | 3,202,676,161 | Yes | 525 MiB | 57.9 |
| **8192 (configured)** | **3,341,088,193** | **Yes** | **374 MiB** | **57.3** |
| 16384 | 3,617,912,257 | Yes | 335 MiB | 43.6 |

**Configured: 8192.** It holds full throughput and doubles the window over the
Ollama default of 4096. 16384 also fits but costs 24% of the speed for 39 MiB
less headroom — a bad trade.

⚠️ **The headroom is small and it is shared.** 374 MiB is what is left *with the
current desktop*. This machine also runs Unity and Blender, which take VRAM in
gigabytes. **With Unity open, this model will not fit and will spill to CPU.**
The no-spill result above is conditional on the GPU being otherwise idle.

## 4. Install — what was changed on this machine

- **Binary:** `C:\Users\troyh\AppData\Local\Programs\Ollama\ollama.exe` (v0.32.5),
  extracted from the official `ollama-windows-amd64.zip`. Size-verified at
  1,457,824,795 bytes against the GitHub release asset. Includes the CUDA v12/v13
  runners.
- **The ZIP, not `OllamaSetup.exe`, on purpose.** The installer registers a
  tray app that auto-starts at login and can surface windows. Extracting the zip
  to the same standard location gives the identical binary with no autostart, no
  UAC prompt, and no GUI — the server only runs when it is deliberately started.
- **Models on E:, not C:** `E:\ollama-models` via `OLLAMA_MODELS`. C: has 23.6 GB
  free and a documented space problem; E: has 82.1 GB. The default would have
  been `C:\Users\troyh\.ollama\models`.
- **Nothing else was installed, and no autostart was registered.**

### Starting and stopping the server

Start (hidden, no console window):

```
wscript.exe //B //Nologo "E:\Helmion\artifacts\ollama-serve-hidden.vbs"
```

Stop:

```
Get-Process ollama | Stop-Process
```

Check it is alive: `Invoke-RestMethod http://127.0.0.1:11434/api/version`

**It is running right now** and will keep running until stopped or the machine
reboots. It does not restart at login — after a reboot, re-run the start command.

### It is not reachable off this machine

Ollama binds `127.0.0.1:11434` by default and `OLLAMA_HOST` is pinned to that
value explicitly in `ollama-serve.cmd`. Verified by socket, not by assumption:

```
LocalAddress LocalPort  State OwningProcess
127.0.0.1        11434 Listen         34980
```

`LocalAddress` is `127.0.0.1`, not `0.0.0.0` — nothing outside this box can
reach it.

## 5. Routing criteria — trivial vs hard

### Why this is a pre-empt and not a fourth tier

`model-router.mjs` ranks `fast < standard < deep`: three models from the *same
vendor*, keyed into `PROVIDER_TIER_MODELS`. Local is not a cheaper vendor model —
it is a different endpoint on a different machine with a failure mode the others
do not have (the box can be off). So it runs as a pre-empt *before* the ladder,
and `TIERS` is unchanged. This also keeps every existing caller byte-identical.

This follows the standard shape for hybrid deployments: rule-based routing on
explicit signals, then escalation
([Redis, LLM router architecture best practices 2026](https://redis.io/blog/llm-router-architecture-best-practices/);
[Dynamic Model Routing and Cascading for Efficient LLM Inference: A Survey, arXiv:2603.04445](https://arxiv.org/html/2603.04445v2)).

### The criteria

A turn goes local when **all seven** hold (`classifyLocalEligibility`,
`src/agent/local-provider.mjs`):

| # | Condition | Why |
|---|---|---|
| 1 | A local provider is configured | Off by default — see §6 |
| 2 | Round 0 | Never mid-chain; preserves escalate-only |
| 3 | The ladder classified the turn `fast` | The router's own "nothing to reason about" verdict |
| 4 | No `--tier` and no `--model` | An explicit human choice always wins |
| 5 | ≤ 2000 chars | A long prompt is itself evidence of non-trivial work |
| 6 | No safety-carve-out match | §5.1 |
| 7 | Not a continuation ("continue", "keep going") | Short words, large work behind them |

**Condition 3 is what makes this defensible rather than a guess.** `fast` is
already the existing router's measured trivial bucket (no code shapes, no
root-cause language, short, few messages), and that bucket is precisely where
4B-class models are reliable. Models in the 4–8B range handle classification,
summarization, extraction and rewriting well, while multi-step reasoning,
conditional branching and long-horizon tool chains are where they break down —
one 3B benchmark found prompts with conditional branching and multi-stage
reasoning simply exceeded the model's capacity to track the task
([distil labs, 12 SLMs across 8 tasks](https://www.distillabs.ai/blog/we-benchmarked-12-small-language-models-across-8-tasks-to-find-the-best-base-model-for-fine-tuning/);
[When LLMs Stop Following Steps, arXiv:2605.00817](https://arxiv.org/pdf/2605.00817);
[Why Small LLMs Fail at Tool Calling](https://dev.to/anak_wannaphaschaiyong_11/why-small-llms-fail-at-tool-calling-the-shocking-discovery-from-our-llama-3b-benchmark-5lg)).

### 5.1 Hard safety carve-outs — never local, ever

`LOCAL_SAFETY_DENY` blocks money, credentials, deletion, deploys, schema changes
and Tier-B governance. The reasoning is not "a 4B model would get this wrong" —
it is that the cost of being wrong is unbounded. A mis-summarised paragraph is a
nuisance; a mis-executed `DROP TABLE` is not.

These are belt-and-braces: most such prompts already classify as `standard` (the
existing router treats "delete", "deploy", "migrate" as code work), so the deny
list catches the ones that slip through as short questions — "what is the
password", "read the .env".

> **A real hole this caught.** The first version wrapped every alternative in
> `\b(...)\b`, which made `\.env` unmatchable — in "read the .env" the character
> before `.` is a space, and space→`.` is not a word boundary. **"read the .env"
> routed to the local model.** Found by the deny-list test, not by inspection;
> `.env` is now matched outside the wrapper and the variants are pinned as
> regression cases.

### 5.2 Escalate-only, and failure handling

- Local is round-0 only. If the local model emits a tool call, round 1 re-resolves
  onto the frontier ladder. A turn can *leave* local; it can never come back
  mid-turn.
- `local` is never recorded as the escalate-only floor (`loop.mjs`) — the floor
  exists to stop a turn dropping to a *weaker* model, and local is the weakest
  thing present.
- **A local failure or timeout falls back to the frontier and never fails the
  turn.** Proven end-to-end in `test/local-routing.test.mjs` by pointing the local
  provider at a dead port: the turn still returns an answer from the frontier, the
  fallback is announced rather than silent, and exactly one request reaches the
  frontier.

### 5.3 Tool calling — measured, since the brief required proof

Ollama's OpenAI-compatible endpoint supports `tools` and documents `tool_choice`
as unsupported ([docs](https://docs.ollama.com/api/openai-compatibility)).
`providers.mjs:124` always sends `tool_choice:'auto'` — measured result: **Ollama
ignores it rather than rejecting it.** No 400. `providers.mjs` needed no change.

Measured through the real `chatWithTools` path, 17 trials:

| Probe | Result |
|---|---|
| Valid single-hop tool calls | **5/5** |
| Spurious calls on turns needing no tool | **0/4** |
| Sane first action on conditional multi-step prompts | **3/3** |
| Strict output-format compliance (classification, extraction) | **3/3** |

Better than the literature predicted. It is still **not** licence to trust the
model with a whole tool chain: what was proven is that it emits *valid* calls and
picks a sane *first* action. Completing a multi-round chain correctly was not
tested, which is exactly why local is round-0 only.

## 6. Turning it on — and why it ships OFF

Local routing is **disabled by default**. To enable, add to `E:\Helmion\.env`:

```
HELMION_LOCAL_ENABLED=1
```

| Variable | Default | Meaning |
|---|---|---|
| `HELMION_LOCAL_ENABLED` | *(off)* | Master switch |
| `HELMION_LOCAL_URL` | `http://127.0.0.1:11434/v1` | Endpoint |
| `HELMION_LOCAL_MODEL` | `qwen3.5:4b` | Model tag |
| `HELMION_LOCAL_TIMEOUT_MS` | `45000` | Falls back to frontier on expiry |

> **Why opt-in.** The first cut defaulted to ON and immediately broke three
> unrelated bridge tests: Ollama was listening, so their turns were silently
> answered by the local box instead of the endpoint under test. That is the whole
> risk in miniature — with a default of ON, any machine with something on port
> 11434 quietly gets its prompts rerouted. Cost is a good reason to route local;
> it is not a good enough reason to change where someone's prompts go without
> them saying so.

### The reasoning fix — landed, and what it actually bought

qwen3.5:4b is a **reasoning** model; left alone it emits a long hidden reasoning
trace before answering. `reasoning_effort:'none'` suppresses that, and it is now
wired: `loop.mjs` sets `reasoningEffortNone` for **local turns only**, never
inferred from `providerId 'custom'` (LM Studio / vLLM / DeepSeek are also
'custom' and were never tested against the field). Both directions are asserted
in `test/local-routing.test.mjs`.

Isolated effect, one prompt, same system prompt, real server:

| Request | Tokens | Latency |
|---|---|---|
| Conversational, default | 941 | 39.7 s |
| Conversational, `reasoning_effort:'none'` | 258 | 8.6 s |
| Tool turn, default | 72 | 3.6 s |
| Tool turn, `reasoning_effort:'none'` | 30 | 0.9 s (3/3 valid calls) |

Ruled out first, all measured: `ollama create` with `PARAMETER think false` (set
on the model, overridden by the `/v1` layer), a `/no_think` system message, a
`/no_think` user suffix, and `enable_thinking=False` (4068 tokens and an *empty*
answer). `reasoning_effort` is the only lever that works.

### 🔴 The honest end-to-end number

**The 0.9 s figure is a bare-API best case. It is not what a Helmion turn costs.**
Measured through the real router — 10 warm trivial turns plus 2 cold starts:

| | Measured |
|---|---|
| Cold start (first turn after the 5-minute keep-alive expiry) | **9–18 s** |
| Warm trivial turn, median | **~5 s** |
| Warm trivial turn, range | **2.2 s – 33 s** |

A frontier fast tier answers the same turns in roughly 1–3 s. So **local is
slower than the frontier on the median and considerably worse on the tail.**
What it buys is zero API spend and a prompt that never leaves the machine.

The remaining cost is **not** hidden thinking — it is output length. Latency
tracks answer size almost exactly at ~57 tok/s: a 235-character answer took
2.2 s, a 2,050-character answer 10.4 s, a 2,908-character one 33 s. Under
Helmion's agent system prompt this model writes long, and nothing caps it.

**The next lever is capping local answer length, not tuning the timeout.** A
brevity instruction on local turns would put trivial answers near 1–2 s and make
this unambiguously worth having. That is a deliberate change to prompt
behaviour, so it is proposed here rather than done quietly.

## 6.1 The brevity instruction — landed, measured, and NOT what was predicted

Written 2026-07-28 by `f3673e34/agent-O2-local-brevity`.

The prediction directly above — "would put trivial answers near 1–2 s" — is
**wrong, and it was my own**. It is left standing rather than edited away so the
error is visible. Here is what actually happened.

`LOCAL_BREVITY_INSTRUCTION` + `withLocalBrevity()` (`local-provider.mjs`) fold a
brevity paragraph into the system prompt on **local turns only**; `loop.mjs:92`
applies it, and `test/local-routing.test.mjs` asserts a frontier turn receives
the conversation verbatim. **No `max_tokens` is set anywhere** — a severed answer
is worse than a slow complete one, so the model is asked to be brief and always
allowed to finish.

### Measured: 20 paired warm turns + 4 cold starts

Both arms were measured **in the same runs, on the same 10 prompts**, arm order
alternating so neither side wins on Ollama's prompt-prefix cache. The brevity arm
goes through the real router (`runAgentTurn`); the baseline arm is the identical
`chatWithTools` call minus the brevity paragraph. Both carry the real system
prompt and the real 3 tool definitions.

| | Before (no brevity) | After (brevity) |
|---|---|---|
| Warm median | 3.27 s | **3.12 s** |
| Warm p90 | 8.14 s | **4.82 s** |
| Warm max | 9.79 s | **7.70 s** |
| Mean answer | 680 chars | **460 chars** |
| Cold start | — | 9.65 – 11.86 s (n=4) |

**This is a tail fix, not a median fix.** The median moved 5%, which is inside
the noise. The p90 nearly halved.

### Why the median cannot reach 1–2 s — the floor

The 1–2 s prediction assumed latency is generation-bound. It is not. Ollama's
**native** `/api/chat` reports the split that the OpenAI-compatible endpoint
hides:

```
floor: capital+brev+tools  wall=2.25s  load=0.32s  promptEval=1.86s(678 tok)  gen=0.05s(4 tok)
same, NO tools             wall=1.50s  load=0.30s  promptEval=0.92s(251 tok)  gen=0.20s(13 tok)
```

A **4-token answer still cost 2.25 s**. Prompt evaluation runs at only ~364
tok/s on this card — six times slower than the 57 tok/s *generation* rate that
the earlier analysis extrapolated from — so ~1.9 s of every warm turn is spent
reading the prompt before a single token is emitted. Brevity can only compress
the generation component, which on a trivial turn is already ~0.05 s.

The tool definitions are ~427 of those 678 tokens (~0.94 s), and the brevity
text is itself ~83 tokens (~0.23 s) — so brevity *adds* to the floor it cannot
lower. It still wins overall, but only via the tail.

### The wording was A/B-tested, not guessed

A terser 87-char variant was run against the shipped 385-char one on the same 10
prompts: terser had a marginally better median (3.13 s vs 3.24 s — noise) but a
**worse tail** (max 4.41 s vs 3.75 s) and longer answers (mean 349 vs 294
chars). The tail is the whole point, so the longer wording stayed.

`LOCAL_DEFAULT_TIMEOUT_MS` **stays 45000.** Dropping it to 20 s would abort the
tail this change did not eliminate and force a pointless double wait.

### 🔴 Recommendation: still do NOT enable it for speed

A frontier fast tier answers these same turns in ~1–3 s. Local is **3.12 s warm
median, 4.82 s p90, ~10 s cold**. Brevity closed the worst of the gap but did
not close it. Enable `HELMION_LOCAL_ENABLED=1` if the goal is **zero API spend
and a prompt that never leaves the machine** — not if the goal is a faster
answer. That remains Troy's call, with the real numbers in front of him.

One caveat that bounds all of the above: qwen3.5:4b does not obey the
instruction reliably. In one run a prompt answered in 133 chars without brevity
came back at **2,613 chars with it**. That did not reproduce on the second run,
so it is model variance rather than a prompt-specific defect — but it is why the
max is still 7.70 s and why no token cap was added to force the issue.

## 7. The seam for the four always-on jobs

`LOCAL_JOB_CONTRACT` in `src/agent/local-provider.mjs` defines — but does not
build — the interface for triage, commit-message generation, log monitoring and
dictation summarization. A follow-up agent implements against it.

Background jobs do **not** go through `classifyLocalEligibility`: that function
decides whether an *interactive* turn may be downgraded, whereas a job has
already chosen the local model and has no frontier turn to protect. What they
share is the endpoint and the deny-list. An implementation must:

- call `resolveLocalProvider()` and **no-op rather than throw** when it returns
  null, so a machine without Ollama degrades to "feature off", never to a crash;
- pass an `AbortSignal` built from `provider.timeoutMs`;
- send **no tools** — these are text-in/text-out jobs, and the measured tool
  reliability was for interactive turns, not unattended ones;
- refuse input matching `LOCAL_SAFETY_DENY`, so a log line containing a
  credential is not shipped to a model merely because the model is local.

## 8. What I could NOT verify

- **Multi-round tool chains.** Only the first action of a conditional prompt was
  tested (3/3 sane). Whether the model completes a chain correctly across rounds
  is unmeasured — hence round-0 only.
- **Behaviour under GPU contention.** The 100%-GPU result assumes an otherwise
  idle card. Unity or Blender running will break it. Not tested.
- **Other OpenAI-compatible runtimes.** `tool_choice` being ignored and
  `reasoning_effort` being accepted were measured against **Ollama 0.32.5 only**.
  LM Studio, vLLM and DeepSeek were not tested and may behave differently — which
  is why any `reasoning_effort` change must stay scoped, not blanket-applied to
  every `custom` provider.
- **Quality on real Helmion work.** Latency, VRAM and format compliance were
  measured; whether Troy finds the *answers* good enough is his call, not mine.
- **The 9B model.** Ruled out by arithmetic (6.6 GB > 6.00 GiB), never downloaded.
- **Sustained load.** All measurements are single-request. No soak test, no
  concurrent-request test.
