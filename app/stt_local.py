"""Local Whisper STT (no-API-key fallback, no OmniVoice container dependency).

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

# Dedicated venv with faster-whisper installed (see app/docs/INTEGRATION_SPEC.md
# for how it was set up). Override with STT_PYTHON for a different interpreter
# (see env.server.example for this server's actual path).
STT_PYTHON = os.environ.get("STT_PYTHON", "python3")

SCRIPT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts", "whisper_transcribe.py")


def transcribe_local(
    audio_path: str,
    language: Optional[str] = None,
    word_timestamps: bool = False,
    timeout: int = 900,
    log: Optional[Callable[[str], None]] = None,
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

    with tempfile.TemporaryDirectory() as tmp_dir:
        out_path = os.path.join(tmp_dir, "whisper_output.json")
        cmd = [STT_PYTHON, SCRIPT_PATH, "--audio", audio_path, "--output", out_path]
        if language:
            cmd += ["--language", language]
        if word_timestamps:
            cmd += ["--word-timestamps"]

        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        except Exception as e:
            raise RuntimeError("local STT failed to run (%s)" % str(e)[:200]) from e

        if r.returncode != 0 or not os.path.exists(out_path):
            raise RuntimeError(
                "local STT exited with an error (%s)"
                % (r.stderr.strip()[-300:] or "no output produced")
            )

        try:
            with open(out_path, encoding="utf-8") as f:
                result = json.load(f)
        except Exception as e:
            raise RuntimeError("local STT produced invalid output (%s)" % str(e)[:200]) from e

    if not result.get("ok"):
        raise RuntimeError("local STT reported an error (%s)" % str(result.get("error"))[:300])

    if not language and log:
        detected = result.get("language")
        if detected:
            log("   detected source language: %s" % detected)

    segments = result.get("segments")
    if not segments:
        raise RuntimeError("local STT produced no segments")
    return segments
