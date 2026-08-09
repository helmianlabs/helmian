# Helmian voice punch list (Whisper + Kokoro)

**Deep dive date:** 2026-08-02  
**Verified this session:**

| Test | Result |
|---|---|
| `helmion-voice probe` | models present, TTS ready, mic K66 |
| `helmion-voice selftest` | **PASS** — Kokoro → WAV → Whisper match |
| Pack models beside `Helmian.exe` | ggml-base.en, kokoro.onnx, voices, espeak, runtimes |
| Smoke suite (Voice* included in desktop suite) | suite green |

CLI path is healthy. “Wonky” is mostly **desktop UX / cold start / status lies / half-duplex lag**.

---

## S — Small (polish, ship this week)

| # | Task | Description / fix |
|---|---|---|
| S1 | **Prefer Whisper+Kokoro** | Stop defaulting preferred=Moshi when Moshi is not installed. Status no longer says “fallback / Moshi missing” on every start. **Done this session.** |
| S2 | **Warm Whisper + Kokoro on engine construct** | Load ggml/ONNX in background so first Voice/Dictate click is not multi-second freeze. **Done this session.** |
| S3 | **Status strip only for voice errors** | No more `[Voice warning]` walls in the Maestro transcript. **Done this session.** |
| S4 | **Honest start failure text** | “models or Moshi” → real selector detail (mic privacy, missing models). **Done this session.** |
| S5 | **Vocabulary prompt expand** | Add Room, Herald, Ably, Guard, Cora, Brandon so Whisper less often mangles product names. **Done this session.** |
| S6 | **Ship script always copies models** | `publish.ps1` already copies `desktop/models` — gate ship on `get-voice-models.ps1` when sizes wrong. **Process.** |
| S7 | **UI: voice pill always visible** | Show `voice: Whisper+Kokoro active` / `off` / `degraded` next to composer; amber when degraded. **Done 2026-08-02** — `ConsoleVoicePill` + status strip. |
| S8 | **Dictate vs Voice tooltips** | Short: Dictate = type only; Voice = hear + speak replies. Remove long tooltips that clip. **Done 2026-08-02**. |
| S9 | **Selftest in pack smoke** | After publish, run `helmion-voice selftest` (or pack-side equivalent) exit 0 before calling ship done. |
| S10 | **Default mic label in status** | On start, status: `Listening · Microphone (K66)` so wrong device is obvious. |

---

## M — Medium (feel + reliability)

| # | Task | Description / fix |
|---|---|---|
| M1 | **Endpointing tune** | `EndSilenceMs=420` can cut short or feel laggy. A/B 350 vs 550 with Troy; optional “talk speed” setting. |
| M2 | **Mic device picker** | WaveIn uses Windows default only. Settings: list NAudio devices, save preferred device id. |
| M3 | **AGC / noise floor** | Loud rooms trip VAD; quiet mics need higher margin. Expose SpeechMarginDb or auto-calibrate 1s of room tone on start. |
| M4 | **Partial captions** | Show “…” while utterance open so user knows mic heard something before final Whisper line. |
| M5 | **Agent-reply TTS path audit** | Trace every completion → `SpeakAsync` when Voice mode on; ensure ResumeListening after empty TTS / chat failure. |
| M6 | **Half-duplex gap** | After Kokoro ends, 100–200 ms pad before unpausing mic so speaker tail is not re-transcribed. |
| M7 | **Dictate reserved phrases** | Verify “send it / scratch that / new line / stop dictation” on live mic; document in Help. |
| M8 | **Composer focus** | On final transcript, focus input without stealing if user is mid-type on another field. |
| M9 | **Native DLL probe** | On start, if Whisper native load fails, status names `runtimes\win-x64\whisper.dll` path — not generic “unavailable”. |
| M10 | **Publish pack voice matrix** | Checklist: models, voices, espeak, runtimes, onnxruntime.dll sizes match expected. |

---

## L — Large (architecture / product)

| # | Task | Description / fix |
|---|---|---|
| L1 | **Streaming STT** | Partial Whisper / whisper streaming so long turns update live instead of silence then dump. |
| L2 | **GPU / accelerate path** | Optional CUDA/OpenVINO Whisper for lower latency on capable machines; keep CPU default. |
| L3 | **Moshi optional install** | Real duplex only when VRAM + host present; wizard “Install full duplex?” — never prefer dead Moshi. |
| L4 | **Speech floor for desktop** | Port Voice.Host SpeechFloor so console TTS cannot be re-heard even if pause fails. |
| L5 | **Converse mode in desktop** | Continuous conversation (host already has `converse`) inside Maestro without press-per-turn. |
| L6 | **Per-project vocabulary** | Load project terms from PROJECT.md into Whisper prompt so customer names stick. |
| L7 | **Voice accessibility pack** | Larger buttons, always-on captions, keyboard-only Dictate toggle. |
| L8 | **Telemetry (local)** | Count cold-start ms, utterance ms, selftest pass — no cloud; operator QA only. |

---

## Immediate operator checklist (when it feels wonky)

1. Windows **Settings → Privacy → Microphone → Desktop apps on**.  
2. Default input = headset/K66 (not “Stereo Mix”).  
3. Run pilot from pack that has `models\` next to `Helmian.exe`.  
4. Click **Dictate** once, wait ~2s for warmup, then speak a short phrase.  
5. CLI proof:  
   `E:\Helmion\desktop\Helmion.Voice.Host\bin\Release\net10.0-windows\helmion-voice.exe selftest`  
   must print `round trip : PASS`.

---

## Done this session (code)

- Prefer `VoiceBackend.WhisperKokoro` in `MainWindow` selector (no Moshi).  
- Whisper `Warmup()` + engine background load.  
- Vocabulary + status-message cleanups.  
- Models/voices/espeak/runtimes on pack.  
- **Latency pack 02s:** EndSilence 420→280 ms, faster onset, Kokoro speed 1.12, TTS max 420 chars, skip audio re-probe every speak, 80 ms post-TTS pad. Selftest still PASS.
