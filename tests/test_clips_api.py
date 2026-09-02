"""Cutting a stretch of a video into its own file, next to the original.

ffmpeg is replaced with a recorder -- what these pin down is the command the
route builds (accurate seek, re-encode, faststart), where the clip lands, and
that nothing already on disk is ever written over. All free and local: no
Perso, no credits, no confirm gate.
"""
from fastapi.testclient import TestClient

import app.main as main
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


class _Ran:
    """The ffmpeg calls made, answering success and writing the output file."""

    def __init__(self):
        self.calls = []
        self.returncode = 0
        self.stderr = ""

    def __call__(self, cmd, capture_output=True, text=True):
        self.calls.append(cmd)
        if self.returncode == 0:
            # A real ffmpeg leaves a file behind; the no-overwrite rule below
            # needs that to be true here as well.
            open(cmd[-1], "wb").close()
        return self

    @property
    def out_path(self):
        return self.calls[-1][-1]


def _wire(monkeypatch, tmp_path, duration=60.0):
    ran = _Ran()
    monkeypatch.setattr(main.subprocess, "run", ran)
    monkeypatch.setattr(main, "_video_duration", lambda p: duration)
    video = tmp_path / "쇼츠 3편.mp4"
    video.write_bytes(b"not really a video")
    return ran, video


def test_cut_writes_the_clip_next_to_the_video(monkeypatch, tmp_path):
    ran, video = _wire(monkeypatch, tmp_path)
    r = client.post("/api/clips/cut",
                    json={"video_path": str(video), "start": 10, "end": 25})
    assert r.status_code == 200
    body = r.json()
    assert body["seconds"] == 15.0
    assert body["clip_path"] == str(tmp_path / "쇼츠 3편-clip-10s-25s.mp4")
    cmd = ran.calls[0]
    assert cmd[0] == "ffmpeg"
    # -ss before -i with -t: the accurate cut the official plugin uses.
    assert cmd[cmd.index("-ss") + 1] == "10.000"
    assert cmd[cmd.index("-t") + 1] == "15.000"
    assert cmd[cmd.index("-i") + 1] == str(video)
    assert "+faststart" in cmd


def test_cut_reads_colon_timecodes_too(monkeypatch, tmp_path):
    ran, video = _wire(monkeypatch, tmp_path, duration=600.0)
    r = client.post("/api/clips/cut",
                    json={"video_path": str(video), "start": "1:05", "end": "2:00"})
    assert r.status_code == 200
    assert r.json()["seconds"] == 55.0
    assert r.json()["clip_path"].endswith("-clip-1m5s-2m0s.mp4")


def test_cut_never_writes_over_an_existing_file(monkeypatch, tmp_path):
    ran, video = _wire(monkeypatch, tmp_path)
    keep = tmp_path / "쇼츠 3편-clip-10s-25s.mp4"
    keep.write_bytes(b"an earlier clip")
    r = client.post("/api/clips/cut",
                    json={"video_path": str(video), "start": 10, "end": 25})
    assert r.status_code == 200
    assert r.json()["clip_path"] == str(tmp_path / "쇼츠 3편-clip-10s-25s-1.mp4")
    assert keep.read_bytes() == b"an earlier clip"


def test_cut_refuses_a_backwards_range(monkeypatch, tmp_path):
    ran, video = _wire(monkeypatch, tmp_path)
    r = client.post("/api/clips/cut",
                    json={"video_path": str(video), "start": 25, "end": 10})
    assert r.status_code == 422
    assert ran.calls == []


def test_cut_refuses_a_start_past_the_end_of_the_video(monkeypatch, tmp_path):
    ran, video = _wire(monkeypatch, tmp_path, duration=30.0)
    r = client.post("/api/clips/cut",
                    json={"video_path": str(video), "start": 45, "end": 60})
    assert r.status_code == 422
    assert ran.calls == []


def test_cut_clamps_an_end_past_the_video_to_its_end(monkeypatch, tmp_path):
    ran, video = _wire(monkeypatch, tmp_path, duration=30.0)
    r = client.post("/api/clips/cut",
                    json={"video_path": str(video), "start": 20, "end": 999})
    assert r.status_code == 200
    assert r.json()["seconds"] == 10.0


def test_cut_names_a_video_that_is_not_there(monkeypatch, tmp_path):
    _wire(monkeypatch, tmp_path)
    r = client.post("/api/clips/cut",
                    json={"video_path": str(tmp_path / "없음.mp4"),
                          "start": 0, "end": 5})
    assert r.status_code == 404


def test_cut_relays_an_ffmpeg_failure(monkeypatch, tmp_path):
    ran, video = _wire(monkeypatch, tmp_path)
    ran.returncode = 1
    ran.stderr = "moov atom not found"
    r = client.post("/api/clips/cut",
                    json={"video_path": str(video), "start": 0, "end": 5})
    assert r.status_code == 503
    assert "moov" in r.json()["detail"]
