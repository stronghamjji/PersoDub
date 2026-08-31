"""/api/dub/start with source_url instead of an upload.

run_dub and source_fetch.fetch are both replaced -- no dubbing, no network.
"""
import json
import os
import time

from fastapi.testclient import TestClient
import pytest

import app.main as main
from app.main import app


@pytest.fixture(autouse=True)
def _models_ready(monkeypatch):
    # Model files live in a kit these tests never build -- the 409
    # preflight is exercised in tests/test_dub_start_preflight.py.
    from app import main as _main
    monkeypatch.setattr(_main, "_missing_models", lambda *a, **kw: [])

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


def test_trim_cuts_the_uploaded_video(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "_cut_video", lambda src, start, end: calls.append((start, end)))
    monkeypatch.setattr(main, "run_dub", lambda **kw: None)
    r = client.post("/api/dub/start", files={"video": ("a.mp4", b"0" * 10, "video/mp4")},
                    data={"language_code": "ko", "language": "Korean", "trim_start": "2.0", "trim_end": "8.0"})
    assert r.status_code == 200
    assert calls == [(2.0, 8.0)]


def _job_files(name="input.mp4"):
    """Every job file of that name under the (temp) workspace.

    A refused trim must leave nothing behind, and the only way to see that is
    to look at the disk the endpoint writes to.
    """
    return [os.path.join(root, f)
            for root, _dirs, files in os.walk(main.WORKSPACE)
            for f in files if f == name]


@pytest.mark.parametrize("trim, expected", [
    # One half of a range says nothing about what to keep.
    ({"trim_start": "2.0"}, "both"),
    ({"trim_end": "8.0"}, "both"),
    # Before the beginning, backwards, and empty.
    ({"trim_start": "-1", "trim_end": "5"}, "0 seconds"),
    ({"trim_start": "8", "trim_end": "2"}, "0 seconds"),
    ({"trim_start": "2", "trim_end": "2"}, "0 seconds"),
    # Shorter than the screen's own minimum span.
    ({"trim_start": "1", "trim_end": "1.1"}, "half a second"),
    # inf and nan would otherwise reach ffmpeg as "-to inf".
    ({"trim_start": "0", "trim_end": "inf"}, "0 seconds"),
    ({"trim_start": "nan", "trim_end": "5"}, "0 seconds"),
])
def test_a_broken_trim_is_refused_before_anything_is_saved(monkeypatch, trim, expected):
    monkeypatch.setattr(main, "_cut_video", lambda *a: pytest.fail("must not cut"))
    monkeypatch.setattr(main, "run_dub", lambda **kw: pytest.fail("must not dub"))
    data = {"language_code": "ko", "language": "Korean", **trim}
    r = client.post("/api/dub/start", files={"video": ("a.mp4", b"0" * 10, "video/mp4")}, data=data)
    assert r.status_code == 400
    assert expected in r.json()["detail"]
    assert _job_files() == []


def test_a_non_numeric_trim_is_refused_by_request_validation(monkeypatch):
    """422, not 400: FastAPI rejects "abc" as a float before dub_start runs."""
    monkeypatch.setattr(main, "_cut_video", lambda *a: pytest.fail("must not cut"))
    monkeypatch.setattr(main, "run_dub", lambda **kw: pytest.fail("must not dub"))
    r = client.post("/api/dub/start", files={"video": ("a.mp4", b"0" * 10, "video/mp4")},
                    data={"language_code": "ko", "trim_start": "abc", "trim_end": "5"})
    assert r.status_code == 422
    assert _job_files() == []


def test_a_failed_cut_answers_with_a_sentence_and_leaves_no_job_folder(monkeypatch):
    def boom(path, start, end):
        raise RuntimeError("Could not trim the video: moov atom not found")

    monkeypatch.setattr(main, "_cut_video", boom)
    monkeypatch.setattr(main, "run_dub", lambda **kw: pytest.fail("must not dub"))
    r = client.post("/api/dub/start", files={"video": ("a.mp4", b"0" * 10, "video/mp4")},
                    data={"language_code": "ko", "trim_start": "2.0", "trim_end": "8.0"})
    assert r.status_code == 400
    assert "Could not trim the video" in r.json()["detail"]
    # No job record was created yet, so a folder left here would never be reaped.
    assert _job_files() == []


def test_a_failed_cut_reports_only_ffmpeg_s_last_line(monkeypatch):
    """ffmpeg names the input file on its way to the complaint, and the tail of
    its whole output put the user's folders on screen for nothing."""
    import subprocess

    class Failed:
        returncode = 1
        stderr = ("[in#0 @ 0x7f] Error opening input file "
                  "/Users/someone/Movies/holiday.mp4.\n"
                  "Invalid data found when processing input\n")

    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: Failed())
    with pytest.raises(RuntimeError) as e:
        main._cut_video(str(main.WORKSPACE + "/nothing.mp4"), 1.0, 2.0)
    assert str(e.value) == "Could not trim the video: Invalid data found when processing input"


def _job_json(video_path):
    """The job.json sitting beside a job's video, read as it stands right now --
    which is what a force-quit at this instant would leave behind."""
    with open(os.path.join(os.path.dirname(video_path), "job.json"), encoding="utf-8") as f:
        return json.load(f)


def test_a_link_is_cut_after_it_is_fetched_and_the_record_says_so_at_once(monkeypatch):
    """The download has to happen first -- there is nothing to cut before it.

    And the cut has to be recorded the instant it lands: a job.json still saying
    a cut is owed, over a video that has already had one, is a job that gets the
    same seconds taken out twice when it is run again.
    """
    order = []
    saved = {}

    def fake_fetch(url, dest, log=None, cancel_check=None):
        order.append("fetch")
        with open(dest, "wb") as f:
            f.write(b"FAKEVIDEO")
        saved["before"] = _job_json(dest)

    def fake_cut(path, start, end, on_cut=None):
        order.append(("cut", start, end))
        if on_cut:
            on_cut()   # the real _cut_video calls this the moment os.replace lands
        saved["after"] = _job_json(path)

    monkeypatch.setattr(main, "fetch_source", fake_fetch)
    monkeypatch.setattr(main, "_cut_video", fake_cut)
    monkeypatch.setattr(main, "run_dub", lambda **kw: order.append("dub"))

    r = client.post("/api/dub/start",
                    data={"language_code": "ko", "source_url": "https://youtu.be/abc",
                          "trim_start": "2.0", "trim_end": "8.0"})
    assert r.status_code == 200
    _wait_done(r.json()["job_id"])
    assert order == ["fetch", ("cut", 2.0, 8.0), "dub"]
    # Downloaded but not yet cut: the whole video is on disk and the cut is owed.
    assert saved["before"]["trim_pending"] is True
    assert saved["before"]["trim"] == {"start": 2.0, "end": 8.0}
    # Cut: owed no longer, and written before anything else could happen.
    assert saved["after"]["trim_pending"] is False
