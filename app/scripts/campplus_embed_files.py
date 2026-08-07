#!/usr/bin/env python3
"""CAM++ (campplus.onnx) file-embedding worker for the speaker-identity gate
(app/scripts/check_speaker_identity.py). Runs OUTSIDE the app's Python 3.8
venv under the same dedicated interpreter as diarization (DIAR_PYTHON, see
app/diar_campplus_client.py) -- the established "heavy deps in a separate
process, talk over JSON" convention.

Unlike campplus_diarize.py (which embeds time-spans of ONE vocals wav), this
worker embeds a batch of WHOLE wav files -- synthesized per-line takes
(qwen_line_N.wav) and per-speaker reference clips (qwen_ref_<Speaker>.wav) --
in a single process so the ONNX session is created once.

Usage: python campplus_embed_files.py --input job.json --output result.json
Input JSON:  {"wav_paths": ["<wav>", ...], "campplus_model": "<onnx path>"}
Output JSON: {"ok": true, "embeddings": [[float, ...], ...],
              "durations": [float, ...]}   (same order as wav_paths;
              embeddings are L2-normalized, durations in seconds)
             or {"ok": false, "error": "..."}. Prints "__EMBED_DONE__" on
success; failures exit non-zero with ok=false, mirroring campplus_diarize.py
so the 3.8-side caller can raise a clean RuntimeError.
"""
import argparse
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")

SR = 16000
# Segments shorter than this are zero-padded before fbank -- same floor as
# campplus_diarize.py's _embed (kaldi.fbank needs a minimum frame count).
MIN_EMBED_SEC = 0.2


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
    """CAM++ embedding for one segment (fbank80 + CMN, L2-normalized) --
    same computation as campplus_diarize.py._embed."""
    if len(seg) < int(MIN_EMBED_SEC * SR):
        seg = np.pad(seg, (0, int(MIN_EMBED_SEC * SR) - len(seg)))
    fb = kaldi.fbank(torch.tensor(seg).unsqueeze(0), num_mel_bins=80,
                     dither=0, sample_frequency=SR)
    fb = fb - fb.mean(dim=0, keepdim=True)
    e = sess.run(None, {"input": fb.unsqueeze(0).numpy()})[0].flatten()
    return e / (np.linalg.norm(e) + 1e-9)


def embed_files(wav_paths, campplus_model):
    """Embed each wav file; returns (embeddings, durations_sec), same order."""
    np, ort, sf, torch, kaldi = _lazy_imports()
    sess = ort.InferenceSession(campplus_model, providers=["CPUExecutionProvider"])
    embs, durs = [], []
    for p in wav_paths:
        x = _load_mono16k(p, np, sf)
        durs.append(len(x) / float(SR))
        embs.append(_embed(x, sess, np, torch, kaldi).tolist())
    return embs, durs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    a = ap.parse_args()
    try:
        with open(a.input, encoding="utf-8") as f:
            payload = json.load(f)
        paths = payload.get("wav_paths") or []
        missing = [p for p in paths if not os.path.exists(p)]
        if missing:
            raise FileNotFoundError("missing wav(s): %s" % ", ".join(missing[:3]))
        embs, durs = embed_files(
            paths, payload.get("campplus_model") or "models/campplus/campplus.onnx")
        result = {"ok": True, "embeddings": embs, "durations": durs}
    except Exception as e:
        with open(a.output, "w", encoding="utf-8") as f:
            json.dump({"ok": False, "error": str(e)[:500]}, f)
        print("__EMBED_ERROR__ %s" % str(e)[:200], file=sys.stderr)
        sys.exit(1)

    with open(a.output, "w", encoding="utf-8") as f:
        json.dump(result, f)
    print("__EMBED_DONE__")


if __name__ == "__main__":
    main()
