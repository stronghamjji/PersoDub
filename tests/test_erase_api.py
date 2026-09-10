"""The erase routes (app/api/erase.py).

An erase job goes through the dub's own start ritual, so what these pin is
what is different about it: the two ways a video arrives, the band being
checked before minutes are spent on it, the pack that is not installed
answering before anything is copied, and the four things that can be done with
the result -- watch it, compare it with the original, save it, dub it.

The erase itself is faked at app.eraser.run_erase, which is the seam
app/erase_launch.py reaches it through.
"""
import json
import os
import time

import pytest
from fastapi.testclient import TestClient

from app import engines_status, eraser, state
from app.api import downloads as downloads_api
from app.api import erase as erase_api
from app.jobs import JobCancelled
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")

# The real check, kept before the fixture below replaces it -- one test wants
# to watch it change its mind as kit.env is written.
real_eraser_available = engines_status.eraser_available


@pytest.fixture(autouse=True)
def _eraser_installed(monkeypatch):
    monkeypatch.setattr(engines_status, "eraser_available", lambda: True)


@pytest.fixture
def erased(monkeypatch):
    """A stand-in erase: one progress line, then a video where one is wanted.
    Returns the calls it was given."""
    calls = []

    def fake_run_erase(src, out, area, *, log, cancel_check):
        calls.append({"src": src, "out": out, "area": area})
        log("progress 50%")
        log("progress 100%")
        with open(out, "wb") as f:
            f.write(b"clean-video")
        return {"frames_checked": 114, "frames_with_text": 0, "sample_times": []}

    monkeypatch.setattr(eraser, "run_erase", fake_run_erase)
    return calls


def _start(area="whole", **data):
    return client.post("/api/erase",
                       files={"video": ("clip.mp4", b"video-bytes", "video/mp4")},
                       data={"area": area, **data})


def _wait(jid, want="done"):
    for _ in range(200):
        r = client.get("/api/erase/%s" % jid)
        if r.json()["status"] == want:
            return r.json()
        time.sleep(0.02)
    return client.get("/api/erase/%s" % jid).json()


# --- starting one -----------------------------------------------------------

def test_an_uploaded_video_is_erased_and_the_job_says_how_far_along_it_is(erased):
    r = _start(area=json.dumps([660, 800, 0, 608]), project="clip")
    assert r.status_code == 200
    job = _wait(r.json()["job_id"])
    assert job["status"] == "done"
    assert job["percent"] == 100 and job["done"] is True
    # The band reaches the eraser as a tuple, rows first, and the job's own
    # folder is where both videos live.
    assert erased[0]["area"] == (660, 800, 0, 608)
    assert erased[0]["src"].endswith("input.mp4")
    assert erased[0]["out"].endswith("erased.mp4")


def test_the_whole_frame_reaches_the_eraser_as_no_band_at_all(erased):
    job = _wait(_start().json()["job_id"])
    assert job["area"] == "whole"
    assert erased[0]["area"] is None


def test_a_held_download_is_not_uploaded_a_second_time(erased, tmp_path):
    held = downloads_api.download_store.add_file(
        state.WORKSPACE, "held clip", 12.0,
        lambda dest: open(dest, "wb").write(b"video-bytes"))
    r = client.post("/api/erase", data={"download_id": held.id, "area": "whole"})
    assert r.status_code == 200
    job = _wait(r.json()["job_id"])
    assert job["project"] == "held clip"
    assert job["status"] == "done"


def test_a_video_has_to_come_from_exactly_one_place(erased):
    assert client.post("/api/erase", data={"area": "whole"}).status_code == 422
    r = client.post("/api/erase", files={"video": ("c.mp4", b"x", "video/mp4")},
                    data={"area": "whole", "download_id": "abc"})
    assert r.status_code == 422


def test_a_download_id_that_is_not_ready_is_named_as_such(erased):
    r = client.post("/api/erase", data={"download_id": "nope", "area": "whole"})
    assert r.status_code == 404


@pytest.mark.parametrize("area", ["[1,2,3]", "[660, 600, 0, 608]", "banana",
                                  '{"ymin": 1}', "[0, 100, 5, 5]"])
def test_a_band_that_is_not_a_box_is_refused_before_any_work(erased, area):
    assert _start(area=area).status_code == 422
    assert erased == []


def test_a_trim_is_made_before_the_job_starts(erased, monkeypatch):
    cut = []
    monkeypatch.setattr(erase_api, "_cut_video", lambda p, s, e: cut.append((p, s, e)))
    r = _start(trim_start="5", trim_end="9")
    assert r.status_code == 200
    _wait(r.json()["job_id"])
    assert cut and cut[0][1] == 5 and cut[0][2] == 9
    assert cut[0][0].endswith("input.mp4")


def test_half_a_trim_is_refused(erased):
    assert _start(trim_start="5").status_code == 400
    assert _start(trim_start="5", trim_end="5.1").status_code == 400


def test_without_the_pack_nothing_is_copied_and_the_screen_is_told_which_pack(monkeypatch):
    monkeypatch.setattr(engines_status, "eraser_available", lambda: False)
    r = _start()
    assert r.status_code == 409
    assert r.json()["detail"] == {"reason": "pack_missing", "pack": "subtitle-eraser"}
    r = client.post("/api/erase/suggest", files={"video": ("c.mp4", b"x", "video/mp4")})
    assert r.status_code == 409


# --- where the subtitles are ------------------------------------------------

def test_suggest_answers_with_a_band_and_leaves_no_copy_behind(monkeypatch):
    seen = {}

    def fake_suggest(path):
        seen["path"] = path
        assert os.path.exists(path)      # the detector needs a real file
        return {"found": True, "area": [614, 847, 23, 571], "width": 608,
                "height": 1080, "frames": 12}

    monkeypatch.setattr(eraser, "suggest_area", fake_suggest)
    r = client.post("/api/erase/suggest",
                    files={"video": ("clip.mp4", b"video-bytes", "video/mp4")})
    assert r.status_code == 200
    assert r.json() == {"area": [614, 847, 23, 571], "width": 608,
                        "height": 1080, "found": True}
    assert not os.path.exists(os.path.dirname(seen["path"]))


def test_suggest_reads_a_held_download_where_it_lies(monkeypatch):
    held = downloads_api.download_store.add_file(
        state.WORKSPACE, "held", 5.0, lambda dest: open(dest, "wb").write(b"v"))
    monkeypatch.setattr(eraser, "suggest_area",
                        lambda path: {"found": False, "area": [810, 1080, 0, 608],
                                      "width": 608, "height": 1080, "frames": 12}
                        if path == held.path else pytest.fail("copied the file"))
    r = client.post("/api/erase/suggest", data={"download_id": held.id})
    assert r.status_code == 200 and r.json()["found"] is False


def test_a_detector_that_fell_over_is_a_503_not_a_crash(monkeypatch):
    monkeypatch.setattr(eraser, "suggest_area",
                        lambda path: (_ for _ in ()).throw(RuntimeError("no frames")))
    r = client.post("/api/erase/suggest", files={"video": ("c.mp4", b"x", "video/mp4")})
    assert r.status_code == 503 and "no frames" in r.json()["detail"]


# --- the result -------------------------------------------------------------

def test_the_cleaned_video_and_the_original_can_both_be_watched(erased):
    jid = _start().json()["job_id"]
    _wait(jid)
    assert client.get("/api/erase/%s/video" % jid).content == b"clean-video"
    assert client.get("/api/erase/%s/original" % jid).content == b"video-bytes"


def test_saving_names_the_file_after_the_project_and_never_writes_over_one(erased, tmp_path):
    jid = _start(project="my clip").json()["job_id"]
    _wait(jid)
    first = client.post("/api/erase/%s/save" % jid, json={"dir": str(tmp_path)}).json()
    assert os.path.basename(first["path"]) == "my clip (no subtitles).mp4"
    second = client.post("/api/erase/%s/save" % jid, json={"dir": str(tmp_path)}).json()
    assert second["path"] != first["path"]
    assert open(first["path"], "rb").read() == b"clean-video"


def test_the_cleaned_video_is_handed_to_the_new_project_screen(erased):
    jid = _start(project="clip").json()["job_id"]
    _wait(jid)
    r = client.post("/api/erase/%s/dub" % jid)
    assert r.status_code == 200
    held = downloads_api.download_store.get(r.json()["download_id"])
    # Held, not dubbed: which language and which engines are still the user's
    # to choose on the New project screen.
    assert held.status == "ready"
    assert open(held.path, "rb").read() == b"clean-video"


def test_the_result_routes_wait_for_the_result(monkeypatch):
    """A job still running has no cleaned video, and saying 404 is better than
    handing back a file that is being written."""
    monkeypatch.setattr(eraser, "run_erase",
                        lambda *a, **kw: kw["log"]("progress 10%"))
    jid = _start().json()["job_id"]
    _wait(jid)
    assert client.get("/api/erase/%s/video" % jid).status_code == 404
    assert client.post("/api/erase/%s/save" % jid, json={}).status_code == 404
    assert client.post("/api/erase/%s/dub" % jid).status_code == 404


def test_a_dub_job_is_not_an_erase_job(erased):
    jid = state.job_store.create()
    state.job_store.update(jid, status="done", project="a dub")
    assert client.get("/api/erase/%s" % jid).status_code == 404
    assert client.get("/api/erase/%s/video" % jid).status_code == 404


def test_an_erase_is_cancelled_by_the_button_every_other_job_uses(monkeypatch):
    def blocking_erase(src, out, area, *, log, cancel_check):
        log("progress 5%")
        for _ in range(500):
            if cancel_check():
                raise JobCancelled("Subtitle erasing was cancelled.")
            time.sleep(0.01)

    monkeypatch.setattr(eraser, "run_erase", blocking_erase)
    jid = _start().json()["job_id"]
    for _ in range(200):
        if client.get("/api/erase/%s" % jid).json()["percent"] == 5:
            break
        time.sleep(0.02)
    assert client.post("/api/dub/jobs/%s/cancel" % jid).status_code == 200
    assert _wait(jid, "cancelled")["status"] == "cancelled"


def test_an_erase_job_shows_up_in_the_projects_list_as_an_erase(erased):
    jid = _start(project="clip").json()["job_id"]
    _wait(jid)
    rows = client.get("/api/dub/jobs").json()["jobs"]
    row = next(r for r in rows if r["id"] == jid)
    assert row["kind"] == "erase"


def test_try_again_is_not_offered_a_job_that_erased_subtitles(erased):
    """Both kinds share the Projects list, and this button on an erase would
    start dubbing a video nobody asked to have dubbed."""
    jid = _start(project="clip").json()["job_id"]
    _wait(jid)
    r = client.post("/api/dub/jobs/%s/retry" % jid)
    assert r.status_code == 409 and "erased subtitles" in r.json()["detail"]


def test_a_band_that_missed_the_subtitles_says_so_where_both_the_screen_and_the_agent_read_it(monkeypatch):
    """The sentence app/eraser.py raises is what lands on the job's record --
    which is the red bar on the screen and the `error` the Dub Agent's
    get_job_status hands back."""
    def missed(src, out, area, *, log, cancel_check):
        raise RuntimeError(eraser.NO_SUBTITLES_MESSAGE)

    monkeypatch.setattr(eraser, "run_erase", missed)
    jid = _start(area=json.dumps([0, 100, 0, 100])).json()["job_id"]
    job = _wait(jid, "error")
    assert job["error"] == "No subtitles were found in that area. Move the box and try again."


def test_the_route_stops_refusing_the_moment_the_pack_is_installed(erased, tmp_path, monkeypatch):
    """The pack arrives while the app is open, and the desktop shell writes its
    two lines into kit.env then and there. Nothing may wait for a restart."""
    import sys
    monkeypatch.setattr(engines_status, "eraser_available", real_eraser_available)
    monkeypatch.delenv("ERASER_PYTHON", raising=False)
    monkeypatch.delenv("ERASER_VSR_DIR", raising=False)
    kit = tmp_path / "kit"
    kit.mkdir()
    env = kit / "kit.env"
    env.write_text("PERSODUB_NO_ANALYTICS=0\n", encoding="utf-8")
    monkeypatch.setenv("PERSODUB_KIT_DIR", str(kit))
    assert _start().status_code == 409

    vsr = tmp_path / "vsr"
    vsr.mkdir()
    env.write_text("ERASER_PYTHON=%s\nERASER_VSR_DIR=%s\n" % (sys.executable, vsr),
                   encoding="utf-8")
    r = _start()
    assert r.status_code == 200
    assert _wait(r.json()["job_id"])["done"] is True


def test_what_the_check_found_is_on_the_job_and_survives_a_restart(erased, tmp_path):
    """"Is it really gone?" is the question this feature lives or dies on, so
    the answer is stamped on the record rather than left in a log line."""
    jid = _start(project="clip").json()["job_id"]
    job = _wait(jid)
    assert job["check"] == {"frames_checked": 114, "frames_with_text": 0, "sample_times": []}
    with open(os.path.join(job["work_dir"], "job.json"), encoding="utf-8") as f:
        assert json.load(f)["check"]["frames_checked"] == 114


def test_saving_with_no_folder_goes_under_downloads_by_day_and_project(erased, tmp_path, monkeypatch):
    # The same rule the dub's exports follow (Downloads/<day>/<project>); the
    # erased video landed loose in Downloads beside them (Windows, 2026-09-10).
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    jid = _start(project="my clip.mp4").json()["job_id"]
    _wait(jid)
    job = client.get("/api/erase/%s" % jid).json()
    assert job["project"] == "my clip"
    path = client.post("/api/erase/%s/save" % jid, json={}).json()["path"]
    assert path == os.path.join(str(tmp_path), "Downloads", job["day"], "my clip", "my clip (no subtitles).mp4")
    assert open(path, "rb").read() == b"clean-video"
