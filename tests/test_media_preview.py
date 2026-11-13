"""The timeline's film strip and sound picture (app/media_preview.py and the
GET /api/media/{kind}/{id}/filmstrip|waveform routes).

Made once with ffmpeg and kept beside the video; made again only when the
video is newer than what was kept. The real ffmpeg runs on a tiny generated
video; the maths is checked on hand-made sound.
"""
import json
import math
import os
import struct
import subprocess
import time

import pytest
from fastapi.testclient import TestClient

from app import media_preview, state
from app.api import downloads as dl
from app.main import app
from tests.marks import needs_ffmpeg

client = TestClient(app, base_url="http://127.0.0.1")


def _make_video(path, seconds=3, audio=True):
    argv = ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
            f"testsrc=size=160x90:rate=25:duration={seconds}"]
    if audio:
        argv += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-shortest"]
    argv += ["-c:v", "libx264", "-pix_fmt", "yuv420p", path]
    subprocess.run(argv, check=True, capture_output=True)


def _jpeg_size(path):
    """Width and height out of a JPEG's SOF marker, without an image library."""
    data = open(path, "rb").read()
    i = 2
    while i < len(data):
        marker, length = data[i + 1], struct.unpack(">H", data[i + 2:i + 4])[0]
        if 0xC0 <= marker <= 0xC3:
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return w, h
        i += 2 + length
    raise AssertionError("no frame header")


# --- the numbers ------------------------------------------------------------

def test_one_frame_per_strip_width_at_zoom_one_and_never_more_than_sixty():
    assert media_preview.frame_count(0) == 1
    assert media_preview.frame_count(10) == 12          # 770px of timeline / 69
    assert media_preview.frame_count(3600) == 60


def test_the_strip_command_tiles_frames_of_the_right_size():
    argv = media_preview.filmstrip_command("/v/in.mp4", "/v/out.jpg", 10)
    vf = argv[argv.index("-vf") + 1]
    assert "scale=69:39" in vf and "crop=69:39" in vf and vf.endswith("tile=12x1")
    assert "-skip_frame" not in argv
    # A long video reads keyframes only.
    assert "-skip_frame" in media_preview.filmstrip_command("/v/in.mp4", "/v/o.jpg", 600)


def test_loudness_is_rms_per_25th_of_a_second_scaled_to_the_loudest():
    step = media_preview.SAMPLE_RATE // 25
    quiet, loud = [100] * step, [1000] * step
    pcm = struct.pack(f"<{step * 3}h", *(quiet + loud + [0] * step))
    data = media_preview.peaks_from_pcm(pcm, 0.12)
    assert data["peaks"] == [0.1, 1.0, 0.0]
    assert data["rate"] == 25


def test_an_hour_of_sound_stays_small(monkeypatch):
    # One sample per window, so an hour is 90 000 windows without 14 million
    # samples: the size of the answer is what is checked, not the loudness.
    monkeypatch.setattr(media_preview, "SAMPLE_RATE", 25)
    seconds = 3600
    pcm = struct.pack(f"<{seconds * 25}h", *([500] * (seconds * 25)))
    data = media_preview.peaks_from_pcm(pcm, seconds)
    assert len(data["peaks"]) <= media_preview.MAX_PEAKS
    assert math.isclose(data["rate"] * seconds, len(data["peaks"]), rel_tol=0.01)


# --- the real thing -----------------------------------------------------------

@needs_ffmpeg
def test_a_strip_and_a_waveform_are_made_once_and_kept(tmp_path):
    (tmp_path / "v").mkdir()
    video = str(tmp_path / "v" / "input.mp4")
    _make_video(video, seconds=3)
    strip = media_preview.filmstrip(video)
    assert strip == video + ".filmstrip.jpg"
    n = media_preview.frame_count(3)
    assert _jpeg_size(strip) == (69 * n, 39)
    made = os.path.getmtime(strip)

    wave = media_preview.waveform(video)
    assert len(wave["peaks"]) == pytest.approx(75, abs=2)
    assert max(wave["peaks"]) == 1.0 and min(wave["peaks"]) >= 0
    assert json.load(open(video + ".waveform.json")) == wave

    # Asked again: the kept files, not a second ffmpeg run.
    time.sleep(0.01)
    assert media_preview.filmstrip(video) == strip and os.path.getmtime(strip) == made
    # No temporary file is left behind.
    assert sorted(os.listdir(tmp_path / "v")) == ["input.mp4", "input.mp4.filmstrip.jpg",
                                             "input.mp4.waveform.json"]


@needs_ffmpeg
def test_a_video_newer_than_its_strip_is_described_again(tmp_path):
    video = str(tmp_path / "input.mp4")
    _make_video(video, seconds=2)
    strip = media_preview.filmstrip(video)
    old = os.path.getmtime(strip) - 10
    os.utime(strip, (old, old))
    assert os.path.getmtime(media_preview.filmstrip(video)) > old


@needs_ffmpeg
def test_a_silent_video_has_an_empty_waveform(tmp_path):
    video = str(tmp_path / "input.mp4")
    _make_video(video, seconds=2, audio=False)
    assert media_preview.waveform(video)["peaks"] == []


@needs_ffmpeg
def test_a_file_ffmpeg_cannot_read_says_so(tmp_path):
    (tmp_path / "v").mkdir()
    video = str(tmp_path / "v" / "input.mp4")
    open(video, "wb").write(b"not a video")
    with pytest.raises(RuntimeError, match="Could not read frames"):
        media_preview.filmstrip(video)
    assert os.listdir(tmp_path / "v") == ["input.mp4"]


def test_an_audio_file_has_no_film_strip_even_when_it_carries_a_cover(monkeypatch, tmp_path):
    """ffmpeg would tile an album cover into a strip; an audio project's
    timeline shows its sound only, so it is refused before ffmpeg is asked."""
    (tmp_path / "v").mkdir()
    song = str(tmp_path / "v" / "input.mp4")
    open(song, "wb").write(b"ID3")
    monkeypatch.setattr(media_preview.media, "media_kind", lambda path: "audio")
    monkeypatch.setattr(media_preview.subprocess, "run", lambda *a, **kw: pytest.fail("must not run ffmpeg"))
    with pytest.raises(RuntimeError, match="Could not read frames"):
        media_preview.filmstrip(song)
    assert os.listdir(tmp_path / "v") == ["input.mp4"]


@needs_ffmpeg
def test_an_audio_file_has_a_waveform(tmp_path):
    song = str(tmp_path / "input.mp4")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                    "-f", "wav", song], check=True, capture_output=True)
    wave = media_preview.waveform(song)
    assert wave["duration"] == pytest.approx(2.0, abs=0.05)
    assert len(wave["peaks"]) == pytest.approx(50, abs=2) and max(wave["peaks"]) == 1.0


# --- the routes ---------------------------------------------------------------

def _job_with_video(tmp_path, make=True):
    work = tmp_path / "job"
    work.mkdir()
    if make:
        _make_video(str(work / "input.mp4"), seconds=2)
    jid = state.job_store.create()
    state.job_store._update(jid, status="done", work_dir=str(work))
    return jid


@needs_ffmpeg
def test_the_routes_serve_a_jobs_original(tmp_path):
    jid = _job_with_video(tmp_path)
    r = client.get(f"/api/media/job/{jid}/filmstrip")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    w = client.get(f"/api/media/job/{jid}/waveform").json()
    assert w["rate"] > 0 and len(w["peaks"]) > 0


@needs_ffmpeg
def test_the_routes_serve_a_held_download(tmp_path):
    held = dl.download_store.add_file(str(tmp_path / "ws"), "Cats", 2,
                                      lambda dest: _make_video(dest, seconds=2))
    r = client.get(f"/api/media/download/{held.id}/waveform")
    assert r.status_code == 200 and r.json()["peaks"]
    assert client.get(f"/api/media/download/{held.id}/filmstrip").status_code == 200


def test_unknown_videos_are_404(tmp_path):
    assert client.get("/api/media/job/nope/filmstrip").status_code == 404
    assert client.get("/api/media/download/nope/waveform").status_code == 404
    assert client.get("/api/media/other/x/waveform").status_code == 404
    jid = _job_with_video(tmp_path, make=False)
    assert client.get(f"/api/media/job/{jid}/filmstrip").status_code == 404


@needs_ffmpeg
def test_a_broken_video_answers_503_with_a_sentence(tmp_path):
    work = tmp_path / "job"
    work.mkdir()
    (work / "input.mp4").write_bytes(b"junk")
    jid = state.job_store.create()
    state.job_store._update(jid, status="done", work_dir=str(work))
    r = client.get(f"/api/media/job/{jid}/filmstrip")
    assert r.status_code == 503 and "frames" in r.json()["detail"]
