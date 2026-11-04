import os
import subprocess
import sys

from fastapi.testclient import TestClient

from app.engines.base import (
    TTSEngine,
    get_engine,
    list_engines,
    register_engine,
)
from app.engines.qwen_tts import QwenTTSEngine
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


class FakeEngine(TTSEngine):
    id = "fake"
    display_name = "Fake"
    supports_cloning = False

    def is_available(self):
        return True


def test_register_and_get():
    register_engine(FakeEngine())
    assert get_engine("fake") is not None
    assert any(e.id == "fake" for e in list_engines())


def test_get_unknown_returns_none():
    assert get_engine("does-not-exist") is None


def test_engines_endpoint_lists_qwen3_tts():
    r = client.get("/api/tts/engines")
    assert r.status_code == 200
    ids = [e["id"] for e in r.json()["engines"]]
    assert "qwen3_tts" in ids


def test_the_voice_engine_is_registered_without_the_api_module():
    # A remade line (app/qwen_pipeline.resynth_one_line) reads the registry,
    # which used to be filled only once app/api/misc.py had been imported.
    code = ("import sys; import app.qwen_pipeline; from app.engines.base import list_engines; "
            "print([e.id for e in list_engines()], 'app.api.misc' in sys.modules)")
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = subprocess.run([sys.executable, "-c", code], cwd=root, capture_output=True, text=True,
                         encoding="utf-8", check=True).stdout
    assert out.strip() == "['qwen3_tts', 'omnivoice'] False"


def test_the_voice_choice_names_its_engine():
    # kit.env TTS_ENGINE / a dub's "tts" -> the engine that makes its voices;
    # anything else (an old job without one) is Qwen3-TTS, as before.
    from app.engines import engine_for
    assert engine_for("qwen3").id == "qwen3_tts"
    assert engine_for("omnivoice").id == "omnivoice"
    assert engine_for("OmniVoice").id == "omnivoice"
    assert engine_for(None).id == "qwen3_tts" and engine_for("nonsense").id == "qwen3_tts"


def test_the_voice_stage_treats_each_engine_as_it_did_by_its_id():
    # Each flag stands where app/qwen_pipeline.py asked whether the engine
    # was "qwen3_tts": Qwen3-TTS has all three, the socket's defaults none.
    flags = ("needs_spoken_numbers", "adds_stray_sounds", "free_retakes")
    assert [getattr(QwenTTSEngine, f) for f in flags] == [True, True, True]
    assert [getattr(TTSEngine, f) for f in flags] == [False, False, False]
    assert QwenTTSEngine.log_name == "Qwen"
    # OmniVoice runs on this computer like Qwen, through the same sidecar
    # contract, and keeps all three; the log names it as itself.
    from app.engines.omnivoice import OmniVoiceEngine
    assert [getattr(OmniVoiceEngine, f) for f in flags] == [True, True, True]
    assert OmniVoiceEngine.log_name == "OmniVoice"


def test_an_engine_without_a_member_keeps_the_sockets_safe_default():
    engine = FakeEngine()
    assert engine.memory_mb() is None and engine.device_label() is None
    assert engine.restart() is None
