"""/api/dub/start with source_url instead of an upload.

run_dub and source_fetch.fetch are both replaced -- no dubbing, no network.
"""
import time

from fastapi.testclient import TestClient
import pytest

import app.main as main
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


@pytest.fixture(autouse=True)
def _all_engines_available(monkeypatch):
    monkeypatch.setattr(main, "gemma_available", lambda: True)
    monkeypatch.setattr(main, "qwen_available", lambda: True)
    monkeypatch.setattr(main, "gemma_status", lambda: "available")
    monkeypatch.setattr(main, "qwen_status", lambda: "available")
    monkeypatch.setattr(main, "gemini_available", lambda: True)
    monkeypatch.setattr(main, "perso_available", lambda: True)


def _wait_done(jid, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = client.get(f"/api/dub/jobs/{jid}").json()["status"]
        if status in ("done", "error", "cancelled"):
            return status
        time.sleep(0.02)
    raise AssertionError("job never finished")


def test_rejects_neither_video_nor_url():
    r = client.post("/api/dub/start", data={"language_code": "en"})
    assert r.status_code == 422
    assert "video" in str(r.json()).lower() or "source_url" in str(r.json()).lower()


def test_rejects_both_video_and_url():
    r = client.post(
        "/api/dub/start",
        data={"language_code": "en", "source_url": "https://youtu.be/abc"},
        files={"video": ("v.mp4", b"FAKE", "video/mp4")},
    )
    assert r.status_code == 422


def test_url_job_fetches_before_dubbing(monkeypatch):
    order = []

    def fake_fetch(url, dest, log=None, cancel_check=None):
        order.append("fetch")
        with open(dest, "wb") as f:
            f.write(b"FAKEMP4")

    def fake_run_dub(**kw):
        order.append("dub")
        with open(kw["out_path"], "wb") as f:
            f.write(b"FAKEDUB")
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1,
                "auto_translated": False}

    monkeypatch.setattr(main, "fetch_source", fake_fetch)
    monkeypatch.setattr(main, "run_dub", fake_run_dub)

    r = client.post("/api/dub/start",
                    data={"language_code": "en", "source_url": "https://youtu.be/abc"})
    assert r.status_code == 200
    _wait_done(r.json()["job_id"])
    assert order == ["fetch", "dub"]


def test_fetch_failure_fails_the_job_with_the_human_message(monkeypatch):
    from app.source_fetch import FetchError

    def boom(url, dest, log=None, cancel_check=None):
        raise FetchError("geo", "This video isn't available in your region.")

    monkeypatch.setattr(main, "fetch_source", boom)
    monkeypatch.setattr(main, "run_dub", lambda **kw: pytest.fail("must not dub"))

    r = client.post("/api/dub/start",
                    data={"language_code": "en", "source_url": "https://youtu.be/abc"})
    jid = r.json()["job_id"]
    assert _wait_done(jid) == "error"
    job = client.get(f"/api/dub/jobs/{jid}").json()
    assert "region" in str(job).lower()
