"""Qwen3-TTS adapter.

Wraps the local Qwen3-TTS FastAPI sidecar (POST /generate) in the standard
socket spec (app/engines/base.py). Qwen does not use num_step / guidance_scale /
speed -- those are generic knobs the socket spec defines for other engines.
"""
import os
from typing import Dict, Optional

import httpx

from app.config import QWEN_TTS_URL, QWEN_VOICE_MODE
from app.engines.base import (
    SynthesisRequest,
    SynthesisResult,
    TTSEngine,
)

# /generate timeout, env-overridable (PERSODUB_TTS_TIMEOUT) -- Mac CPUs are
# slower than the server's. Garbage/unset falls back to 300.
try:
    PERSODUB_TTS_TIMEOUT = float(os.environ.get("PERSODUB_TTS_TIMEOUT", "300"))
except (TypeError, ValueError):
    PERSODUB_TTS_TIMEOUT = 300.0


class QwenTTSEngine(TTSEngine):
    id = "qwen3_tts"
    display_name = "Qwen3-TTS (local voice clone)"
    supports_cloning = True

    def __init__(self, base_url: str = QWEN_TTS_URL):
        self.base_url = base_url.rstrip("/")

    def is_available(self) -> bool:
        """True only when the sidecar answers and the model is loaded."""
        try:
            r = httpx.get(self.base_url + "/health", timeout=5)
            return r.status_code == 200 and bool(r.json().get("model_loaded"))
        except Exception:
            return False

    def device_label(self) -> Optional[str]:
        """Human-readable compute device, or None when it cannot be known.

        Users cannot otherwise tell a GPU run from a CPU one except by how long
        they wait -- and on Windows, where only NVIDIA is accelerated, "it's
        slow" is nearly always "it ran on CPU". None (rather than a guess) when
        the sidecar is unreachable or predates the /health field.
        """
        try:
            r = httpx.get(self.base_url + "/health", timeout=5)
            device = r.json().get("device") if r.status_code == 200 else None
        except Exception:
            return None
        if not device:
            return None
        if device.startswith("cpu"):
            return "CPU — no GPU acceleration"
        if device.startswith("mps"):
            return "GPU (Apple)"
        return f"GPU ({device})"

    def _build_form(self, req: SynthesisRequest) -> Dict[str, str]:
        """Convert the request into /generate form fields (network-free, so it
        can be unit-tested). ref_audio is a file upload, sent in synthesize."""
        form = {"text": req.text}  # type: Dict[str, str]
        if req.language:
            form["language"] = req.language
        if req.voice_id:
            form["voice_id"] = req.voice_id
        if req.ref_text:
            form["ref_text"] = req.ref_text
        form["mode"] = req.mode or QWEN_VOICE_MODE
        if req.seed is not None:
            form["seed"] = str(req.seed)
        return form

    def clone(self, ref_audio_path: str, ref_text: str = None, mode: str = None) -> str:
        """Register a reference voice once (POST /clone) and return its voice_id.

        Reusing the returned voice_id in later synthesize() calls (via
        SynthesisRequest.voice_id) skips re-uploading + re-cloning the reference
        audio on every line.

        mode: "timbre" (ref_text optional/ignored) | "icl" (ref_text required).
        Defaults to config.QWEN_VOICE_MODE when omitted.
        """
        resolved_mode = mode or QWEN_VOICE_MODE
        if resolved_mode == "icl" and (not ref_text or not ref_text.strip()):
            raise ValueError(
                "Qwen3-TTS ICL voice clone requires ref_text (the transcript of the "
                "reference audio); empty ref_text is rejected by the model.")
        data = {"mode": resolved_mode}
        if ref_text:
            data["ref_text"] = ref_text
        with open(ref_audio_path, "rb") as f:
            r = httpx.post(
                self.base_url + "/clone",
                data=data,
                files={"ref_audio": (os.path.basename(ref_audio_path), f, "audio/wav")},
                timeout=120,
            )
        r.raise_for_status()
        return r.json()["voice_id"]

    def synthesize(self, req: SynthesisRequest) -> SynthesisResult:
        # Qwen ICL clone REQUIRES ref_text; fail early with a clear message.
        # (voice_id-only requests reuse an already-cloned prompt server-side, so
        # they carry no ref_audio/ref_text here and skip this check. Timbre mode
        # never needs ref_text.)
        resolved_mode = req.mode or QWEN_VOICE_MODE
        if req.ref_audio and not req.ref_text and resolved_mode == "icl":
            raise ValueError(
                "Qwen3-TTS ICL voice clone requires ref_text (the transcript of the "
                "reference audio); empty ref_text is rejected by the model.")
        form = self._build_form(req)
        files = None
        ref_file = None
        if req.ref_audio:
            if not os.path.exists(req.ref_audio):
                raise FileNotFoundError(
                    "Sample voice file not found: " + req.ref_audio)
            ref_file = open(req.ref_audio, "rb")
            files = {"ref_audio": (os.path.basename(req.ref_audio),
                                   ref_file, "audio/wav")}
        try:
            r = httpx.post(self.base_url + "/generate",
                           data=form, files=files, timeout=PERSODUB_TTS_TIMEOUT)
        finally:
            if ref_file is not None:
                ref_file.close()
        r.raise_for_status()
        dur = r.headers.get("x-audio-duration")
        seed = r.headers.get("x-seed")
        return SynthesisResult(
            audio_bytes=r.content,
            engine_id=self.id,
            duration=float(dur) if dur else None,
            seed=int(seed) if seed else None,
        )
