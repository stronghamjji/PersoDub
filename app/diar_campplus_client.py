# -*- coding: utf-8 -*-
"""Subprocess bridge to app/scripts/campplus_diarize.py (local, download-free
speaker diarization using CAM++ / campplus.onnx). The app's own Python 3.8
venv has neither onnxruntime, torch, torchaudio, nor scikit-learn, so
diarization runs as a separate process under DIAR_PYTHON (config.py) -- the
same "heavy deps in a separate process, talk over JSON" convention as
app/qwen_scoring.py (QWEN_SCORER_PYTHON) and app/separate.py (SEP_PYTHON).

CAM++ has NO built-in VAD: it only labels the pre-existing cue time-spans that
STT (Whisper or Perso) already produced. diarize() ships each cue's start/end
plus the vocals wav path to the worker, which embeds each span, clusters the
embeddings, and returns a neutral speaker label (SPK0, SPK1, ...) per cue.

Like app/separate.py (and unlike app/qwen_scoring.py, which degrades to None),
diarize() raises RuntimeError on any bridge failure. app/pipeline.py already
catches that at the call site, logs a warning, and keeps the existing labels
-- so raising here preserves the exact contract the pipeline was written for.
"""
import json
import os
import subprocess
import tempfile
from collections import Counter
from typing import List

from app.config import DIAR_PYTHON

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DEFAULT_CAMPPLUS = "models/campplus/campplus.onnx"


def resolve_campplus_model(explicit=None):
    """CAM++ model path -- never a bare relative one.

    The default here used to be the bare relative string, which resolves against
    whatever working directory the process happens to have.
    app/scripts/qwen_score_takes.py already hit exactly that: its own resolver's
    docstring records the 2026-07-30 regression where the scorer was launched
    from a different directory, the relative path did not exist there, and
    best-of-N selection silently fell back to take 0 for the whole job.

    Same default, same latent failure, but on the live diarization path -- where
    the symptom is every speaker collapsing into one. Note this repo has no
    models/ directory of its own, so the relative form only ever resolved when
    the process happened to run from the parent directory.

    Order: explicit -> PERSODUB_CAMPPLUS_MODEL -> the relative default if it does
    exist under the cwd -> the same path under the repo root (absolute).
    """
    for p in (explicit, os.environ.get("PERSODUB_CAMPPLUS_MODEL")):
        if p:
            return p
    cwd_candidate = os.path.join(os.getcwd(), _DEFAULT_CAMPPLUS)
    if os.path.exists(cwd_candidate):
        return cwd_candidate
    return os.path.join(_REPO_ROOT, _DEFAULT_CAMPPLUS)


CAMPPLUS_MODEL = resolve_campplus_model()

SCRIPT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts", "campplus_diarize.py")

# Diarization subprocess timeout, env-overridable (PERSODUB_DIAR_TIMEOUT) --
# Mac CPUs are slower than the server's. Garbage/unset falls back to 600.
try:
    PERSODUB_DIAR_TIMEOUT = float(os.environ.get("PERSODUB_DIAR_TIMEOUT", "600"))
except (TypeError, ValueError):
    PERSODUB_DIAR_TIMEOUT = 600.0


def relabel_by_size(cluster_labels: List[int]) -> List[str]:
    """Map raw cluster ids to neutral SPK labels, largest cluster first (pure).

    SPK0 is the biggest cluster, SPK1 the next, etc. Size ties are broken by the
    order each cluster id first appears, so the result is fully deterministic.
    """
    counts = Counter(cluster_labels)
    first_seen = {}
    for i, c in enumerate(cluster_labels):
        if c not in first_seen:
            first_seen[c] = i
    order = sorted(counts, key=lambda c: (-counts[c], first_seen[c]))
    rank = {c: i for i, c in enumerate(order)}
    return ["SPK%d" % rank[c] for c in cluster_labels]


def diarize(vocals_wav_path, cues, num_speakers=None):
    """Label each cue with a neutral speaker id using CAM++ embeddings.

    vocals_wav_path : the full Demucs vocals wav (any sample rate; resampled to 16k).
    cues            : list of dicts with 'start'/'end' seconds (from STT).
    num_speakers    : fixed k, or None to silhouette-estimate over k=2..4.

    Returns COPIES of cues, each with an added 'speaker' ('SPK0', 'SPK1', ...).
    Input cues are never mutated. CAM++ supplies NO VAD -- it only labels the
    spans the cues already define.

    Raises RuntimeError on any failure (missing interpreter/script, subprocess
    crash/timeout, bad JSON, or the worker itself reporting ok=false).
    """
    if not cues:
        return list(cues)

    py = DIAR_PYTHON
    if not (os.path.exists(py) and os.access(py, os.X_OK)):
        raise RuntimeError("local diarization interpreter not found (%s)" % py)
    if not os.path.exists(SCRIPT_PATH):
        raise RuntimeError("local diarization script missing (%s)" % SCRIPT_PATH)

    with tempfile.TemporaryDirectory(prefix="persodub_diar_") as work_dir:
        in_path = os.path.join(work_dir, "diar_input.json")
        out_path = os.path.join(work_dir, "diar_output.json")
        payload = {
            "vocals_wav_path": vocals_wav_path,
            "cues": [{"start": c["start"], "end": c["end"]} for c in cues],
            "num_speakers": num_speakers,
            "campplus_model": CAMPPLUS_MODEL,
        }
        with open(in_path, "w", encoding="utf-8") as f:
            json.dump(payload, f)

        try:
            r = subprocess.run(
                [py, SCRIPT_PATH, "--input", in_path, "--output", out_path],
                capture_output=True, text=True, timeout=PERSODUB_DIAR_TIMEOUT,
            )
        except Exception as e:
            raise RuntimeError("local diarization failed to run (%s)" % str(e)[:120])

        if r.returncode != 0 or not os.path.exists(out_path):
            raise RuntimeError(
                "local diarization exited with an error (%s)"
                % (r.stderr.strip()[-200:] or "no output produced"))
        try:
            with open(out_path, encoding="utf-8") as f:
                result = json.load(f)
        except Exception as e:
            raise RuntimeError("local diarization produced invalid output (%s)" % str(e)[:120])
        if not result.get("ok"):
            raise RuntimeError("local diarization reported an error (%s)" % str(result.get("error"))[:200])

    labels = result.get("speakers")
    if labels is None or len(labels) != len(cues):
        raise RuntimeError("local diarization returned mismatched speaker labels")

    out = [dict(c) for c in cues]
    for c, spk in zip(out, labels):
        c["speaker"] = spk
    return out
