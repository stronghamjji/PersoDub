"""One dub at a time: later jobs wait their turn and start on their own.

The rule lives in JobStore.start -- every door that starts a dub (a new
upload, Try again, a redub) goes through it, so none of them can run two
pipelines at once on a laptop that can barely afford one.
"""
import json
import os
import threading
import time

from fastapi.testclient import TestClient
import pytest

from app.jobs import JobStore
import app.main as main
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


@pytest.fixture(autouse=True)
def _all_engines_available(monkeypatch):
    monkeypatch.setattr(main, "gemma_available", lambda: True)
    monkeypatch.setattr(main, "gemma_status", lambda: "available")
    monkeypatch.setattr(main, "gemini_available", lambda: True)
    monkeypatch.setattr(main, "perso_available", lambda: True)
    monkeypatch.setattr(main, "_missing_models", lambda *a, **kw: [])


def _start(name="v.mp4"):
    r = client.post(
        "/api/dub/start",
        files={"video": (name, b"video-bytes", "video/mp4")},
        data={"language": "English", "language_code": "en"},
    )
    assert r.status_code == 200
    return r.json()


def _status(jid):
    return client.get(f"/api/dub/jobs/{jid}").json()["status"]


def _wait(jid, wanted, secs=5.0):
    deadline = time.time() + secs
    while time.time() < deadline:
        if _status(jid) in wanted:
            return _status(jid)
        time.sleep(0.02)
    return _status(jid)


@pytest.fixture
def slow_dub(monkeypatch):
    """A run_dub that holds until released, recording who ran and when."""
    gate = threading.Event()
    ran = []

    def fake_run_dub(**kw):
        ran.append(kw["out_path"])
        gate.wait(timeout=10)
        return {"out_path": kw["out_path"]}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)
    yield gate, ran
    gate.set()          # never leave a later test queued behind this one
    time.sleep(0.05)


def test_a_second_dub_waits_until_the_first_is_done(slow_dub):
    gate, ran = slow_dub
    first = _start("첫번째.mp4")
    second = _start("두번째.mp4")

    assert first["status"] == "running"
    # The answer the screen builds its toast from says the job is waiting --
    # and the pipeline really has not been entered for it.
    assert second["status"] == "queued"
    assert _status(second["job_id"]) == "queued"
    assert len(ran) == 1

    gate.set()
    assert _wait(first["job_id"], ("done",)) == "done"
    # Nobody pressed anything: the queue itself starts the next one.
    assert _wait(second["job_id"], ("done",)) == "done"
    assert len(ran) == 2


def test_a_queued_job_can_be_cancelled_and_is_skipped(slow_dub):
    gate, ran = slow_dub
    first = _start("첫번째.mp4")
    second = _start("두번째.mp4")
    third = _start("세번째.mp4")

    r = client.post(f"/api/dub/jobs/{second['job_id']}/cancel")
    assert r.status_code == 200
    # No thread to wind down: a waiting job stops the moment it is told to.
    assert _status(second["job_id"]) == "cancelled"

    gate.set()
    assert _wait(first["job_id"], ("done",)) == "done"
    assert _wait(third["job_id"], ("done",)) == "done"
    assert _status(second["job_id"]) == "cancelled"
    # The cancelled job never reached the pipeline.
    assert len(ran) == 2


def test_try_again_waits_its_turn_too(slow_dub, monkeypatch):
    gate, ran = slow_dub
    first = _start("첫번째.mp4")
    gate.set()
    assert _wait(first["job_id"], ("done",)) == "done"
    gate.clear()

    blocker = _start("막는쪽.mp4")
    assert blocker["status"] == "running"
    r = client.post(f"/api/dub/jobs/{first['job_id']}/retry")
    assert r.status_code == 200
    retry_jid = r.json()["job_id"]
    assert _status(retry_jid) == "queued"

    gate.set()
    assert _wait(blocker["job_id"], ("done",)) == "done"
    assert _wait(retry_jid, ("done",)) == "done"


def test_restore_keeps_a_queued_job_in_the_queue(tmp_path):
    """A queued job's thread never existed, so a restart loses nothing about
    it -- unlike a running one, it must come back still waiting rather than
    as an error."""
    work = tmp_path / "day" / "proj_en"
    work.mkdir(parents=True)
    (work / "job.json").write_text(json.dumps({
        "id": "qd123456", "status": "queued", "language": "English",
        "language_code": "en", "project": "proj", "day": "day",
        "created": "2026-09-01T10:00:00", "work_dir": str(work),
    }), encoding="utf-8")
    store = JobStore(log_dir=str(tmp_path))
    store.restore(str(tmp_path))
    assert store.get("qd123456")["status"] == "queued"


def test_a_restored_queued_job_is_rearmed_from_its_record(monkeypatch, tmp_path):
    """What the boot re-arm hands the pipeline is the job's own saved choices."""
    work = tmp_path / "day" / "proj_en"
    work.mkdir(parents=True)
    (work / "input.mp4").write_bytes(b"video-bytes")
    job = {
        "id": "qd654321", "status": "queued", "language": "Korean",
        "language_code": "ko", "project": "proj", "day": "day",
        "created": "2026-09-01T10:00:00", "work_dir": str(work),
        "stt_engine": "perso", "translator": "gemini", "quality": 2,
        "separation": "perso", "source_lang": "en", "num_speakers": 3,
        "dub_mode": "local",
    }
    seen = {}

    def fake_run_dub(**kw):
        seen.update(kw)
        return {"out_path": kw["out_path"]}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)
    target = main._dub_target_for(job)
    target(lambda msg: None)
    assert seen["video_path"] == str(work / "input.mp4")
    assert seen["language"] == "Korean"
    assert seen["stt_engine"] == "perso"
    assert seen["sep_engine"] == "perso"
    assert seen["translate_engine"] == "gemini"
    assert seen["n_takes"] == 2
    assert seen["num_speakers"] == 3
    assert seen["source_language_code"] == "en"
