"""GET /api/whats-new: the bundled release notes the update popup shows."""
from fastapi.testclient import TestClient

from app import main
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


def test_whats_new_returns_version_and_notes():
    r = client.get("/api/whats-new")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body["version"], str)
    assert isinstance(body["notes"], list) and body["notes"]
    assert all(isinstance(n, str) for n in body["notes"])


def test_whats_new_survives_a_missing_file(monkeypatch, tmp_path):
    import os
    real_join = os.path.join

    def fake_join(*parts):
        p = real_join(*parts)
        return str(tmp_path / "gone.json") if p.endswith("whats_new.json") else p

    monkeypatch.setattr(main.os.path, "join", fake_join)
    r = client.get("/api/whats-new")
    assert r.status_code == 200
    assert r.json()["notes"] == []
