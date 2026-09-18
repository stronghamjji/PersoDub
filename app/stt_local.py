"""Local Whisper STT (no-API-key fallback, no container dependency).

Subprocess bridge to app/scripts/whisper_transcribe.py -- the app's own Python
3.8 venv doesn't have faster-whisper/ctranslate2 installed, so transcription
runs as a separate process under STT_PYTHON (a dedicated venv), same
"subprocess into a heavier venv, parse its JSON" convention app/qwen_scoring.py
uses for the take scorer.

Unlike qwen_scoring.score_takes() (which degrades to None on failure so a dub
job can keep going without best-of-N), transcribe_local() RAISES on any
failure. It has no fallback of its own -- it IS the last fallback (see
app/docs/INTEGRATION_SPEC.md) -- so the caller must decide what happens next.
"""
import json
import os
import subprocess
import tempfile
from typing import Callable, List, Optional

from app.run_errors import describe_exit_failure, describe_start_failure

# Dedicated venv with faster-whisper installed (see app/docs/INTEGRATION_SPEC.md
# for how it was set up). Override with STT_PYTHON for a different interpreter
# (see env.server.example for this server's actual path).
STT_PYTHON = os.environ.get("STT_PYTHON", "python3")

SCRIPT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts", "whisper_transcribe.py")

# Per-second-of-video timeout budget, env-overridable the way
# app/diar_campplus_client.py's PERSODUB_DIAR_TIMEOUT already is. Same
# reasoning as app/separate.py's SEP_TIMEOUT_PER_SEC: 0.32x realtime measured
# on an M4 Mac, ~10x slower on a CPU-only Windows laptop (~3.2x realtime),
# doubled again for headroom -> ~6x realtime.
try:
    STT_TIMEOUT_PER_SEC = float(os.environ.get("PERSODUB_STT_TIMEOUT_PER_SEC", "6"))
except (TypeError, ValueError):
    STT_TIMEOUT_PER_SEC = 6.0
# Upper cap so a genuinely stuck subprocess still gets killed instead of
# hanging for a day.
try:
    STT_TIMEOUT_CAP = float(os.environ.get("PERSODUB_STT_TIMEOUT_CAP", "10800"))
except (TypeError, ValueError):
    STT_TIMEOUT_CAP = 10800.0


def stt_timeout(video_duration: Optional[float], default: float = 900) -> float:
    """The transcription subprocess ceiling for a video this long -- `default`
    (today's fixed value) when the duration is unknown, otherwise the
    length-scaled budget, never below `default` and never above STT_TIMEOUT_CAP."""
    if not video_duration or video_duration <= 0:
        return default
    return min(max(default, video_duration * STT_TIMEOUT_PER_SEC), STT_TIMEOUT_CAP)


def transcribe_local(
    audio_path: str,
    language: Optional[str] = None,
    word_timestamps: bool = False,
    timeout: int = 900,
    log: Optional[Callable[[str], None]] = None,
    on_language: Optional[Callable[[str], None]] = None,
    video_duration: Optional[float] = None,
) -> List[dict]:
    """Transcribe audio_path with local Whisper. Returns a list of cues in the
    same shape the pipeline expects everywhere else: [{"start": float,
    "end": float, "text": str}, ...] (see app/srt_utils.Cue).

    Raises RuntimeError (with a clear message) on any failure: missing
    interpreter/script, subprocess crash/timeout, non-zero exit, bad JSON
    output, or the worker itself reporting an error. Never returns partial
    results.

    When no language hint was given, whisper_transcribe.py's auto-detected
    source language is reported to `log` (if given) as one line -- otherwise
    it would just be discarded.
    """
    if not os.path.exists(audio_path):
        raise RuntimeError("audio file not found: %s" % audio_path)
    if not (os.path.exists(STT_PYTHON) and os.access(STT_PYTHON, os.X_OK)):
        raise RuntimeError("local STT interpreter not found: %s" % STT_PYTHON)
    if not os.path.exists(SCRIPT_PATH):
        raise RuntimeError("local STT script missing: %s" % SCRIPT_PATH)

    # video_duration, when known, scales the timeout up for long videos (see
    # stt_timeout above); omitted, it's today's fixed `timeout`.
    effective_timeout = stt_timeout(video_duration, default=timeout)

    with tempfile.TemporaryDirectory() as tmp_dir:
        out_path = os.path.join(tmp_dir, "whisper_output.json")
        cmd = [STT_PYTHON, SCRIPT_PATH, "--audio", audio_path, "--output", out_path]
        if language:
            cmd += ["--language", language]
        if word_timestamps:
            cmd += ["--word-timestamps"]

        try:
            r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                               timeout=effective_timeout)
        except Exception as e:
            raise RuntimeError(describe_start_failure("local STT", e, effective_timeout)) from e

        if r.returncode != 0 or not os.path.exists(out_path):
            raise RuntimeError(describe_exit_failure("local STT", r))

        try:
            with open(out_path, encoding="utf-8") as f:
                result = json.load(f)
        except Exception as e:
            raise RuntimeError("local STT produced invalid output (%s)" % str(e)[:200]) from e

    if not result.get("ok"):
        raise RuntimeError("local STT reported an error (%s)" % str(result.get("error"))[:300])

    if not language:
        detected = result.get("language")
        if detected:
            if log:
                log("   detected source language: %s" % detected)
            if on_language:
                on_language(detected)

    segments = result.get("segments")
    if not segments:
        raise RuntimeError("local STT produced no segments")
    return segments
