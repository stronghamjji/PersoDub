import httpx
import pytest
from fastapi.testclient import TestClient

from app.engines.base import SynthesisRequest
from app.engines.qwen_tts import QwenTTSEngine
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


def test_build_form_drops_unused_synthesis_knobs():
    form = QwenTTSEngine()._build_form(SynthesisRequest(text="안녕"))
    assert form["text"] == "안녕"
    # Qwen has no num_step / guidance_scale / speed.
    assert "num_step" not in form
    assert "guidance_scale" not in form
    assert "speed" not in form


def test_build_form_with_clone():
    req = SynthesisRequest(text="안녕", ref_audio="/x/ref.wav",
                           ref_text="hello there", language="Korean", seed=7)
    form = QwenTTSEngine()._build_form(req)
    assert "ref_audio" not in form          # file upload, not form data
    assert form["ref_text"] == "hello there"
    assert form["language"] == "Korean"
    assert form["seed"] == "7"


def test_synthesize_requires_ref_text_when_cloning_in_icl_mode(tmp_path):
    p = tmp_path / "ref.wav"
    p.write_bytes(b"RIFF")
    with pytest.raises(ValueError):
        QwenTTSEngine().synthesize(
            SynthesisRequest(text="안녕", ref_audio=str(p), mode="icl"))


class _FakeResp:
    content = b"WAVDATA"
    headers = {"x-audio-duration": "1.23", "x-seed": "7"}

    def raise_for_status(self):
        return None


def test_synthesize_parses_headers(monkeypatch):
    captured = {}

    def fake_post(url, data=None, files=None, timeout=None):
        captured["url"] = url
        return _FakeResp()

    monkeypatch.setattr(httpx, "post", fake_post)
    res = QwenTTSEngine(base_url="http://x").synthesize(
        SynthesisRequest(text="안녕", language="Korean", seed=7))
    assert res.audio_bytes == b"WAVDATA"
    assert res.engine_id == "qwen3_tts"
    assert res.duration == 1.23
    assert res.seed == 7
    assert captured["url"] == "http://x/generate"


def test_is_available_true(monkeypatch):
    class R:
        status_code = 200
        def json(self):
            return {"status": "ok", "model_loaded": True}
    monkeypatch.setattr(httpx, "get", lambda *a, **k: R())
    assert QwenTTSEngine(base_url="http://x").is_available() is True


def test_is_available_false_when_model_not_loaded(monkeypatch):
    class R:
        status_code = 200
        def json(self):
            return {"status": "ok", "model_loaded": False}
    monkeypatch.setattr(httpx, "get", lambda *a, **k: R())
    assert QwenTTSEngine(base_url="http://x").is_available() is False


def test_is_available_false_when_down(monkeypatch):
    def boom(*a, **k):
        raise httpx.ConnectError("no route")
    monkeypatch.setattr(httpx, "get", boom)
    assert QwenTTSEngine(base_url="http://x").is_available() is False


def test_engines_endpoint_lists_qwen():
    r = client.get("/api/tts/engines")
    assert r.status_code == 200
    ids = [e["id"] for e in r.json()["engines"]]
    assert "qwen3_tts" in ids


def test_build_form_with_voice_id_omits_ref_text():
    req = SynthesisRequest(text="안녕", voice_id="v123", language="Korean", seed=7)
    form = QwenTTSEngine()._build_form(req)
    assert form["voice_id"] == "v123"
    assert "ref_text" not in form


def test_clone_posts_ref_audio_and_returns_voice_id(monkeypatch, tmp_path):
    p = tmp_path / "ref.wav"
    p.write_bytes(b"RIFFxxxx")
    captured = {}

    class _R:
        def raise_for_status(self):
            return None

        def json(self):
            return {"voice_id": "abc123"}

    def fake_post(url, data=None, files=None, timeout=None):
        captured["url"] = url
        captured["data"] = data
        captured["files"] = files
        return _R()

    monkeypatch.setattr(httpx, "post", fake_post)
    vid = QwenTTSEngine(base_url="http://x").clone(str(p), "hello there", mode="icl")
    assert vid == "abc123"
    assert captured["url"] == "http://x/clone"
    assert captured["data"] == {"mode": "icl", "ref_text": "hello there"}
    assert "ref_audio" in captured["files"]


def test_clone_requires_ref_text_in_icl_mode():
    with pytest.raises(ValueError):
        QwenTTSEngine().clone("/x/ref.wav", "  ", mode="icl")


def test_clone_defaults_to_timbre_mode_no_ref_text_needed(monkeypatch, tmp_path):
    p = tmp_path / "ref.wav"
    p.write_bytes(b"RIFFxxxx")
    captured = {}

    class _R:
        def raise_for_status(self):
            return None

        def json(self):
            return {"voice_id": "xyz789"}

    def fake_post(url, data=None, files=None, timeout=None):
        captured["data"] = data
        return _R()

    monkeypatch.setattr(httpx, "post", fake_post)
    vid = QwenTTSEngine(base_url="http://x").clone(str(p))  # no ref_text, no mode
    assert vid == "xyz789"
    assert captured["data"] == {"mode": "timbre"}


def test_synthesize_timbre_mode_allows_ref_audio_without_ref_text(monkeypatch, tmp_path):
    p = tmp_path / "ref.wav"
    p.write_bytes(b"RIFF")
    monkeypatch.setattr(httpx, "post", lambda *a, **k: _FakeResp())
    res = QwenTTSEngine(base_url="http://x").synthesize(
        SynthesisRequest(text="안녕", ref_audio=str(p), mode="timbre"))
    assert res.audio_bytes == b"WAVDATA"


def test_synthesize_with_voice_id_sends_no_files(monkeypatch):
    captured = {}

    def fake_post(url, data=None, files=None, timeout=None):
        captured["files"] = files
        captured["data"] = data
        return _FakeResp()

    monkeypatch.setattr(httpx, "post", fake_post)
    QwenTTSEngine(base_url="http://x").synthesize(
        SynthesisRequest(text="안녕", voice_id="v123", language="Korean"))
    assert captured["files"] is None
    assert captured["data"]["voice_id"] == "v123"


# --- Mac CPUs run slower than the server's: the /generate timeout is
# env-overridable (PERSODUB_TTS_TIMEOUT) so a Mac install isn't stuck with a
# server-tuned budget ---

def test_generate_timeout_honours_env_override(monkeypatch):
    import importlib

    from app.engines import qwen_tts as qt

    monkeypatch.setenv("PERSODUB_TTS_TIMEOUT", "42")
    importlib.reload(qt)
    try:
        assert qt.PERSODUB_TTS_TIMEOUT == 42.0
    finally:
        monkeypatch.undo()
        importlib.reload(qt)


def test_generate_timeout_garbage_env_falls_back_to_default(monkeypatch):
    import importlib

    from app.engines import qwen_tts as qt

    monkeypatch.setenv("PERSODUB_TTS_TIMEOUT", "banana")
    importlib.reload(qt)
    try:
        assert qt.PERSODUB_TTS_TIMEOUT == 300.0
    finally:
        monkeypatch.undo()
        importlib.reload(qt)
