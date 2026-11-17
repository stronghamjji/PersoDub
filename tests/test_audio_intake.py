"""An audio file as a dubbing's source: what the app takes, and where the one
fact "this project is audio" is written.

A dubbing takes a video, and audio in one of four containers: WAV, FLAC, MP3
and M4A. Anything else is refused with one sentence. The file itself decides,
not its name: what it is is asked once, when it comes in (app/media.py
media_kind and audio_format), and kept as `media: "audio"` on the held upload
and on the job made from it; a video carries nothing. The tools
that work on a picture -- Erase subtitles, Captions, cutting a clip -- keep
refusing audio.

ffprobe is replaced: tests/conftest.py answers "video" for every file, and
the tests here answer for theirs.
"""
import json
import os
import shutil
import time

import pytest
from fastapi.testclient import TestClient

from app import engines_status, eraser, jobs, media, state
from app.api import _launch as launch_api
from app.api import downloads as dl
from app.api import dub as dub_api
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")

REFUSED = "Only MP4 or MOV video and WAV, FLAC, MP3 or M4A audio can be used."
VIDEO_ONLY = "This tool takes video files only."


@pytest.fixture(autouse=True)
def _ready(monkeypatch):
    monkeypatch.setattr(launch_api, "missing_models", lambda *a, **kw: [])
    for name in ("gemma", "hunyuan", "qwen"):
        monkeypatch.setattr(engines_status, f"{name}_available", lambda: True)
        monkeypatch.setattr(engines_status, f"{name}_status", lambda: "available")
    monkeypatch.setattr(engines_status, "eraser_available", lambda: True)
    monkeypatch.setattr(media, "video_duration", lambda path: 10.0)


@pytest.fixture
def probe(monkeypatch):
    """ffprobe's answer for the files of this test: probe.kind is what
    media_kind says ("video", "audio" or None) and probe.format what
    audio_format says. Starts as a WAV."""
    class Probe:
        kind = "audio"
        format = "wav"
        asked = []
    monkeypatch.setattr(media, "media_kind", lambda path: (Probe.asked.append(path), Probe.kind)[1])
    monkeypatch.setattr(media, "audio_format", lambda path: Probe.format)
    Probe.asked = []
    return Probe


@pytest.fixture
def dubbed(monkeypatch):
    """A stand-in dub that writes its result where it is told. Returns the
    arguments of every run."""
    runs = []

    def fake_run_dub(**kw):
        runs.append(kw)
        with open(kw["out_path"], "wb") as f:
            f.write(b"DUBBED")
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(dub_api, "run_dub", fake_run_dub)
    return runs


def _upload(name="talk.wav", body=b"RIFF-bytes"):
    return client.post("/api/downloads/upload", files={"video": (name, body, "audio/wav")})


def _start(**data):
    files = data.pop("files", None)
    return client.post("/api/dub/start", files=files,
                       data={"language": "Korean", "language_code": "ko", **data})


def _wait(jid):
    for _ in range(250):
        job = state.job_store.get(jid)
        if job["status"] not in ("queued", "running"):
            return job
        time.sleep(0.02)
    raise AssertionError("the job did not end")


def _held_folders():
    root = os.path.join(state.WORKSPACE, "downloads")
    return sorted(os.listdir(root)) if os.path.isdir(root) else []


def _held_ids():
    # The store is one for the whole session, so the tests count what it gained.
    return {d["id"] for d in client.get("/api/downloads").json()["downloads"]}


def _job_ids():
    return {j["id"] for j in client.get("/api/dub/jobs").json()["jobs"]}


def _job_folders():
    return [os.path.join(root, d) for root, dirs, _f in os.walk(state.WORKSPACE) for d in dirs
            if os.path.exists(os.path.join(root, d, "input.mp4"))]


# --- a dropped file ----------------------------------------------------------

@pytest.mark.parametrize("name,fmt", [("talk.wav", "wav"), ("talk.FLAC", "flac"),
                                      ("talk.mp3", "mp3"), ("talk.m4a", "m4a")])
def test_a_dropped_audio_file_is_held_as_audio(probe, name, fmt):
    probe.format = fmt
    r = _upload(name)
    assert r.status_code == 200, r.text
    held = r.json()
    assert held["media"] == "audio" and held["status"] == "ready"
    # The bytes are the user's, untouched, under the name every held file has.
    assert os.path.basename(held["path"]) == "source.mp4"
    assert open(held["path"], "rb").read() == b"RIFF-bytes"
    # The record the screen polls, and the Dub Agent's list, say the same.
    assert client.get("/api/downloads/%s" % held["id"]).json()["media"] == "audio"
    listed = {d["id"]: d["media"] for d in client.get("/api/downloads").json()["downloads"]}
    assert listed[held["id"]] == "audio"
    # Played back as the sound it is, not as video/mp4.
    played = client.get("/api/downloads/%s/video" % held["id"])
    assert played.status_code == 200 and played.headers["content-type"] == media.AUDIO_MIME[fmt]


def test_a_dropped_video_is_held_as_before(probe):
    probe.kind = "video"
    r = client.post("/api/downloads/upload", files={"video": ("clip.mov", b"MOV", "video/quicktime")})
    assert r.status_code == 200, r.text
    assert r.json()["media"] is None
    played = client.get("/api/downloads/%s/video" % r.json()["id"])
    assert played.headers["content-type"] == "video/mp4"


@pytest.mark.parametrize("name", ["clip.mkv", "clip.webm", "clip.avi", "clip.mp4", "noextension"])
def test_a_file_with_a_picture_is_a_video_whatever_its_name(probe, name):
    # The Dub Agent lists .mkv, .webm and .avi beside .mp4 and .mov
    # (app/mcp_server.py list_videos), and they were taken before audio was.
    probe.kind = "video"
    r = _upload(name)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ready" and r.json()["media"] is None


@pytest.mark.parametrize("name", ["talk.ogg", "talk.aac", "talk.opus"])
def test_sound_in_another_container_is_refused_and_not_held(probe, name):
    # ffprobe reads its sound, and says the container is none of the four.
    probe.format = None
    before = _held_ids()
    r = _upload(name)
    assert r.status_code == 422 and r.json()["detail"] == REFUSED
    assert _held_ids() == before and _held_folders() == []


def test_made_up_bytes_are_refused_and_not_held(probe):
    probe.kind = None
    before = _held_ids()
    r = _upload("talk.wav", b"garbage")
    assert r.status_code == 422 and r.json()["detail"] == REFUSED
    assert _held_ids() == before and _held_folders() == []


def test_the_name_does_not_decide_either_way(probe):
    # An .ogg renamed .mp3 is still refused...
    probe.format = None
    r = _upload("talk.mp3")
    assert r.status_code == 422 and r.json()["detail"] == REFUSED
    assert _held_folders() == []
    # ...and an MP3 under some other name is still taken.
    probe.format = "mp3"
    r = _upload("talk.bin")
    assert r.status_code == 200 and r.json()["media"] == "audio"


def test_the_refusal_is_said_in_korean_on_a_korean_computer(probe, monkeypatch):
    from app import i18n
    monkeypatch.setattr(i18n, "_language", "ko")
    probe.format = None
    assert _upload("talk.ogg").json()["detail"] == "MP4, MOV 영상과 WAV, FLAC, MP3, M4A 오디오만 받아요."


def test_a_held_audio_file_is_audio_again_after_a_restart(probe):
    held = _upload().json()
    dl.download_store._items.clear()    # the records live in memory only
    r = client.post("/api/downloads/%s/hold" % held["id"], json={"title": "talk", "duration_sec": 10})
    assert r.status_code == 200, r.text
    assert r.json()["media"] == "audio"


def test_saving_a_held_audio_file_as_a_video_is_refused(probe, tmp_path, monkeypatch):
    held = _upload().json()
    tmp_path = tmp_path / "saved"
    r = client.post("/api/downloads/%s/save" % held["id"], json={"dir": str(tmp_path)})
    assert r.status_code == 409 and r.json()["detail"] == "Only for projects with a video."
    assert not tmp_path.exists()
    # Its sound is saved as any held file's is, in each of the four formats.
    monkeypatch.setattr(media, "has_audio", lambda p: True)
    ran = []
    monkeypatch.setattr(media, "run_new_file", lambda argv, seconds, what: ran.append(argv))
    for fmt in ("mp3", "wav", "flac", "m4a"):
        r = client.post("/api/downloads/%s/save" % held["id"], json={"dir": str(tmp_path), "audio": fmt})
        assert r.status_code == 200, r.text
        assert r.json()["path"].endswith("talk." + fmt) and ran[-1][-1] == r.json()["path"]


# --- a dubbing of it ---------------------------------------------------------

def test_a_dubbing_of_a_held_audio_file_is_an_audio_project(probe, dubbed, tmp_path):
    held = _upload().json()
    r = _start(download_id=held["id"])
    assert r.status_code == 200, r.text
    jid = r.json()["job_id"]
    job = _wait(jid)
    assert job["status"] == "done" and job["media"] == "audio"
    # The source keeps its name and its bytes; only the result is named anew.
    work = job["work_dir"]
    assert open(os.path.join(work, "input.mp4"), "rb").read() == b"RIFF-bytes"
    assert dubbed[0]["video_path"] == os.path.join(work, "input.mp4")
    assert dubbed[0]["out_path"] == os.path.join(work, "dubbed.wav")
    # The job's detail and the jobs list carry it, as job.json does.
    assert client.get("/api/dub/jobs/%s" % jid).json()["media"] == "audio"
    assert [j["media"] for j in client.get("/api/dub/jobs").json()["jobs"] if j["id"] == jid] == ["audio"]
    assert json.load(open(os.path.join(work, "job.json"), encoding="utf-8"))["media"] == "audio"
    # ...and the job's own log says what it was given.
    log = open(os.path.join(str(tmp_path / "logs"), "job-%s.log" % jid), encoding="utf-8").read()
    assert json.loads(log.split(" - Inputs: ", 1)[1].splitlines()[0])["media"] == "audio"


def test_a_dubbing_of_a_video_says_nothing_about_its_media(dubbed):
    r = _start(files={"video": ("v.mp4", b"video-bytes", "video/mp4")})
    assert r.status_code == 200, r.text
    job = _wait(r.json()["job_id"])
    assert job.get("media") is None
    assert dubbed[0]["out_path"] == os.path.join(job["work_dir"], "dubbed.mp4")
    assert json.load(open(os.path.join(job["work_dir"], "job.json"), encoding="utf-8")).get("media") is None


def test_an_audio_file_sent_straight_to_a_start_is_an_audio_project(probe, dubbed):
    # The Dub Agent's door (app/mcp_server.py queue_dub): no held upload first.
    r = _start(files={"video": ("talk.mp3", b"ID3-bytes", "audio/mpeg")})
    assert r.status_code == 200, r.text
    job = _wait(r.json()["job_id"])
    assert job["media"] == "audio" and dubbed[0]["out_path"].endswith("dubbed.wav")


@pytest.mark.parametrize("name", ["clip.mkv", "clip.webm", "clip.avi"])
def test_a_video_of_another_name_sent_straight_to_a_start_is_dubbed_as_before(probe, dubbed, name):
    probe.kind = "video"
    r = _start(files={"video": (name, b"video-bytes", "video/x-matroska")})
    assert r.status_code == 200, r.text
    job = _wait(r.json()["job_id"])
    assert job["status"] == "done" and job.get("media") is None
    assert dubbed[0]["out_path"] == os.path.join(job["work_dir"], "dubbed.mp4")


@pytest.mark.parametrize("name,kind", [
    ("talk.ogg", "audio"),      # sound in a container that is not one of the four
    ("talk.mp3", "audio"),      # the same, named as one of the four
    ("talk.wav", None),         # made-up bytes
])
def test_a_start_refuses_what_a_dubbing_does_not_take_and_leaves_no_folder(probe, monkeypatch, name, kind):
    probe.kind, probe.format = kind, None
    monkeypatch.setattr(dub_api, "run_dub", lambda **kw: pytest.fail("must not dub"))
    before = _job_ids()
    r = _start(files={"video": (name, b"bytes", "application/octet-stream")})
    assert r.status_code == 422 and r.json()["detail"] == REFUSED
    assert _job_folders() == [] and _job_ids() == before


def test_a_trim_of_an_audio_file_is_cut_before_the_dub(probe, dubbed, monkeypatch):
    cuts = []
    monkeypatch.setattr(dub_api, "_cut_video", lambda path, a, b: cuts.append((os.path.basename(path), a, b)))
    held = _upload().json()
    job = _wait(_start(download_id=held["id"], trim_start="1", trim_end="4").json()["job_id"])
    assert job["media"] == "audio" and cuts == [("input.mp4", 1.0, 4.0)]


# --- made again --------------------------------------------------------------

@pytest.fixture
def audio_job(probe, dubbed):
    """A finished dubbing of a held audio file, with a script to remake it from."""
    held = _upload().json()
    job = _wait(_start(download_id=held["id"]).json()["job_id"])
    with open(os.path.join(job["work_dir"], "translated.srt"), "w", encoding="utf-8") as f:
        f.write("1\n00:00:00,000 --> 00:00:01,000\nhi\n")
    return job


def test_try_again_on_an_audio_project_is_an_audio_project(audio_job, dubbed, probe):
    probe.kind = "video"    # not asked again: the record says what it is
    r = client.post("/api/dub/jobs/%s/retry" % audio_job["id"])
    assert r.status_code == 200, r.text
    again = _wait(r.json()["job_id"])
    assert again["media"] == "audio" and dubbed[-1]["out_path"] == os.path.join(again["work_dir"], "dubbed.wav")


def test_a_redub_of_an_audio_project_is_an_audio_project(audio_job, dubbed, probe, monkeypatch):
    probe.kind = "video"
    monkeypatch.setattr(dub_api, "_require_voice_engine_running", lambda voice=None: None)
    r = client.post("/api/dub/jobs/%s/redub" % audio_job["id"])
    assert r.status_code == 200, r.text
    again = _wait(r.json()["job_id"])
    assert again["media"] == "audio" and dubbed[-1]["out_path"] == os.path.join(again["work_dir"], "dubbed.wav")


def test_add_language_on_an_audio_project_opens_an_audio_draft(audio_job, probe):
    # The file it was made from is still held.
    r = client.post("/api/dub/jobs/%s/again" % audio_job["id"])
    assert r.status_code == 200, r.text
    assert r.json()["media"] == "audio"
    assert client.get("/api/downloads/%s" % r.json()["download_id"]).json()["media"] == "audio"
    # And when it is not (the holding folder was cleared), the job's own copy
    # is held, as the audio the record says it is.
    shutil.rmtree(os.path.join(state.WORKSPACE, "downloads"))
    dl.download_store._items.clear()
    probe.kind = "video"
    r = client.post("/api/dub/jobs/%s/again" % audio_job["id"])
    assert r.status_code == 200, r.text
    assert r.json()["media"] == "audio"
    assert client.get("/api/downloads/%s" % r.json()["download_id"]).json()["media"] == "audio"


def test_an_audio_project_that_waited_out_a_restart_still_writes_audio(audio_job, dubbed, tmp_path):
    # The boot re-arm has only job.json to go on (app/api/dub.py).
    store = jobs.JobStore(log_dir=str(tmp_path / "logs"))
    store.restore(state.WORKSPACE)
    job = store.get(audio_job["id"])
    assert job["media"] == "audio"
    dub_api._dub_target_for(job)(lambda line: None)
    assert dubbed[-1]["out_path"] == os.path.join(job["work_dir"], "dubbed.wav")


# --- the tools that work on a picture -----------------------------------------

def test_captions_refuse_a_held_audio_file_and_leave_no_folder(probe):
    held = _upload().json()
    r = client.post("/api/captions/import", data={"download_id": held["id"]},
                    files={"srt": ("a.srt", b"1\n00:00:00,500 --> 00:00:02,000\nhi\n", "application/x-subrip")})
    assert r.status_code == 422 and r.json()["detail"] == VIDEO_ONLY
    assert _job_folders() == []


def test_erase_refuses_audio_however_it_arrives_and_leaves_no_folder(probe, monkeypatch):
    monkeypatch.setattr(eraser, "run_erase", lambda *a, **kw: pytest.fail("must not erase"))
    held = _upload().json()
    before = _job_ids()
    r = client.post("/api/erase", data={"download_id": held["id"], "area": "whole"})
    assert r.status_code == 422 and r.json()["detail"] == VIDEO_ONLY
    r = client.post("/api/erase", data={"area": "whole"},
                    files={"video": ("talk.mp3", b"ID3", "audio/mpeg")})
    assert r.status_code == 422 and r.json()["detail"] == VIDEO_ONLY
    assert _job_folders() == [] and _job_ids() == before
    # Nor is it looked through for subtitles.
    monkeypatch.setattr(eraser, "suggest_area", lambda path: pytest.fail("must not look"))
    r = client.post("/api/erase/suggest", data={"download_id": held["id"]})
    assert r.status_code == 422 and r.json()["detail"] == VIDEO_ONLY


def test_cutting_a_clip_refuses_an_audio_file(probe, tmp_path, monkeypatch):
    from app.api import clips as clips_api
    monkeypatch.setattr(clips_api.subprocess, "run", lambda *a, **kw: pytest.fail("must not cut"))
    song = tmp_path / "song.mp3"
    song.write_bytes(b"ID3")
    r = client.post("/api/clips/cut", json={"video_path": str(song), "start": 1, "end": 2})
    assert r.status_code == 422 and r.json()["detail"] == VIDEO_ONLY
    assert sorted(p.name for p in tmp_path.iterdir() if p.name.startswith("song")) == ["song.mp3"]
