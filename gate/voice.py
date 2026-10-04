"""Speech to text for the headset.

Quest Browser has no Web Speech API — verified on device: `SpeechRecognition`
is absent, prefixed or not, and so is `speechSynthesis`. What it does have is
`getUserMedia` and `MediaRecorder` with opus/webm. So the viewer records a clip
and uploads it here, and transcription happens server-side.

The key lives in this process, never in the frontend: the headset posts audio to
the gate, the gate talks to OpenAI. That keeps the repo rule about secrets and
means the browser needs no credentials of any kind.

Set `OPENAI_API_KEY` in the environment before starting the gate. Without it the
endpoint returns a clear 503 rather than failing somewhere deeper.
"""

from __future__ import annotations

import os

OPENAI_URL = "https://api.openai.com/v1/audio/transcriptions"
# whisper-1 is the transcription endpoint's model id; gpt-4o-transcribe is the
# newer option on the same route if you want to switch.
MODEL = os.environ.get("WHISPER_MODEL", "whisper-1")
# Short spoken questions only. A long upload means something is wrong with the
# recorder, and it costs real money to find out.
MAX_BYTES = 8 * 1024 * 1024


class TranscriptionError(RuntimeError):
    """Carries an HTTP status so the route can pass it straight through."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def transcribe(audio: bytes, filename: str, language: str | None = None) -> dict:
    """Send one clip to Whisper and return `{text, model, bytes}`."""
    import httpx

    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        raise TranscriptionError(
            503,
            "OPENAI_API_KEY is not set on the gate. Export it and restart, "
            "and keep it out of the frontend.",
        )
    if not audio:
        raise TranscriptionError(400, "empty audio upload")
    if len(audio) > MAX_BYTES:
        raise TranscriptionError(413, f"audio larger than {MAX_BYTES // 1024 // 1024} MB")

    data = {"model": MODEL}
    if language:
        data["language"] = language

    try:
        response = httpx.post(
            OPENAI_URL,
            headers={"Authorization": f"Bearer {key}"},
            files={"file": (filename or "speech.webm", audio, "audio/webm")},
            data=data,
            timeout=60,
        )
    except Exception as exc:  # noqa: BLE001
        raise TranscriptionError(502, f"could not reach OpenAI: {exc}") from exc

    if response.status_code != 200:
        # Pass the provider's own message through: "invalid api key" is far more
        # useful to see in the headset than a generic failure.
        detail = response.text[:300]
        raise TranscriptionError(response.status_code, f"transcription failed: {detail}")

    body = response.json()
    return {
        "text": (body.get("text") or "").strip(),
        "model": MODEL,
        "bytes": len(audio),
    }


def configured() -> bool:
    return bool(os.environ.get("OPENAI_API_KEY", "").strip())
