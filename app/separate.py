"""Subprocess bridge to app/scripts/demucs_separate.py (local htdemucs vocals/
background separation). The app's own Python 3.8 venv has neither torch nor
demucs, so separation runs as a separate process under SEP_PYTHON (config.py) --
the same subprocess-bridge shape as app/qwen_scoring.py (score_takes /
QWEN_SCORER_PYTHON), just for Demucs instead of the take scorer.

The app's only separation path (app/pipeline.py) -- no container, no fallback.

Unlike qwen_scoring.score_takes (which degrades to None on failure so the
caller can fall back silently mid-function), SeparationEngine.separate()
raises RuntimeError on any failure. app/pipeline.py catches it at the call
site and fails the whole job with a clear error -- there is nothing left to
silently fall back to.
"""
import json
import os
import shutil
import subprocess
from typing import Dict, Optional

from app.config import SEP_MODEL_DIR, SEP_PYTHON
from app.run_errors import describe_exit_failure, describe_start_failure

SCRIPT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts", "demucs_separate.py")

# Per-second-of-video timeout budget, env-overridable the way
# app/diar_campplus_client.py's PERSODUB_DIAR_TIMEOUT already is. Measured
# 2026-09-18 on an M4 Mac: separating a 31s clip took 10s (0.32x realtime). A
# CPU-only Windows laptop can run roughly 10x slower than this Mac, i.e.
# ~3.2x realtime worst case; doubled again for headroom (older/busier
# machines, disk contention) gives ~6x realtime as the budget below.
try:
    SEP_TIMEOUT_PER_SEC = float(os.environ.get("PERSODUB_SEP_TIMEOUT_PER_SEC", "6"))
except (TypeError, ValueError):
    SEP_TIMEOUT_PER_SEC = 6.0
# Upper cap so a genuinely stuck subprocess still gets killed instead of
# hanging for a day.
try:
    SEP_TIMEOUT_CAP = float(os.environ.get("PERSODUB_SEP_TIMEOUT_CAP", "10800"))
except (TypeError, ValueError):
    SEP_TIMEOUT_CAP = 10800.0


def separation_timeout(video_duration: Optional[float], default: float = 900) -> float:
    """The separation subprocess ceiling for a video this long.

    `default` (today's fixed value) when the duration is unknown, so a failed
    ffprobe or an untouched caller behaves exactly as before. Otherwise the
    length-scaled budget, but never below `default` (short videos are
    unaffected) and never above SEP_TIMEOUT_CAP.
    """
    if not video_duration or video_duration <= 0:
        return default
    return min(max(default, video_duration * SEP_TIMEOUT_PER_SEC), SEP_TIMEOUT_CAP)


class SeparationEngine:
    """Local Demucs separation socket: separate(path, out_dir) -> {"vocals", "background"}."""

    def __init__(self, python_path: Optional[str] = None, model_dir: Optional[str] = None,
                timeout: int = 900, video_duration: Optional[float] = None):
        self.python_path = python_path or SEP_PYTHON
        self.model_dir = model_dir or SEP_MODEL_DIR
        # video_duration, when known, scales the timeout up for long videos
        # (see separation_timeout above); omitted, it's today's fixed `timeout`.
        self.timeout = separation_timeout(video_duration, default=timeout)

    def separate(self, video_or_audio_path: str, out_dir: str) -> Dict[str, str]:
        """Run local Demucs separation on one video/audio file.

        Returns {"vocals": path, "background": path} (both 48kHz wav files
        written into out_dir). Raises RuntimeError on any failure (missing
        interpreter/script, subprocess crash/timeout, bad JSON, or the
        separator itself reporting ok=false) -- never returns a partial
        result, so the caller's fallback logic can rely on all-or-nothing.
        """
        py = self.python_path
        if os.sep not in py:
            # bare command name (e.g. the "python3" default) -- resolve via PATH
            py = shutil.which(py) or py
        if not (os.path.exists(py) and os.access(py, os.X_OK)):
            raise RuntimeError("local separation interpreter not found (%s)" % py)
        if not os.path.exists(SCRIPT_PATH):
            raise RuntimeError("local separation script missing (%s)" % SCRIPT_PATH)

        os.makedirs(out_dir, exist_ok=True)
        in_path = os.path.join(out_dir, "sep_input.json")
        out_path = os.path.join(out_dir, "sep_output.json")
        payload = {"input": video_or_audio_path, "out_dir": out_dir, "model_dir": self.model_dir}
        with open(in_path, "w", encoding="utf-8") as f:
            json.dump(payload, f)

        try:
            r = subprocess.run(
                [py, SCRIPT_PATH, "--input", in_path, "--output", out_path],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=self.timeout,
            )
        except Exception as e:
            raise RuntimeError(describe_start_failure("local separation", e, self.timeout))

        if r.returncode != 0 or not os.path.exists(out_path):
            raise RuntimeError(describe_exit_failure("local separation", r))
        try:
            with open(out_path, encoding="utf-8") as f:
                result = json.load(f)
        except Exception as e:
            raise RuntimeError("local separation produced invalid output (%s)" % str(e)[:120])
        if not result.get("ok"):
            raise RuntimeError("local separation reported an error (%s)" % str(result.get("error"))[:200])
        return {"vocals": result["vocals"], "background": result["background"]}
