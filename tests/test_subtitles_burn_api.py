"""Laying subtitles onto a video, as a new file beside the original.

ffmpeg is replaced with a recorder, the same way test_clips_api.py does it:
what these pin down is the filter the route builds (which .srt, which style),
where the result lands, and that nothing on disk is written over. All free
and local: no Perso, no credits, no confirm gate.
"""
from fastapi.testclient import TestClient

import app.main as main
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


class _Ran:
    def __init__(self):
        self.calls = []
        self.returncode = 0
        self.stderr = ""

    def __call__(self, cmd, capture_output=True, text=True):
        self.calls.append(cmd)
        if self.returncode == 0:
            open(cmd[-1], "wb").close()
        return self


def _wire(monkeypatch, tmp_path, srt=True):
    ran = _Ran()
    monkeypatch.setattr(main.subprocess, "run", ran)
    video = tmp_path / "쇼츠 3편.mp4"
    video.write_bytes(b"not really a video")
    if srt:
        (tmp_path / "쇼츠 3편.srt").write_text("1\n00:00:00,000 --> 00:00:01,000\n안녕\n")
    return ran, video


def _vf(cmd):
    return cmd[cmd.index("-vf") + 1]


def test_burn_writes_the_subtitled_video_next_to_the_original(monkeypatch, tmp_path):
    ran, video = _wire(monkeypatch, tmp_path)
    r = client.post("/api/subtitles/burn",
                    json={"video_path": str(video), "preset": "variety"})
    assert r.status_code == 200
    assert r.json()["out_path"] == str(tmp_path / "쇼츠 3편-sub-variety.mp4")
    cmd = ran.calls[0]
    assert cmd[0] == "ffmpeg"
    assert cmd[cmd.index("-i") + 1] == str(video)
    assert "쇼츠 3편.srt" in _vf(cmd)
    # variety is the loud yellow one; the colour pins the preset table.
    assert "&H0000FFFF" in _vf(cmd)
    assert "+faststart" in cmd


def test_burn_takes_a_named_srt_and_the_quiet_default(monkeypatch, tmp_path):
    ran, video = _wire(monkeypatch, tmp_path, srt=False)
    other = tmp_path / "손질한 자막.srt"
    other.write_text("1\n00:00:00,000 --> 00:00:01,000\n안녕\n")
    r = client.post("/api/subtitles/burn",
                    json={"video_path": str(video), "srt_path": str(other)})
    assert r.status_code == 200
    # No preset named means clean -- white with a dark outline.
    assert r.json()["out_path"].endswith("-sub-clean.mp4")
    assert "손질한 자막.srt" in _vf(ran.calls[0])


def test_burn_never_writes_over_an_existing_file(monkeypatch, tmp_path):
    ran, video = _wire(monkeypatch, tmp_path)
    keep = tmp_path / "쇼츠 3편-sub-clean.mp4"
    keep.write_bytes(b"an earlier pass")
    r = client.post("/api/subtitles/burn", json={"video_path": str(video)})
    assert r.status_code == 200
    assert r.json()["out_path"] == str(tmp_path / "쇼츠 3편-sub-clean-1.mp4")
    assert keep.read_bytes() == b"an earlier pass"


def test_burn_says_when_there_is_no_srt_to_lay_on(monkeypatch, tmp_path):
    ran, video = _wire(monkeypatch, tmp_path, srt=False)
    r = client.post("/api/subtitles/burn", json={"video_path": str(video)})
    assert r.status_code == 404
    assert "subtitle" in r.json()["detail"].lower()
    assert ran.calls == []


def test_burn_refuses_a_preset_it_does_not_know(monkeypatch, tmp_path):
    ran, video = _wire(monkeypatch, tmp_path)
    r = client.post("/api/subtitles/burn",
                    json={"video_path": str(video), "preset": "neon"})
    assert r.status_code == 422
    assert ran.calls == []


def test_burn_escapes_the_srt_path_for_the_filter(monkeypatch, tmp_path):
    # libass reads the filename through ffmpeg's filter parser, where a bare
    # apostrophe or colon ends the argument early.
    ran, video = _wire(monkeypatch, tmp_path, srt=False)
    quoted = tmp_path / "it's.srt"
    quoted.write_text("1\n00:00:00,000 --> 00:00:01,000\nhi\n")
    r = client.post("/api/subtitles/burn",
                    json={"video_path": str(video), "srt_path": str(quoted)})
    assert r.status_code == 200
    assert "it\\'s.srt" in _vf(ran.calls[0])
