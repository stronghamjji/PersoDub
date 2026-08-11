"""Result downloads: original.mp4 / dubbed_<lang>.mp4 / dubbed_<lang>.srt."""
import os
import time

from fastapi.testclient import TestClient
import pytest

import app.main as main
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


@pytest.fixture(autouse=True)
def _all_engines_available(monkeypatch):
    for name in ("gemma_available", "qwen_available", "gemini_available", "perso_available"):
        monkeypatch.setattr(main, name, lambda: True)
    monkeypatch.setattr(main, "gemma_status", lambda: "available")
    monkeypatch.setattr(main, "qwen_status", lambda: "available")


def _finished_job(monkeypatch, target="en"):
    """Start a real upload job whose pipeline is faked, and wait for it."""
    def fake_run_dub(**kw):
        work = os.path.dirname(kw["out_path"])
        with open(kw["out_path"], "wb") as f:
            f.write(b"FAKEDUB")
        with open(os.path.join(work, "translated.srt"), "w", encoding="utf-8") as f:
            f.write("1\n00:00:00,000 --> 00:00:01,000\nhello\n")
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1,
                "auto_translated": True}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)
    r = client.post("/api/dub/start",
                    data={"language_code": target},
                    files={"video": ("v.mp4", b"FAKEMP4", "video/mp4")})
    jid = r.json()["job_id"]
    deadline = time.time() + 5
    while time.time() < deadline:
        if client.get(f"/api/dub/jobs/{jid}").json()["status"] == "done":
            return jid
        time.sleep(0.02)
    raise AssertionError("job never finished")


def test_dub_download_is_named_for_the_target_language(monkeypatch):
    jid = _finished_job(monkeypatch, target="ko")
    r = client.get(f"/api/dub/result/{jid}")
    assert r.status_code == 200
    assert 'filename="dubbed_ko.mp4"' in r.headers["content-disposition"]


def test_original_is_downloadable(monkeypatch):
    jid = _finished_job(monkeypatch)
    r = client.get(f"/api/dub/result/{jid}/original")
    assert r.status_code == 200
    assert r.content == b"FAKEMP4"
    assert 'filename="original.mp4"' in r.headers["content-disposition"]


def test_original_404s_when_the_job_is_unknown():
    assert client.get("/api/dub/result/nope/original").status_code == 404


def test_srt_download_has_a_filename(monkeypatch):
    jid = _finished_job(monkeypatch, target="ja")
    r = client.get(f"/api/dub/result/{jid}/srt?download=1")
    assert r.status_code == 200
    assert 'filename="dubbed_ja.srt"' in r.headers["content-disposition"]


def test_srt_viewer_response_is_unchanged(monkeypatch):
    # The in-app subtitle viewer fetches this without ?download -- it must keep
    # returning plain text with no attachment header.
    jid = _finished_job(monkeypatch)
    r = client.get(f"/api/dub/result/{jid}/srt")
    assert r.status_code == 200
    assert "content-disposition" not in {k.lower() for k in r.headers}
    assert "hello" in r.text
