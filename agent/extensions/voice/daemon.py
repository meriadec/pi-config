# /// script
# requires-python = ">=3.10"
# dependencies = ["faster-whisper", "av>=14,<17"]
# ///
"""Long-lived faster-whisper worker. Protocol: one JSON object per line.

stdout -> {"ready": true} once, then {"id": N, "text": "..."} or {"id": N, "error": "..."}
stdin  <- {"id": N, "wav": "/path/in.wav"}
Everything else (logs, download progress) goes to stderr.
"""
import json
import os
import sys

from faster_whisper import WhisperModel

model = WhisperModel(
    os.environ.get("PI_VOICE_MODEL", "small"),
    device="cpu",
    compute_type="int8",
)
language = os.environ.get("PI_VOICE_LANG") or None


def reply(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


reply({"ready": True})
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    try:
        segments, _ = model.transcribe(req["wav"], language=language, vad_filter=True)
        reply({"id": req["id"], "text": " ".join(s.text.strip() for s in segments).strip()})
    except Exception as exc:  # noqa: BLE001 - report any failure to the client
        reply({"id": req["id"], "error": str(exc)})
