#!/usr/bin/env python3
"""Local CAM++ (campplus.onnx) speaker-diarization worker, run OUTSIDE the
app's Python 3.8 venv under a dedicated interpreter (see
app/diar_campplus_client.py, DIAR_PYTHON) -- same "heavy deps in a separate
process, talk over JSON" convention as app/scripts/demucs_separate.py
(app/separate.py, SEP_PYTHON) and app/scripts/qwen_score_takes.py
(app/qwen_scoring.py, QWEN_SCORER_PYTHON).

CAM++ has NO built-in VAD: it only embeds and labels the pre-existing cue
time-spans (start/end seconds) already produced by STT. Embeds each cue's
audio span (fbank80 + CMN + ONNX), clusters the embeddings (agglomerative,
cosine distance; k fixed or silhouette-estimated over k=2..4), and relabels
clusters by size using relabel_by_size -- pure logic imported from
app/diar_campplus_client.py so both sides share one source of truth.

Usage: python campplus_diarize.py --input job.json --output result.json
Input JSON: {"vocals_wav_path": "<wav path>", "cues": [{"start": float,
             "end": float}, ...], "num_speakers": int|null,
             "campplus_model": "<onnx path>"}
Output JSON: {"ok": true, "speakers": ["SPK0", "SPK1", ...]} (one label per
             input cue, same order) or {"ok": false, "error": "..."}. Prints
"__DIARIZE_DONE__" to stdout on success. Never raises past main(): any
failure is instead reported as {"ok": false, ...} with a non-zero exit code,
so the 3.8-side caller (app/diar_campplus_client.py) can turn it into a
clean RuntimeError for app/pipeline.py to catch and fall back on.
"""
import argparse
import json
import os
import sys
import warnings
from collections import Counter

warnings.filterwarnings("ignore")

# Make the repo root importable regardless of cwd, so we can reuse
# relabel_by_size from app/diar_campplus_client.py instead of duplicating it.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)
from app.diar_campplus_client import relabel_by_size  # noqa: E402

SR = 16000
K_MIN = 2
K_MAX = 4

# Auto-diarization can over-split a single narrator once the transcript has
# several cues (k=2..4 is always searched). Collapse back to one speaker when
# every pairwise cluster-centroid cosine similarity is >= this. First
# calibrated on clean hand-cut 1.5-3s windows (same-speaker sim 0.88,
# cross-speaker sim 0.22), but real short/noisy Whisper cues (job 4ec68328,
# moon.mp4, 0.44-2.46s cues) still split one narrator into 3 spurious
# clusters whose pairwise sims (0.63/0.50/0.49) fell under that 0.65 --
# lowered to keep this real case collapsing with margin (<= 0.49 - 0.05)
# while staying well above the measured cross-speaker floor (>= 0.22 + 0.10)
# -- see task-2 report, "job 4ec68328 fix" section.
DIAR_MERGE_SIM_DEFAULT = 0.38


def _parse_diar_merge_sim():
    """PERSODUB_DIAR_MERGE_SIM as a float; unset/invalid -> the default."""
    raw = os.environ.get("PERSODUB_DIAR_MERGE_SIM")
    if raw is None:
        return DIAR_MERGE_SIM_DEFAULT
    try:
        return float(raw)
    except ValueError:
        return DIAR_MERGE_SIM_DEFAULT


DIAR_MERGE_SIM = _parse_diar_merge_sim()


def _lazy_imports():
    """Heavy deps imported lazily so --help / arg errors don't require them."""
    import numpy as np
    import onnxruntime as ort
    import soundfile as sf
    import torch
    import torchaudio.compliance.kaldi as kaldi
    return np, ort, sf, torch, kaldi


def _load_mono16k(path, np, sf):
    """Read a wav as float32 mono at 16 kHz (resample if needed)."""
    x, sr = sf.read(path, always_2d=False)
    if x.ndim > 1:
        x = x.mean(axis=1)
    x = x.astype(np.float32)
    if sr != SR:
        import scipy.signal as ss
        x = ss.resample(x, int(len(x) * SR / sr)).astype(np.float32)
    return x


def _embed(seg, sess, np, torch, kaldi):
    """CAM++ embedding for one audio segment (fbank80 + CMN, L2-normalized)."""
    if len(seg) < int(0.2 * SR):  # pad segments shorter than 0.2s
        seg = np.pad(seg, (0, int(0.2 * SR) - len(seg)))
    fb = kaldi.fbank(torch.tensor(seg).unsqueeze(0), num_mel_bins=80,
                     dither=0, sample_frequency=SR)
    fb = fb - fb.mean(dim=0, keepdim=True)
    # Exports name this tensor differently ("input" on the server's bundled
    # model, "feats"/"x" on the public ones), so ask the session for it.
    e = sess.run(None, {sess.get_inputs()[0].name: fb.unsqueeze(0).numpy()})[0].flatten()
    return e / (np.linalg.norm(e) + 1e-9)


def _estimate_k(embs):
    """Auto-estimate speaker count over k=2..4 by silhouette (cosine)."""
    from sklearn.cluster import AgglomerativeClustering
    from sklearn.metrics import silhouette_score
    from sklearn.metrics.pairwise import cosine_distances
    n = len(embs)
    if n < K_MIN + 1:
        return min(n, K_MIN)
    D = cosine_distances(embs)
    best_k, best_s = K_MIN, -2.0
    for k in range(K_MIN, min(K_MAX, n - 1) + 1):
        lab = AgglomerativeClustering(
            n_clusters=k, metric="cosine", linkage="average"
        ).fit_predict(embs)
        s = silhouette_score(D, lab, metric="precomputed")
        if s > best_s:
            best_s, best_k = s, k
    return best_k


def _cluster(embs, k):
    """Agglomerative cosine clustering into k clusters -> list[int]."""
    from sklearn.cluster import AgglomerativeClustering
    return list(AgglomerativeClustering(
        n_clusters=k, metric="cosine", linkage="average"
    ).fit_predict(embs))


def _should_collapse(embs, labels, np, threshold):
    """True iff every pairwise cosine similarity between cluster centroids is
    >= threshold, i.e. the clusters AUTO-estimation found are indistinguishable
    enough to actually be one speaker. Centroid = mean of that label's
    embeddings, L2-normalized before the dot product (embeddings from _embed
    are already unit-norm, but the mean of several unit vectors is not, so
    normalize the centroid too).
    """
    groups = {}
    for e, lab in zip(embs, labels):
        groups.setdefault(lab, []).append(e)
    if len(groups) < 2:
        return True
    centroids = []
    for vecs in groups.values():
        dim = len(vecs[0])
        mean = [sum(v[d] for v in vecs) / len(vecs) for d in range(dim)]
        norm = np.linalg.norm(mean) + 1e-9
        centroids.append([m / norm for m in mean])
    for i in range(len(centroids)):
        for j in range(i + 1, len(centroids)):
            if np.dot(centroids[i], centroids[j]) < threshold:
                return False
    return True


def _maybe_collapse(embs, labels, num_speakers, k, np, threshold):
    """Collapse an AUTO-estimated result to one speaker when every cluster
    turns out indistinguishable (see _should_collapse). A caller-supplied
    num_speakers always bypasses this -- the user's override wins.
    """
    if num_speakers or k < 2:
        return labels
    if _should_collapse(embs, labels, np, threshold):
        return ["SPK0"] * len(labels)
    return labels


def diarize(vocals_wav_path, cues, num_speakers, campplus_model):
    """Label each cue with a neutral speaker id using CAM++ embeddings.

    Returns a list of labels ("SPK0", "SPK1", ...), one per cue, same order.
    Ported from the pre-refactor in-process app/diar_campplus_client.py --
    logic unchanged, just parameterized to run standalone in this process.
    """
    np, ort, sf, torch, kaldi = _lazy_imports()
    if not cues:
        return []

    sess = ort.InferenceSession(campplus_model, providers=["CPUExecutionProvider"])
    x = _load_mono16k(vocals_wav_path, np, sf)

    valid_idx, embs = [], []
    for i, c in enumerate(cues):
        a, b = int(float(c["start"]) * SR), int(float(c["end"]) * SR)
        seg = x[a:b]
        if len(seg) <= 0:
            continue
        valid_idx.append(i)
        embs.append(_embed(seg, sess, np, torch, kaldi))

    if len(valid_idx) < 2:
        return ["SPK0"] * len(cues)

    embs = np.array(embs)
    k = int(num_speakers) if num_speakers else _estimate_k(embs)
    k = max(1, min(k, len(valid_idx)))
    raw = _cluster(embs, k) if k > 1 else [0] * len(valid_idx)
    labels = relabel_by_size(raw)
    labels = _maybe_collapse(embs, labels, num_speakers, k, np, DIAR_MERGE_SIM)

    out = [None] * len(cues)
    for pos, i in enumerate(valid_idx):
        out[i] = labels[pos]
    # Empty/degenerate spans (no embedding) inherit the majority speaker.
    majority = Counter(labels).most_common(1)[0][0]
    for i in range(len(out)):
        if out[i] is None:
            out[i] = majority
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    a = ap.parse_args()
    try:
        with open(a.input, encoding="utf-8") as f:
            payload = json.load(f)
        speakers = diarize(
            payload["vocals_wav_path"], payload.get("cues") or [],
            payload.get("num_speakers"),
            payload.get("campplus_model") or "models/campplus/campplus.onnx",
        )
        result = {"ok": True, "speakers": speakers}
    except Exception as e:
        result = {"ok": False, "error": str(e)[:500]}
        with open(a.output, "w", encoding="utf-8") as f:
            json.dump(result, f)
        print("__DIARIZE_ERROR__ %s" % str(e)[:200], file=sys.stderr)
        sys.exit(1)

    with open(a.output, "w", encoding="utf-8") as f:
        json.dump(result, f)
    print("__DIARIZE_DONE__")


if __name__ == "__main__":
    main()
