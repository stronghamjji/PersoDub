"""The voice engines this app has, registered once per process in base.py's
registry: Qwen3-TTS on this computer.

Here, in the package, so importing any engine module registers it: a remade
line (app/qwen_pipeline.resynth_one_line) reads the registry, and must not
depend on an API module having been imported first.
"""
from app.engines.base import get_engine, register_engine
from app.engines.omnivoice import OmniVoiceEngine
from app.engines.qwen_tts import QwenTTSEngine

register_engine(QwenTTSEngine())
register_engine(OmniVoiceEngine())

# The voice choice as the Settings screen and kit.env name it (TTS_ENGINE:
# "qwen3" | "omnivoice") -> the registered engine behind it.
VOICE_ENGINE_IDS = {"qwen3": "qwen3_tts", "omnivoice": "omnivoice"}


def engine_for(voice):
    """The engine a dub's voice choice names; Qwen3-TTS for an unknown or empty one."""
    return get_engine(VOICE_ENGINE_IDS.get((voice or "").lower(), "qwen3_tts"))
