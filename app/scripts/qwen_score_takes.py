#!/usr/bin/env python3
"""Best-of-N take scorer for the Qwen dub path (app/qwen_pipeline.synth_lines).

Runs OUTSIDE the app's Python 3.8 venv, which has neither onnxruntime nor
torch -- invoked as a subprocess from a separate interpreter (see
app/qwen_scoring.py, QWEN_SCORER_PYTHON). This lets the Qwen dub path (3.8)
stay dependency-free while still scoring takes with the same CAM++ embedding
model 97_qwen3_tts/score_takes.py uses (READ ONLY reference -- this file is a
self-contained port, nothing there is imported or modified).

Scores every candidate take of every line with:
  sim / sim_other : CAM++ speaker-embedding cosine similarity to this line's
                     own speaker reference / the best-matching OTHER speaker
  asr              : pronunciation match (SequenceMatcher ratio) against a
                      whisper transcription of the take, produced by shelling
                      out to the app's own local Whisper worker (no
                      container/network dependency)
  dur              : silence-trimmed speech duration (seconds)
  emb              : the take's own embedding (list[float]), needed by
                      app/qwen_select.py's coherence rounds

Usage: python qwen_score_takes.py --input job.json --output scores.json
Reads a JSON job spec (see the module docstring of app/qwen_scoring.py for
the exact shape) and writes JSON scores. Prints "__SCORE_TAKES_DONE__" to
stdout on success. Never raises past main(): any failure is instead reported
as {"ok": false, "error": ...} in the output file with a non-zero exit code,
so the 3.8-side caller can fall back to single-take behavior instead of
failing the whole dub job.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
import warnings
from difflib import SequenceMatcher

warnings.filterwarnings("ignore")
# CPU-only scoring: this subprocess must never fight the dub job for the shared GPU.
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")

DEFAULT_CAMPPLUS = "models/campplus/campplus.onnx"
# Repo root = two directories above this file (app/scripts/ -> app/ -> root).
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SR = 16000


def resolve_campplus_model(explicit=None):
    """CAM++ model path, cwd-independent.

    The 2026-07-30 v2 rebuild regression: this scorer was launched from a
    different working directory, the bare relative DEFAULT_CAMPPLUS didn't
    exist there, and best-of-N selection silently fell back to take 0 for the
    whole job. Resolution order: explicit (payload "campplus_model") ->
    PERSODUB_CAMPPLUS_MODEL env -> QWEN_CAMPPLUS_MODEL env (legacy name) ->
    DEFAULT_CAMPPLUS under the cwd if it exists there -> DEFAULT_CAMPPLUS
    under the repo root (always an absolute path, never a bare relative one).
    """
    for p in (explicit, os.environ.get("PERSODUB_CAMPPLUS_MODEL"),
              os.environ.get("QWEN_CAMPPLUS_MODEL")):
        if p:
            return p
    cwd_candidate = os.path.join(os.getcwd(), DEFAULT_CAMPPLUS)
    if os.path.exists(cwd_candidate):
        return cwd_candidate
    return os.path.join(REPO_ROOT, DEFAULT_CAMPPLUS)

# ASR for take scoring always shells out to the app's own local Whisper
# worker (scripts/whisper_transcribe.py), so scoring has zero container/
# network dependency.
STT_PYTHON = os.environ.get("STT_PYTHON", "python3")
WHISPER_TRANSCRIBE_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "whisper_transcribe.py")

ASR_BATCH_TIMEOUT_FLOOR = 600   # seconds; enough for small batches incl. model load
# CPU large-v3 per short take, with headroom for load. Env-overridable
# (PERSODUB_SCORER_ASR_TIMEOUT) -- Mac CPUs are slower than the server's.
# Garbage/unset falls back to 15. Runs in a separate interpreter (module
# docstring), so this reads the env inherited from the app process directly.
try:
    ASR_BATCH_TIMEOUT_PER_FILE = float(os.environ.get("PERSODUB_SCORER_ASR_TIMEOUT", "15"))
except (TypeError, ValueError):
    ASR_BATCH_TIMEOUT_PER_FILE = 15.0
ASR_BATCH_TIMEOUT_LOAD = 300     # model-load + contention headroom on scaled batches


def _asr_batch_timeout(n_files):
    """Batch-ASR timeout that scales with take count. Measured failure (2026-07-30
    v3full): a fixed 600s ceiling silently expired on an 88-take batch under CPU
    contention -- the scorer then returned asr=0 for EVERY take, which collapses
    eligibility to a single best-margin candidate per line and disables the
    duration-fit choice entirely."""
    return max(ASR_BATCH_TIMEOUT_FLOOR, n_files * ASR_BATCH_TIMEOUT_PER_FILE + ASR_BATCH_TIMEOUT_LOAD)


def _lazy_imports():
    """Heavy deps imported lazily so --help / arg errors don't require them."""
    import numpy as np
    import onnxruntime as ort
    import soundfile as sf
    import torch
    import torchaudio.compliance.kaldi as kaldi
    return np, sf, torch, ort, kaldi


def load16k(path, tmp_dir, sf):
    dst = os.path.join(tmp_dir, re.sub(r"[^\w]", "_", os.path.basename(path)) + ".16k.wav")
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", path, "-ac", "1", "-ar", str(SR), dst],
        check=True,
    )
    x, _ = sf.read(dst, dtype="float32")
    return x


def embed(sess, x, torch, kaldi):
    if len(x) < SR * 0.4:
        return None
    fb = kaldi.fbank(torch.tensor(x).unsqueeze(0), num_mel_bins=80, dither=0, sample_frequency=SR)
    fb = fb - fb.mean(dim=0, keepdim=True)
    # Exports name this tensor differently ("input" on the server's bundled
    # model, "feats"/"x" on the public ones), so ask the session for it.
    return sess.run(None, {sess.get_inputs()[0].name: fb.unsqueeze(0).numpy()})[0].flatten()


def cos(a, b, np):
    if a is None or b is None:
        return 0.0
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


def nfc(s):
    return re.sub(r"[^\w가-힣]", "", unicodedata.normalize("NFC", s or "").lower())


def speech_dur(path, sf, np):
    w, sr = sf.read(path)
    if w.ndim > 1:
        w = w.mean(axis=1)
    hop = int(sr * 0.02)
    nfr = len(w) // hop
    if nfr == 0:
        return len(w) / sr
    env = np.array([np.sqrt((w[j * hop:(j + 1) * hop] ** 2).mean() + 1e-12) for j in range(nfr)])
    thr = 0.06 * env.max()
    on = next((j for j, e in enumerate(env) if e > thr), 0)
    off = next((j for j in range(nfr - 1, -1, -1) if env[j] > thr), nfr - 1)
    return max((off + 1 - on) * hop / sr, 0.01)


def _transcribe_batch_local(paths, language, timeout=600):
    """Batch ASR for take scoring: ONE subprocess call transcribes every take,
    loading the local Whisper model once instead of once per take.

    Loading faster-whisper-large-v3 from disk takes ~15-20s per call; with
    dozens of takes (n_takes=4 x many lines), reloading it for every single
    take could blow past this scorer's own subprocess timeout and silently
    disable best-of-N selection for the whole job (measured: 13 lines x 4
    takes = 52 per-take reloads ~= 960s, over the 900s scorer timeout).
    Batching pays the model-load cost once.

    Never raises -- a missing/failed take just gets an empty transcript
    ("" -> asr score 0), same graceful-degradation spirit as the rest of
    this scorer (score()'s caller already tolerates missing/zero scores).
    """
    if not (os.path.exists(STT_PYTHON) and os.access(STT_PYTHON, os.X_OK)):
        return {}
    if not os.path.exists(WHISPER_TRANSCRIBE_SCRIPT):
        return {}
    with tempfile.TemporaryDirectory() as tmp_dir:
        list_path = os.path.join(tmp_dir, "audio_list.json")
        out_path = os.path.join(tmp_dir, "batch_output.json")
        with open(list_path, "w", encoding="utf-8") as f:
            json.dump(paths, f)
        cmd = [STT_PYTHON, WHISPER_TRANSCRIBE_SCRIPT, "--audio-list", list_path, "--output", out_path]
        if language:
            cmd += ["--language", language]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        except Exception:
            return {}
        if r.returncode != 0 or not os.path.exists(out_path):
            return {}
        try:
            with open(out_path, encoding="utf-8") as f:
                result = json.load(f)
        except Exception:
            return {}
    if not result.get("ok"):
        return {}
    heard = {}
    for path, entry in (result.get("results") or {}).items():
        if entry.get("ok"):
            segs = entry.get("segments") or []
            heard[path] = " ".join(seg.get("text", "").strip() for seg in segs).strip()
    return heard


def score(payload, tmp_dir):
    np, sf, torch, ort, kaldi = _lazy_imports()
    campplus = resolve_campplus_model(payload.get("campplus_model"))
    if not os.path.exists(campplus):
        raise ValueError(
            "CAM++ model not found at %s -- set PERSODUB_CAMPPLUS_MODEL to an absolute path" % campplus)
    language = payload.get("language") or "ko"
    speakers = payload.get("speakers") or {}
    if not speakers:
        raise ValueError("no speaker references given")

    sess = ort.InferenceSession(campplus, providers=["CPUExecutionProvider"])
    ref_embs = {spk: embed(sess, load16k(path, tmp_dir, sf), torch, kaldi)
                for spk, path in speakers.items()}

    # Batch-transcribe every take up front (one Whisper model load) instead of
    # once per take -- see _transcribe_batch_local's docstring.
    all_take_paths = [t["path"] for line in payload.get("lines") or [] for t in line.get("takes") or []]
    heard_by_path = _transcribe_batch_local(all_take_paths, language,
                                            timeout=_asr_batch_timeout(len(all_take_paths)))
    if all_take_paths and not heard_by_path:
        # Not fatal (sim/dur still score), but say so loudly in stderr: with no
        # transcripts every asr is 0 and per-line selection degenerates.
        print("__SCORE_TAKES_WARN__ batch ASR returned nothing -- asr=0 for all takes",
              file=sys.stderr)

    out_lines = {}
    for line in payload.get("lines") or []:
        i = line["i"]
        spk = line.get("spk")
        usable = line.get("usable", 0.0)
        text = line.get("text", "")
        ref_emb = ref_embs.get(spk)
        others = [e for s, e in ref_embs.items() if s != spk and e is not None]
        rows = []
        for t in line.get("takes") or []:
            k, path = t["k"], t["path"]
            e = embed(sess, load16k(path, tmp_dir, sf), torch, kaldi)
            heard = heard_by_path.get(path, "")
            asr = round(SequenceMatcher(None, nfc(text), nfc(heard)).ratio(), 4)
            sim = round(cos(e, ref_emb, np), 4) if ref_emb is not None else 0.0
            sim_other = round(max([cos(e, o, np) for o in others], default=0.0), 4)
            dur = round(speech_dur(path, sf, np), 3)
            rows.append({
                "k": k, "sim": sim, "sim_other": sim_other, "asr": asr, "dur": dur,
                "usable": usable, "spk": spk, "emb": (e.tolist() if e is not None else None),
            })
        if rows:
            out_lines[str(i)] = rows
    return out_lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    a = ap.parse_args()
    try:
        with open(a.input, encoding="utf-8") as f:
            payload = json.load(f)
        tmp_dir = os.path.dirname(os.path.abspath(a.output)) or "."
        lines = score(payload, tmp_dir)
        result = {"ok": True, "lines": lines}
    except Exception as e:
        result = {"ok": False, "error": str(e)[:500]}
        with open(a.output, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False)
        print("__SCORE_TAKES_ERROR__ %s" % str(e)[:200], file=sys.stderr)
        sys.exit(1)

    with open(a.output, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    print("__SCORE_TAKES_DONE__")


if __name__ == "__main__":
    main()
