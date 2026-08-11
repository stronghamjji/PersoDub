"""POST /api/source/probe -- metadata for the confirm card.

app.source_fetch.probe is replaced in every test; nothing here reaches YouTube.
"""
from fastapi.testclient import TestClient

import app.main as main
from app.main import app
from app.source_fetch import FetchError

client = TestClient(app, base_url="http://127.0.0.1")


def test_probe_returns_metadata(monkeypatch):
    monkeypatch.setattr(main, "probe_source", lambda url: {
        "title": "How to make sourdough bread",
        "duration_sec": 1392,
        "thumbnail_url": "https://i.ytimg.com/vi/abc/hq.jpg",
        "site": "Youtube",
    })
    r = client.post("/api/source/probe", json={"url": "https://youtu.be/abc"})
    assert r.status_code == 200
    assert r.json()["title"] == "How to make sourdough bread"
    assert r.json()["duration_sec"] == 1392


def test_probe_surfaces_the_reason_and_message(monkeypatch):
    def boom(url):
        raise FetchError("login", "This video needs a sign-in, so it can't be fetched.")

    monkeypatch.setattr(main, "probe_source", boom)
    r = client.post("/api/source/probe", json={"url": "https://youtu.be/abc"})
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["reason"] == "login"
    assert "sign-in" in detail["message"]


def test_probe_rejects_a_non_web_url(monkeypatch):
    # No monkeypatch of probe_source: validate_url inside it must do the work.
    r = client.post("/api/source/probe", json={"url": "file:///etc/passwd"})
    assert r.status_code == 422
    assert r.json()["detail"]["reason"] == "unsupported"
