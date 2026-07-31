# Voice Vendor Replacement Plan — Hume.ai (Cora) and ElevenLabs (Thinking Buddy)

**Date:** 2026-07-29
**Status:** RESEARCH AND PLANNING ONLY. No code was written. All code access was read-only.
**Hardware constraint used throughout:** GTX 1660 Ti, 6.00 GiB VRAM, 16 GB RAM (Turing — no bf16, no FP8).

Every code claim below cites `file:line` read this session from the working tree.
Every price cites a live URL. Anything I could not verify is stamped and stated.

---

## 0. THE HEADLINE — read this before anything else

**Ripping Hume out of Cora silently kills Gauge's fatigue scoring. This is now proven
in code, not inferred from a comment.**

Since 2026-07-26, Gauge has **no Hume connection of its own**. It registers a callback
and waits for Cora's socket to deliver:

| Stage | Cite | What actually happens |
|---|---|---|
| A. Gauge registers its scorer | `gaugeContext.tsx:330` | `setOnHumeScores(handleHumeScores)` |
| B. Gauge does NOT open a socket | `gaugeContext.tsx:336-364` | Comment block: *"GAUGE NO LONGER OWNS THE SOCKET OR THE MIC"*; the `connectToHume()` + `startHumeMicBridge()` calls that used to be here were removed |
| C. Same on resume | `gaugeContext.tsx:469-474` | `resumeListening` also no longer calls `connectToHume()` |
| D. Cora owns the only socket | `coraSession.ts:58-72` | State machine: socket OPEN in exactly two states (ONBOARDING, ACTIVE), CLOSED otherwise. `heyDairyForge.ts` performs the effects |
| E. Scores arrive on that socket | `humeClient.ts:3286` | `if (message?.type !== "user_message") return;` |
| F. Scores parsed from EVI prosody | `humeClient.ts:3346` | `const raw = message?.models?.prosody?.scores` |
| G. Delivered to Gauge | `humeClient.ts:3367` | `if (state.onScores) state.onScores(scores)` |
| H. Tripwire fires | `humeClient.ts:74-80`, `gaugeContext.tsx:238` | `evaluateTripwire()` → FATIGUE if tiredness > 0.85; HIGH_AROUSAL if anger > 0.8 or anxiety > 0.85 (`humeClient.ts:70-72`) |

**Chain conclusion:** A → H has no uncited gap. If Cora stops opening a Hume EVI socket,
`state.onScores` is never called, and `handleHumeScores` never runs. **Gauge's fatigue and
stress scoring goes to zero — silently, with no error anywhere.** There is no separate
Gauge Hume path left to fall back on.

**Corollary the team lead's brief got right and I confirmed:** Gauge's 60-second audio
clips do NOT feed scoring. `audioLoop.ts:44-48` says so, and the code agrees —
`gaugeContext.tsx:394` sends those clips to `transcribeChunk(...)` (Whisper via backend
proxy), producing `TranscriptLogEntry` only. Clips → Whisper → transcript log.
Prosody → Cora's socket → fatigue. **Two completely separate paths.**

**Therefore: "Replace Hume for Cora, keep Hume for Gauge" is not a config change.
It requires building a second, independent Hume connection for Gauge — which is a
paid EVI socket carrying a conversation nobody listens to, OR moving Gauge onto
Hume's standalone Prosody API, whose price is no longer published (see §2).**

---

## 1. What Hume actually provides Cora today — the full replacement surface

Troy said Hume runs Cora on **"Sonic 4.6"**. Verified: **there is no "Sonic" anywhere in
the codebase** (grep across `gauge-sandbox`, case-insensitive, 0 hits for the model name).
**"Sonic" is Cartesia's TTS product line, not Hume's** ([cartesia.ai/sonic](https://www.cartesia.ai/sonic)).
Hume's names are **EVI 3 / EVI 4 mini** (speech-to-speech) and **Octave / Octave 2** (TTS).
If someone said "Hume Sonic," two vendors got conflated.

What IS verifiable from code:

- **Config ID:** `8ef07029-368b-4e6d-9621-2b8defadfea7` — `eas.json:17,31,43,55`, and
  hardcoded in `scripts/_fix_voice_and_ticket.mjs:6` and `scripts/_fix_tone_prompt.mjs:6`.
- **Voice:** `"Warm Female Assistant Voice"`, provider `HUME_AI` —
  `scripts/_fix_voice_and_ticket.mjs:7`. (Swapped off a "Valley Girl" voice; same file's header.)
- **The LLM, EVI version, and prompt live in the Hume dashboard, not in the repo.**
  `humeClient.ts:3497-3502` states the dashboard config is *"the single source of truth
  for Kora's prompt"* and the client deliberately stopped sending `system_prompt`.
  A sibling script (`_create_bigsister_config.mjs:31-36`) shows the shape Troy uses
  elsewhere: `evi_version: "4-mini"`, `language_model: { model_provider: "ANTHROPIC",
  model_resource: "claude-sonnet-4-5-20250929", temperature: 0.6 }`.
  **[UNVERIFIED for Cora specifically]** — reading Cora's actual EVI version and LLM
  requires a `GET /v0/evi/configs/8ef07029-.../version/N` call with `HUME_API_KEY`,
  which I did not make (read-only brief, no credential use).

### 1a. Every capability, setting, slider and restriction that must be replaced

This is the parity checklist. A replacement covering only "STT + LLM + TTS" fails.

| # | Capability | Cite | What it does | Free-stack replacement difficulty |
|---|---|---|---|---|
| 1 | **75 tool definitions** | `humeClient.ts:209-2474`, `DAIRYFORGE_TOOLS` | Full DOT pre-trip + pickup + delivery voice surface, each with rich JSON-Schema and teaching text | **Portable.** Plain JSON Schema; any tool-calling LLM accepts them. Biggest single asset, and it is already in the repo, not locked in the vendor |
| 2 | **Tool-capable config gate** | `humeClient.ts:3492-3493` | `TOOLS_ENABLED = HUME_CONFIG_ID.length > 0`; empty config id ⇒ default `ellm` model ⇒ zero tools, silently | Disappears — you pick your own LLM |
| 3 | **Assistant-voice gate** | `humeClient.ts:2550, 3275-3277, 3294-3313` | Drops her audio unless (a) addressed by name, (b) a tool fired, or (c) we injected a deterministic prompt. Exists because *"an LLM given a turn ALWAYS emits text"* | **You must rebuild this.** It is compensation for EVI handing the LLM a turn on every user utterance. A framework with proper wake/turn control needs less of it, but the address-detection logic is product behavior |
| 4 | **Address regex** | `humeClient.ts:2555` | `/\b(kora\|cora\|korra\|dairy\s?forge)\b/i` | Portable, trivial |
| 5 | **Follow-up window** | `humeClient.ts:2564-2572` | 12 s default; driver's next turn doesn't need her name again. `EXPO_PUBLIC_KORA_FOLLOWUP_WINDOW_MS` | Portable, trivial |
| 6 | **Filler suppression** | `humeClient.ts:2579-2580` | `FILLER_ONLY` regex mutes "I'm listening", "standing by" | Portable |
| 7 | **Deflection suppression** | `humeClient.ts:2589-2590` | `DEFLECTION_RE` mutes multi-sentence "I'm staying silent because you weren't talking to me" rambles | Portable |
| 8 | **Barge-in / mic gating** | `humeClient.ts:2604, 2637-2641`, `humeMicBridge.ts` (`isTtsPlaying` consumer) | Mic frames suppressed for the whole TTS span, not just per chunk — closes the 5-50 ms inter-chunk window that caused *"had to repeat the command 3 times"* | **Framework gives you better than this natively.** LiveKit/Pipecat do real barge-in |
| 9 | **Post-TTS holdoff** | `humeClient.ts:2613-2620` | 400 ms default, `EXPO_PUBLIC_KORA_POST_TTS_HOLDOFF_MS`, so speaker resonance doesn't self-trigger | Replaced by proper AEC |
| 10 | **TTS chunk pre-loading** | `humeClient.ts:2673-2767` | Preload chunk N+1 while N plays; removes 50-150 ms dead air | Framework handles streaming playback |
| 11 | **Volume slider + mute + voice on/off** | `appSettings.ts:23-32, 102-105` | `voiceEnabled`, `voiceMuted`, `ttsVolume` (0..1, default 0.55 from `EXPO_PUBLIC_KORA_TTS_VOLUME`), persisted to AsyncStorage; `getEffectiveTtsVolume()` returns 0 when off/muted | Portable, trivial |
| 12 | **Mic audio source** | `humeMicBridge.ts` const `HUME_MIC_AUDIO_SOURCE = 10` | Android `VOICE_PERFORMANCE` (API 29+) for aggressive AEC. Soak history documented: 6 → 7 → 10 | Portable — same Android constant |
| 13 | **Wire format** | `humeClient.ts:102-104` | linear16 PCM, 16 kHz, mono; frames 4096 bytes ≈ 128 ms, capped 20 fps | Portable; every stack wants this |
| 14 | **Verbatim speech injection** | `humeClient.ts:3636-3648` | `assistant_input` + `assistant_end` makes her say exact text (wake greeting, screen narration) | **Easier off Hume** — you own the TTS, so you just speak the string |
| 15 | **Pre-open injection queue** | `humeClient.ts:3593-3612` | Queues up to 3 lines sent before socket open, flushed in `onopen`, so the wake greeting is her first word | Portable |
| 16 | **Reconnect ladder** | `humeClient.ts:3107-3154` | Hume *"disconnects every ~60s by design"*; exponential backoff + jitter, max 5, then `onSessionEnd("max-reconnect")` re-arms the wake word | **Disappears** — this exists only because Hume drops the socket |
| 17 | **Session state machine** | `coraSession.ts:58-72` | SIGNED_OUT → ONBOARDING → DORMANT → ACTIVE; wake listener armed in exactly one state; socket open in exactly two | Portable — it's pure logic, no vendor imports (`coraSession.ts:38-45`) |
| 18 | **Prosody scores** | `humeClient.ts:3346-3367` | 9 dimensions: anger, anxiety, distress, tiredness, sadness, boredom, confidence, contentment, enthusiasm | 🔴 **NOT REPLACEABLE — see §4** |
| 19 | **Anti-hallucination prompt** | `humeClient.ts:156-195` | Closed-world / no-fake-confirmation / DOT warning. Written because Kora confirmed brake checks with zero tool calls — *"For DOT pre-trip this is regulatory fraud."* Note at `:146`: EVI exposes **no `tool_choice` / `strict_mode` knob** | **Gets BETTER off Hume.** OpenAI/Anthropic/vLLM all support forced tool choice. This is a genuine win |

**Restrictions Hume imposes that a replacement removes:** no `tool_choice`/`strict_mode`
(`:146`); ~60 s forced disconnects (`:3107`); prosody only on `user_message`, no
mid-utterance streaming without a different endpoint (`:11-13`); `ellm` default config
silently supports no tools (`:3475-3479`).

---

## 2. What Troy pays now

### Hume.ai — [hume.ai/pricing](https://www.hume.ai/pricing)

| Tier | Monthly | EVI minutes | Overage $/min |
|---|---|---|---|
| Free | $0 | 5 | $0.06 |
| Starter | $3 | 40 | $0.05–0.07 ⚠ |
| Creator | $7 or $14 ⚠ | 200 | ⚠ |
| Pro | $70 | 1,200 | $0.06 |
| Scale | $200 | 5,000 | $0.05 ⚠ |
| Business | $500 | 12,500 | $0.04 |

⚠ Four cells read inconsistently across three fetches of the same page (Starter overage,
Creator monthly, Creator overage, and Scale — where $200 ÷ 5,000 = $0.04 but the table
prints $0.05). Treat those as unverified.

Overage is billed *"each time you accrue $44 of usage"*
([dev.hume.ai/docs/resources/billing](https://dev.hume.ai/docs/resources/billing)).
**Bring-your-own LLM key means Hume does not charge for LLM usage** (same page) —
so if Cora's config uses Troy's own Anthropic key, the EVI minute rate is the whole bill.

**🔴 The Expression Measurement finding — this is the one that matters:**

Hume's standalone prosody product ([hume.ai/expression-measurement-api](https://www.hume.ai/expression-measurement-api))
is **live and marketed** — "Tagger (Batch)" and "Prosody API (Streaming)" — but:

- **It has no published price.** The only CTA is a sales form.
- `dev.hume.ai/docs/expression-measurement/overview` now **404s**.
- Hume's own docs index (`dev.hume.ai/llms.txt`) lists Voice, TTS, EVI, Integrations —
  **no expression-measurement section**.
- The billing doc lists metered products as *"TTS, EVI, and Voice features"* — expression
  measurement is **not on the billed list**.
- The old self-serve rate ($0.0639/min audio-only) survives **only on third-party sites**.
  Multiple third parties report a **May/June 2026 sunset** of the legacy API.
  **[UNVERIFIED — no Hume-owned page confirms either the rate or the sunset dates.]**

**Practical consequence:** the "keep Hume for Gauge only" plan has **no known price**.
Troy would have to talk to Hume sales before anyone can cost it.

### ElevenLabs — [elevenlabs.io/pricing/agents](https://elevenlabs.io/pricing/agents)

| Tier | Monthly | Agent minutes | Overage $/min |
|---|---|---|---|
| Free | $0 | 15 | $0.08 |
| Starter | $6 | 75 | $0.08 |
| Creator | $22 | 275 | $0.08 |
| Pro | $99 | 1,238 | $0.08 |
| Scale | $299 | 3,738 | $0.08 |
| Business | $990 | 12,375 | $0.08 |

Plus: **the LLM is billed separately** — *"The LLM model and any telephony are billed
separately on top, based on usage."* Knowledge base and RAG carry **no separate charge**.
Burst (over concurrency) is $0.160/min. Annual billing = 2 months free.

**I do not know which tier Troy is on** — that requires his dashboard or an invoice.
The tier is the single biggest input to "what is he spending," so this plan gives
break-even points instead of a spend figure.

---

## 3. Thinking Buddy — what it actually is

**Confirmed: `C:\Users\troyh\n8n_Pod_Uploader_jarvis\jarvis` IS Thinking Buddy.**
Not the memory vault.

- `index.html:776-777` — `STORAGE_KEY = 'thinkbuddy_user_v1'`, `HISTORY_KEY = 'thinkbuddy_history_v1'`
- `docs/persistent-memory-spec-2026-05-27.md:1` — "# Thinking Buddy — Persistent Memory Architecture"
- `scribe/DEPLOY_INSTRUCTIONS.md:85` — deploys to the **`thinkbuddy` Vercel project**
- `scripts/setup-postcall-webhook-and-rename.mjs:41` — agent PATCHed to `name: 'ThinkinBuddy'`
- Historical name "Jarvis" is all over the tree (`create-agent.js:3`) — same app, renamed

**What it calls:**

| Piece | Cite | Detail |
|---|---|---|
| Agent | `script.js:3` | `agent_4401kqcb0w2dey28c69zhchv7ayn` |
| SDK | `package.json` deps | `@elevenlabs/client ^1.7.0` |
| Session start | `script.js:121-122` | `Conversation.startSession({ agentId: AGENT_ID, ... })` |
| Widget path | `index.html:542, 1237` | `elevenlabs.io/convai-widget/index.js`, `<elevenlabs-convai>` element |
| Separate plain TTS | `api/speak.js` | `POST /v1/text-to-speech/nPczCjzI2devNBz1zQrb`, `model_id: 'eleven_turbo_v2'`, stability 0.5 / similarity 0.8 |
| Original agent config | `create-agent.js:32-36` | voice `nPczCjzI2devNBz1zQrb`, `eleven_turbo_v2`, `llm: "claude-3-5-sonnet"`, temp 0.7 |
| Post-call webhook | `setup-postcall-webhook-and-rename.mjs:24` | HMAC → `jarvis-troy.vercel.app/api/conversation-webhook` |
| Memory tool | `update-agent-config.mjs:36` | `tool_5501kt5r8fqyf3xssf9xw0v3fw3y` — a **webhook tool** with `api_schema` calling **his own Vercel API** |
| Storage | `package.json` (`pg`), `api/memory.js`, `scripts/setup-memory-db.mjs` | **Postgres — his own database** |

**🔴 Important correction to the premise.** The brief says ElevenLabs "holds his knowledge
base, system prompts and tool definitions — his curriculum brain."

Two of those three are **already outside ElevenLabs**:

- **Memory/knowledge lives in HIS Postgres**, reached by ElevenLabs webhook tools that call
  his own API (`update-agent-config.mjs:68-102`, `api/memory.js`, `api/recall-memory.js`).
  **grep found zero `knowledge_base` references in the codebase.** He is not using
  ElevenLabs' native RAG knowledge base at all — he built his own memory layer.
- **Tool definitions are webhook tools pointing at his own endpoints.** Portable by
  construction — the schemas describe HIS API.
- **Only the system prompt and voice settings are genuinely vendor-side**, and both come
  out cleanly via `GET /v1/convai/agents/{agent_id}`
  ([docs](https://elevenlabs.io/docs/api-reference/agents/get)).

**Migration risk is therefore much lower than assumed.** The one real gap: if any
curriculum was uploaded as PDF/DOCX to an ElevenLabs knowledge base, the API returns
`extracted_inner_html`, **not the original binary**
([docs](https://elevenlabs.io/docs/api-reference/knowledge-base/get-document)).
Since he appears not to use their KB, this probably does not bite — but it should be
confirmed with one API call before any migration.

---

## 4. 🔴 The emotion-scoring gap — the decisive finding

**There is no open-source replacement for Hume's expression measurement that is honest
to ship in a driver-safety context. The gap is not small, and it is not an engineering
problem you can grind through.**

The numbers that settle it:

| Evidence | Result | Source |
|---|---|---|
| HuggingFace SER model cards | 78–82% accuracy | On **acted** corpora (IEMOCAP, RAVDESS — paid actors performing emotions in a quiet booth) |
| Odyssey 2024 SER Challenge, **naturalistic** speech (MSP-Podcast, 8 classes) — **winner of the entire international field** | **Macro-F1 35.69%, accuracy 37.32%** | [arXiv:2405.20064](https://arxiv.org/abs/2405.20064) |
| INTERSPEECH 2011 Sleepiness Sub-Challenge (**binary**, real sleep-deprived speakers) — winner of 18 teams | **UAR 71.7%** (chance = 50%) | ISCA archive |
| INTERSPEECH 2019 ComParE Continuous Sleepiness — winner | **Spearman ρ = 0.387** (~15% of variance) | [ISCA](https://www.isca-archive.org/interspeech_2019/schuller19_interspeech.html) |

Fifteen years of dedicated academic effort with purpose-built corpora put the
fatigue-from-voice ceiling at **ρ ≈ 0.39**. The literature is explicit that acted-corpus
numbers *"lead to overestimation of actual performance"* and that performance
*"decreases dramatically cross-corpora."*

**Licenses kill most of the survivors anyway:**

| Tool | License | Verdict |
|---|---|---|
| SpeechBrain wav2vec2-IEMOCAP | Apache-2.0 ✓ | Usable, narrow, acted-data trained |
| emotion2vec+ large | Repo MIT, **HF card says `license: other`** (FunASR) | ⚠ Ambiguous — needs a lawyer, and publishes no accuracy numbers |
| audeering wav2vec2 dimensional SER | 🔴 **CC-BY-NC-SA-4.0, research only** | Cannot ship |
| openSMILE / eGeMAPS | 🔴 **Paid audEERING license for commercial** | Cannot ship free |

**And the legal landmine:** EU AI Act Article 5, in force since **2025-02-02**, prohibits
AI systems that infer emotions of a natural person **in the workplace** — fines to
**€35 M or 7% of global turnover**. A truck cab is a workplace. There is a narrow
medical/safety carve-out that a genuine fatigue system might qualify for, but
*"scoring anger, anxiety and stress from prosody"* is squarely the banned thing.

**The honest framing:** Hume is a better-calibrated instrument for measuring something
that is not quite the thing anyone wants to know. Hume itself concedes in its own docs
that expressions *"are not straightforward signals of emotions"* and that detecting
emotions is *"an impossible form of mind-reading."* The open models measure the same
not-the-thing, with less calibration, on narrower data, with worse licenses.

**What Troy can honestly build instead** (free, explainable, defensible in a deposition):
speaking rate, pause duration, response latency and disfluency rate — all derivable from
Whisper/Parakeet timestamps he already produces (`gaugeContext.tsx:394` already runs the
transcription) — measured as **deviation from that specific driver's own baseline**, and
surfaced as *"You sound different than usual — want to take ten?"* rather than
*"Fatigue score 0.73, pull over."* Hours-of-service and ELD stay the primary signals.

---

## 5. TABLE A — Cora (DairyForge driver app, runs on an Android phone)

| Option | Free? | Runs on phone? | Latency (end-of-speech → audio) | What he loses | Monthly cost |
|---|---|---|---|---|---|
| **Keep Hume EVI (today)** | No | Yes (thin client) | ~60 s forced reconnects; per-turn OK | Nothing | $70–200/mo at Pro/Scale + $0.04–0.06/min overage |
| **LiveKit Agents + commercial models** (server) | Framework yes (Apache-2.0) | Yes — first-party RN + Expo SDK | **0.7–1.1 s**; +60–100 ms cellular | **All prosody/fatigue scoring** | $32/mo Fly CPU + per-minute STT/LLM/TTS |
| **LiveKit/Pipecat + all-open models** (Parakeet + Qwen3-4B + Kokoro on a GPU box) | Yes, models free | Yes (thin client) | **~1 s median** (Modal, measured) | All prosody; some TTS naturalness | **~$200/mo** GPU box (Hetzner GEX44 €184, currently out of stock) |
| **Pipecat + commercial models** | Framework yes (BSD-2, cleanest license) | Yes, but RN transports less mature; free transport is "demo-grade" per own docs | 800–950 ms typical | All prosody | $32/mo CPU + per-minute |
| **Everything on-device (whisper.rn + Kokoro + on-device LLM)** | Yes | 🔴 **Not the full loop** | n/a | Prosody, plus tool-calling reliability | $0, but see below |
| **Moshi / full-duplex speech-to-speech** | 🔴 **Not viable** | No | n/a | n/a | Needs 16–24 GB GPU |
| **Ultravox** | MIT ✓ | No | ~150 ms TTFT | 🔴 **Outputs TEXT ONLY — it is not speech-to-speech**, it replaces the STT half | ~17 GB fp16 |

**Why "everything on-device" fails today, concretely:** no orchestration layer exists on
a phone — Pipecat and LiveKit Agents are Python **server** processes, so the VAD /
turn-taking / barge-in / tool-calling state machine would be written from scratch. Add
thermal throttling on a windshield mount in summer (Llama 3.2 3B peaks 37.58 tok/s
*then throttles*), Kokoro's 833 MB resident on Android, and a 2–4B model's tool-calling
reliability against 75 DOT-critical tools. The components exist and are good
(`whisper.rn` MIT, pushed 2026-07-24; `react-native-executorch` MIT, pushed 2026-07-29;
Silero VAD MIT, ~1 ms/chunk) — the **loop** does not.

**Truck-cab noise, called out because it will matter more than 100 ms of latency:**
LiveKit's Krisp BVC is the best answer and is **LiveKit-Cloud-only and paid from
2026-05-01**. Self-hosted alternative is DTLN (MIT) or RNNoise. Budget engineering time.

**License traps found (most comparison articles miss these):**

- **TEN Framework** — Apache-2.0 **with additional restrictions**: *"You may not (i) host
  the TEN Framework ... on any End User devices, including but not limited to any mobile
  terminal devices."* 🔴 Fatal for a phone app.
- **Gabber** — Sustainable Use License, non-commercial. 🔴 Fatal.
- **LiveKit turn-detector model** — framework is Apache-2.0, but the model forbids use
  *"with any frameworks other than LiveKit Agents."* Commercial use OK; you just can't
  lift it out later. Pipecat's Smart Turn v3.2 is BSD-2 with no strings.
- **Vocode** — MIT but **effectively dead**: last push 2024-11-15, README asks for maintainers.
- **Piper TTS** — 🔴 **flipped MIT → GPL-3.0** (Oct 2025, `OHF-Voice/piper1-gpl`). Copyleft
  risk in a closed app. **Kokoro (Apache-2.0) has no such problem — use Kokoro, not Piper.**
- **XTTS-v2 / Coqui** — 🔴 CPML **non-commercial**, and Coqui Inc. dissolved Jan 2024, so
  there is nobody left to sell the commercial license. Unlicensable.
- **Moonshine** — English models MIT ✓, but **non-English models are non-commercial with a
  $1M-revenue termination clause.** Fine for English-only freight; not for Spanish.
- **NVIDIA Parakeet TDT / Canary-1b-v2** — CC-BY-4.0, commercial use explicitly OK ✓.
  Parakeet at ~1.4 GB fp16 is the best accuracy-per-VRAM available.

---

## 6. TABLE B — Thinking Buddy (browser/PWA, desktop and phone, not safety-critical)

| Option | Free? | Runs on phone? | Latency | What he loses | Monthly cost |
|---|---|---|---|---|---|
| **Keep ElevenLabs ConvAI (today)** | No | Yes (web widget) | Good | Nothing | Tier ($6–299) + separate LLM bill |
| **LiveKit Agents + Whisper/Kokoro on his own PC** | **Yes** | Yes (browser client) | ~1 s | ElevenLabs voice quality (Kokoro is very close — #1 on TTS Arena Jan 2026) | **$0** — fits in 6 GiB with ~4 GiB spare |
| **LiveKit/Pipecat + commercial STT/TTS** | Framework yes | Yes | 0.7–1.1 s | Nothing meaningful | $32/mo CPU + usage |
| **Keep ElevenLabs TTS only, self-host the rest** | Partly | Yes | ~1 s | Nothing | TTS credits only |
| **Everything on-device in the browser** | Yes | Marginal | Poor | Quality | $0 |

**This is the easy one, and it is the one to do first.** Thinking Buddy is not
safety-critical, it has no prosody dependency, its memory already lives in his Postgres,
and its tools are webhook calls to his own API. The whole stack —
**Silero VAD + Parakeet or faster-whisper + Kokoro** — is **under 2 GiB VRAM**, leaving
~4 GiB free on the card he already owns. Same Whisper + Kokoro pieces he just proved
in Helmion.

---

## 7. TABLE C — What he pays now vs each option

| Scenario | Cora | Thinking Buddy | Total/mo | Note |
|---|---|---|---|---|
| **Today** | Hume $70–200 + overage | ElevenLabs $6–299 + LLM | **~$76–500** | Exact tiers unconfirmed — needs his invoices |
| **Cora stays, TB self-hosted** | Hume $70–200 | **$0** | **$70–200** | Zero new hardware, zero risk to Gauge |
| **Both on a self-hosted GPU box** | ~$200 GPU box | shares the box | **~$200** | 🔴 Loses all fatigue scoring |
| **Both on framework + commercial models** | $32 CPU + usage | shares | **~$32 + usage** | 🔴 Loses fatigue scoring; may not beat Hume |
| **Cora keeps Hume for Gauge only + open Cora voice** | Hume prosody **(price unknown)** + $200 box | $0 | **unknown + $200** | 🔴 **Cannot be costed** — Hume won't publish the number |

**Break-even math, stated plainly:** a self-hosted GPU box is ~$200/mo. Hume Pro is
$70/mo for 1,200 minutes. **Self-hosting Cora only saves money above roughly 3,300
EVI minutes/month (~55 hours of driver conversation), and even then it costs the
fatigue scoring.** For Thinking Buddy the math is opposite: it runs free on hardware
Troy already owns, so every dollar saved is real.

### The GPU question, since it will come up

Do **not** buy a GPU for full-duplex. Moshi's own project says 24 GB and states PyTorch
quantization is unsupported; a user with an **8 GiB RTX 4060** hit CUDA OOM on the q8
build ([moshi#125](https://github.com/kyutai-labs/moshi/issues/125)) — consistent with
the 14.32 GiB measured on Troy's box. **12 GB is not the entry point; 16 GB is.** The
cheapest card that clears it is an **RTX 4060 Ti 16 GB at ~$270 used** — and Moshi is
the only thing waiting on the other side. A 2026 DRAM supercycle has pushed mid-range
GPUs up 10–25%. **Renting beats buying:** RunPod RTX 3090 $0.46/hr, RTX 4090 $0.34/hr —
a $270 card is ~790 hours of a 4090.

Also worth knowing: **Fly.io GPUs are deprecated and unavailable after August 1, 2026**
([fly.io docs](https://fly.io/docs/gpus/gpu-quickstart/)). Any older plan assuming Fly
GPU is dead.

---

## 8. RECOMMENDATIONS

### Cora → **KEEP PAYING HUME. Do not replace it.**

Three independent reasons, any one of which is sufficient:

1. **Cora's socket IS Gauge's fatigue pipeline** (`gaugeContext.tsx:330` → `humeClient.ts:3367`).
   Replacing Cora's voice without first building Gauge an independent scoring path
   silently zeroes the safety feature. Silently — there is no error path.
2. **The replacement for the piece he'd keep has no published price.** Hume's standalone
   Prosody API is sales-form-only and the self-serve docs 404. Nobody can cost this plan today.
3. **Nothing open replaces the scoring.** Best-in-field naturalistic SER is 35.69% macro-F1;
   best fatigue-from-voice is ρ = 0.387. Plus an EU AI Act workplace-emotion prohibition
   with €35 M exposure.

Self-hosting Cora would trade a $70–200/mo bill for a ~$200/mo GPU box **and** lose the
one thing Hume is uniquely good at. That is not a saving.

**FIRST CONCRETE STEP:** Email Hume sales via [hume.ai/sales-form](https://www.hume.ai/sales-form)
and ask exactly one question — *"What does the standalone Prosody API (Streaming) cost per
minute, and is the legacy Expression Measurement API sunset?"* Every other decision on this
target is blocked on that number, and it costs one email to unblock.

### Thinking Buddy → **REPLACE IT. It is free, low-risk, and the pieces are already proven.**

No prosody dependency, not safety-critical, memory already in his own Postgres, tools
already webhook calls to his own API. The full local stack fits in under 2 GiB of his
6 GiB card.

**FIRST CONCRETE STEP:** Run one read-only export —
`GET https://api.elevenlabs.io/v1/convai/agents/agent_4401kqcb0w2dey28c69zhchv7ayn`
with his `xi-api-key` — and save the JSON. That captures the system prompt, voice
settings, turn-taking config and tool references in one call, before touching anything.
Also run `GET /v1/convai/knowledge-base` to confirm the (expected) result that he has no
vendor-side knowledge base to migrate.

---

## 9. What I could NOT verify — do not quote these as fact

1. **Cora's actual EVI version, LLM and prompt.** They live in the Hume dashboard config
   `8ef07029-368b-4e6d-9621-2b8defadfea7`, not in the repo (`humeClient.ts:3497-3502`).
   Reading them needs an authenticated `GET /v0/evi/configs/...` call I did not make.
2. **"Sonic 4.6."** Not in the code; not a Hume product name. Almost certainly a
   conflation with Cartesia Sonic. Could conceivably be a config *version* number —
   the scripts do version configs — but I cannot confirm that without dashboard access.
3. **Which tiers Troy is on** at either vendor. Needs his invoices/dashboards. Every
   "what he pays now" figure is therefore a range, not a number.
4. **Hume Expression Measurement pricing and the legacy sunset dates.** No Hume-owned
   page carries either. The circulating $0.0639/min is from third parties citing pages
   that now 404.
5. **Four cells of Hume's own pricing table** read inconsistently across repeated fetches.
6. **Hetzner GPU prices** (€184 GEX44 / €889 GEX131) come from third-party trackers and a
   press release, not a live configurator — and Hetzner raised cloud prices sharply in
   June 2026. Verify before budgeting.
7. **No latency measured on a GTX 1660 Ti specifically** for Kokoro, Parakeet or Whisper.
   All figures are from other hardware. Measure on the box before committing.
8. **emotion2vec+ license is genuinely ambiguous** — MIT badge on GitHub, `license: other`
   (FunASR) on the HF card. Needs a lawyer's read before shipping.
