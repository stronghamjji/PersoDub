"""Subprocess bridge to app/scripts/roformer_separate.py (Mel-Band RoFormer,
when its weights are downloaded) or app/scripts/demucs_separate.py (local
htdemucs, otherwise): vocals/background separation. The app's own Python 3.8
venv has neither torch nor demucs, so separation runs as a separate process
under SEP_PYTHON (config.py) --
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
from app.run_errors import PartsMissing, describe_exit_failure, describe_start_failure
from app.timeouts import scaled_timeout

SCRIPT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts", "demucs_separate.py")
ROFORMER_SCRIPT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts", "roformer_separate.py")
ROFORMER_MODEL_ID = "vocal-separator"
# Two passes of the RoFormer took about five times as long as Demucs on an M4
# Mac's CPU (2026-10-02); its ceiling grows by more, for slower machines.
ROFORMER_SLOWER = 8


def roformer_model_path() -> Optional[str]:
    """The RoFormer weights when their download is complete on this kit, else
    None -- and then Demucs separates, as before the model existed."""
    from app import models as model_store
    entry = model_store.find(ROFORMER_MODEL_ID)
    kit = model_store.kit_dir()
    if not (entry and kit) or model_store.model_state(entry, kit) != "ready":
        return None
    return os.path.join(kit, *entry["dir"].split("/"), entry["markers"][0])


class SeparationEngine:
    """Local separation socket: separate(path, out_dir) -> {"vocals", "background"}."""

    def __init__(self, python_path: Optional[str] = None, model_dir: Optional[str] = None,
                timeout: int = 900, video_duration: Optional[float] = None,
                roformer_path: Optional[str] = None):
        self.python_path = python_path or SEP_PYTHON
        self.model_dir = model_dir or SEP_MODEL_DIR
        # The RoFormer when its weights are here (cleaner: no original voice
        # left in the background), else Demucs.
        self.roformer_path = roformer_path or roformer_model_path()
        self.name = "RoFormer" if self.roformer_path else "Demucs"
        # The weights file, for the log: which RoFormer checkpoint ran, or
        # Demucs's one model.
        self.model_file = os.path.basename(self.roformer_path) if self.roformer_path else "htdemucs"
        # video_duration, when known, scales `timeout` up for long videos
        # (see app.timeouts.scaled_timeout); omitted, it's today's fixed value.
        if self.roformer_path:
            timeout *= ROFORMER_SLOWER
            video_duration = video_duration and video_duration * ROFORMER_SLOWER
        self.timeout = scaled_timeout(video_duration, timeout)

    def separate(self, video_or_audio_path: str, out_dir: str) -> Dict[str, str]:
        """Run local separation (RoFormer, or Demucs) on one video/audio file.

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
            raise PartsMissing("local separation interpreter not found (%s)" % py)
        script = ROFORMER_SCRIPT_PATH if self.roformer_path else SCRIPT_PATH
        if not os.path.exists(script):
            raise PartsMissing("local separation script missing (%s)" % script)

        os.makedirs(out_dir, exist_ok=True)
        in_path = os.path.join(out_dir, "sep_input.json")
        out_path = os.path.join(out_dir, "sep_output.json")
        payload = {"input": video_or_audio_path, "out_dir": out_dir, "model_dir": self.model_dir}
        if self.roformer_path:
            payload["model_path"] = self.roformer_path
        with open(in_path, "w", encoding="utf-8") as f:
            json.dump(payload, f)

        try:
            r = subprocess.run(
                [py, script, "--input", in_path, "--output", out_path],
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
