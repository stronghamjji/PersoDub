"""The Export dialog's subtitled video: built in the job's own folder, the
edited script preferred over the original, rebuilt only when something under
it changed. ffmpeg is a recorder here, as in test_clips_api.py."""
import os
import time

import pytest
from fastapi.testclient import TestClient

import app.main as main
from app.main import app

client = TestClient(app, base_url="http://127.0.0.1")


@pytest.fixture(autouse=True)
def _all_engines_available(monkeypatch):
    # Same bypass as tests/test_dub_api.py: these tests exercise the export
    # routes, not the model preflight.
    monkeypatch.setattr(main, "gemma_available", lambda: True)
    monkeypatch.setattr(main, "qwen_available", lambda: True)
    monkeypatch.setattr(main, "gemma_status", lambda: "available")
    monkeypatch.setattr(main, "qwen_status", lambda: "available")
    monkeypatch.setattr(main, "gemini_available", lambda: True)
    monkeypatch.setattr(main, "perso_available", lambda: True)
    monkeypatch.setattr(main, "_missing_models", lambda *a, **kw: [])


class _Ran:
    def __init__(self):
        self.calls = []
        self.returncode = 0
        self.stderr = ""

    def __call__(self, cmd, capture_output=True, text=True):
        self.calls.append(cmd)
        open(cmd[-1], "wb").write(b"FAKE")
        return self


def _vf(cmd):
    return cmd[cmd.index("-vf") + 1]


def _done_job(monkeypatch, tmp_path):
    ran = _Ran()
    monkeypatch.setattr(main.subprocess, "run", ran)
    out_file = tmp_path / "dubbed.mp4"
    (tmp_path / "translated.srt").write_text(
        "1\n00:00:02,000 --> 00:00:04,000\n원래 번역\n", encoding="utf-8")

    def fake_run_dub(**kw):
        out_file.write_bytes(b"FAKEMP4")
        return {"job_id": "x", "out_path": str(out_file), "num_segments": 1}

    monkeypatch.setattr(main, "run_dub", fake_run_dub)
    r = client.post("/api/dub/start", files={"video": ("v.mp4", b"vid", "video/mp4")},
                    data={"language": "Korean", "language_code": "ko"})
    jid = r.json()["job_id"]
    for _ in range(100):
        if client.get(f"/api/dub/jobs/{jid}").json()["status"] != "running":
            break
        time.sleep(0.02)
    return ran, jid, tmp_path


def test_subtitled_builds_in_the_workspace_then_reuses_it(monkeypatch, tmp_path):
    ran, jid, work = _done_job(monkeypatch, tmp_path)
    r = client.get(f"/api/dub/result/{jid}/subtitled?preset=variety")
    assert r.status_code == 200
    assert len(ran.calls) == 1
    assert ran.calls[0][-1] == str(work / "subtitled-variety.mp4")
    assert "translated.srt" in _vf(ran.calls[0])
    # The second ask finds the file already made and runs nothing.
    r = client.get(f"/api/dub/result/{jid}/subtitled?preset=variety")
    assert r.status_code == 200
    assert len(ran.calls) == 1


def test_subtitled_prefers_the_edited_script_and_rebuilds_for_it(monkeypatch, tmp_path):
    ran, jid, work = _done_job(monkeypatch, tmp_path)
    client.get(f"/api/dub/result/{jid}/subtitled")
    assert "translated.srt" in _vf(ran.calls[0])
    # The user fixes a line: edited.srt appears, newer than the built file.
    edited = work / "edited.srt"
    edited.write_text("1\n00:00:02,000 --> 00:00:04,000\n고친 번역\n", encoding="utf-8")
    later = time.time() + 5
    os.utime(edited, (later, later))
    client.get(f"/api/dub/result/{jid}/subtitled")
    assert len(ran.calls) == 2
    assert "edited.srt" in _vf(ran.calls[1])


def test_subtitled_download_carries_a_proper_name(monkeypatch, tmp_path):
    ran, jid, work = _done_job(monkeypatch, tmp_path)
    r = client.get(f"/api/dub/result/{jid}/subtitled?download=1")
    assert 'filename="dub_ko-sub-clean.mp4"' in r.headers.get("content-disposition", "")


def test_subtitled_refuses_an_unknown_preset(monkeypatch, tmp_path):
    ran, jid, work = _done_job(monkeypatch, tmp_path)
    assert client.get(f"/api/dub/result/{jid}/subtitled?preset=neon").status_code == 422
    assert client.get("/api/dub/result/nope/subtitled").status_code == 404
    assert ran.calls == []


def test_subtitle_preview_is_one_frame_from_the_first_line(monkeypatch, tmp_path):
    ran, jid, work = _done_job(monkeypatch, tmp_path)
    r = client.get(f"/api/dub/result/{jid}/subtitle_preview?preset=box")
    assert r.status_code == 200
    cmd = ran.calls[0]
    assert cmd[cmd.index("-frames:v") + 1] == "1"
    # Seeked into the first subtitle line (2s), with the original timestamps
    # kept so the line is actually on screen in the frame.
    assert "-copyts" in cmd
    assert float(cmd[cmd.index("-ss") + 1]) >= 2.0
    assert cmd[-1] == str(work / "subtitle-preview-box.jpg")
    # And cached, like the video itself.
    client.get(f"/api/dub/result/{jid}/subtitle_preview?preset=box")
    assert len(ran.calls) == 1


def test_srt_export_prefers_the_edited_script(monkeypatch, tmp_path):
    ran, jid, work = _done_job(monkeypatch, tmp_path)
    (work / "edited.srt").write_text(
        "1\n00:00:02,000 --> 00:00:04,000\n고친 번역\n", encoding="utf-8")
    r = client.get(f"/api/dub/result/{jid}/srt")
    assert "고친 번역" in r.text


def test_subtitled_takes_a_vertical_position(monkeypatch, tmp_path):
    # pos is a percentage of the frame's height, 0 top to 100 bottom, mapped
    # onto libass's MarginV (bottom-anchored, PlayResY 288). Dragging the
    # subtitles in the Export preview sends it.
    ran, jid, work = _done_job(monkeypatch, tmp_path)
    r = client.get(f"/api/dub/result/{jid}/subtitled?preset=clean&pos=20")
    assert r.status_code == 200
    assert "MarginV=230" in _vf(ran.calls[0])          # (100-20)% of 288
    assert ran.calls[0][-1] == str(work / "subtitled-clean-p20.mp4")
    # Its own cache: the default-position build stays a separate file.
    client.get(f"/api/dub/result/{jid}/subtitled?preset=clean")
    assert "MarginV=22" in _vf(ran.calls[1])
    client.get(f"/api/dub/result/{jid}/subtitled?preset=clean&pos=20")
    assert len(ran.calls) == 2


def test_subtitle_preview_takes_the_same_position(monkeypatch, tmp_path):
    ran, jid, work = _done_job(monkeypatch, tmp_path)
    r = client.get(f"/api/dub/result/{jid}/subtitle_preview?preset=box&pos=50")
    assert r.status_code == 200
    assert "MarginV=144" in _vf(ran.calls[0])
    assert ran.calls[0][-1] == str(work / "subtitle-preview-box-p50.jpg")


def test_subtitled_refuses_a_position_off_the_frame(monkeypatch, tmp_path):
    ran, jid, work = _done_job(monkeypatch, tmp_path)
    assert client.get(f"/api/dub/result/{jid}/subtitled?pos=140").status_code == 422
    assert ran.calls == []
