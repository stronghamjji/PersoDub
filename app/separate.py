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

SCRIPT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts", "demucs_separate.py")


class SeparationEngine:
    """Local Demucs separation socket: separate(path, out_dir) -> {"vocals", "background"}."""

    def __init__(self, python_path: Optional[str] = None, model_dir: Optional[str] = None,
                timeout: int = 900):
        self.python_path = python_path or SEP_PYTHON
        self.model_dir = model_dir or SEP_MODEL_DIR
        self.timeout = timeout

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
                capture_output=True, text=True, timeout=self.timeout,
            )
        except Exception as e:
            raise RuntimeError("local separation failed to run (%s)" % str(e)[:120])

        if r.returncode != 0 or not os.path.exists(out_path):
            raise RuntimeError(
                "local separation exited with an error (%s)"
                % (r.stderr.strip()[-200:] or "no output produced"))
        try:
            with open(out_path, encoding="utf-8") as f:
                result = json.load(f)
        except Exception as e:
            raise RuntimeError("local separation produced invalid output (%s)" % str(e)[:120])
        if not result.get("ok"):
            raise RuntimeError("local separation reported an error (%s)" % str(result.get("error"))[:200])
        return {"vocals": result["vocals"], "background": result["background"]}
