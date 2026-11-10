#!/usr/bin/env python3
"""Helmian served TTS (lag bite 1, 2026-11-10).

Server-side Kokoro synthesis for Helmian voice chat. The browser tab
no longer synthesizes speech on its own CPU (q8 WASM inference in the
tab was the freeze behind Chrome's "page unresponsive" dialog); it
POSTs one sentence-sized chunk at a time here and only plays the WAV
that comes back, through its one ordered playback queue
(web/shared/voice-dictation.mjs, served engine).

Road: Caddy (voice.5-78-222-178.sslip.io) -> 127.0.0.1:8795 -> here.
Same sslip.io + Caddy pattern as the Executive Guard feed receiver.

Design points that matter:
- ONE synthesis at a time. A single lock serializes every generate:
  Kokoro on CPU is thread-hungry, and ten chunks racing on the box
  would be slower for the first chunk than a strict queue. Requests
  are answered in arrival order; the tab keeps at most one request
  outstanding beyond the chunk it is playing.
- Disk cache keyed by sha256(voice + text): repeated chunks (seat
  catchphrases, replays) are served without synthesis.
- Fail closed: the service refuses to start without VOICE_TTS_TOKEN,
  and every /tts call must carry it as a Bearer token (compared in
  constant time). The token is never logged.
- Bounded inputs: JSON body <= 16 KB, text <= 400 chars (the tab
  chunks at 180), voice must be a voice the model actually ships.

Env:
  VOICE_TTS_TOKEN   required, the bearer token (never printed)
  VOICE_TTS_PORT    default 8795 (binds 127.0.0.1 only)
  VOICE_TTS_MODEL   default /opt/helmian-voice-tts/models/kokoro-v1.0.int8.onnx
  VOICE_TTS_VOICES  default /opt/helmian-voice-tts/models/voices-v1.0.bin
  VOICE_TTS_CACHE   default /opt/helmian-voice-tts/cache
  VOICE_TTS_ORIGIN  CORS allow-origin, default https://helmian.cloud
"""
import hashlib
import hmac
import io
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import soundfile as sf

PORT = int(os.environ.get("VOICE_TTS_PORT", "8795"))
MODEL_PATH = os.environ.get(
    "VOICE_TTS_MODEL", "/opt/helmian-voice-tts/models/kokoro-v1.0.int8.onnx"
)
VOICES_PATH = os.environ.get(
    "VOICE_TTS_VOICES", "/opt/helmian-voice-tts/models/voices-v1.0.bin"
)
CACHE_DIR = os.environ.get("VOICE_TTS_CACHE", "/opt/helmian-voice-tts/cache")
ALLOW_ORIGIN = os.environ.get("VOICE_TTS_ORIGIN", "https://helmian.cloud")
TOKEN = os.environ.get("VOICE_TTS_TOKEN", "")
SAMPLE_RATE = 24000
MAX_BODY_BYTES = 16 * 1024
MAX_TEXT_CHARS = 400
VOICE_RE = re.compile(r"^[a-z]{2}_[a-z]+$")

_kokoro = None
_kokoro_voices = None
_synth_lock = threading.Lock()


def log(*args):
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} [voice-tts]", *args, flush=True)


def load_engine():
    """Load the Kokoro model once per process (takes seconds)."""
    global _kokoro, _kokoro_voices
    if _kokoro is None:
        from kokoro_onnx import Kokoro

        _kokoro = Kokoro(MODEL_PATH, VOICES_PATH)
        try:
            _kokoro_voices = set(_kokoro.get_voices())
        except Exception:
            _kokoro_voices = None
    return _kokoro


def synthesize_wav(text, voice):
    """One chunk -> WAV bytes. Serialized: one generate at a time."""
    with _synth_lock:
        kokoro = load_engine()
        samples, sr = kokoro.create(text, voice=voice, speed=1.0, lang="en-us")
        if sr != SAMPLE_RATE:
            raise RuntimeError(f"unexpected sample rate {sr}")
        buf = io.BytesIO()
        sf.write(buf, np.asarray(samples, dtype=np.float32), SAMPLE_RATE, format="WAV")
        return buf.getvalue()


def cache_path(text, voice):
    key = hashlib.sha256(f"{voice}\n{text}".encode("utf-8")).hexdigest()
    return os.path.join(CACHE_DIR, f"{key}.wav")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep the journal clean; log() above is ours
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", ALLOW_ORIGIN)
        self.send_header("Vary", "Origin")

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        return hmac.compare_digest(header[len("Bearer "):], TOKEN)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type, authorization")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {
                "ok": True,
                "engineLoaded": _kokoro is not None,
                "queueWaiting": _synth_lock.locked(),
            })
            return
        self._send_json(404, {"ok": False, "code": "NOT_FOUND"})

    def do_POST(self):
        if self.path != "/tts":
            self._send_json(404, {"ok": False, "code": "NOT_FOUND"})
            return
        if not self._authorized():
            self._send_json(401, {"ok": False, "code": "UNAUTHORIZED"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            self._send_json(413, {"ok": False, "code": "BODY_TOO_LARGE"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            self._send_json(400, {"ok": False, "code": "BAD_JSON"})
            return
        text = str(payload.get("text", "")).strip()
        voice = str(payload.get("voice", "af_heart")).strip()
        if not text or len(text) > MAX_TEXT_CHARS:
            self._send_json(400, {"ok": False, "code": "TEXT_OUT_OF_BOUNDS"})
            return
        if not VOICE_RE.match(voice) or (_kokoro_voices is not None and voice not in _kokoro_voices):
            self._send_json(400, {"ok": False, "code": "VOICE_UNKNOWN"})
            return
        started = time.time()
        try:
            path = cache_path(text, voice)
            cached = os.path.exists(path)
            if cached:
                with open(path, "rb") as fh:
                    wav = fh.read()
            else:
                wav = synthesize_wav(text, voice)
                os.makedirs(CACHE_DIR, exist_ok=True)
                tmp = f"{path}.tmp-{os.getpid()}"
                with open(tmp, "wb") as fh:
                    fh.write(wav)
                os.replace(tmp, path)
        except Exception as err:  # synthesis failed: the tab falls back to its in-tab engines
            log(f"synth failed voice={voice} chars={len(text)}: {type(err).__name__}: {str(err)[:200]}")
            self._send_json(500, {"ok": False, "code": "SYNTH_FAILED"})
            return
        ms = int((time.time() - started) * 1000)
        log(f"tts voice={voice} chars={len(text)} ms={ms} cached={cached} bytes={len(wav)}")
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.send_header("X-Voice-Tts-Ms", str(ms))
        self.send_header("X-Voice-Tts-Cache", "hit" if cached else "miss")
        self._cors()
        self.end_headers()
        self.wfile.write(wav)


def main():
    if not TOKEN:
        print("fatal: VOICE_TTS_TOKEN is not set; refusing to start unauthenticated", file=sys.stderr)
        return 1
    if not os.path.exists(MODEL_PATH) or not os.path.exists(VOICES_PATH):
        print(f"fatal: model files missing (model={MODEL_PATH} voices={VOICES_PATH})", file=sys.stderr)
        return 1
    os.makedirs(CACHE_DIR, exist_ok=True)
    t0 = time.time()
    load_engine()
    log(f"engine loaded in {time.time() - t0:.1f}s; listening on 127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
