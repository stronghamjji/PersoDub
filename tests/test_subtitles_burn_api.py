"""Laying subtitles onto a video, as a new file beside the original.

The route now writes a full .ass (app/subtitle_ass.py, the plugin's ten
presets) and burns THAT; ffmpeg is a recorder, so what these pin down is the
.ass that was written, where the result lands, and that nothing on disk is
written over. All free and local: no Perso, no credits, no confirm gate."""
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
        (tmp_path / "쇼츠 3편.srt").write_text("1\n00:00:00,000 --> 00:00:01,000\n안녕\n", encoding="utf-8")
    return ran, video


def _ass(tmp_path):
    return (tmp_path / "subtitle_render.ass").read_text(encoding="utf-8")


def test_burn_writes_the_subtitled_video_next_to_the_original(monkeypatch, tmp_path):
    ran, video = _wire(monkeypatch, tmp_path)
    r = client.post("/api/subtitles/burn",
                    json={"video_path": str(video), "preset": "neon-yellow"})
    assert r.status_code == 200
    assert r.json()["out_path"] == str(tmp_path / "쇼츠 3편-sub-neon-yellow.mp4")
    cmd = ran.calls[0]
    assert cmd[0] == "ffmpeg"
    assert cmd[cmd.index("-i") + 1] == str(video)
    assert cmd[cmd.index("-vf") + 1].startswith("ass=filename=")
    # The .ass carries the preset's own yellow and the srt's words.
    assert "&H0000E6FF&" in _ass(tmp_path)
    assert "안녕" in _ass(tmp_path)
    assert "+faststart" in cmd


def test_burn_takes_a_named_srt_and_the_quiet_default(monkeypatch, tmp_path):
    ran, video = _wire(monkeypatch, tmp_path, srt=False)
    other = tmp_path / "손질한 자막.srt"
    other.write_text("1\n00:00:00,000 --> 00:00:01,000\n다듬은 문장\n", encoding="utf-8")
    r = client.post("/api/subtitles/burn",
                    json={"video_path": str(video), "srt_path": str(other)})
    assert r.status_code == 200
    assert r.json()["out_path"].endswith("-sub-clean.mp4")
    assert "다듬은 문장" in _ass(tmp_path)


def test_burn_still_answers_to_the_old_style_names(monkeypatch, tmp_path):
    # variety and box shipped for a day; they are the plugin's neon-yellow
    # and sticker now, and anything asking by the old name gets the new one.
    ran, video = _wire(monkeypatch, tmp_path)
    r = client.post("/api/subtitles/burn",
                    json={"video_path": str(video), "preset": "variety"})
    assert r.status_code == 200
    assert r.json()["preset"] == "neon-yellow"


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
                    json={"video_path": str(video), "preset": "sparkle"})
    assert r.status_code == 422
    assert ran.calls == []
