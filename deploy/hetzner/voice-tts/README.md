# Helmian served TTS — deploy notes (lag bite 1, STAGED, not deployed)

Server-side Kokoro synthesis for Helmian voice chat. The tab fetches
one sentence-sized chunk at a time from this service and only plays
the WAV back (see the served engine in `web/shared/voice-dictation.mjs`
and its inline copy in `web/marketing/app/app.js`).

## Files here

- `voice-tts-server.py` — the service (stdlib HTTP + kokoro-onnx,
  one synthesis at a time, disk cache, bearer token, fail closed).
- `helmian-voice-tts.service` — systemd unit.
- `Caddyfile.voice-tts.txt` — the vhost to append on the box.
- `requirements.txt` — the Python deps for the service venv.

## Deploy steps (parent runs these; the bite staged everything)

1. On the Hetzner box (5.78.222.178):
   - `mkdir -p /opt/helmian-voice-tts/models /opt/helmian-voice-tts/cache`
   - Copy `voice-tts-server.py`, `requirements.txt`, and
     `helmian-voice-tts.service` (to `/etc/systemd/system/`) up.
   - Model files: `kokoro-v1.0.int8.onnx` (92,361,271 bytes, sha-named
     `kokoro-v1.0.int8.onnx`) and `voices-v1.0.bin` (26,124,436 bytes) —
     the same int8 model + voices the local Kokoro connector uses
     (`~/workspace/custom-connectors/custom.kokoro/models/` on the
     Muse VM). Copy them into `/opt/helmian-voice-tts/models/`.
     Do NOT use `/srv/probe/kokoro-model/` on the box: the 2026-11-10
     probe found it holds only the 19 voice `.bin` files (9.6 MB) and
     no model weights.
   - `python3 -m venv /opt/helmian-voice-tts/venv && /opt/helmian-voice-tts/venv/bin/pip install -r /opt/helmian-voice-tts/requirements.txt`
2. Token: generate one high-entropy token on the box. Put it in
   `/opt/helmian-voice-tts/voice-tts.env` (mode 600) as
   `VOICE_TTS_TOKEN=<token>` — and set the SAME value as
   `SERVED_TTS_TOKEN` in `web/marketing/app/app.js` AND
   `web/shared/voice-dictation.mjs` in the web deploy. The token value
   must never be printed in a report or commit message. (An empty
   token in the tab disables the served road; the service refuses to
   start without one.)
3. `systemctl daemon-reload && systemctl enable --now helmian-voice-tts`
   then append the Caddy vhost and `systemctl reload caddy`.
4. Smoke, from the box: `curl -s http://127.0.0.1:8795/health` and a
   timed authorized POST of one ~150-char chunk to
   `https://voice.5-78-222-178.sslip.io/tts`; record the
   `X-Voice-Tts-Ms` header and the WAV duration. The reply must be a
   valid WAV at 24 kHz.

## Threat model (bite 1, named)

The bearer token ships in the signed-in Helmian app bundle, so it is
a workspace-member credential, not a public secret: worst case abuse
is a member synthesizing <=400-char WAVs, rate-bounded by the single
synthesis lock and the disk cache. Signed per-session audio URLs via
the admin API are the bite-2 hardening; do not widen this service's
inputs before that lands.
