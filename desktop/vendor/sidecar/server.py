"""Qwen3-TTS local HTTP sidecar.

Runs INSIDE the qwen venv (torch 2.8.0, Python 3.11). Loads the 1.7B Base
model once at startup and exposes a tiny HTTP surface the persodub app calls
over httpx (see app/engines/qwen_tts.py for the client side).

Endpoints:
  GET  /health   -> {"status":"ok","model_loaded":bool}
  POST /clone    -> form(ref_audio file, ref_text, mode) -> {"voice_id": str}
  POST /generate -> form(text, language, voice_id | ref_audio(+ref_text), mode,
                    seed, temperature, top_p, repetition_penalty)
                    -> 24 kHz wav bytes + headers x-audio-duration, x-seed

mode ("timbre" | "icl", default QWEN_VOICE_MODE env, else "timbre"):
  - "timbre": speaker-embedding-only clone (qwen_tts x_vector_only_mode=True).
    ref_text is optional and ignored -- no transcript of the reference audio
    is needed.
  - "icl": in-context-learning clone (x_vector_only_mode=False). ref_text is
    REQUIRED (empty string raises a 400), matching the original contract.
"""
import hashlib
import io
import math
import os
import tempfile
import threading

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

app = FastAPI(title="qwen3-tts-sidecar")

# Same DNS-rebinding defense as the main backend (app/main.py): a hostile page
# whose domain re-resolves to 127.0.0.1 arrives with its own domain in Host
# and is turned away. This server binds 127.0.0.1 only; this is depth, not the
# primary barrier.
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])

# voice_id -> voice_clone_prompt, built once per speaker and reused per line.
_PROMPTS = {}

DEFAULT_TEMPERATURE = 0.9
DEFAULT_TOP_P = 1.0
DEFAULT_REP_PENALTY = 1.05

# Default voice-clone mode when the request omits `mode`. "timbre" clones from
# reference audio alone (no transcript needed) -- see module docstring.
QWEN_VOICE_MODE = os.environ.get("QWEN_VOICE_MODE", "timbre")

# QWEN_TTS_MODEL must be provided by the environment (kit.env sets it); the
# vendored copy ships no default path.
MODEL_PATH = os.environ.get("QWEN_TTS_MODEL", "")


def _resolve_mode(mode):
    """Normalize a request's `mode` form field, falling back to QWEN_VOICE_MODE."""
    m = (mode or QWEN_VOICE_MODE or "timbre").strip().lower()
    if m not in ("timbre", "icl"):
        raise HTTPException(400, "mode must be 'timbre' or 'icl'")
    return m


# Guards the late load below: without it two concurrent /generate requests
# arriving right after the download finishes would both build a QwenSynth.
_LOAD_LOCK = threading.Lock()
# One model, one piece of work at a time -- and the work runs off the event
# loop (run_in_threadpool), so /health still answers while a line is being
# made. It used to run on the loop itself: a line the app had stopped waiting
# for kept the loop busy, the app's "are you there?" probe got no answer, and
# a live engine was taken for a dead one (review 2026-09-23).
_WORK_LOCK = threading.Lock()


def _locked(fn, *args, **kwargs):
    with _WORK_LOCK:
        return fn(*args, **kwargs)


def _weights_path():
    return os.path.join(MODEL_PATH, "model.safetensors")


def _synth():
    s = getattr(app.state, "synth", None)
    if s is None:
        # The model is optional at startup now (downloaded through the in-app
        # catalog): if the weights have appeared since, load them here -- no
        # restart needed after a download. Only a still-missing file is a 503.
        if not os.path.exists(_weights_path()):
            raise HTTPException(503, "model not loaded")
        with _LOAD_LOCK:
            if getattr(app.state, "synth", None) is None:
                app.state.synth = QwenSynth(device=app.state.device)
        s = app.state.synth
    return s


def _to_wav_bytes(wav, sr):
    buf = io.BytesIO()
    sf.write(buf, wav, sr, format="WAV")
    return buf.getvalue()


@app.get("/health")
def health():
    # device is what the app shows the user in the dub log: on Windows, where
    # only NVIDIA is accelerated, "it ran on CPU" is the answer to almost every
    # "why is this slow". Reported even when the model was not loaded, since
    # the choice is made from the environment, not from the load.
    return {"status": "ok",
            "model_loaded": getattr(app.state, "synth", None) is not None,
            "device": getattr(app.state, "device", None)}


@app.post("/clone")
async def clone(ref_audio: UploadFile = File(...), ref_text: str = Form(None),
                mode: str = Form(None)):
    resolved_mode = _resolve_mode(mode)
    # ICL mode: ref_text is REQUIRED (empty/missing raises inside the model).
    # Timbre mode: ref_text is optional and ignored.
    if resolved_mode == "icl" and not (ref_text and ref_text.strip()):
        raise HTTPException(400, "ref_text is required for Qwen ICL voice clone")
    data = await ref_audio.read()
    key_text = ref_text if resolved_mode == "icl" else ""
    voice_id = hashlib.sha1(
        data + resolved_mode.encode("utf-8") + (key_text or "").encode("utf-8")
    ).hexdigest()[:16]
    if voice_id not in _PROMPTS:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(data)
            tmp = f.name
        try:
            _PROMPTS[voice_id] = await run_in_threadpool(
                _locked, lambda: _synth().clone(tmp, ref_text, mode=resolved_mode))
        finally:
            os.unlink(tmp)
    return {"voice_id": voice_id}


@app.post("/generate")
async def generate(
    text: str = Form(...),
    language: str = Form("Korean"),
    voice_id: str = Form(None),
    ref_audio: UploadFile = File(None),
    ref_text: str = Form(None),
    mode: str = Form(None),
    seed: int = Form(None),
    temperature: float = Form(DEFAULT_TEMPERATURE),
    top_p: float = Form(DEFAULT_TOP_P),
    repetition_penalty: float = Form(DEFAULT_REP_PENALTY),
    max_seconds: float = Form(None),
):
    # Resolve the voice-clone prompt: cached voice_id first, else inline ref.
    if voice_id and voice_id in _PROMPTS:
        prompt = _PROMPTS[voice_id]
    elif ref_audio is not None:
        resolved_mode = _resolve_mode(mode)
        if resolved_mode == "icl" and not (ref_text and ref_text.strip()):
            raise HTTPException(400, "ref_text is required for Qwen ICL voice clone")
        data = await ref_audio.read()
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(data)
            tmp = f.name
        try:
            prompt = await run_in_threadpool(
                _locked, lambda: _synth().clone(tmp, ref_text, mode=resolved_mode))
        finally:
            os.unlink(tmp)
    else:
        raise HTTPException(400, "provide a known voice_id or ref_audio + ref_text")

    wav, sr = await run_in_threadpool(_locked, lambda: _synth().generate(
        text=text, language=language, prompt=prompt, seed=seed,
        temperature=temperature, top_p=top_p, repetition_penalty=repetition_penalty,
        max_new_tokens=tokens_for_seconds(max_seconds),
    ))
    wav = np.asarray(wav, dtype=np.float32)
    dur = len(wav) / float(sr)
    headers = {"x-audio-duration": "%.3f" % dur}
    cap_tokens = tokens_for_seconds(max_seconds)
    if cap_tokens and round(dur * FRAMES_PER_SECOND) >= cap_tokens - 1:
        # The model was stopped by the cap, not by the end of the sentence:
        # the app treats this as a line that could not be made.
        headers["x-audio-cut"] = "1"
    if seed is not None:
        headers["x-seed"] = str(seed)
    return Response(content=_to_wav_bytes(wav, sr),
                    media_type="audio/wav", headers=headers)


# The speech tokenizer makes 12.5 codec frames per second of audio
# (speech_tokenizer/config.json "_frame_rate"), so a cap in seconds is a cap
# in tokens. Without one the model runs to its own default of thousands of
# tokens -- minutes of speech for a five-second line, which is what a runaway
# made on a Mac for 15 minutes (2026-09-23). A cut is read by frames, not by
# a margin in seconds, so a decoder that trims a frame does not hide it.
FRAMES_PER_SECOND = 12.5
MIN_TOKENS = 8


def tokens_for_seconds(max_seconds):
    """The token cap for a cap in seconds; None keeps the model's default."""
    if not max_seconds or max_seconds <= 0 or max_seconds != max_seconds:   # none, or NaN
        return None
    return max(MIN_TOKENS, int(math.ceil(max_seconds * FRAMES_PER_SECOND)))


class QwenSynth:
    """Real synthesizer wrapping Qwen3TTSModel. torch/qwen_tts are imported
    lazily in __init__ so the module (and its tests) load without a GPU."""

    def __init__(self, model_path=MODEL_PATH, device="cuda:0"):
        import torch
        from qwen_tts import Qwen3TTSModel
        self._torch = torch
        # CPU lacks fast bfloat16 kernels; use float32 there. GPU backends
        # (cuda, Apple mps) keep bfloat16.
        dtype = torch.float32 if str(device).startswith("cpu") else torch.bfloat16
        self.model = Qwen3TTSModel.from_pretrained(
            model_path, device_map=device, dtype=dtype,
        )

    def clone(self, ref_audio_path, ref_text, mode="icl"):
        # timbre: speaker-embedding-only (x_vector_only_mode=True, ref_text ignored).
        # icl: in-context-learning clone; ref_text must be non-empty (guarded by the routes).
        x_vector_only = mode == "timbre"
        return self.model.create_voice_clone_prompt(
            ref_audio=ref_audio_path,
            ref_text=None if x_vector_only else ref_text,
            x_vector_only_mode=x_vector_only,
        )

    def generate(self, text, language, prompt, seed,
                 temperature, top_p, repetition_penalty, max_new_tokens=None):
        if seed is not None:
            self._torch.manual_seed(seed)
        extra = {"max_new_tokens": max_new_tokens} if max_new_tokens else {}
        wavs, sr = self.model.generate_voice_clone(
            text=text, language=language, voice_clone_prompt=prompt,
            temperature=temperature, top_p=top_p,
            repetition_penalty=repetition_penalty, **extra,
        )
        return wavs[0], sr


def _resolve_device(device):
    """Map "auto" to cuda when a GPU is visible, else cpu. Explicit values
    (cuda:0, mps, cpu) pass through untouched. The Windows kit env sets "auto";
    macOS sets "mps"."""
    if device != "auto":
        return device
    try:
        import torch
        return "cuda:0" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


@app.on_event("startup")
def _load_model():
    # Resolved first and kept on app.state so /health can report it even when
    # the load below is skipped -- the device is decided by the environment,
    # not by whether a model is resident.
    device = _resolve_device(os.environ.get("QWEN_TTS_DEVICE", "cuda:0"))
    app.state.device = device
    print(f"QWEN_TTS device={device}", flush=True)
    # Skip the heavy load when a fake was injected (tests) or explicitly disabled.
    if getattr(app.state, "synth", None) is not None:
        return
    if os.environ.get("QWEN_TTS_SKIP_LOAD") == "1":
        return
    # The model is optional now: when its weights are not on disk yet (the
    # in-app catalog downloads them later), start without it. /health reports
    # model_loaded false and _synth() loads it lazily once the file appears.
    if not os.path.exists(_weights_path()):
        print(f"QWEN_TTS model not downloaded yet ({_weights_path()}); starting without it", flush=True)
        return
    app.state.synth = QwenSynth(device=device)
