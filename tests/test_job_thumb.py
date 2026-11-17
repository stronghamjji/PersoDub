"""The Home screen's project-card thumbnail: a small JPEG made from a job's
own video with real ffmpeg (a tiny generated clip, no network, no mocked
subprocess -- the point of this route is what ffmpeg actually draws)."""
import os
import subprocess as sp
import time

import pytest
from fastapi.testclient import TestClient

from app import state
from app.api import _launch as launch_api
from app.api import dub as dub_api
from app.main import app
from tests.marks import needs_ffmpeg

client = TestClient(app, base_url="http://127.0.0.1")


@pytest.fixture(autouse=True)
def _all_engines_available(monkeypatch):
    monkeypatch.setattr(launch_api, "missing_models", lambda *a, **kw: [])


def _tiny_video(tmp_path) -> bytes:
    """A 1-second, 64x64 clip made with ffmpeg's own test source -- real,
    decodable video bytes, fast to generate and tiny to carry around."""
    out = tmp_path / "tiny.mp4"
    r = sp.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "testsrc=size=64x64:rate=5:duration=1",
                "-pix_fmt", "yuv420p", str(out)],
               capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return out.read_bytes()


def _queued_job(monkeypatch, tmp_path):
    """A job whose input.mp4 is a real tiny video, with the (slow, heavy)
    dubbing pipeline itself faked out -- the thumbnail route only ever reads
    the uploaded video, never the finished dub."""
    return _queued_job_of_bytes(monkeypatch, _tiny_video(tmp_path))


def _queued_job_of_bytes(monkeypatch, video: bytes):
    monkeypatch.setattr(dub_api, "run_dub", lambda **kw: {
        "job_id": "x", "out_path": kw["out_path"], "num_segments": 1})
    r = client.post("/api/dub/start", files={"video": ("v.mp4", video, "video/mp4")},
                    data={"language": "Korean", "language_code": "ko"})
    assert r.status_code == 200, r.text
    return r.json()["job_id"]


def test_unknown_job_is_404():
    assert client.get("/api/dub/jobs/nope/thumb").status_code == 404


def test_a_job_with_no_video_yet_is_404(monkeypatch):
    jid = state.job_store.create()
    assert client.get(f"/api/dub/jobs/{jid}/thumb").status_code == 404


@needs_ffmpeg
def test_thumb_is_a_real_jpeg_drawn_from_the_video(monkeypatch, tmp_path):
    jid = _queued_job(monkeypatch, tmp_path)
    r = client.get(f"/api/dub/jobs/{jid}/thumb")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "image/jpeg"
    assert r.content[:2] == b"\xff\xd8"  # a JPEG's own magic bytes
    assert len(r.content) > 100


@needs_ffmpeg
def test_thumb_is_cached_after_the_first_draw(monkeypatch, tmp_path):
    jid = _queued_job(monkeypatch, tmp_path)
    r1 = client.get(f"/api/dub/jobs/{jid}/thumb")
    made_at = os.path.getmtime(
        os.path.join(state.job_store.get(jid)["work_dir"], "thumb.jpg"))
    time.sleep(0.05)
    r2 = client.get(f"/api/dub/jobs/{jid}/thumb")
    assert r1.content == r2.content
    assert os.path.getmtime(
        os.path.join(state.job_store.get(jid)["work_dir"], "thumb.jpg")) == made_at


# --- an audio project: the card's picture is the shape of its sound ----------

def _tiny_song(tmp_path) -> bytes:
    """Two seconds of a tone that comes and goes, as a WAV: real sound, with
    loud and quiet parts for a waveform to show."""
    out = tmp_path / "tiny.wav"
    r = sp.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                "-af", "tremolo=f=2:d=0.9", str(out)],
               capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return out.read_bytes()


def _audio_job(monkeypatch, song: bytes):
    """A finished job made from an audio file. ffprobe's answer at intake is
    replaced, as in tests/test_audio_intake.py; the pipeline is faked."""
    from app import media
    monkeypatch.setattr(media, "media_kind", lambda path: "audio")
    monkeypatch.setattr(media, "audio_format", lambda path: "wav")
    monkeypatch.setattr(dub_api, "run_dub", lambda **kw: {
        "job_id": "x", "out_path": kw["out_path"], "num_segments": 1})
    r = client.post("/api/dub/start", files={"video": ("talk.wav", song, "audio/wav")},
                    data={"language": "Korean", "language_code": "ko"})
    assert r.status_code == 200, r.text
    jid = r.json()["job_id"]
    _wait(jid)
    assert state.job_store.get(jid)["media"] == "audio"
    return jid


def _wait(jid):
    """Until the job's own thread is done, so nothing of it runs under a
    stand-in put in afterwards."""
    deadline = time.time() + 5
    while state.job_store.get(jid)["status"] in ("queued", "running") and time.time() < deadline:
        time.sleep(0.02)


def _fake_ffmpeg(monkeypatch):
    """ffmpeg replaced by a stand-in that writes a few bytes where it is told
    (its last word is the file to make). Nothing else is run."""
    calls = []

    def fake_run(cmd, **kw):
        assert cmd[0] == "ffmpeg", cmd
        calls.append(cmd)
        with open(cmd[-1], "wb") as f:
            f.write(b"\xff\xd8JPEG")
        return sp.CompletedProcess(cmd, 0, "", "")
    monkeypatch.setattr(sp, "run", fake_run)
    return calls


def test_an_audio_projects_thumb_is_drawn_from_its_sound(monkeypatch):
    jid = _audio_job(monkeypatch, b"RIFF-bytes")
    calls = _fake_ffmpeg(monkeypatch)
    r = client.get(f"/api/dub/jobs/{jid}/thumb")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    drawn = " ".join(calls[-1])
    assert "showwavespic" in drawn and "thumbnail=" not in drawn
    # The same file as a video's: a JPEG 248 wide, kept as thumb.jpg.
    assert "248x" in drawn and calls[-1][-3:-1] == ["-f", "mjpeg"]
    assert os.path.exists(os.path.join(state.job_store.get(jid)["work_dir"], "thumb.jpg"))
    # Drawn once.
    client.get(f"/api/dub/jobs/{jid}/thumb")
    assert len(calls) == 1


def test_a_video_projects_thumb_is_drawn_as_it_always_was(monkeypatch, tmp_path):
    jid = _queued_job_of_bytes(monkeypatch, b"FAKEMP4")
    _wait(jid)
    calls = _fake_ffmpeg(monkeypatch)
    assert client.get(f"/api/dub/jobs/{jid}/thumb").status_code == 200
    video = os.path.join(state.job_store.get(jid)["work_dir"], "input.mp4")
    assert calls[-1][:-1] == ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                              "-t", "8", "-i", video,
                              "-vf", "thumbnail=90,scale=248:-2",
                              "-frames:v", "1", "-q:v", "4", "-f", "mjpeg"]


@needs_ffmpeg
def test_an_audio_projects_thumb_is_a_real_jpeg_of_its_waveform(monkeypatch, tmp_path):
    jid = _audio_job(monkeypatch, _tiny_song(tmp_path))
    r = client.get(f"/api/dub/jobs/{jid}/thumb")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "image/jpeg"
    assert r.content[:2] == b"\xff\xd8"
    thumb = os.path.join(state.job_store.get(jid)["work_dir"], "thumb.jpg")
    # As wide as a video's thumbnail, and square like the card it fills.
    size = sp.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                   "stream=width,height", "-of", "csv=p=0", thumb], capture_output=True, text=True)
    assert size.stdout.strip().rstrip(",") == "248,248"
    # A picture of something: bright bars on a dark ground, not one flat colour.
    grey = sp.run(["ffmpeg", "-v", "error", "-i", thumb, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                  capture_output=True).stdout
    assert len(grey) == 248 * 248
    assert min(grey) < 40 and max(grey) > 90
    # The sound comes and goes, so the columns are not all the same height.
    lit = [sum(1 for y in range(248) if grey[y * 248 + x] > 60) for x in range(248)]
    assert max(lit) - min(lit) > 40
