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

**Confirmed: `C:\Users\<you>\n8n_Pod_Uploader_jarvis\jarvis` IS Thinking Buddy.**
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

---
---

# DEEP PASS 2026-07-29

**Author:** agent-AG-cora-gauge-deep. **Status:** READ-ONLY. Nothing built, installed,
deployed or configured. No Hume API key and no ElevenLabs API key was used.

**Method:** every claim in the plan above was treated as `[UNVERIFIED]` and re-checked
against the primary source THIS session. Where the prior pass was right, I say so and
cite the line I read. Where it was wrong, I cite the line that disproves it.

**Correction to this document's own header:** line 5 states the GTX 1660 Ti is
"Turing — no bf16, no FP8." **The no-bf16 half is measurably false on this box.**
agent-M3 recorded `torch.cuda.is_bf16_supported() = True` on this exact card and ran a
bf16 matmul (checksum 262144.0) — see the agent-M3-moshi-silent row in
`E:\Helmion\SESSION_BOARD.md`. Moshi's real blocker is PCIe spill bandwidth after a
WDDM system-RAM spill, not dtype support. Do not repeat the bf16 claim.

---

## D0. THE HEADLINE CORRECTION — Gauge's fatigue scoring is already near-zero while driving

The prior pass's section 0 chain is **correct line for line**. I read every cite myself:

| Stage | Cite | Verified text |
|---|---|---|
| Gauge registers its scorer | `gaugeContext.tsx:330` | `setOnHumeScores(handleHumeScores);` OK |
| Gauge opens no socket | `gaugeContext.tsx:336-364` | `// 2026-07-26 — GAUGE NO LONGER OWNS THE SOCKET OR THE MIC.` OK |
| Resume opens no socket | `gaugeContext.tsx:469-474` | resume no longer calls `connectToHume()`/`startHumeMicBridge()` OK |
| Scores gated to speech | `humeClient.ts:3286` | `if (message?.type !== "user_message") return;` OK |
| Prosody parsed | `humeClient.ts:3346` | `const raw = message?.models?.prosody?.scores;` OK |
| Delivered to Gauge | `humeClient.ts:3367` | `if (state.onScores) state.onScores(scores);` OK |
| Tripwire | `humeClient.ts:70-72, 74-80` | tiredness>0.85 FATIGUE; anger>0.8 or anxiety>0.85 HIGH_AROUSAL OK |
| Alert POSTed | `gaugeContext.tsx:238-258, 262-299` | `evaluateTripwire` then `postFatigueAlert` to `/api/safety/fatigue-alert` OK |

**But the prior pass stopped one file too early.** It cited `coraSession.ts:58-72` as
"socket OPEN in exactly two states" and moved on without drawing the consequence.

`coraSession.ts:40-59` — the state machine, read this session:

```
        sign in                pre-trip complete
   S0 ---------> S1 ONBOARDING ---------------> S2 DORMANT
   SIGNED_OUT     (socket OPEN)                 (socket CLOSED)
                  mic: Cora                     mic: wake listener
                  wake: OFF                     wake: ARMED
                                                   |      ^
                                         wake word |      | ~2 min idle
                                                   v      |
                                               S3 ACTIVE -+
                                               (socket OPEN)
```

`coraSession.ts:96` — `export const IDLE_TIMEOUT_MS = 120_000;`

Now compose that with `humeClient.ts:3286`. A prosody score reaches Gauge only when
**both** are true at once:

1. Cora is in ONBOARDING or ACTIVE (the only two states holding a socket), **and**
2. the driver is *actively speaking to Cora* (scores ride `user_message` only).

DORMANT is "the rest of the shift" (`coraSession.ts:72`). ACTIVE self-terminates after
**2 minutes** of idle. So for the hours a driver actually spends driving, **Gauge
receives exactly zero fatigue scores — not degraded, zero.**

The code says so itself, and treats it as a feature. `coraSession.ts:61-66`:

> **COST NOTE (why closing the socket is free)** ... prosody/fatigue scores arrive ONLY on
> driver speech. An open socket during silence emits nothing at all while still burning
> uplink, battery, and Hume ingest. So dropping to DORMANT costs ZERO fatigue data.

**Why this matters more than anything else in this document:** the prior pass made
"replacing Cora silently zeroes Gauge's fatigue scoring" its single decisive argument
(sections 0 and 8 reason 1). That sentence is **literally true and materially misleading.**
What exists today is a **pre-trip and short-task sampler**, not a continuous in-cab
fatigue monitor. The migration risk to the safety feature is therefore far smaller than
the prior pass argued — and, separately, **Troy should know this regardless of any vendor
decision**, because it is a gap between what "Gauge fatigue monitoring" sounds like and
what it does.

The recommendation below still lands on "keep Hume," but **for different reasons**, and
this argument should be struck from the reasoning.

---

## D1. What else Hume actually holds — verified surface

**75 tools: CONFIRMED.** A name-grep over `lib/humeClient.ts` returns **75**, and
`DAIRYFORGE_TOOLS` closes at `:2485`. The prior pass's `:209-2474` range is right.

**NEW — the 75 tools in code are NOT proven to be the tools live in Hume.**
Two in-repo audit artefacts say the live config state is unprovable:

- `CORA_TRACE_FULL_2026-06-12.json:841-845` — *"Tool-promotion drift: promote script is
  UNTRACKED, written for 66 tools, manifest is now 75 — live config 8ef07029 state
  unprovable from the repo."*
- `CORA_PUNCHLIST_2026-06-12.json:385-393` — same finding; notes at least 6 tools
  (including `locate_truck`, **demoed to DFA**) landed after the last recorded promote run.
- `KORA_VOICE_FLOW_MAP.md:9` records the manifest at **66** entries at that date. Today
  it is **75**. The growth is real; the promotion of that growth is not evidenced.

For a migration this is *good* news — every JSON Schema is in git, nothing is trapped
vendor-side. But it means **nobody can currently state what Cora can do in the field**
without reading the dashboard.

**Config delivery — one prior finding is now FIXED, one is still open.**
`eas.json` today carries `EXPO_PUBLIC_HUME_CONFIG_ID` in **all four** build profiles:
preview `:17`, demo `:31`, test `:43`, production `:55`. The 06-12 trace doc claiming
production/test ship tools-OFF is **stale — that was fixed.**

Still open and uncited-as-fixed: `CORA_TRACE_FULL_2026-06-12.json:779-790` — `eas.json`
`build.env` applies only to `eas build`. `HUME_CONFIG_ID` is read at module scope
(`humeClient.ts:3492`) and inlined by Metro at bundle time, so **an `eas update` from a
shell lacking the var ships a bundle with `TOOLS_ENABLED = false` and all 75 tools gone,
with no error anywhere** (`humeClient.ts:3493`, `:3510`). I found no wrapper script
guarding this.

**The model / "Sonic 4.6" question — the repo genuinely cannot answer it, and here is why.**
`scripts/_fix_voice_and_ticket.mjs:41` posts `evi_version: cur.evi_version` — it
**preserves** whatever the config already had rather than setting one. So no script in
the tree ever pins an EVI version. Combined with `humeClient.ts:3497-3502` (the dashboard
config is *"the single source of truth for Kora's prompt"*, client-side `system_prompt`
deliberately dropped), the EVI version, LLM and prompt are **dashboard-only**.
The prior pass's `[UNVERIFIED]` stamp stands and is now explained rather than merely asserted.

**Citation errors in the prior pass** (small, but they are the kind that propagate):
its `_fix_voice_and_ticket.mjs:6,7` cite is wrong. Actual: `:10`
(`const NEW_VOICE = "Warm Female Assistant Voice";`) and `:43`
(`voice: { provider: "HUME_AI", name: NEW_VOICE }`).

**NEW — an unresolved late-night experiment is still shipping on the mic path.**
`humeMicBridge.ts:81-83`:

```ts
const AUDIO_SOURCE_VOICE_COMMUNICATION = 7;
const AUDIO_SOURCE_VOICE_PERFORMANCE = 10;
const HUME_MIC_AUDIO_SOURCE = AUDIO_SOURCE_VOICE_PERFORMANCE;
```

The soak history at `:65-75` records `6 -> 7 -> 10`, ending:

> *2026-05-24 late night (this commit): trying VOICE_PERFORMANCE (=10) to push clipping
> further down. ... Risk: the more-aggressive AEC could over-process and degrade
> transcription quality (Kora hearing the driver worse). **If so, revert to 7 in one
> commit** — both constants kept for easy A/B.*

**There is no later note in the file recording how that A/B came out.** It has been the
shipping mic source since 2026-05-24.

The comment justifying the switch (`:62-63`) says VOICE_PERFORMANCE is *"near-field comms
with optimized echo cancellation per AudioSource docs. More aggressive AEC than =7."*
I could not reproduce that wording from any Android reference. The AOSP javadoc mirror I
could reach describes **VOICE_PERFORMANCE as a live-performance / karaoke path** — a
*minimal-processing, low-latency* capture route — while **VOICE_COMMUNICATION (7) is the
one where AEC is CDD-required.** If that is right, the 2026-05-24 change moved the mic
*off* the only source guaranteed to give echo cancellation, in a cab with a loudspeaker
playing Cora's own TTS back into it.

**STAMP: [SUSPECT], not [VERIFIED].** `developer.android.com` is JS-rendered and
returned only navigation chrome on three separate fetch attempts, so my source is the
Microsoft .NET-for-Android mirror of the javadoc, which is **secondary**. This is a
**flag for a one-device A/B**, not a proven defect. It is cheap to settle: flip the
constant at `:83` to `AUDIO_SOURCE_VOICE_COMMUNICATION` and have Troy talk to Cora on
speaker. The code was already written to make that a one-line change.

**Everything else in the prior pass's section 1a parity table I spot-checked held**,
including the assistant-voice gate (`:2550`, `:3275-3277`, `:3294-3313`), address regex
(`:2555`), follow-up window 12 s (`:2565-2572`), filler and deflection suppression
(`:2579-2580`, `:2589-2590`), TTS-span mic gate (`:2604`, `:2637-2641`), 400 ms post-TTS
holdoff (`:2613-2620`), chunk pre-loading (`:2673-2767`), ~60 s forced reconnect ladder
(`:3107-3154`), and the anti-hallucination prompt with its *"EVI exposes no
tool_choice / strict_mode knob"* note (`:146`, `:156-195`).

---

## D2. Pricing — corrected against vendor-owned pages

The prior pass flagged "four cells that read inconsistently across three fetches" and
treated Hume's pricing page as unreliable. **That was reader error, not vendor
instability.** Six fetches of the same page, via distinct URL forms, returned a stable
table. Two specific causes: the cell format is `"5,000 minutes ($0.05/minute)"` — the
overage rate sits *inline* with the included minutes, so a scanner grabs an adjacent
tier's number; and the `$200 / 5,000 = $0.04` arithmetic is invalid because $200 also
buys 3,300,000 TTS characters.

**Hume — [hume.ai/pricing](https://www.hume.ai/pricing), stable across 6 reads**

| Tier | Monthly | EVI min | Overage $/min | TTS chars | Concurrent |
|---|---|---|---|---|---|
| Free | $0 | 5 | $0.06 | 10,000 | 1 |
| Starter | $3 | 40 | **$0.07** | 30,000 | 5 |
| Creator | **$14 recurring** ($7 1st month only) | 200 | **$0.07** | 140,000 | 5 |
| Pro | $70 | 1,200 | $0.06 | 1,000,000 | 10 |
| Scale | $200 | 5,000 | **$0.05** | 3,300,000 | 20 |
| Business | $500 | 12,500 | $0.04 | 10,000,000 | 30 |

**Creator is $14/mo, not $7.** The $7 carries an explicit "1st month 50% off" badge.
The prior pass's "$7 or $14" resolves to $14.

**BYO-LLM confirmed verbatim** — [dev.hume.ai/docs/resources/billing](https://dev.hume.ai/docs/resources/billing):
> *"If you use your own LLM API key or a custom language model, Hume does not charge for that LLM usage."*

**Expression Measurement — the prior pass's section 2 finding is CONFIRMED and now stronger.**
No published price exists on any Hume-owned domain; the only CTA is a sales form.
Four developer URLs 404 today (`/docs/expression-measurement/overview`, `/faq`,
`/models/prosody`, `/docs/expression-measurement-api/overview`). It is absent from
[dev.hume.ai/llms.txt](https://dev.hume.ai/llms.txt), absent from `dev.hume.ai/intro`
(which lists only EVI, TTS, Voice), and absent from the billing page's metered list
(*"Text-to-Speech (TTS), Speech-to-Speech (EVI), and Voice features"*). It is still
listed on [hume.ai/products](https://www.hume.ai/products) with no deprecation language.

**Provenance warning the prior pass should have carried:** the circulating
$0.0639/min rate and the May/June 2026 sunset dates come **only from third parties, and
the two loudest sources — audEERING and Imentiv — are competitors selling replacement
products.** Search snippets attribute the sunset text to `dev.hume.ai` pages that 404
when actually fetched; that is a stale crawl index, not vendor confirmation.
`dev.hume.ai/changelog` has no sunset entry. Wayback was unreachable from this harness.

**ElevenLabs — [elevenlabs.io/pricing/agents](https://elevenlabs.io/pricing/agents)**

Prior pass's table is correct on minutes and the flat **$0.080/min** overage. Additions:
burst is **$0.160/min**; concurrency runs 4/6/10/20/30/40 by tier; LLM-billed-separately
and annual-equals-2-months-free both confirmed verbatim; RAG carries no fee **but the
index is tier-capped** (Free 1 MB up to Business/Enterprise 1 GB), and sub-500-byte
documents fall back into the prompt where they consume billed LLM tokens.

**NEW, and the prior pass missed it — ElevenLabs' free tier forbids commercial use.**
[Terms of Use section 1(c)](https://elevenlabs.io/terms-of-use):
> *"if you access or use our Services free of charge ... you may only use the Services for
> **non-commercial purposes**"*

The cheapest commercially-licensed Agents tier is **Starter $6/mo**. Any "$0 ElevenLabs"
option is off the table for a business product.

---

## D3. Licenses — corrections that matter legally

The prior pass's license work was mostly right. Confirmed verbatim against LICENSE files
and model cards: **TEN**'s End-User-device ban, **Gabber**'s Sustainable Use License,
**XTTS/Coqui** CPML non-commercial plus no surviving counterparty to sell a commercial
licence, **audeering** CC-BY-NC-SA-4.0 research-only, **openSMILE**'s paid-commercial
requirement, **Moonshine**'s non-English NC plus $1M revenue-termination clause,
**Kokoro** Apache-2.0, **Parakeet/Canary** CC-BY-4.0 commercial-OK, **LiveKit
turn-detector**'s framework lock, and **Ultravox outputs TEXT ONLY**
(`pipeline_tag: audio-text-to-text`; audio generation is stated future work).

**Corrections:**

| Prior claim | Verdict | Proof |
|---|---|---|
| emotion2vec: "GitHub says MIT, HF card says other — ambiguous" | **WORSE THAN STATED.** There is **no LICENSE file at all** — repo root holds only `.gitignore` and `README.md`; GitHub API returns `spdx_id: null`. The "MIT" is a badge with nothing behind it. Unlicensed means all rights reserved | `api.github.com/repos/ddlBoJack/emotion2vec` and `/contents/` |
| Piper "flipped MIT to GPL-3.0 Oct 2025" | **Right in substance, wrong on mechanism.** `OHF-Voice/piper1-gpl` was **created 2025-03-28 already GPL-3.0**. October was when `rhasspy/piper` was **archived** (`archived: true`, last push 2025-08-26). The old MIT grant is irrevocable but frozen. **Piper voices are MIT either way** | both repos via GitHub API |
| Vocode "README asks for maintainers" | **Not verified — likely confused with Piper.** That text is in `piper1-gpl`'s README. The 2024-11-15 last-push date is correct | `raw.githubusercontent.com/OHF-Voice/piper1-gpl/main/README.md` |
| Moshi "needs 16-24 GB" | **Confirmed** (README: *"a GPU with a significant amount of memory (24GB)"*; issue #125 = 8 GB RTX 4060 OOM). But see the header correction — on *this* box the int8 alloc succeeded via WDDM spill; the blocker is PCIe bandwidth, not refusal | README plus kyutai-labs/moshi#125 plus agent-M3 measurement |

**Two new legal exposures the prior pass did not raise:**

1. **Kokoro's G2P dependency chain.** The weights are cleanly Apache-2.0, but the
   phonemizer it calls at runtime is commonly **espeak-ng (GPL-family)**. For an APK that
   bundles it, *that dependency* — not the model — is where a copyleft problem lives.
   Unverified; verify before shipping.
2. **Ultravox and Orpheus are Llama derivatives** (Llama-3.1-8B-Instruct and Llama-3.2
   bases) while declaring MIT / Apache-2.0. **Meta's Llama Community License terms
   plausibly flow through regardless of the publisher's tag** — the 700M-MAU clause, the
   "Built with Llama" attribution and the naming requirement. Needs counsel before a
   closed-source commercial ship.

**Cleanest closed-source stack from everything checked:** Pipecat (BSD-2) + Smart Turn v3
(BSD-2) + faster-whisper (MIT) or Parakeet v3 (CC-BY-4.0) + Silero VAD (MIT) + Kokoro
(Apache-2.0) or Chatterbox (MIT). Attribution only, no copyleft, no NC.

---

## D4. On-device reality — this is where the "$0 on the phone" story dies

The prior pass concluded on-device fails because "no orchestration layer exists on a
phone." **That specific claim is now out of date, and the real blockers are different
and harder.**

**An on-device orchestrator does exist:** `soniqo/speech-android`, **Apache-2.0**,
v0.0.9 (7 Jul 2026), ~51 stars — Silero VAD to Parakeet-EOU STT to FunctionGemma 270M
tool calls to TTS, with a genuine `Idle -> Listening -> Transcribing -> Speaking` state
machine, working barge-in (*"speaking during TTS playback interrupts and starts a new
transcription"*), and DeepFilterNet3 noise cancellation at ~8 MB. **No wake word.** Every
published benchmark is on a Galaxy S23 Ultra. Treat it as a reference implementation to
study, **not a dependency to ship on** at v0.0.x.

**The blockers that actually kill it:**

| Blocker | Number | Consequence |
|---|---|---|
| **Wake word is no longer free** | Porcupine free-tier AccessKeys **stopped working 2026-06-30**; Picovoice: *"There is no non-commercial tier planned."* openWakeWord's code is Apache-2.0 but its **pre-trained models are CC-BY-NC-SA** | The only $0 commercial path is **training your own** with the Apache-2.0 pipeline. gauge-sandbox ships a wake word today (`hey_dairyforge.tflite`), so **any** migration inherits this |
| **On-device tool-calling** | Qwen3-4B BFCL **multi-turn 35.25%**; FunctionGemma 270M out-of-box tool-call equivalence **9.90 / 23.35 / 38.82%**, reaching 90-97% only after fine-tuning on **14** tools | Cora has **75** DOT-critical tools. Nobody has published a 75-tool on-device number. **Not fit for a federal inspection record** |
| **Kokoro on Android** | **RTF 1.13** (EN v0.19) to **2.42** (int8 v1.1) on a Galaxy S10 — *slower than real time*. 0.75-0.88 short-turn even on an S23 Ultra | Kokoro is fine on the desktop GPU, **not viable on a mid-range phone**. Its Apache-2.0 licence was never the problem |
| **Thermals** | ~12-15 tok/s for a 3B Q4 on a Pixel 8; throttling *"after 60-90 seconds of continuous generation"*, *"token rates can drop 40-60%"* | Derived sustained approx **5-9 tok/s**, worse in a windshield mount in summer sun. **No published measurement exists** under solar load |

**Two prior-pass numbers were misattributed across platforms:** the "Kokoro ~833 MB
resident on Android" figure is an **iOS** measurement, and "Llama 3.2 3B peaks 37.58
tok/s then throttles" is an **iPhone** measurement. The Android comparables are ~604 MB
(S23 Ultra) and ~12-15 tok/s (Pixel 8).

**The free answer the prior pass never mentioned: Android's built-in system TTS.**
In the same benchmark that put Kokoro at RTF 1.13, Android system TTS scored **440 ms
synthesis, RTF 0.058, 21 MB** — 17x faster than real time and the best result in the
field, with downloadable offline voice packs. Piper via sherpa-onnx (RTF 0.077) is the
upgrade path if a distinct voice identity matters.

**Noise beats latency, and it is not close.** Whisper WER by SNR: **0.36 at +5 dB,
0.57 at 0 dB, 0.86 at -5 dB.** A diesel cab is the worst case (stationary hum masking
low frequencies *plus* non-stationary road/wind/CB). A 36% word error rate is a broken
product no matter how fast it answers. **DeepFilterNet3** is the right free tool
(~40 ms, RTF 0.19 on a laptop CPU, best-in-class on non-stationary noise, already
shipping at ~8 MB inside the Apache-2.0 soniqo SDK).

**Krisp correction:** the prior pass said Krisp BVC is "paid from 2026-05-01." Per
[LiveKit's own pricing](https://livekit.com/pricing.md), Krisp **NC** (noise suppression)
is **free** on all Cloud tiers, and Krisp **BVC** (voice isolation) is **$0.0012/min** —
not $0.002-0.004 — and LiveKit publishes no start date. Both remain **LiveKit-Cloud-only**
(*"These models are not available for self-hosted deployments"*), so neither is a $0
self-hosted option either way.

---

## D5. Self-hosting economics — the prior pass's cost basis has collapsed

**Fly.io GPUs confirmed dead**, quoted verbatim from
[fly.io/docs/gpus/gpu-quickstart](https://fly.io/docs/gpus/gpu-quickstart/):
> **"GPUs are deprecated and will be unavailable after August 1."**

That is **three days from now**.

**The "~$200/mo GPU box" figure is no longer purchasable.** The prior pass built its
entire break-even math on Hetzner GEX44 at EUR 184. That number **is** genuinely
Hetzner's — from their **4 March 2024 press release** — but the box is reported **out of
stock** in July 2026, GEX130 is discontinued, and the live GPU lineup is effectively
**GEX131 at EUR 889/mo**. Hetzner is no longer the cheap self-host answer, which
**invalidates the "self-hosting Cora breaks even above ~3,300 EVI minutes" conclusion in
section 7 above.** Rented 24/7 equivalents: RunPod Community 4090 approx **$248/mo**,
RunPod Secure approx **$504/mo**, Vast.ai typical approx **$212/mo** (spot, no SLA,
15 s reclaim).

**The 1660 Ti genuinely runs the speech stack.** Per
[CTranslate2's own quantization docs](https://opennmt.net/CTranslate2/quantization.html),
`float16` and `int8` require Compute Capability >= 7.0; the 1660 Ti is **CC 7.5**. Only
`bfloat16` requires CC >= 8.0. Budget: faster-whisper `large-v3-turbo` int8 approx 1.6 GB
plus Kokoro approx 1.2 GB plus Silero on CPU (~2 MB) plus CUDA contexts approx
**3.5-4 GB of 6 GiB**. **The LLM is the thing that does not fit** — that is the
architectural fork: this card is a *speech server*, and the LLM lives elsewhere.

---

## D6. Thinking Buddy — the "cheapest win" claim is PARTLY WRONG

**Confirmed, and it is the good news:** grep across the entire tree (all extensions,
including `android/`, `public/`, `.vercel/`, and even `node_modules/@elevenlabs`) returns
**zero** hits for `knowledge_base` / `knowledgeBase` / `knowledge-base` / `rag`. The only
`documentId` hits are the **Google Docs** API (`lib/actionable/docs.js:348-395`),
unrelated. Memory really is **his own Neon Postgres + pgvector** —
`api/memory.js:28` reads `DATABASE_URL_MEMORY || DATABASE_URL`, `:35-40` builds the `pg`
Pool, tables `memory_items` / `conversation_sessions` / `conversation_turns`. Transcripts
are **already** captured live into his DB per turn (`api/conversation-turn.js:38-53`,
called from `index.html:631-646`), independent of the vendor.

**WRONG: "only the system prompt is genuinely vendor-side."** Five separate things are
vendor-side, and one of them is unrecoverable if he cancels:

1. **5 of 6 tool definitions exist ONLY in the ElevenLabs dashboard.**
   `save_memory`, `search_web`, `browse_url`, `generate_image`, `set_alarm` appear in the
   repo **only as prose** in `lib/personality.js:20-28`. Their webhook URLs, JSON schemas
   and IDs are **not committed anywhere**. Only `recall_memory`'s full definition is in
   git (`scripts/update-agent-config.mjs:88` type `webhook`, `:104` URL).
   **Cancel the subscription before exporting these and they are gone.**
2. The prior pass's cite `update-agent-config.mjs:36` is the **`save_memory` tool-ID
   constant**, not a URL.
3. **Live LLM, voice ID, TTS model and temperature are dashboard-only.**
   `create-agent.js` is ~3 months stale (last commit 2026-04-29 vs 2026-07-20 for the
   live config work) and `lib/personality.js:41` **contradicts** it — Multilingual v2
   vs `create-agent.js:30`'s `eleven_turbo_v2`.
4. **The entire call UI is the vendor widget.** `index.html:542` loads
   `elevenlabs.io/convai-widget/index.js`; the app's own orb/status/transcript are
   CSS-hidden in `elevenlabs-mode` (`:271-273`, always applied at `:1242`); and
   `initBrowserVoice()` — the Web Speech fallback — is **defined at `:1312` and never
   called.** There is **no working non-ElevenLabs voice path today.**
   `script.js` (the `@elevenlabs/client` SDK path) is **orphaned** — referenced by no HTML.
5. **Turn detection, VAD, interruption, barge-in, STT and session lifecycle are 100%
   vendor.** Plus `api/extract-memories.js:75` fetches transcripts from
   `api.elevenlabs.io/v1/convai/conversations` and breaks outright on removal, and the
   Android APK bundles the widget (`android/app/src/main/assets/public/index.html:543`)
   so it needs a reship.

**Also worth Troy's attention, found in passing:** the in-repo webhook/tool URLs point at
**`jarvis-troy.vercel.app`** (`update-agent-config.mjs:37`,
`setup-postcall-webhook-and-rename.mjs:24`) while the app is **`thinkinbuddy.vercel.app`**
(`api/mcp.js:3`). Whether those are the same deployment cannot be determined from code.
And `api/speak.js` plus `script.js` are both dead code still shipping in the tree.

**Verdict:** Thinking Buddy is still the better migration candidate than Cora — no
prosody dependency, not safety-critical, memory and transcripts genuinely portable. But
it is **not "cheap" and not zero-risk**: it is a real rebuild of the conversational layer,
and it has an **export deadline** hiding in it.

---

## D7. REVISED RECOMMENDATIONS

### Cora: **KEEP PAYING HUME** — right answer, mostly wrong reasons above

Strike the prior pass's reason 1. "It would zero Gauge's fatigue scoring" overstates a
feature that is **already zero during driving** (`coraSession.ts:43-66` plus
`humeClient.ts:3286`).

The reasons that actually hold:

1. **The on-device replacement cannot do the job.** 75 DOT-critical tools against a
   35.25% multi-turn tool-calling benchmark is not a federal inspection record.
2. **The self-hosted cost basis collapsed.** Hetzner's EUR 184 box is unavailable; the
   live lineup is EUR 889/mo and rented 24/7 GPU is $212-504/mo. Against Hume Pro at
   $70/mo, self-hosting Cora is now **more expensive**, not less — the opposite of
   section 7's conclusion.
3. **Any migration also inherits a wake-word rebuild** that did not exist when the prior
   pass was written (Porcupine free tier died 2026-06-30; openWakeWord's models are NC).
4. The prior pass's SER-accuracy and EU AI Act Article 5 arguments still stand on their own.

**FIRST CONCRETE STEP — cheaper and more decisive than the Hume sales email:**
have Troy run one authenticated `GET /v0/evi/configs/8ef07029-368b-4e6d-9621-2b8defadfea7`
(latest version) and paste the result. That single read answers **three** open questions
at once: the real EVI version and LLM (settling "Sonic 4.6"), whether the LLM is
BYO-key'd (which decides whether the EVI minute rate is the whole bill), and **how many
of the 75 tools are actually promoted** — closing the `CORA_TRACE` 66-vs-75 gap that has
been open since 2026-06-12. The sales-form email about Prosody pricing is worth sending
too, but it only matters if he later decides to split Gauge off.

**Second, unrelated to any vendor decision:** settle the `audioSource` A/B at
`humeMicBridge.ts:83`. It is a one-line flip that has been sitting unresolved since
2026-05-24 on the theory that constant 10 gives *more* AEC than constant 7 — which the
Android docs I could reach contradict.

### Thinking Buddy: **EXPORT FIRST. Do not cancel anything yet.**

**FIRST CONCRETE STEP:** two read-only API calls, saved into the repo —
`GET /v1/convai/agents/agent_4401kqcb0w2dey28c69zhchv7ayn` **and**
`GET /v1/convai/tools`. The second is the one that matters: it is the only copy of five
tool definitions that exist nowhere in git. Until those JSONs are on disk, cancelling
ElevenLabs destroys work that cannot be reconstructed from the repo.

After the export, the migration target is the stack he has already proven in Helmion:
**Pipecat (BSD-2) + Smart Turn v3 (BSD-2) + faster-whisper int8 + Silero VAD (MIT) +
Kokoro (Apache-2.0)** on the 1660 Ti — approx 3.5-4 GB of his 6 GiB, $0/mo hosting.
Note he is on **at least Starter $6/mo** today regardless, because ElevenLabs' free tier
forbids commercial use.

---

## D8. What I could NOT verify this pass

1. **The Android `AudioSource` javadoc for VOICE_PERFORMANCE.** `developer.android.com`
   is JS-rendered and returned only nav chrome on three fetches. My source is a secondary
   mirror. The D1 mic finding is stamped **[SUSPECT]**, not proven.
2. **Cora's live EVI version, LLM, prompt, and promoted tool count.** Dashboard-only by
   construction (`humeClient.ts:3497-3502`, `_fix_voice_and_ticket.mjs:41`). No API key
   was used, per brief.
3. **Hume Expression Measurement pricing and the legacy sunset dates.** No Hume-owned
   page carries either; Wayback was unreachable from this harness.
4. **Which tiers Troy is on** at either vendor. Still needs his invoices.
5. **Whether the 5 dashboard-only Thinking Buddy tools still exist** — that is exactly
   what the D7 export call is for.
6. **Kokoro's espeak-ng/G2P licence**, and **Llama flow-through for Ultravox/Orpheus.**
7. **No latency measured on a GTX 1660 Ti specifically** — unchanged from the prior pass.
8. **No published whisper.cpp RTF on any mid-range Snapdragon**, no sustained
   post-throttle Android tok/s, and no on-device end-to-end cascaded voice latency
   measurement exists anywhere. Do not let anyone fill those with a guess.
