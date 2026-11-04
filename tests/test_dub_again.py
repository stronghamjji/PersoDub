"""Dub again: POST /api/dub/jobs/{id}/again holds a dub's video once more for a
new project, with the parts that dub kept (mockup edit-flow, user 2026-09-30).
The job itself is never changed, and a link is never fetched a second time.
"""
import json
import os
import time

import pytest
from fastapi.testclient import TestClient

from app import engines_status, media, state
from app.api import _launch as launch_api
from app.api import downloads as dl
from app.api import dub as dub_api
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


@pytest.fixture(autouse=True)
def _ready(monkeypatch):
    monkeypatch.setattr(launch_api, "missing_models", lambda *a, **kw: [])
    for name in ("gemma", "hunyuan", "qwen"):
        monkeypatch.setattr(engines_status, f"{name}_available", lambda: True)
        monkeypatch.setattr(engines_status, f"{name}_status", lambda: "available")
    monkeypatch.setattr(engines_status, "gemini_available", lambda: True)
    monkeypatch.setattr(engines_status, "perso_available", lambda: True)
    monkeypatch.setattr(media, "video_duration", lambda path: 10.0)
    monkeypatch.setattr(dub_api, "run_dub", lambda **kw: None)
    monkeypatch.setattr(dub_api, "_cut_video", lambda path, a, b: None)
    monkeypatch.setattr(dub_api, "_cut_ranges", lambda path, ranges, on_cut=None: open(path, "wb").write(b"JOINED"))


def _wait(jid):
    for _ in range(250):
        if state.job_store.get(jid)["status"] not in ("queued", "running"):
            return
        time.sleep(0.02)


def _held(body=b"ORIGINAL"):
    return dl.download_store.add_file(state.WORKSPACE, "Cats", 10, lambda dest: open(dest, "wb").write(body))


def _dub_held(held, ranges):
    r = client.post("/api/dub/start", data={"language_code": "ko", "download_id": held.id,
                                            "ranges": json.dumps(ranges)})
    assert r.status_code == 200, r.text
    jid = r.json()["job_id"]
    _wait(jid)
    return jid


def test_a_dub_of_a_held_video_comes_back_on_that_video_with_its_kept_parts():
    held = _held()
    jid = _dub_held(held, [[0, 2], [4, 6]])
    assert state.job_store.get(jid)["download_id"] == held.id
    before = dict(state.job_store.get(jid))
    n = len(dl.download_store.all())

    r = client.post(f"/api/dub/jobs/{jid}/again")
    assert r.status_code == 200, r.text
    assert r.json() == {"download_id": held.id, "title": "Cats", "duration_sec": 10,
                        "ranges": [[0.0, 2.0], [4.0, 6.0]]}
    assert len(dl.download_store.all()) == n, "nothing new is held"
    assert state.job_store.get(jid) == before, "the job is not touched"


def test_one_kept_part_comes_back_as_one_pair():
    held = _held()
    jid = _dub_held(held, [[2, 8]])
    assert state.job_store.get(jid)["trim"] == {"start": 2.0, "end": 8.0}
    assert client.post(f"/api/dub/jobs/{jid}/again").json()["ranges"] == [[2.0, 8.0]]


def test_after_a_restart_the_original_still_on_disk_is_held_again_under_its_id():
    held = _held()
    jid = _dub_held(held, [[0, 2], [4, 6]])
    # The store is memory only: a restart forgets the record, not the file.
    dl.download_store._items.pop(held.id)

    r = client.post(f"/api/dub/jobs/{jid}/again").json()
    assert r["download_id"] == held.id
    assert r["ranges"] == [[0.0, 2.0], [4.0, 6.0]]
    again = dl.download_store.get(held.id)
    assert again.status == "ready" and open(again.path, "rb").read() == b"ORIGINAL"


def test_with_the_original_gone_the_jobs_own_cut_copy_comes_back_whole(monkeypatch):
    held = _held()
    jid = _dub_held(held, [[0, 2], [4, 6]])
    dl.download_store._items.pop(held.id)
    os.remove(held.path)
    work = state.job_store.get(jid)["work_dir"]

    r = client.post(f"/api/dub/jobs/{jid}/again")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["download_id"] != held.id
    assert body["ranges"] is None, "the copy is the kept parts, already joined"
    assert body["title"] == state.job_store.get(jid)["project"]
    copy = dl.download_store.get(body["download_id"])
    assert open(copy.path, "rb").read() == b"JOINED"
    assert os.path.exists(os.path.join(work, "input.mp4")), "the job keeps its own copy"


def test_an_uploaded_dub_comes_back_from_its_own_copy():
    r = client.post("/api/dub/start", files={"video": ("clip.mp4", b"UPLOADED", "video/mp4")},
                    data={"language_code": "ko", "trim_start": "1", "trim_end": "5"})
    jid = r.json()["job_id"]
    _wait(jid)
    body = client.post(f"/api/dub/jobs/{jid}/again").json()
    assert body["ranges"] is None
    assert dl.download_store.get(body["download_id"]).status == "ready"


def test_a_link_still_being_fetched_is_not_copied_half_way():
    held = _held()
    jid = _dub_held(held, [[0, 2], [4, 6]])
    state.job_store.update(jid, download_id=None, from_link=True, status="running")
    r = client.post(f"/api/dub/jobs/{jid}/again")
    assert r.status_code == 409
    assert "fetched" in r.json()["detail"]


def test_a_link_job_that_stopped_before_its_cut_keeps_the_parts_on_the_whole_video():
    held = _held()
    jid = _dub_held(held, [[0, 2], [4, 6]])
    state.job_store.update(jid, download_id=None, from_link=True, status="error", ranges_pending=True)
    body = client.post(f"/api/dub/jobs/{jid}/again").json()
    assert body["ranges"] == [[0.0, 2.0], [4.0, 6.0]]


def test_no_video_left_says_so():
    held = _held()
    jid = _dub_held(held, [[0, 2], [4, 6]])
    dl.download_store._items.pop(held.id)
    os.remove(held.path)
    os.remove(os.path.join(state.job_store.get(jid)["work_dir"], "input.mp4"))
    r = client.post(f"/api/dub/jobs/{jid}/again")
    assert r.status_code == 409
    assert "no longer on disk" in r.json()["detail"]


def test_an_unknown_job_or_an_erase_is_refused():
    assert client.post("/api/dub/jobs/nope/again").status_code == 404
    held = _held()
    jid = _dub_held(held, [[0, 2], [4, 6]])
    state.job_store.update(jid, kind="erase")
    r = client.post(f"/api/dub/jobs/{jid}/again")
    assert r.status_code == 409


def test_a_record_naming_a_folder_outside_the_holding_area_is_ignored():
    held = _held()
    jid = _dub_held(held, [[0, 2], [4, 6]])
    state.job_store.update(jid, download_id="../../etc")
    body = client.post(f"/api/dub/jobs/{jid}/again").json()
    assert body["download_id"] != "../../etc"
    assert body["ranges"] is None


# Add language (mockup script-buttons, 2026-10-01): a dubbing started from it
# names the first dubbing of its project, in its own job.json, so the
# languages of one video stay one project across a restart.

def _add_language(held, project_id, code="en"):
    r = client.post("/api/dub/start", data={"language_code": code, "download_id": held.id,
                                            "project_id": project_id})
    assert r.status_code == 200, r.text
    jid = r.json()["job_id"]
    _wait(jid)
    return jid


def test_add_language_records_the_project_in_the_record_its_file_and_the_list():
    held = _held()
    first = _dub_held(held, [[0, 2], [4, 6]])
    second = _add_language(held, first)
    job = state.job_store.get(second)
    assert job["project_id"] == first
    with open(os.path.join(job["work_dir"], "job.json"), encoding="utf-8") as f:
        assert json.load(f)["project_id"] == first
    rows = {j["id"]: j for j in client.get("/api/dub/jobs").json()["jobs"]}
    assert rows[second]["project_id"] == first
    assert rows[first]["project_id"] is None, "the first one is the project"


def test_a_project_id_that_is_not_a_job_id_is_refused():
    held = _held()
    r = client.post("/api/dub/start", data={"language_code": "en", "download_id": held.id,
                                            "project_id": "../x"})
    assert r.status_code == 422


def test_starting_a_language_again_keeps_it_in_its_project(monkeypatch):
    monkeypatch.setattr(dub_api, "_require_voice_engine_running", lambda voice=None: None)
    held = _held()
    first = _dub_held(held, [[0, 2], [4, 6]])
    second = _add_language(held, first)
    state.job_store.update(second, status="error")
    r = client.post(f"/api/dub/jobs/{second}/retry")
    assert r.status_code == 200, r.text
    assert state.job_store.get(r.json()["job_id"])["project_id"] == first
    # One that never joined a project stays on its own when started again.
    state.job_store.update(first, status="error")
    r = client.post(f"/api/dub/jobs/{first}/retry")
    assert state.job_store.get(r.json()["job_id"]).get("project_id") is None
