"""OmniVoice local HTTP sidecar.

Runs INSIDE its own venv: omnivoice 0.2.1 pins a transformers version the
Qwen venv cannot take, so OmniVoice cannot live in server.py's process. It
answers the same HTTP surface as server.py (Qwen3-TTS), so the app talks to
either with the same client code.

Endpoints:
  GET  /health   -> {"status":"ok"|"loading","model_loaded":bool,"device":str|None,
                    "rss_mb":int|None}
  POST /restart  -> {"restarting":true}; the process then exits with
                    RESTART_EXIT_CODE once the line in flight is done, and the
                    desktop shell starts it again (desktop/src/orchestrator.js)
  POST /clone    -> form(ref_audio file, ref_text, mode) -> {"voice_id": str}
  POST /generate -> form(text, language, voice_id | ref_audio + ref_text, mode,
                    seed, temperature, top_p, repetition_penalty, max_seconds)
                    -> 24 kHz wav bytes + headers x-audio-duration, x-seed

ref_text (the words spoken in the reference clip) is REQUIRED wherever a
reference clip is sent: OmniVoice needs it, and without it the library would
load a Whisper model of its own to transcribe the clip, which we never ship.

Environment:
  OMNIVOICE_MODEL      local model folder (holds model.safetensors and
                       audio_tokenizer/); the kit sets it. The weights may
                       arrive after startup: they are loaded on first use.
  OMNIVOICE_DEVICE     "mps" | "cuda:0" | "cpu" | "auto" (cuda when a GPU is
                       visible, else cpu). Default "auto".
  OMNIVOICE_SKIP_LOAD  "1" skips the model load (tests).
"""
import hashlib
import os
import sys
import tempfile
import threading
import traceback

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

# The parts that do not depend on the model are server.py's own, not copies:
# the memory figure, the device choice, the wav encoding and the exit code
# the shell restarts on. server.py sits in this same folder in every kit.
from server import RESTART_EXIT_CODE, _resolve_device, _rss_mb, _to_wav_bytes

app = FastAPI(title="omnivoice-sidecar")

# Same DNS-rebinding defense as server.py: this server binds 127.0.0.1 only;
# this is depth, not the primary barrier.
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])

MODEL_PATH = os.environ.get("OMNIVOICE_MODEL", "")

# voice_id -> voice clone prompt, built once per reference clip and reused.
_PROMPTS = {}

# Guards the late load: two requests arriving right after a download must
# not both build an OmniVoiceSynth.
_LOAD_LOCK = threading.Lock()
# One model, one piece of work at a time, run off the event loop so /health
# keeps answering while a line is being made (see server.py _WORK_LOCK).
_WORK_LOCK = threading.Lock()


def _locked(fn, *args, **kwargs):
    with _WORK_LOCK:
        return fn(*args, **kwargs)


def _weights_present():
    # Both halves are needed: without audio_tokenizer/ the library would try
    # to fetch a tokenizer from the internet instead.
    return all(os.path.exists(os.path.join(MODEL_PATH, p)) for p in
               ("model.safetensors", os.path.join("audio_tokenizer", "model.safetensors")))


def _synth():
    s = getattr(app.state, "synth", None)
    if s is None:
        # Weights downloaded since startup load here, no restart needed.
        # Only weights still missing are a 503.
        if not _weights_present():
            raise HTTPException(503, "model not loaded")
        with _LOAD_LOCK:
            if getattr(app.state, "synth", None) is None:
                app.state.synth = OmniVoiceSynth(MODEL_PATH, device=app.state.device)
        s = app.state.synth
    return s


async def _prompt_for(ref_audio, ref_text):
    """The voice_id and clone prompt for one reference clip and its words,
    built on first sight and kept: the same clip sent again, whether through
    /clone or inline with /generate, is not cloned twice."""
    if not (ref_text and ref_text.strip()):
        raise HTTPException(400, "ref_text is required for an OmniVoice voice clone")
    data = await ref_audio.read()
    voice_id = hashlib.sha1(data + ref_text.encode("utf-8")).hexdigest()[:16]
    if voice_id not in _PROMPTS:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(data)
            tmp = f.name
        try:
            _PROMPTS[voice_id] = await run_in_threadpool(
                _locked, lambda: _synth().clone(tmp, ref_text))
        finally:
            os.unlink(tmp)
    return voice_id, _PROMPTS[voice_id]


@app.get("/health")
def health():
    # "loading" while the startup load runs: the app keeps waiting on that
    # answer and gives up only on silence. device is reported even without a
    # model, since it comes from the environment (see server.py health).
    return {"status": "loading" if getattr(app.state, "loading", False) else "ok",
            "model_loaded": getattr(app.state, "synth", None) is not None,
            "device": getattr(app.state, "device", None),
            "rss_mb": _rss_mb()}


@app.post("/restart")
def restart():
    """Exit once the line in flight is done, so the shell brings up a fresh
    engine with its memory given back."""
    def go():
        with _WORK_LOCK:
            sys.stdout.flush()
            sys.stderr.flush()
            os._exit(RESTART_EXIT_CODE)
    threading.Timer(0.2, go).start()
    return {"restarting": True}


# `mode` (here and in /generate), temperature, top_p and repetition_penalty
# are Qwen settings the shared client always sends; OmniVoice has no use for
# them, so they are accepted and ignored. So is max_seconds: OmniVoice has no
# token cap and always ends its sentence, so no x-audio-cut is ever sent.
@app.post("/clone")
async def clone(ref_audio: UploadFile = File(...), ref_text: str = Form(None),
                mode: str = Form(None)):
    voice_id, _ = await _prompt_for(ref_audio, ref_text)
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
    temperature: float = Form(None),
    top_p: float = Form(None),
    repetition_penalty: float = Form(None),
    max_seconds: float = Form(None),
):
    if voice_id and voice_id in _PROMPTS:
        prompt = _PROMPTS[voice_id]
    elif ref_audio is not None:
        _, prompt = await _prompt_for(ref_audio, ref_text)
    else:
        raise HTTPException(400, "provide a known voice_id or ref_audio + ref_text")

    wav, sr = await run_in_threadpool(_locked, lambda: _synth().generate(
        text=text, language=language, prompt=prompt, seed=seed))
    wav = np.asarray(wav, dtype=np.float32)
    headers = {"x-audio-duration": "%.3f" % (len(wav) / float(sr))}
    if seed is not None:
        headers["x-seed"] = str(seed)
    return Response(content=_to_wav_bytes(wav, sr),
                    media_type="audio/wav", headers=headers)


class OmniVoiceSynth:
    """Real synthesizer wrapping omnivoice.OmniVoice. torch/omnivoice are
    imported lazily here so the module (and its tests) load without them."""

    def __init__(self, model_path, device):
        import torch
        from omnivoice import OmniVoice
        self._torch = torch
        # float16 on GPUs (mps, cuda), as the model's authors run it; CPU has
        # no fast half-precision kernels, so float32 there.
        dtype = torch.float32 if str(device).startswith("cpu") else torch.float16
        # A local folder is used as it is (omnivoice _resolve_model_path only
        # downloads when the name is not a folder), so nothing goes online.
        self.model = OmniVoice.from_pretrained(model_path, device_map=device, dtype=dtype)

    def clone(self, ref_audio_path, ref_text):
        return self.model.create_voice_clone_prompt(ref_audio_path, ref_text)

    def generate(self, text, language, prompt, seed):
        if seed is not None:
            self._torch.manual_seed(seed)
        wavs = self.model.generate(text, language=language, voice_clone_prompt=prompt)
        return wavs[0], self.model.sampling_rate


@app.on_event("startup")
def _start_loading():
    # The load runs beside the server so /health can answer "loading" during
    # it (see server.py _start_loading); requests needing the model wait on
    # _LOAD_LOCK, which the load holds.
    app.state.loading = True
    _LOAD_LOCK.acquire()
    threading.Thread(target=_load_model, daemon=True).start()


def _load_model():
    try:
        device = _resolve_device(os.environ.get("OMNIVOICE_DEVICE", "auto"))
        app.state.device = device
        print(f"OMNIVOICE device={device}", flush=True)
        if getattr(app.state, "synth", None) is not None:   # a fake (tests)
            return
        if os.environ.get("OMNIVOICE_SKIP_LOAD") == "1":
            return
        if not MODEL_PATH:
            raise RuntimeError("OMNIVOICE_MODEL is not set")
        if not _weights_present():
            print(f"OMNIVOICE model not downloaded yet ({MODEL_PATH}); starting without it", flush=True)
            return
        app.state.synth = OmniVoiceSynth(MODEL_PATH, device=device)
        print("OMNIVOICE model loaded", flush=True)
    except BaseException:
        # A failed load ends the process with its traceback in the log, so the
        # app sees an engine that stopped, not one "loading" forever.
        traceback.print_exc()
        sys.stderr.flush()
        os._exit(1)
    finally:
        app.state.loading = False
        _LOAD_LOCK.release()
