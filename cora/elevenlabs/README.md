# Cora on ElevenLabs Agents (shared config)

Step 1 of the Hume → ElevenLabs migration: Cora's prompt, voice and tools live in git, not a vendor dashboard.

- `agent.json`: agent id (not secret), voice Matilda (`XrExE9yKIg1WjnnlVkGX`), LLM `claude-sonnet-4-6` (ElevenLabs built-in for now; later `custom-llm` → Helmian Cloud).
- `prompts/dairyforge-driver.md`: Cora persona + guardrails, ported from `DAIRYFORGE_SYSTEM_PROMPT` in troy83352/gauge-sandbox `lib/humeClient.ts` (the code-side canonical copy of the Hume dashboard prompt; the dashboard version itself was never exported).
- `tools.json`: 27 tools ported 1:1 (same names + JSON-schema params) from gauge-sandbox `DAIRYFORGE_TOOLS`. Registered as **client tools** so the app's `voiceIntent.ts` executors stay unchanged. `routing`/`requires_approval` mark the ones that must go through server/Helmian approval (dispatch_command, confirm_reroute, accept_delivery, sign_out_for_day; plus server reads/records).
- `scripts/sync-elevenlabs-agent.mjs`: upserts tools by name and creates/PATCHes the agent. `ELEVENLABS_API_KEY=... node cora/elevenlabs/scripts/sync-elevenlabs-agent.mjs` (`--dry-run` to check). Never deletes, generates no speech.

Next: freight/AimForge tool sets (69/78) tagged by vertical, token + post-call routes in dairyforge, Custom LLM endpoint in Helmian.
