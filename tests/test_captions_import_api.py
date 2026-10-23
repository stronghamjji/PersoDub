"""The Subtitle style tab on its own (app/api/captions.py): a held video and
the user's .srt become a finished "captions" project, which the finished-dub
routes then serve -- the lines, the .srt and the subtitled video."""
import os

import pytest
from fastapi.testclient import TestClient

from app import media, state
from app.api import downloads as downloads_api
from app.api import results as results_api
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")

SRT = (b"1\n00:00:00,500 --> 00:00:02,000\nBonjour\n\n"
       b"2\n00:00:02,500 --> 00:00:04,000\nComment ca va\n\n"
       b"3\n00:00:09,000 --> 00:00:12,000\nA bientot\n")


@pytest.fixture(autouse=True)
def _ten_seconds(monkeypatch):
    monkeypatch.setattr(media, "video_duration", lambda path: 10.0)


def _held():
    return downloads_api.download_store.add_file(
        state.WORKSPACE, "paris_steps", 10, lambda dest: open(dest, "wb").write(b"VIDEO"))


def _import(download_id, srt=SRT, name="paris_ko.srt"):
    return client.post("/api/captions/import", data={"download_id": download_id},
                       files={"srt": (name, srt, "application/x-subrip")})


def test_a_video_and_its_srt_become_a_finished_captions_project():
    r = _import(_held().id)
    assert r.status_code == 200, r.text
    assert r.json()["lines"] == 3
    jid = r.json()["job_id"]
    job = client.get("/api/dub/jobs/%s" % jid).json()
    assert job["kind"] == "captions" and job["status"] == "done"
    assert job["title"] == "paris_steps" and job["srt_name"] == "paris_ko.srt"
    assert job["duration"] == 10.0
    work = state.job_store.get(jid)["work_dir"]
    assert open(os.path.join(work, "input.mp4"), "rb").read() == b"VIDEO"
    # The last line ran past the video's end and is cut there.
    srt = client.get("/api/dub/result/%s/srt?download=1" % jid)
    assert srt.status_code == 200
    assert "00:00:09,000 --> 00:00:10,000" in srt.text
    assert srt.headers["content-disposition"] == 'attachment; filename="video.srt"'
    # The finished-dub script route reads the same lines for the tab.
    lines = client.get("/api/dub/jobs/%s/script" % jid).json()["lines"]
    assert [l["text"] for l in lines] == ["Bonjour", "Comment ca va", "A bientot"]
    # A dub's subtitles start off; these are the project, so they start on.
    assert client.get("/api/dub/jobs/%s/subtitle_style" % jid).json()["enabled"] is True
    # Written beside the video, so Projects reopens it after a restart.
    assert os.path.isfile(os.path.join(work, "job.json"))


def test_a_file_with_no_subtitle_lines_is_refused_and_leaves_no_folder():
    held = _held()
    before = set(os.listdir(state.WORKSPACE))
    r = _import(held.id, srt=b"this is not a subtitle file\n")
    assert r.status_code == 422
    assert "no lines" in r.json()["detail"]
    assert set(os.listdir(state.WORKSPACE)) == before
    # Not UTF-8 at all.
    assert _import(held.id, srt=b"\xff\xfe\x00\x01").status_code == 422


def test_lines_that_all_start_after_the_video_are_refused():
    late = b"1\n00:00:20,000 --> 00:00:22,000\nToo late\n"
    r = _import(_held().id, srt=late)
    assert r.status_code == 422
    assert "after the video ends" in r.json()["detail"]


def test_a_video_that_is_not_held_is_refused():
    r = _import("nope")
    assert r.status_code == 404


def test_the_subtitled_video_downloads_under_a_plain_name(monkeypatch):
    jid = _import(_held().id).json()["job_id"]
    calls = []

    def ran(cmd, **_kw):
        if cmd[0] == "ffprobe":
            raise OSError("no ffprobe in tests")
        calls.append(cmd)
        open(cmd[-1], "wb").write(b"FAKE")
        return type("R", (), {"returncode": 0, "stderr": ""})()

    monkeypatch.setattr(results_api.subprocess, "run", ran)
    r = client.get("/api/dub/result/%s/subtitled?preset=sticker&download=1" % jid)
    assert r.status_code == 200, r.text
    assert r.headers["content-disposition"] == 'attachment; filename="video-sub-sticker.mp4"'
    # Burned onto the job's own video.
    assert calls[0][calls[0].index("-i") + 1].endswith("input.mp4")


def test_its_video_can_be_held_again_to_dub_it():
    """The Dubbing tab's one button: the same video, held for a new project."""
    held = _held()
    jid = _import(held.id).json()["job_id"]
    r = client.post("/api/dub/jobs/%s/again" % jid)
    assert r.status_code == 200, r.text
    assert r.json()["download_id"]
    assert r.json()["title"] == "paris_steps"
