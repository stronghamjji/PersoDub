#!/usr/bin/env python3
# Portions of this file (_decode_json, _unflatten_state, load_safetensors_model)
# are ported from the Demucs project's demucs/hf.py
# (https://github.com/adefossez/demucs).
# Copyright (c) Meta Platforms, Inc. and affiliates.
# Licensed under the MIT License -- see NOTICE for the full text.
"""Local Demucs (htdemucs) vocals/background separation, run OUTSIDE the app's
Python 3.8 venv under a dedicated interpreter (see app/separate.py, SEP_PYTHON) --
same "heavy deps in a separate process, talk over JSON" convention as
app/scripts/qwen_score_takes.py (app/qwen_scoring.py).

Loads the htdemucs weights directly from local files (a local copy of the
HuggingFace-cache snapshot -- see app/config.py SEP_MODEL_DIR) instead of
demucs.hf.get_hf_model(), so no network call (huggingface.co /
dl.fbaipublicfiles.com, both blocked on this server) ever happens.

The PyPI release of demucs installed in this venv (4.0.1) predates the
demucs.hf module the container's demucs (4.1.0) uses to load .safetensors
files from the HuggingFace hub -- it only has the legacy .th/torch.hub
loading path. load_safetensors_model() below is a self-contained port of
container demucs/hf.py's same-named function (verified byte-identical logic,
READ ONLY reference -- nothing there is imported or modified): it decodes
the safetensors metadata (model class + init args + flattened state) and
calls demucs.states.load_model(), which both versions have.

Flow: ffmpeg-extract the input to 48kHz stereo -> resample down to the
model's native 44.1kHz for separation -> resample the vocals/background
stems back up to 48kHz (Demucs always outputs at its own 44.1kHz regardless
of input rate) -> write vocals.wav + background.wav.

Usage: python demucs_separate.py --input job.json --output result.json
Input JSON: {"input": "<video_or_audio_path>", "out_dir": "<dir>",
             "model_dir": "<optional override of SEP_MODEL_DIR>"}
Output JSON: {"ok": true, "vocals": "<path>", "background": "<path>"} or
             {"ok": false, "error": "..."}. Prints "__SEPARATE_DONE__" to
stdout on success. Never raises past main(): any failure is instead reported
as {"ok": false, ...} with a non-zero exit code, so the 3.8-side caller
(app/separate.py) can turn it into a clean RuntimeError for app/pipeline.py
to fail the job on -- there is no fallback path (local Demucs is the only
separation engine).
"""
import argparse
import json
import os
import subprocess
import sys
import warnings

warnings.filterwarnings("ignore")

DEFAULT_MODEL_DIR = "models/demucs"
TARGET_SR = 48000


def _lazy_imports():
    """Heavy deps imported lazily so --help / arg errors don't require them."""
    import torch
    import yaml
    from demucs.apply import BagOfModels, apply_model
    from demucs.audio import convert_audio, save_audio
    from demucs.states import load_model as demucs_load_model
    return torch, yaml, apply_model, BagOfModels, convert_audio, save_audio, demucs_load_model


def _decode_json(value):
    """Decode the json encoding of model init arguments, in particular
    fractions (e.g. the `segment` param of HTDemucs). Port of demucs/hf.py."""
    from fractions import Fraction
    if isinstance(value, dict):
        if value.get("_type") == "fraction":
            return Fraction(value["numerator"], value["denominator"])
        return {key: _decode_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_decode_json(item) for item in value]
    return value


def _import_model_class(dotted):
    """Model metadata names a class to import and call -- restrict it to the
    demucs package so a tampered .safetensors file cannot run arbitrary code
    (e.g. klass = "os.system")."""
    import importlib
    module, name = dotted.rsplit(".", 1)
    if module != "demucs" and not module.startswith("demucs."):
        raise ValueError("Refusing %r from model metadata (only demucs.* classes are allowed)" % dotted)
    return getattr(importlib.import_module(module), name)


def _unflatten_state(tensors, structure):
    """Rebuild a nested model state from the flat safetensors tensor dict and
    the json structure stored in its metadata. Port of demucs/hf.py."""
    def unflatten(node):
        if isinstance(node, dict):
            if "_tensor" in node:
                return tensors[node["_tensor"]]
            if "_dict" in node:
                return {key: unflatten(item) for key, item in node["_dict"]}
            if "_list" in node:
                return [unflatten(item) for item in node["_list"]]
            if "_tuple" in node:
                return tuple(unflatten(item) for item in node["_tuple"])
            if "_class" in node:
                return _import_model_class(node["_class"])
            raise ValueError("Invalid structure node %r" % node)
        return node
    return unflatten(structure)


def load_safetensors_model(path, demucs_load_model):
    """Load a single model from a safetensors file, with the model class and
    init arguments stored as json in its metadata. Port of demucs/hf.py's
    same-named function -- the container's demucs (4.1.0) has this built in,
    but the PyPI release installed here (4.0.1) does not."""
    import json

    from safetensors import safe_open
    with safe_open(str(path), framework="pt") as f:
        metadata = f.metadata()
        tensors = {key: f.get_tensor(key) for key in f.keys()}
    if "structure" in metadata:
        state = _unflatten_state(tensors, json.loads(metadata["structure"]))
    else:
        state = tensors
    klass = _import_model_class(metadata["klass"])
    args = _decode_json(json.loads(metadata["args"]))
    kwargs = _decode_json(json.loads(metadata["kwargs"]))
    return demucs_load_model({"klass": klass, "args": args, "kwargs": kwargs, "state": state})


def load_model(model_dir, yaml, BagOfModels, demucs_load_model):
    """Build the htdemucs bag-of-models straight from local safetensors + yaml
    files (the same two files demucs.hf.get_hf_model() would otherwise fetch
    from the HuggingFace hub) -- no network, no huggingface_hub cache lookup."""
    ht_dir = os.path.join(model_dir, "HTDemucs")
    with open(os.path.join(ht_dir, "htdemucs.yaml")) as f:
        bag = yaml.safe_load(f)
    models = [
        load_safetensors_model(os.path.join(ht_dir, "%s.safetensors" % sig), demucs_load_model)
        for sig in bag["models"]
    ]
    model = BagOfModels(models, bag.get("weights"), bag.get("segment"))
    model.eval()
    return model


def extract_48k_stereo(input_path, out_wav):
    """ffmpeg-decode any input (video or audio) to a 48kHz stereo wav."""
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", input_path,
         "-ac", "2", "-ar", str(TARGET_SR), "-f", "wav", out_wav],
        check=True,
    )


def separate(input_path, out_dir, model_dir, device="cpu"):
    (torch, yaml, apply_model, BagOfModels, convert_audio, save_audio,
     demucs_load_model) = _lazy_imports()
    import torchaudio

    os.makedirs(out_dir, exist_ok=True)
    model = load_model(model_dir, yaml, BagOfModels, demucs_load_model)

    extracted = os.path.join(out_dir, "sep_extracted_48k.wav")
    extract_48k_stereo(input_path, extracted)

    wav, sr = torchaudio.load(extracted)  # (channels, samples), sr == 48000
    wav = convert_audio(wav, sr, model.samplerate, model.audio_channels)

    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    with torch.no_grad():
        out = apply_model(model, ((wav - mean) / std)[None], device=device, progress=False)
    out = out * std + mean
    sources = dict(zip(model.sources, out[0]))

    vocals = sources["vocals"]
    background = sum(t for name, t in sources.items() if name != "vocals")

    vocals_48k = convert_audio(vocals, model.samplerate, TARGET_SR, 2)
    background_48k = convert_audio(background, model.samplerate, TARGET_SR, 2)

    vocals_path = os.path.join(out_dir, "vocals.wav")
    background_path = os.path.join(out_dir, "background.wav")
    save_audio(vocals_48k, vocals_path, samplerate=TARGET_SR, clip="rescale")
    save_audio(background_48k, background_path, samplerate=TARGET_SR, clip="rescale")

    os.remove(extracted)
    return {"vocals": vocals_path, "background": background_path}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    a = ap.parse_args()
    try:
        with open(a.input, encoding="utf-8") as f:
            payload = json.load(f)
        model_dir = payload.get("model_dir") or os.environ.get("SEP_MODEL_DIR", DEFAULT_MODEL_DIR)
        device = payload.get("device") or os.environ.get("SEP_DEVICE", "cpu")
        paths = separate(payload["input"], payload["out_dir"], model_dir, device=device)
        result = {"ok": True, "vocals": paths["vocals"], "background": paths["background"]}
    except Exception as e:
        result = {"ok": False, "error": str(e)[:500]}
        with open(a.output, "w", encoding="utf-8") as f:
            json.dump(result, f)
        print("__SEPARATE_ERROR__ %s" % str(e)[:200], file=sys.stderr)
        sys.exit(1)

    with open(a.output, "w", encoding="utf-8") as f:
        json.dump(result, f)
    print("__SEPARATE_DONE__")


if __name__ == "__main__":
    main()
