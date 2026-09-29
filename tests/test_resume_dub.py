"""Resume: a stopped dub carries on in its own folder from the first stage
with no result, keeping what the earlier run finished (2026-09-23)."""
import os
import time

import pytest
from fastapi.testclient import TestClient

from app import pipeline
from app.api import dub as dub_api
from app.engines.base import SynthesisResult
from app.main import app

# The dub API tests' own preflight fakes (every engine "available"), reused.
from tests.test_dub_api import _all_engines_available  # noqa: F401

client = TestClient(app, base_url="http://127.0.0.1")


def _wait_not_running(jid):
    for _ in range(200):
        if client.get(f"/api/dub/jobs/{jid}").json()["status"] not in ("running", "queued"):
            return
        time.sleep(0.02)


def test_resume_carries_on_the_same_job_in_the_same_folder(monkeypatch):
    calls = []

    def fake_run_dub(**kw):
        calls.append(kw)
        if len(calls) == 1:
            raise RuntimeError("stopped half way")
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(dub_api, "run_dub", fake_run_dub)
    jid = client.post("/api/dub/start", files={"video": ("v.mp4", b"vid", "video/mp4")},
                      data={"language": "Korean", "language_code": "ko", "project": "resume"}).json()["job_id"]
    _wait_not_running(jid)
    before = client.get(f"/api/dub/jobs/{jid}").json()
    assert before["status"] == "error"

    r = client.post(f"/api/dub/jobs/{jid}/resume")
    assert r.status_code == 200 and r.json()["job_id"] == jid
    _wait_not_running(jid)
    after = client.get(f"/api/dub/jobs/{jid}").json()
    assert after["status"] == "done"
    assert after["work_dir"] == before["work_dir"]
    assert "resume" not in calls[0] and calls[1]["resume"] is True
    assert os.path.dirname(calls[1]["out_path"]) == os.path.dirname(calls[0]["out_path"])


def test_resume_refuses_a_job_that_is_not_stopped_or_unknown():
    assert client.post("/api/dub/jobs/nope/resume").status_code == 404


def test_resume_refuses_a_cloud_dub(monkeypatch):
    monkeypatch.setattr(dub_api, "run_dub", lambda **kw: (_ for _ in ()).throw(RuntimeError("x")))
    jid = client.post("/api/dub/start", files={"video": ("v.mp4", b"vid", "video/mp4")},
                      data={"language": "Korean", "language_code": "ko"}).json()["job_id"]
    _wait_not_running(jid)
    from app import state
    state.job_store.update(jid, dub_mode="perso", status="error")
    r = client.post(f"/api/dub/jobs/{jid}/resume")
    assert r.status_code == 409 and "Start over" in r.json()["detail"]


# --- what a stage leaves behind -------------------------------------------

def test_saved_separation_needs_both_files(tmp_path):
    v, b = tmp_path / "vocals.wav", tmp_path / "background.wav"
    v.write_bytes(b"R" * 100)
    pipeline._save_json(str(tmp_path), pipeline.SEPARATED_NAME, {"vocals": str(v), "background": str(b)})
    assert pipeline._saved_separation(str(tmp_path)) is None      # background missing
    b.write_bytes(b"R" * 100)
    assert pipeline._saved_separation(str(tmp_path)) == (str(v), str(b))


def test_saved_transcript_round_trips(tmp_path):
    cues = [{"start": 0.0, "end": 1.0, "text": "안녕", "speaker": "A"}]
    pipeline._save_json(str(tmp_path), pipeline.TRANSCRIPT_NAME, {"cues": cues, "perso": True, "detected": "ko"})
    d = pipeline._saved_transcript(str(tmp_path))
    assert d["cues"] == cues and d["perso"] is True and d["detected"] == "ko"
    assert pipeline._saved_transcript(str(tmp_path / "nowhere")) is None


class _CountingEngine:
    def __init__(self):
        self.texts = []

    def synthesize(self, req):
        self.texts.append(req.text)
        return SynthesisResult(audio_bytes=b"RIFF" + b"x" * 100, duration=1.0)


def test_voices_made_before_are_kept_and_the_rest_are_made(tmp_path):
    from app.qwen_pipeline import synth_lines

    segs = [{"start": i * 2.0, "end": i * 2.0 + 1.5, "text": "line %d" % i} for i in range(3)]
    (tmp_path / "qwen_line_0.wav").write_bytes(b"RIFF" + b"k" * 100)
    (tmp_path / "qwen_line_1.wav").write_bytes(b"RIFF" + b"k" * 100)
    engine, logs = _CountingEngine(), []
    paths = synth_lines(engine, segs, ["A"] * 3, {"A": "v"}, "English", str(tmp_path),
                        n_takes=1, log=logs.append, reuse_lines=True)
    assert all(paths) and engine.texts == ["line 2"]
    assert "   2 line(s) kept from the earlier run" in logs
    # Without resume every line is made again.
    engine2 = _CountingEngine()
    synth_lines(engine2, segs, ["A"] * 3, {"A": "v"}, "English", str(tmp_path), n_takes=1, log=logs.append)
    assert len(engine2.texts) == 3


def test_cancel_during_the_voices_stops_before_the_next_line(tmp_path):
    import pytest

    from app.jobs import JobCancelled
    from app.qwen_pipeline import synth_lines

    segs = [{"start": i * 2.0, "end": i * 2.0 + 1.5, "text": "line %d" % i} for i in range(4)]
    engine = _CountingEngine()
    pressed = {"after": 2}

    def cancel_check():
        return len(engine.texts) >= pressed["after"]

    logs = []
    with pytest.raises(JobCancelled):
        synth_lines(engine, segs, ["A"] * 4, {"A": "v"}, "English", str(tmp_path),
                    n_takes=1, log=logs.append, cancel_check=cancel_check)
    assert engine.texts == ["line 0", "line 1"]
    assert logs[-1] == "Cancelled by user request"


# --- run_dub itself, resuming --------------------------------------------

SRT = "1\n00:00:00,000 --> 00:00:01,500\nHola\n\n2\n00:00:01,500 --> 00:00:03,000\nAdios\n"


def _stub_world(monkeypatch, tmp_path, fail=()):
    """Every stage replaced; a stage named in `fail` must not run at all."""
    seen = {}

    def must_not(name):
        def f(*a, **k):
            raise AssertionError("%s ran on resume" % name)
        return f

    def ran(name, value):
        def f(*a, **k):
            seen[name] = k
            return value
        return f

    monkeypatch.setattr(pipeline, "_video_duration", lambda p: 3.0)
    monkeypatch.setattr(pipeline, "_check_room", lambda *a: None)
    monkeypatch.setattr(pipeline, "leakage_gate", lambda mix, *a: mix)
    monkeypatch.setattr(pipeline, "_stage_finish", lambda *a: None)
    cues = [{"start": 0.0, "end": 1.5, "text": "hola"}, {"start": 1.5, "end": 3.0, "text": "adios"}]
    for name, value in (("_stage_separate", (str(tmp_path / "vocals.wav"), str(tmp_path / "background.wav"), None)),
                        ("_stage_transcribe_local", (cues, "es", None)),
                        ("_stage_diarize", None),
                        ("_stage_translate", ([{"start": 0.0, "end": 1.5, "text": "x"}], True))):
        monkeypatch.setattr(pipeline, name, must_not(name) if name in fail else ran(name, value))
    monkeypatch.setattr(pipeline, "_stage_synthesize", ran("_stage_synthesize", str(tmp_path / "mix.wav")))
    return seen


def _earlier_run(tmp_path, translated=True):
    for name in ("vocals.wav", "background.wav", "input.mp4"):
        (tmp_path / name).write_bytes(b"R" * 100)
    pipeline._save_json(str(tmp_path), pipeline.SEPARATED_NAME, {"vocals": "vocals.wav", "background": "background.wav"})
    pipeline._save_json(str(tmp_path), pipeline.TRANSCRIPT_NAME,
                        {"cues": [{"start": 0.0, "end": 1.5, "text": "hola"}], "perso": True, "detected": "es"})
    if translated:
        (tmp_path / "translated.srt").write_text(SRT, encoding="utf-8")


def _run_dub(tmp_path, resume):
    return pipeline.run_dub(video_path=str(tmp_path / "input.mp4"), out_path=str(tmp_path / "dubbed.mp4"),
                            language="Spanish", language_code="es", stt_engine="perso", sep_engine="perso",
                            translate_engine="chatgpt", resume=resume, log=lambda m: None)


def test_resume_skips_every_finished_stage_and_keeps_voices(tmp_path, monkeypatch):
    _earlier_run(tmp_path)
    seen = _stub_world(monkeypatch, tmp_path,
                       fail=("_stage_separate", "_stage_transcribe_local", "_stage_diarize", "_stage_translate"))
    monkeypatch.setattr(pipeline, "_stage_transcribe_perso", lambda *a, **k: pytest.fail("Perso STT ran"))
    _run_dub(tmp_path, resume=True)
    assert seen["_stage_synthesize"]["reuse_lines"] is True


def test_a_stage_made_again_drops_the_reuse_of_everything_after_it(tmp_path, monkeypatch):
    _earlier_run(tmp_path)
    (tmp_path / "separated.json").unlink()        # separation must run again
    seen = _stub_world(monkeypatch, tmp_path)
    monkeypatch.setattr(pipeline, "_stage_transcribe_perso", lambda *a, **k: ([{"start": 0, "end": 1, "text": "h"}], None))
    _run_dub(tmp_path, resume=True)
    assert "_stage_translate" in seen                              # translation redone, not reused
    assert seen["_stage_synthesize"]["reuse_lines"] is False       # so no old voice lines


def test_without_resume_nothing_is_reused(tmp_path, monkeypatch):
    _earlier_run(tmp_path)
    seen = _stub_world(monkeypatch, tmp_path)
    monkeypatch.setattr(pipeline, "_stage_transcribe_perso", lambda *a, **k: ([{"start": 0, "end": 1, "text": "h"}], None))
    _run_dub(tmp_path, resume=False)
    assert "_stage_separate" in seen and "_stage_translate" in seen
    assert seen["_stage_synthesize"]["reuse_lines"] is False


def test_separation_record_cannot_point_outside_the_folder(tmp_path):
    outside = tmp_path.parent / "elsewhere.wav"
    outside.write_bytes(b"R" * 100)
    (tmp_path / "background.wav").write_bytes(b"R" * 100)
    pipeline._save_json(str(tmp_path), pipeline.SEPARATED_NAME, {"vocals": str(outside), "background": "background.wav"})
    assert pipeline._saved_separation(str(tmp_path)) is None


def test_a_second_resume_click_is_refused(monkeypatch):
    import threading
    release = threading.Event()
    calls = []

    def fake_run_dub(**kw):
        calls.append(kw)
        if len(calls) == 1:
            raise RuntimeError("stopped")
        release.wait(5)
        return {"job_id": "x", "out_path": kw["out_path"], "num_segments": 1}

    monkeypatch.setattr(dub_api, "run_dub", fake_run_dub)
    jid = client.post("/api/dub/start", files={"video": ("v.mp4", b"vid", "video/mp4")},
                      data={"language": "Korean", "language_code": "ko"}).json()["job_id"]
    _wait_not_running(jid)
    assert client.post(f"/api/dub/jobs/{jid}/resume").status_code == 200
    assert client.post(f"/api/dub/jobs/{jid}/resume").status_code == 409
    release.set()
    _wait_not_running(jid)


def test_a_remade_voices_job_resumes_voices_only():
    from app import dub_launch

    seen = {}
    job = {"id": "j", "work_dir": "/w", "stt_engine": "perso", "separation": "perso",
           "translator": "chatgpt", "voices_only": True, "language_code": "es"}
    dub_launch.work_for(job, cancel_check=lambda: False, on_notice=None, resume=True,
                        voices_only=bool(job["voices_only"]), run_dub=lambda **k: seen.update(k))(lambda m: None)
    assert seen["stt_engine"] is None and seen["sep_engine"] is None and seen["translate_engine"] is None


def test_high_quality_resume_keeps_the_takes_already_made(tmp_path, monkeypatch):
    from app import qwen_pipeline
    from app.qwen_pipeline import synth_lines

    monkeypatch.setattr(qwen_pipeline, "_score_and_select", lambda *a, **k: {})
    segs = [{"start": i * 2.0, "end": i * 2.0 + 1.5, "text": "line %d" % i} for i in range(3)]
    for name in ("qwen_line_0_t0.wav", "qwen_line_0_t1.wav", "qwen_line_1_t0.wav"):
        (tmp_path / name).write_bytes(b"RIFF" + b"k" * 100)
    engine, logs = _CountingEngine(), []
    paths = synth_lines(engine, segs, ["A"] * 3, {"A": "v"}, "English", str(tmp_path),
                        n_takes=2, log=logs.append, reuse_lines=True)
    assert all(paths)
    assert engine.texts == ["line 1", "line 2", "line 2"]   # line 1 take 1, both takes of line 2
    assert "   3 take(s) kept from the earlier run" in logs
