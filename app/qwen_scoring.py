"""Subprocess bridge to app/scripts/qwen_score_takes.py (the CAM++/whisper take
scorer). The app's own Python 3.8 venv has neither onnxruntime nor torch, so
scoring runs as a separate process under QWEN_SCORER_PYTHON (config.py) --
same "run a heavy tool in its own process, parse its JSON" convention
app/quality.py uses, just with a local venv interpreter instead of a container.

Graceful degradation is the whole point of this module: any failure (missing
interpreter, missing script, subprocess crash/timeout, bad JSON, or the
scorer itself reporting ok=false) returns None instead of raising, so
app/qwen_pipeline.synth_lines can fall back to single-take behavior and the
dub job still completes.

Input JSON handed to the scorer:
  {"language": "ko", "speakers": {spk: ref_wav_path, ...},
   "lines": [{"i": int, "spk": str, "usable": float, "text": str,
              "takes": [{"k": int, "path": str}, ...]}, ...]}
Output JSON the scorer writes back:
  {"ok": true, "lines": {"<i>": [{"k", "sim", "sim_other", "asr", "dur",
                                  "usable", "spk", "emb"}, ...]}}
  or {"ok": false, "error": "..."} on failure.
"""
import json
import os
import subprocess
from typing import Callable, Dict, List, Optional

from app.config import QWEN_SCORER_PYTHON

SCRIPT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts", "qwen_score_takes.py")


def _scorer_asr_timeout_per_take() -> float:
    """Per-take ASR seconds this parent budgets for the child -- the SAME
    PERSODUB_SCORER_ASR_TIMEOUT env var and default-15 garbage-safe parse
    app/scripts/qwen_score_takes.py uses for its own ASR_BATCH_TIMEOUT_PER_FILE,
    read live (not cached at import time) so the two actually stay in sync
    (e.g. kit.env's 60) instead of this parent silently hardcoding 15."""
    try:
        return float(os.environ.get("PERSODUB_SCORER_ASR_TIMEOUT", "15"))
    except (TypeError, ValueError):
        return 15.0


def score_takes(
    speaker_ref_paths: Dict[str, str],
    lines_payload: List[dict],
    language: str,
    work_dir: str,
    log: Optional[Callable[[str], None]] = None,
    timeout: int = 900,
) -> Optional[Dict[int, List[dict]]]:
    """Score every candidate take of every line. Returns {line_index: [scored
    take dicts]}, or None if scoring is unavailable/fails for any reason
    (never raises -- see module docstring)."""
    log = log or (lambda m: None)
    # Scale the subprocess ceiling with the actual take count: embeddings + batch
    # ASR on N takes cannot fit a fixed 900s once N grows (measured 2026-07-30:
    # 88 takes under CPU contention). Per-take budget mirrors the scorer's own
    # ASR budget (_scorer_asr_timeout_per_take, same env var) so the two
    # actually stay in sync; the fixed floor stays for small jobs.
    total_takes = sum(len(line.get("takes") or []) for line in lines_payload)
    timeout = max(timeout, total_takes * _scorer_asr_timeout_per_take() + 900)
    py = QWEN_SCORER_PYTHON
    if not (os.path.exists(py) and os.access(py, os.X_OK)):
        log("   Warning: take scorer interpreter not found (%s) -- skipping take selection" % py)
        return None
    if not os.path.exists(SCRIPT_PATH):
        log("   Warning: take scorer script missing (%s) -- skipping take selection" % SCRIPT_PATH)
        return None

    lang_code = "ko" if str(language).lower().startswith("k") else "en"
    payload = {"language": lang_code, "speakers": speaker_ref_paths, "lines": lines_payload}
    in_path = os.path.join(work_dir, "qwen_scorer_input.json")
    out_path = os.path.join(work_dir, "qwen_scorer_output.json")
    with open(in_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)

    try:
        r = subprocess.run(
            [py, SCRIPT_PATH, "--input", in_path, "--output", out_path],
            capture_output=True, text=True, timeout=timeout,
        )
    except Exception as e:
        log("   Warning: take scorer failed to run (%s) -- skipping take selection" % str(e)[:120])
        return None

    if r.returncode != 0 or not os.path.exists(out_path):
        log("   Warning: take scorer exited with an error (%s) -- skipping take selection"
            % (r.stderr.strip()[-200:] or "no output produced"))
        return None
    try:
        with open(out_path, encoding="utf-8") as f:
            result = json.load(f)
    except Exception as e:
        log("   Warning: take scorer produced invalid output (%s) -- skipping take selection" % str(e)[:120])
        return None
    if not result.get("ok"):
        log("   Warning: take scorer reported an error (%s) -- skipping take selection"
            % str(result.get("error"))[:200])
        return None

    lines = result.get("lines") or {}
    return {int(k): v for k, v in lines.items()}
