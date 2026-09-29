"""Qwen3-TTS adapter.

Wraps the local Qwen3-TTS FastAPI sidecar (POST /generate) in the standard
socket spec (app/engines/base.py). Qwen does not use num_step / guidance_scale /
speed -- those are generic knobs the socket spec defines for other engines.
"""
import os
from typing import Dict, Optional

import httpx

from app import runtime
from app.config import QWEN_VOICE_MODE
from app.engines.base import (
    SynthesisCut,
    SynthesisRequest,
    SynthesisResult,
    SynthesisTimeout,
    TTSEngine,
)

# Two ceilings per line, both from the slot the line goes into (the time its
# speaker's mouth moves). One line of 5.5s ran away for 15 minutes on a Mac
# (2026-09-23): the model's own cap is 4096 tokens = 5.5 MINUTES of speech,
# and the app waited a flat PERSODUB_TTS_TIMEOUT (900s in kit.env) per line,
# then the next line waited behind it. Measured on an M4: a normal line takes
# 4-9s, the slowest seen 70s; on an RTX 3080, 8s.
#
# Speech cap: slot x 3 + 2s -- a normal line is 1.0-1.5x its slot, so only a
# runaway reaches it. Waiting cap: slot x 10 + 60s -- twice the slowest normal
# line, with room for a CPU-only machine. PERSODUB_TTS_WAIT_SCALE (kit.env)
# stretches the waiting cap for a slow machine; nothing stretches the speech
# cap, since more speech than that is never right.
TTS_CAP_FACTOR = 3.0
TTS_CAP_EXTRA = 2.0
TTS_CAP_UNKNOWN = 30.0      # a line whose slot is not known
TTS_WAIT_FACTOR = 10.0
TTS_WAIT_EXTRA = 60.0
TTS_WAIT_UNKNOWN = 120.0
# A Windows PC without an NVIDIA GPU makes voices on the CPU, which nobody has
# measured yet; it waits five times as long rather than fail a slow line.
_DEFAULT_WAIT_SCALE = "5" if os.environ.get("PERSODUB_TORCH_VARIANT", "").lower() == "cpu" else "1"
try:
    PERSODUB_TTS_WAIT_SCALE = max(0.1, float(os.environ.get("PERSODUB_TTS_WAIT_SCALE", _DEFAULT_WAIT_SCALE)))
except (TypeError, ValueError):
    PERSODUB_TTS_WAIT_SCALE = float(_DEFAULT_WAIT_SCALE)
# Registering a voice includes, the first time, loading the 4 GB model: one
# took over two minutes (2026-09-16). It gets its own, longer wait.
CLONE_WAIT_SECONDS = 600.0


# Never below this: a line squeezed into a sliver of a slot (0.01s after
# borrowing) is still a whole sentence, and must not read as a runaway.
TTS_CAP_FLOOR = 8.0


def speech_cap_seconds(slot: Optional[float]) -> float:
    """The most speech one line may be: past this the model has run away."""
    if not slot or slot <= 0 or slot != slot:     # unknown, or NaN
        return TTS_CAP_UNKNOWN
    return round(max(slot * TTS_CAP_FACTOR + TTS_CAP_EXTRA, TTS_CAP_FLOOR), 2)


def wait_seconds(slot: Optional[float]) -> float:
    """How long to wait for one line's answer before giving up on it."""
    base = TTS_WAIT_UNKNOWN if not slot or slot <= 0 else slot * TTS_WAIT_FACTOR + TTS_WAIT_EXTRA
    return round(base * PERSODUB_TTS_WAIT_SCALE, 2)


class QwenTTSEngine(TTSEngine):
    id = "qwen3_tts"
    display_name = "Qwen3-TTS (local voice clone)"
    supports_cloning = True

    def __init__(self, base_url: Optional[str] = None):
        self._base_url = base_url

    @property
    def base_url(self) -> str:
        """Read at every use, not once at construction: the engine registered
        at import (app/api/misc.py) must see a sidecar the desktop shell starts
        later in the session, when the engine pack is installed on demand."""
        return (self._base_url or runtime.url("tts")).rstrip("/")

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
        # The speech cap travels with the request; the sidecar turns it into
        # a token count (desktop/vendor/sidecar/server.py).
        form["max_seconds"] = "%.2f" % speech_cap_seconds(req.duration)
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
                # The same clock as /generate: on a machine that is also
                # dubbing, a clone outlived 120 seconds (2026-09-16).
                timeout=CLONE_WAIT_SECONDS * PERSODUB_TTS_WAIT_SCALE,
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
        wait = req.wait or wait_seconds(req.duration)
        try:
            r = httpx.post(self.base_url + "/generate",
                           data=form, files=files, timeout=wait)
        except httpx.TimeoutException as e:
            raise SynthesisTimeout(wait) from e
        finally:
            if ref_file is not None:
                ref_file.close()
        r.raise_for_status()
        dur = r.headers.get("x-audio-duration")
        seed = r.headers.get("x-seed")
        if r.headers.get("x-audio-cut") == "1":
            # Reached the speech cap: the sentence never ended. Not audio to
            # keep -- it stops mid-word -- so the line is reported, not saved.
            raise SynthesisCut(float(dur) if dur else speech_cap_seconds(req.duration), req.duration)
        return SynthesisResult(
            audio_bytes=r.content,
            engine_id=self.id,
            duration=float(dur) if dur else None,
            seed=int(seed) if seed else None,
        )
