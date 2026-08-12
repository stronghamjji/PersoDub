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
import os
import tempfile

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile
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

# QWEN_TTS_MODEL must be provided by the environment (mac.env sets it); the
# vendored copy ships no default path.
MODEL_PATH = os.environ.get("QWEN_TTS_MODEL", "")


def _resolve_mode(mode):
    """Normalize a request's `mode` form field, falling back to QWEN_VOICE_MODE."""
    m = (mode or QWEN_VOICE_MODE or "timbre").strip().lower()
    if m not in ("timbre", "icl"):
        raise HTTPException(400, "mode must be 'timbre' or 'icl'")
    return m


def _synth():
    s = getattr(app.state, "synth", None)
    if s is None:
        raise HTTPException(503, "model not loaded")
    return s


def _to_wav_bytes(wav, sr):
    buf = io.BytesIO()
    sf.write(buf, wav, sr, format="WAV")
    return buf.getvalue()


@app.get("/health")
def health():
    return {"status": "ok",
            "model_loaded": getattr(app.state, "synth", None) is not None}


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
            _PROMPTS[voice_id] = _synth().clone(tmp, ref_text, mode=resolved_mode)
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
            prompt = _synth().clone(tmp, ref_text, mode=resolved_mode)
        finally:
            os.unlink(tmp)
    else:
        raise HTTPException(400, "provide a known voice_id or ref_audio + ref_text")

    wav, sr = _synth().generate(
        text=text, language=language, prompt=prompt, seed=seed,
        temperature=temperature, top_p=top_p, repetition_penalty=repetition_penalty,
    )
    wav = np.asarray(wav, dtype=np.float32)
    dur = len(wav) / float(sr)
    headers = {"x-audio-duration": "%.3f" % dur}
    if seed is not None:
        headers["x-seed"] = str(seed)
    return Response(content=_to_wav_bytes(wav, sr),
                    media_type="audio/wav", headers=headers)


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
                 temperature, top_p, repetition_penalty):
        if seed is not None:
            self._torch.manual_seed(seed)
        wavs, sr = self.model.generate_voice_clone(
            text=text, language=language, voice_clone_prompt=prompt,
            temperature=temperature, top_p=top_p,
            repetition_penalty=repetition_penalty,
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
    # Skip the heavy load when a fake was injected (tests) or explicitly disabled.
    if getattr(app.state, "synth", None) is not None:
        return
    if os.environ.get("QWEN_TTS_SKIP_LOAD") == "1":
        return
    app.state.synth = QwenSynth(device=_resolve_device(os.environ.get("QWEN_TTS_DEVICE", "cuda:0")))
