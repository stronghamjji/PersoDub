"""TTS socket specification.

Every TTS engine (Qwen3-TTS, and later MOSS, ChatterBox, etc.) follows this spec.
The rest of the app talks only through this spec, so swapping engines leaves the app unchanged.
"""
from dataclasses import dataclass
from typing import Dict, List, Optional


@dataclass
class SynthesisRequest:
    """A single-line speech generation request (what you plug into the socket)."""
    text: str
    ref_audio: Optional[str] = None   # Sample voice path (a location the engine server can read)
    ref_text: Optional[str] = None    # Transcript of the sample voice (audio and text must match)
    voice_id: Optional[str] = None    # Pre-registered voice (skip re-cloning; Qwen /clone-once flow)
    mode: Optional[str] = None        # Qwen voice-clone mode: "timbre" | "icl" (None = engine default)
    language: Optional[str] = None
    duration: Optional[float] = None  # Length (seconds) of the slot this line goes into — a hint
    num_step: int = 32
    guidance_scale: float = 2.0
    speed: float = 1.0
    seed: Optional[int] = None


@dataclass
class SynthesisResult:
    """Generation result (what comes out of the socket)."""
    audio_bytes: bytes                # wav binary
    engine_id: str = ""
    duration: Optional[float] = None  # Length (seconds) of the generated audio
    seed: Optional[int] = None


class TTSEngine:
    """The standard socket a TTS engine must provide."""
    id: str = ""
    display_name: str = ""
    supports_cloning: bool = False

    def is_available(self) -> bool:
        """Whether this engine is currently usable."""
        raise NotImplementedError

    def synthesize(self, req: SynthesisRequest) -> SynthesisResult:
        """One line of text -> speech."""
        raise NotImplementedError


# --- Engine registry (the list of plugged-in engines) ---
_REGISTRY: Dict[str, TTSEngine] = {}


def register_engine(engine: TTSEngine) -> None:
    _REGISTRY[engine.id] = engine


def get_engine(engine_id: str) -> Optional[TTSEngine]:
    return _REGISTRY.get(engine_id)


def list_engines() -> List[TTSEngine]:
    return list(_REGISTRY.values())
