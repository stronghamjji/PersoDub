from fastapi.testclient import TestClient

from app.engines.base import (
    TTSEngine,
    get_engine,
    list_engines,
    register_engine,
)
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
    assert "omnivoice" not in ids
