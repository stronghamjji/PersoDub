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


def _ass(work):
    return (work / "subtitle_render.ass").read_text(encoding="utf-8")


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
    r = client.get(f"/api/dub/result/{jid}/subtitled?preset=neon-yellow")
    assert r.status_code == 200
    assert len(ran.calls) == 1
    assert ran.calls[0][-1] == str(work / "subtitled-neon-yellow.mp4")
    assert "원래 번역" in _ass(work)
    # The second ask finds the file already made and runs nothing.
    r = client.get(f"/api/dub/result/{jid}/subtitled?preset=neon-yellow")
    assert r.status_code == 200
    assert len(ran.calls) == 1


def test_subtitled_prefers_the_edited_script_and_rebuilds_for_it(monkeypatch, tmp_path):
    ran, jid, work = _done_job(monkeypatch, tmp_path)
    client.get(f"/api/dub/result/{jid}/subtitled")
    assert "원래 번역" in _ass(work)
    # The user fixes a line: edited.srt appears, newer than the built file.
    edited = work / "edited.srt"
    edited.write_text("1\n00:00:02,000 --> 00:00:04,000\n고친 번역\n", encoding="utf-8")
    later = time.time() + 5
    os.utime(edited, (later, later))
    client.get(f"/api/dub/result/{jid}/subtitled")
    assert len(ran.calls) == 2
    assert "고친 번역" in _ass(work)


def test_subtitled_download_carries_a_proper_name(monkeypatch, tmp_path):
    ran, jid, work = _done_job(monkeypatch, tmp_path)
    r = client.get(f"/api/dub/result/{jid}/subtitled?download=1")
    assert 'filename="dub_ko-sub-clean.mp4"' in r.headers.get("content-disposition", "")


def test_subtitled_refuses_an_unknown_preset(monkeypatch, tmp_path):
    ran, jid, work = _done_job(monkeypatch, tmp_path)
    assert client.get(f"/api/dub/result/{jid}/subtitled?preset=sparkle").status_code == 422
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
    assert cmd[-1] == str(work / "subtitle-preview-sticker.jpg")
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
    assert ",864,1" in _ass(work).splitlines()[-0 if False else 0] or ",864," in _ass(work)   # (100-20)% of 1080
    assert ran.calls[0][-1] == str(work / "subtitled-clean-p20.mp4")
    # Its own cache: the default-position build stays a separate file.
    client.get(f"/api/dub/result/{jid}/subtitled?preset=clean")
    assert ",302," in _ass(work)                       # clean sits "lower": 28% up
    client.get(f"/api/dub/result/{jid}/subtitled?preset=clean&pos=20")
    assert len(ran.calls) == 2


def test_subtitle_preview_takes_the_same_position(monkeypatch, tmp_path):
    ran, jid, work = _done_job(monkeypatch, tmp_path)
    r = client.get(f"/api/dub/result/{jid}/subtitle_preview?preset=box&pos=50")
    assert r.status_code == 200
    assert ",540," in _ass(work)        # 50% of the 1080 canvas
    assert ran.calls[0][-1] == str(work / "subtitle-preview-sticker-p50.jpg")


def test_subtitled_refuses_a_position_off_the_frame(monkeypatch, tmp_path):
    ran, jid, work = _done_job(monkeypatch, tmp_path)
    assert client.get(f"/api/dub/result/{jid}/subtitled?pos=140").status_code == 422
    assert ran.calls == []


def test_subtitled_takes_a_font_size(monkeypatch, tmp_path):
    # size scales the preset's letters: 100 as designed, 60 to 160 allowed.
    # clean's base Fontsize is 20, so 150 burns at 30.
    ran, jid, work = _done_job(monkeypatch, tmp_path)
    r = client.get(f"/api/dub/result/{jid}/subtitled?preset=clean&size=150")
    assert r.status_code == 200
    assert "Base,Arial,52," in _ass(work).split("Style: ")[1][:40] or ",52," in _ass(work)  # 1080 * .032 * 1.5
    assert ran.calls[0][-1] == str(work / "subtitled-clean-s150.mp4")
    assert client.get(f"/api/dub/result/{jid}/subtitled?size=300").status_code == 422


def test_subtitle_preview_takes_size_and_position_together(monkeypatch, tmp_path):
    ran, jid, work = _done_job(monkeypatch, tmp_path)
    r = client.get(f"/api/dub/result/{jid}/subtitle_preview?preset=variety&pos=30&size=80")
    assert r.status_code == 200
    ass = _ass(work)
    assert ",42," in ass                # neon-yellow's .049 * 1080 * 0.8
    assert ",756," in ass               # (100-30)% of 1080
    assert ran.calls[0][-1] == str(work / "subtitle-preview-neon-yellow-p30-s80.jpg")


# ---- The per-job subtitle settings store --------------------------------------
# One place remembers how this job's subtitles should look -- style, size,
# position, on/off, and any retimed lines -- so the player overlay, the
# timeline lane and the Export dialog all read and write the same truth.

def test_subtitle_settings_start_with_the_defaults(monkeypatch, tmp_path):
    ran, jid, work = _done_job(monkeypatch, tmp_path)
    r = client.get(f"/api/dub/jobs/{jid}/subtitle_style")
    assert r.status_code == 200
    assert r.json() == {"enabled": True, "preset": "clean", "pos": None,
                        "size": None, "cues": {}}


def test_subtitle_settings_survive_a_round_trip(monkeypatch, tmp_path):
    ran, jid, work = _done_job(monkeypatch, tmp_path)
    body = {"enabled": False, "preset": "variety", "pos": 30, "size": 120,
            "cues": {"1": {"start": 0.5, "end": 3.0}}}
    assert client.put(f"/api/dub/jobs/{jid}/subtitle_style", json=body).status_code == 200
    assert client.get(f"/api/dub/jobs/{jid}/subtitle_style").json() == {
        **body, "preset": "neon-yellow"}


def test_subtitle_settings_refuse_nonsense(monkeypatch, tmp_path):
    ran, jid, work = _done_job(monkeypatch, tmp_path)
    put = lambda b: client.put(f"/api/dub/jobs/{jid}/subtitle_style", json=b).status_code
    assert put({"preset": "sparkle"}) == 422
    assert put({"pos": 140}) == 422
    assert put({"size": 30}) == 422
    assert put({"cues": {"1": {"start": 5, "end": 2}}}) == 422


def test_subtitled_reads_the_stored_settings(monkeypatch, tmp_path):
    # The Export dialog sends nothing: what was set on the player is what burns.
    ran, jid, work = _done_job(monkeypatch, tmp_path)
    client.put(f"/api/dub/jobs/{jid}/subtitle_style",
               json={"preset": "variety", "pos": 30, "size": 120})
    r = client.get(f"/api/dub/result/{jid}/subtitled")
    assert r.status_code == 200
    ass = _ass(work)
    assert "&H0000E6FF&" in ass and ",756," in ass and ",64," in ass
    assert "-neon-yellow-p30-s120.mp4" in ran.calls[0][-1]


def test_retimed_lines_burn_with_their_new_times(monkeypatch, tmp_path):
    # The user stretched line 1 on the timeline: the burned srt says so, the
    # original stays untouched.
    ran, jid, work = _done_job(monkeypatch, tmp_path)
    client.put(f"/api/dub/jobs/{jid}/subtitle_style",
               json={"cues": {"1": {"start": 0.5, "end": 4.0}}})
    r = client.get(f"/api/dub/result/{jid}/subtitled")
    assert r.status_code == 200
    ass = _ass(work)
    assert "0:00:00.50,0:00:04.00" in ass
    assert "원래 번역" in ass
    assert "00:00:02,000" in (work / "translated.srt").read_text()
