"""The Separate audio routes (app/api/separate.py).

A separation goes through the dub's own start ritual, so what these pin is
what is different about it: the engine it runs on and what each needs, the two
files it leaves, how far along it says it is, that the stop button and the
Projects list treat it as they treat every job, that its two sounds go out as
mp3 or wav through the routes a dubbing's stems use, and that a dubbing of the
same cut takes them instead of separating again.

The separation itself is faked at app.separate_launch.separate, which is the
seam the work builder reaches the pipeline through.
"""
import json
import os
import subprocess
import time

import pytest
from fastapi.testclient import TestClient

from app import engines_status, media, separate_launch, state
from app.api import _launch as launch_api
from app.api import downloads as downloads_api
from app.api import dub as dub_api
from app.api import separate as separate_api
from app.jobs import JobCancelled, JobStore
from app.main import app
from tests.marks import needs_ffmpeg

client = TestClient(app, base_url="http://127.0.0.1")


@pytest.fixture(autouse=True)
def _ready(monkeypatch):
    monkeypatch.setattr(launch_api, "missing_models", lambda *a, **kw: [])
    monkeypatch.setattr(media, "has_audio", lambda path: True)
    monkeypatch.setattr(media, "video_duration", lambda path: 10.0)
    monkeypatch.setattr(separate_api, "_cut_video", lambda path, a, b: None)
    monkeypatch.setattr(separate_api, "_cut_ranges",
                        lambda path, ranges: open(path, "wb").write(b"JOINED"))


def _silence(path):
    """A second of real silence: what the export routes turn into mp3 and wav."""
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
                    "anullsrc=r=48000:cl=stereo", "-t", "1", path], check=True)


@pytest.fixture
def separated(monkeypatch):
    """A stand-in separation: the two files where they are wanted. Returns the
    calls it was given."""
    calls = []

    def fake(video_path, work, engine, *, cancel_check, on_notice, log, seconds=None, title=None):
        calls.append({"video": video_path, "engine": engine, "seconds": seconds, "title": title})
        log("1/6 Separating background audio…")
        paths = [os.path.join(work, name) for name in ("vocals.wav", "background.wav")]
        for p in paths:
            _silence(p)
        return paths[0], paths[1], None, "RoFormer"

    monkeypatch.setattr(separate_launch, "separate", fake)
    return calls


def _start(**data):
    return client.post("/api/separate",
                       files={"video": ("clip.mp4", b"video-bytes", "video/mp4")}, data=data)


def _wait(jid, want="done"):
    for _ in range(300):
        r = client.get("/api/separate/%s" % jid)
        if r.json()["status"] == want:
            return r.json()
        time.sleep(0.02)
    return client.get("/api/separate/%s" % jid).json()


def _held(body=b"ORIGINAL"):
    return downloads_api.download_store.add_file(
        state.WORKSPACE, "Cats", 10, lambda dest: open(dest, "wb").write(body))


# --- starting one -----------------------------------------------------------

@needs_ffmpeg
def test_a_video_is_separated_into_two_files_kept_in_the_jobs_folder(separated):
    r = _start(project="clip")
    assert r.status_code == 200
    job = _wait(r.json()["job_id"])
    assert job["status"] == "done" and job["done"] is True
    assert job["kind"] == "separate" and job["separation"] == "demucs"
    # The choice ("demucs" = this computer) and what ran are two fields: the
    # record used to say demucs for a RoFormer run.
    assert job["separation_model"] == "RoFormer"
    assert job["duration"] == 10.0
    assert separated[0]["video"].endswith("input.mp4") and separated[0]["engine"] == "demucs"
    work = job["work_dir"]
    assert os.path.isfile(os.path.join(work, "vocals.wav"))
    assert os.path.isfile(os.path.join(work, "background.wav"))
    # The note a dubbing's own separation stage leaves, so a dubbing handed
    # these reads them the way Resume does.
    assert json.load(open(os.path.join(work, "separated.json"))) == {
        "vocals": "vocals.wav", "background": "background.wav", "model": "RoFormer"}


def test_the_kept_parts_are_cut_before_the_job_starts(separated, monkeypatch):
    cuts = []
    monkeypatch.setattr(separate_api, "_cut_video", lambda path, a, b: cuts.append(("trim", a, b)))
    monkeypatch.setattr(separate_api, "_cut_ranges", lambda path, r: cuts.append(("parts", r)))
    a = _wait(_start(trim_start="2", trim_end="8").json()["job_id"])
    b = _wait(_start(ranges="[[0, 2], [4, 6]]").json()["job_id"])
    # One kept part is a trim, as it is for a dubbing.
    c = _wait(_start(ranges="[[1, 5]]").json()["job_id"])
    assert cuts == [("trim", 2.0, 8.0), ("parts", [[0.0, 2.0], [4.0, 6.0]]), ("trim", 1.0, 5.0)]
    assert a["trim"] == {"start": 2.0, "end": 8.0} and a["ranges"] is None
    assert b["ranges"] == [[0.0, 2.0], [4.0, 6.0]]
    assert c["trim"] == {"start": 1.0, "end": 5.0}


def test_what_cannot_start_is_refused_before_anything_is_copied(separated, monkeypatch):
    assert _start(engine="cloud").status_code == 422
    assert _start(trim_start="2").status_code == 400
    assert _start(trim_start="2", trim_end="8", ranges="[[0, 2]]").status_code == 400
    assert client.post("/api/separate", data={"download_id": "nope"}).status_code == 404
    assert client.post("/api/separate").status_code == 422
    monkeypatch.setattr(media, "has_audio", lambda path: False)
    r = _start()
    assert r.status_code == 422 and "no sound" in r.json()["detail"]
    assert not [d for d in os.listdir(state.WORKSPACE) if d != "downloads"
                for _ in os.listdir(os.path.join(state.WORKSPACE, d))]


def test_without_the_engine_pack_the_screen_is_handed_the_download_notice(monkeypatch):
    pack = {"id": "engine", "kind": "pack", "name": "Python + PyTorch", "bytes": 5, "hint": ""}
    asked = {}

    def missing(need_whisper, translate_missing_id, **kw):
        asked.update(kw, need_whisper=need_whisper)
        return [pack]

    monkeypatch.setattr(launch_api, "missing_models", missing)
    before = len(client.get("/api/dub/jobs").json()["jobs"])
    r = _start()
    assert r.status_code == 409
    assert r.json()["detail"]["missing"] == [pack]
    assert r.json()["detail"]["total_bytes"] == 5
    assert r.json()["detail"]["purpose"] == "separating audio"
    # The pack alone: no transcription model, no voice model.
    assert asked == {"need_whisper": False, "need_tts": False, "need_engine": True}
    assert len(client.get("/api/dub/jobs").json()["jobs"]) == before


@needs_ffmpeg
def test_perso_needs_its_key_and_a_workspace_and_runs_beside_the_line(separated, monkeypatch):
    monkeypatch.setattr(engines_status, "perso_available", lambda: False)
    r = _start(engine="perso")
    assert r.status_code == 422 and "API key" in r.json()["detail"]

    monkeypatch.setattr(engines_status, "perso_available", lambda: True)
    monkeypatch.setattr(launch_api, "current_value", lambda name: "")
    monkeypatch.setattr(launch_api, "list_dubbing_spaces", lambda key: [{"seq": 1}, {"seq": 2}])
    r = _start(engine="perso")
    assert r.status_code == 422 and "Select a Perso workspace" in r.json()["detail"]

    monkeypatch.setattr(launch_api, "list_dubbing_spaces", lambda key: [{"seq": 1}])
    # The missing engine pack is no obstacle: Perso does the work.
    monkeypatch.setattr(launch_api, "missing_models", lambda *a, **kw: [{"id": "engine"}])
    job = _wait(_start(engine="perso").json()["job_id"])
    assert job["status"] == "done" and job["separation"] == "perso"
    assert separated[-1]["engine"] == "perso"
    # Named on Perso's workspace as the project is here, not input (owner, 2026-10-22).
    assert separated[-1]["title"] == job["project"]


# --- following it -----------------------------------------------------------

def test_a_running_separation_says_how_long_it_has_been_at_it_and_can_be_stopped(monkeypatch):
    def blocking(video_path, work, engine, *, cancel_check, on_notice, log, seconds=None):
        for _ in range(500):
            if cancel_check():
                raise JobCancelled("Separating was stopped.")
            time.sleep(0.01)

    monkeypatch.setattr(separate_launch, "separate", blocking)
    jid = _start().json()["job_id"]
    seen = client.get("/api/separate/%s" % jid).json()
    for _ in range(200):
        seen = client.get("/api/separate/%s" % jid).json()
        if seen["elapsed"] > 0:
            break
        time.sleep(0.02)
    assert seen["status"] == "running" and seen["elapsed"] > 0 and seen["done"] is False
    assert client.post("/api/dub/jobs/%s/cancel" % jid).status_code == 200
    stopped = _wait(jid, "cancelled")
    assert stopped["status"] == "cancelled" and stopped["elapsed"] == 0


def test_a_stop_pressed_during_an_engine_that_cannot_be_interrupted_still_stops_the_job(monkeypatch):
    gate = {"go": False}

    def deaf(video_path, work, engine, *, cancel_check, on_notice, log, seconds=None):
        while not gate["go"]:
            time.sleep(0.01)
        paths = [os.path.join(work, n) for n in ("vocals.wav", "background.wav")]
        for p in paths:
            open(p, "wb").write(b"x" * 100)
        return paths[0], paths[1], None, None

    monkeypatch.setattr(separate_launch, "separate", deaf)
    jid = _start().json()["job_id"]
    for _ in range(200):
        if client.get("/api/separate/%s" % jid).json()["status"] == "running":
            break
        time.sleep(0.02)
    assert client.post("/api/dub/jobs/%s/cancel" % jid).json()["status"] == "cancelling"
    gate["go"] = True
    assert _wait(jid, "cancelled")["status"] == "cancelled"


def test_a_second_separation_waits_in_the_line_a_dubbing_waits_in(monkeypatch):
    gate = {"go": False}

    def slow(video_path, work, engine, *, cancel_check, on_notice, log, seconds=None):
        while not gate["go"]:
            time.sleep(0.01)
        paths = [os.path.join(work, n) for n in ("vocals.wav", "background.wav")]
        for p in paths:
            open(p, "wb").write(b"x" * 100)
        return paths[0], paths[1], None, None

    monkeypatch.setattr(separate_launch, "separate", slow)
    first = _start().json()
    second = _start().json()
    assert second["status"] == "queued"
    # Taken out of line without a word, as any waiting job is.
    assert client.post("/api/dub/jobs/%s/cancel" % second["job_id"]).json()["status"] == "cancelled"
    gate["go"] = True
    assert _wait(first["job_id"])["status"] == "done"


def test_a_failure_is_the_pipelines_own_sentence(monkeypatch):
    def broken(video_path, work, engine, *, cancel_check, on_notice, log, seconds=None):
        raise RuntimeError("Voice separation failed on this computer. Check the video file.")

    monkeypatch.setattr(separate_launch, "separate", broken)
    job = _wait(_start().json()["job_id"], "error")
    assert job["status"] == "error" and job["done"] is False
    assert job["error"] == "Voice separation failed on this computer. Check the video file."


def test_try_again_runs_the_same_cut_the_same_way_in_a_folder_of_its_own(separated, monkeypatch):
    held = _held()
    first = _wait(client.post("/api/separate", data={"download_id": held.id, "ranges": "[[0, 2], [4, 6]]",
                                                     "project": "Cats"}).json()["job_id"])
    cuts = []
    monkeypatch.setattr(separate_api, "_cut_ranges", lambda path, r: cuts.append(r))
    r = client.post("/api/separate/%s/retry" % first["id"])
    assert r.status_code == 200
    again = _wait(r.json()["job_id"])
    assert again["id"] != first["id"] and again["work_dir"] != first["work_dir"]
    assert again["ranges"] == first["ranges"] and again["download_id"] == held.id
    # The copy in the folder is already cut: nothing is cut twice.
    assert cuts == []
    assert open(os.path.join(again["work_dir"], "input.mp4"), "rb").read() == b"JOINED"


# --- the wrong kind ---------------------------------------------------------

def test_a_separation_is_its_own_kind_in_the_list_and_at_every_other_door(separated, monkeypatch):
    jid = _wait(_start(project="clip").json()["job_id"])["id"]
    row = next(r for r in client.get("/api/dub/jobs").json()["jobs"] if r["id"] == jid)
    assert row["kind"] == "separate" and row["separation"] == "demucs"
    # Not an erase, and not a dubbing to run again, resume or do again.
    assert client.get("/api/erase/%s" % jid).status_code == 404
    for door in ("retry", "again"):
        r = client.post("/api/dub/jobs/%s/%s" % (jid, door))
        assert r.status_code == 409 and "separated audio" in r.json()["detail"]
    # And a dubbing is not a separation.
    monkeypatch.setattr(dub_api, "run_dub", lambda **kw: {"out_path": kw["out_path"]})
    dub = client.post("/api/dub/start", files={"video": ("v.mp4", b"vid", "video/mp4")},
                      data={"language_code": "ko"}).json()["job_id"]
    for path in ("", "/waveform/voice"):
        assert client.get("/api/separate/%s%s" % (dub, path)).status_code == 404
    assert client.post("/api/separate/%s/retry" % dub).status_code == 404
    assert client.post("/api/separate/%s/open" % dub).status_code == 404
    assert client.get("/api/separate/nope").status_code == 404


# --- the two sounds ---------------------------------------------------------

@needs_ffmpeg
def test_both_sounds_are_exported_as_mp3_and_as_wav_named_for_the_project(separated):
    job = _wait(_start(project="clip").json()["job_id"])
    jid = job["id"]
    assert client.get("/api/dub/result/%s/stems" % jid).json() == {"voice": True, "background": True}
    for which in ("voice", "background"):
        r = client.get("/api/dub/result/%s/stem/%s?format=mp3" % (jid, which))
        assert r.status_code == 200 and r.headers["content-type"] == "audio/mpeg"
        assert "clip_%s.mp3" % which in r.headers["content-disposition"]
        assert len(r.content) > 0
        r = client.get("/api/dub/result/%s/stem/%s?format=wav" % (jid, which))
        assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
        assert r.content[:4] == b"RIFF"
        assert "clip_%s.wav" % which in r.headers["content-disposition"]
    assert client.get("/api/dub/result/%s/stem/voice?format=ogg" % jid).status_code == 422


@needs_ffmpeg
def test_each_sound_has_a_picture_once_it_is_separated(separated, monkeypatch):
    job = _wait(_start().json()["job_id"])
    for which in ("voice", "background"):
        wave = client.get("/api/separate/%s/waveform/%s" % (job["id"], which)).json()
        assert wave["rate"] > 0 and len(wave["peaks"]) > 0
    assert client.get("/api/separate/%s/waveform/drums" % job["id"]).status_code == 404

    def never(video_path, work, engine, **kw):
        raise RuntimeError("no")

    monkeypatch.setattr(separate_launch, "separate", never)
    failed = _wait(_start().json()["job_id"], "error")
    assert client.get("/api/separate/%s/waveform/voice" % failed["id"]).status_code == 404
    assert client.get("/api/dub/result/%s/stem/voice" % failed["id"]).status_code == 409


# --- opening it again, and the dubbing that follows --------------------------

def test_a_finished_separation_reopens_on_the_video_it_was_cut_from(separated):
    held = _held()
    job = _wait(client.post("/api/separate", data={"download_id": held.id,
                                                   "ranges": "[[0, 2], [4, 6]]"}).json()["job_id"])
    r = client.post("/api/separate/%s/open" % job["id"]).json()
    assert r["download_id"] == held.id and r["ranges"] == [[0.0, 2.0], [4.0, 6.0]]

    # Uploaded, so nothing is held: its own cut copy comes back whole, once.
    job = _wait(_start(project="clip").json()["job_id"])
    r = client.post("/api/separate/%s/open" % job["id"]).json()
    assert r["ranges"] is None and r["title"] == "clip"
    assert client.post("/api/separate/%s/open" % job["id"]).json()["download_id"] == r["download_id"]


def test_a_reopened_upload_is_held_again_from_its_folder_after_a_restart(separated, monkeypatch):
    job = _wait(_start(project="clip").json()["job_id"])
    first = client.post("/api/separate/%s/open" % job["id"]).json()["download_id"]
    # The app restarts: the job comes back from job.json, and the held videos
    # (records in memory only) are forgotten while their folders stay on disk.
    store = JobStore()
    store.restore(state.WORKSPACE)
    monkeypatch.setattr(state, "job_store", store)
    monkeypatch.setattr(downloads_api, "download_store", downloads_api.DownloadStore())
    assert client.post("/api/separate/%s/open" % job["id"]).json()["download_id"] == first
    assert os.listdir(os.path.join(state.WORKSPACE, "downloads")) == [first]   # no second copy


def _dub(monkeypatch, restart=None, **data):
    seen = {}

    def fake_run_dub(**kw):
        work = os.path.dirname(kw["out_path"])
        seen.update(resume=kw.get("resume", False), sep_engine=kw.get("sep_engine"),
                    files=sorted(os.listdir(work)))
        return {"out_path": kw["out_path"]}

    monkeypatch.setattr(dub_api, "run_dub", fake_run_dub)
    monkeypatch.setattr(dub_api, "_cut_video", lambda path, a, b: None)
    monkeypatch.setattr(dub_api, "_cut_ranges", lambda path, r, on_cut=None: None)
    for name in ("gemma", "hunyuan", "qwen"):
        monkeypatch.setattr(engines_status, "%s_status" % name, lambda: "available")
    monkeypatch.setattr(engines_status, "chatgpt_available", lambda: True)
    monkeypatch.setattr(engines_status, "gemini_available", lambda: True)
    monkeypatch.setattr(dub_api, "_require_voice_engine_running", lambda: None)

    def start():
        r = client.post("/api/dub/start", data={"language_code": "ko", "dub_mode": "local",
                                                "sep_engine": "local", "stt_engine": "local", **data})
        assert r.status_code == 200, r.text
        return r.json()["job_id"]

    # restart: conftest's after_a_restart, for a dubbing that waits out an app
    # restart in the line before it runs.
    jid = restart(start) if restart else start()
    for _ in range(300):
        if state.job_store.get(jid)["status"] not in ("queued", "running"):
            break
        time.sleep(0.02)
    return seen


@needs_ffmpeg
def test_a_dubbing_of_the_same_cut_takes_the_two_sounds_instead_of_separating_again(
        separated, monkeypatch):
    held = _held()
    sep = _wait(client.post("/api/separate", data={"download_id": held.id,
                                                   "ranges": "[[0, 2], [4, 6]]"}).json()["job_id"])
    seen = _dub(monkeypatch, download_id=held.id, ranges="[[0, 2], [4, 6]]", stems_from=sep["id"])
    assert seen["resume"] is True
    assert {"vocals.wav", "background.wav", "separated.json"} <= set(seen["files"])


@needs_ffmpeg
def test_a_dubbing_of_the_same_cut_that_waits_out_a_restart_still_takes_the_two_sounds(
        separated, after_a_restart, monkeypatch):
    """Queued behind another dub and then a restart, it still takes the two
    sounds it was started with: separating again costs minutes here, and
    credits on Perso."""
    held = _held()
    sep = _wait(client.post("/api/separate", data={"download_id": held.id,
                                                   "ranges": "[[0, 2], [4, 6]]"}).json()["job_id"])
    seen = _dub(monkeypatch, restart=after_a_restart, download_id=held.id, ranges="[[0, 2], [4, 6]]",
                stems_from=sep["id"])
    assert seen["resume"] is True
    assert {"vocals.wav", "background.wav", "separated.json"} <= set(seen["files"])


@pytest.mark.parametrize("change", [
    {"ranges": "[[0, 2], [4, 7]]"},     # cut differently
    {"ranges": None},                    # not cut at all
    {"other_video": True},               # another video
    {"stems_from": "nope"},              # no such job
])
def test_anything_else_separates_again(separated, monkeypatch, change):
    held = _held()
    sep = _wait(client.post("/api/separate", data={"download_id": held.id,
                                                   "ranges": "[[0, 2], [4, 6]]"}).json()["job_id"])
    data = {"download_id": held.id, "ranges": "[[0, 2], [4, 6]]", "stems_from": sep["id"]}
    if change.get("other_video"):
        data["download_id"] = _held(b"OTHER").id
    data.update({k: v for k, v in change.items() if k != "other_video"})
    seen = _dub(monkeypatch, **{k: v for k, v in data.items() if v is not None})
    assert seen["resume"] is False
    assert "vocals.wav" not in seen["files"]


@needs_ffmpeg
def test_a_reopened_upload_is_dubbed_whole_with_its_two_sounds(separated, monkeypatch):
    job = _wait(_start(project="clip").json()["job_id"])
    again = client.post("/api/separate/%s/open" % job["id"]).json()["download_id"]
    assert _dub(monkeypatch, download_id=again, stems_from=job["id"])["resume"] is True
    # Cut again, it is no longer the video those two sounds are of.
    assert _dub(monkeypatch, download_id=again, stems_from=job["id"],
                trim_start="1", trim_end="5")["resume"] is False


@needs_ffmpeg
def test_a_separation_that_waited_out_a_restart_is_put_back_in_line(separated, tmp_path):
    job = _wait(_start(project="clip").json()["job_id"])
    for name in ("vocals.wav", "background.wav"):
        os.remove(os.path.join(job["work_dir"], name))
    state.job_store.update(job["id"], status="queued", result=None)
    dub_api.rearm_queued_jobs()
    back = _wait(job["id"])
    assert back["status"] == "done" and back["done"] is True
    assert len(separated) == 2
