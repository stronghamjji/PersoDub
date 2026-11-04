"""The OmniVoice sidecar's HTTP surface, with a fake synthesizer in place of
the model: no torch, no omnivoice, no weights. What matters is that it
answers the same way server.py (Qwen) does, since the app uses one client
for both.

Run from the repo root:
  python -m pytest -q desktop/vendor/sidecar/test_omnivoice_server.py
"""
import io
import os
import sys

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import omnivoice_server as srv   # noqa: E402

SR = 24000


class FakeSynth:
    """Records what it was asked; makes one second of silence per line."""

    def __init__(self):
        self.clones = []
        self.lines = []

    def clone(self, ref_audio_path, ref_text):
        with open(ref_audio_path, "rb") as f:
            self.clones.append((f.read(), ref_text))
        return ("prompt", ref_text)

    def generate(self, text, language, prompt, seed):
        self.lines.append((text, language, prompt, seed))
        return np.zeros(SR, dtype=np.float32), SR


@pytest.fixture
def fake(monkeypatch):
    synth = FakeSynth()
    monkeypatch.setattr(srv.app.state, "synth", synth, raising=False)
    monkeypatch.setattr(srv.app.state, "device", "cpu", raising=False)
    monkeypatch.setattr(srv.app.state, "loading", False, raising=False)
    monkeypatch.setattr(srv, "_PROMPTS", {})
    return synth


@pytest.fixture
def client():
    # Not entered as a context manager, so the startup load never runs.
    return TestClient(srv.app, base_url="http://127.0.0.1")


def _clip():
    return ("ref.wav", b"RIFF-not-really-audio", "audio/wav")


def test_health_says_loading_while_the_model_loads(fake, client, monkeypatch):
    monkeypatch.setattr(srv.app.state, "loading", True)
    assert client.get("/health").json()["status"] == "loading"


def test_health_says_ok_once_loaded(fake, client):
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["model_loaded"] is True
    assert body["device"] == "cpu"
    assert "rss_mb" in body


@pytest.mark.parametrize("ref_text", [None, "", "   "])
def test_clone_needs_the_words_of_the_clip(fake, client, ref_text):
    data = {"ref_text": ref_text} if ref_text is not None else {}
    r = client.post("/clone", files={"ref_audio": _clip()}, data=data)
    assert r.status_code == 400
    assert fake.clones == []


def test_clone_gives_the_same_voice_id_for_the_same_clip_and_words(fake, client):
    a = client.post("/clone", files={"ref_audio": _clip()}, data={"ref_text": "hello", "mode": "icl"})
    b = client.post("/clone", files={"ref_audio": _clip()}, data={"ref_text": "hello"})
    c = client.post("/clone", files={"ref_audio": _clip()}, data={"ref_text": "goodbye"})
    assert a.status_code == 200
    assert a.json()["voice_id"] == b.json()["voice_id"] != c.json()["voice_id"]
    assert len(fake.clones) == 2   # the repeat was not cloned again


def test_generate_with_a_voice_id_returns_a_wav_with_its_length_and_seed(fake, client):
    voice_id = client.post("/clone", files={"ref_audio": _clip()},
                           data={"ref_text": "hello"}).json()["voice_id"]
    # The Qwen-only fields the shared client sends are taken and ignored.
    r = client.post("/generate", data={
        "text": "안녕하세요", "language": "Korean", "voice_id": voice_id, "seed": "42",
        "mode": "icl", "temperature": "0.9", "top_p": "1.0", "max_seconds": "3.5"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    assert r.headers["x-audio-duration"] == "1.000"
    assert r.headers["x-seed"] == "42"
    assert "x-audio-cut" not in r.headers
    wav, sr = sf.read(io.BytesIO(r.content))
    assert sr == SR and len(wav) == SR
    assert fake.lines == [("안녕하세요", "Korean", ("prompt", "hello"), 42)]


def test_generate_with_an_inline_clip_needs_its_words(fake, client):
    r = client.post("/generate", files={"ref_audio": _clip()}, data={"text": "hi"})
    assert r.status_code == 400
    ok = client.post("/generate", files={"ref_audio": _clip()}, data={"text": "hi", "ref_text": "hello"})
    assert ok.status_code == 200
    assert "x-seed" not in ok.headers


def test_generate_without_a_voice_or_clip_is_a_400(fake, client):
    r = client.post("/generate", data={"text": "hi", "voice_id": "unknown"})
    assert r.status_code == 400
    assert fake.lines == []


def test_generate_is_a_503_when_no_model_and_no_weights(client, monkeypatch, tmp_path):
    monkeypatch.setattr(srv.app.state, "synth", None, raising=False)
    monkeypatch.setattr(srv, "MODEL_PATH", str(tmp_path))
    r = client.post("/generate", files={"ref_audio": _clip()}, data={"text": "hi", "ref_text": "hello"})
    assert r.status_code == 503


@pytest.mark.skipif(not os.environ.get("OMNIVOICE_MODEL"), reason="set OMNIVOICE_MODEL to run the real model")
def test_real_model_speaks(tmp_path):
    # Once with the real weights, so a change in omnivoice's own names or
    # shapes is caught here and not in a dub.
    pytest.importorskip("omnivoice")
    synth = srv.OmniVoiceSynth(os.environ["OMNIVOICE_MODEL"],
                               srv._resolve_device(os.environ.get("OMNIVOICE_DEVICE", "auto")))
    ref = tmp_path / "ref.wav"
    t = np.arange(SR * 3) / SR
    sf.write(str(ref), (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), SR)
    wav, sr = synth.generate("Hello there.", "English", synth.clone(str(ref), "Hello there."), 1)
    assert sr == SR and len(wav) > SR // 4
