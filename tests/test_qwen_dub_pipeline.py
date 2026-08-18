"""run_dub's Qwen3-TTS synthesis wiring + the local job-workspace/SRT bookkeeping
that replaced the old container client's upload()/import_srt() (fakes only -- no
container, no ffmpeg, no GPU). Qwen3-TTS is the app's only TTS engine now.
"""
import os

import pytest

from app import pipeline
from app.jobs import JobCancelled


class _FakeSeparationEngine:
    def separate(self, video_path, out_dir):
        return {"vocals": "/local/vocals.wav", "background": "/local/background.wav"}


class _FailingSeparationEngine:
    def separate(self, video_path, out_dir):
        raise RuntimeError("local separation interpreter not found")


class _FakeQwenEngine:
    def __init__(self):
        self.cloned = []
        self.synth_calls = []

    def clone(self, ref_audio_path, ref_text):
        self.cloned.append(ref_text)
        return "voiceX"

    def synthesize(self, req):
        self.synth_calls.append(req)
        class _Res:
            audio_bytes = b"FAKEWAV"
        return _Res()


def _stub_qwen_io(monkeypatch):
    """Neutralize the pieces that would otherwise hit ffmpeg/the sidecar for real."""
    def _fake_run_qwen_dub(engine, segments, ref_cues, work_dir, vocals_path, background_path,
                           language=None, n_takes=1, log=None, on_notice=None):
        engine.clone("/fake/ref.wav", "hello there friend")
        for i, s in enumerate(segments):
            engine.synthesize(type("Req", (), {"text": s["text"], "seed": 1000 * i})())
        p = os.path.join(work_dir, "qwen_dub_48k.wav")
        with open(p, "wb") as f:
            f.write(b"MIXED")
        return p

    monkeypatch.setattr(pipeline, "run_qwen_dub", _fake_run_qwen_dub)
    monkeypatch.setattr(pipeline, "SeparationEngine", _FakeSeparationEngine)
    monkeypatch.setattr(pipeline, "transcribe_local",
                        lambda audio_path, language=None, **k: [
                            {"start": 0.0, "end": 2.0, "text": "hello there friend"}])
    monkeypatch.setattr(pipeline, "diarize", lambda vocals_path, cues, num_speakers=None: cues)


def _fake_mux(video, audio, out, dur):
    with open(out, "wb") as f:
        f.write(b"FINALMP4")
    class _R:
        returncode = 0
        stderr = ""
    return _R()


def _write_inputs(tmp_path):
    video = tmp_path / "in.mp4"; video.write_bytes(b"vid")
    out = tmp_path / "dubbed.mp4"
    srt = tmp_path / "sub.srt"
    srt.write_text("1\n00:00:00,000 --> 00:00:02,000\nhi\n")
    return str(video), str(out), str(srt)


def test_run_dub_fails_on_an_srt_with_no_dialogue(monkeypatch, tmp_path):
    # Zero parsed lines used to sail through to "done" and ship a video whose
    # speech was stripped by separation with nothing dubbed in (review HIGH-1).
    _stub_qwen_io(monkeypatch)
    monkeypatch.setattr(pipeline, "_mux", _fake_mux)
    monkeypatch.setattr(pipeline, "_video_duration", lambda path: 2.0)
    video, out, srt = _write_inputs(tmp_path)
    (tmp_path / "sub.srt").write_text("")  # empty subtitle file
    with pytest.raises(RuntimeError, match="[Nn]o dialogue"):
        pipeline.run_dub(video_path=video, out_path=out, srt_path=srt,
                         language="Korean", language_code="ko", log=lambda m: None)


def test_run_dub_end_to_end_qwen_only(monkeypatch, tmp_path):
    _stub_qwen_io(monkeypatch)
    monkeypatch.setattr(pipeline, "_video_duration", lambda path: 2.0)

    mux_calls = {}

    def fake_mux(video, audio, out, dur):
        mux_calls["video"] = video
        mux_calls["audio"] = audio
        with open(out, "wb") as f:
            f.write(b"FINALMP4")
        class _R:
            returncode = 0
            stderr = ""
        return _R()

    monkeypatch.setattr(pipeline, "_mux", fake_mux)
    monkeypatch.setattr(pipeline, "ensure_video_length", lambda *a, **k: None)

    video, out, srt = _write_inputs(tmp_path)
    engine = _FakeQwenEngine()
    logs = []
    result = pipeline.run_dub(
        video_path=video, out_path=out, srt_path=srt,
        language="Korean", language_code="ko",
        qwen_engine=engine, log=logs.append,
    )

    assert result["out_path"] == out
    assert result["num_segments"] == 1
    with open(out, "rb") as f:
        assert f.read() == b"FINALMP4"
    assert mux_calls["video"] == video
    assert len(engine.cloned) == 1
    assert len(engine.synth_calls) == 1
    assert any("Qwen3-TTS" in m for m in logs)


def test_run_dub_passes_local_separation_paths_to_run_qwen_dub(monkeypatch, tmp_path):
    # Local Demucs separation is the only path now -- its vocals/background outputs
    # must reach run_qwen_dub directly, no container round-trip anywhere.
    captured = {}

    def fake_run_qwen_dub(engine, segments, ref_cues, work_dir, vocals_path, background_path,
                          language=None, n_takes=1, log=None, on_notice=None):
        captured["vocals_path"] = vocals_path
        captured["background_path"] = background_path
        p = os.path.join(work_dir, "qwen_dub_48k.wav")
        with open(p, "wb") as f:
            f.write(b"MIXED")
        return p

    monkeypatch.setattr(pipeline, "run_qwen_dub", fake_run_qwen_dub)
    monkeypatch.setattr(pipeline, "SeparationEngine", _FakeSeparationEngine)
    monkeypatch.setattr(pipeline, "transcribe_local",
                        lambda audio_path, language=None, **k: [{"start": 0.0, "end": 2.0, "text": "hi"}])
    monkeypatch.setattr(pipeline, "diarize", lambda vocals_path, cues, num_speakers=None: cues)
    monkeypatch.setattr(pipeline, "_video_duration", lambda path: 2.0)
    monkeypatch.setattr(pipeline, "_mux", _fake_mux)
    monkeypatch.setattr(pipeline, "ensure_video_length", lambda *a, **k: None)

    video, _, srt = _write_inputs(tmp_path)
    logs = []
    pipeline.run_dub(
        video_path=video, out_path=str(tmp_path / "d.mp4"), srt_path=srt,
        language="Korean", language_code="ko",
        qwen_engine=_FakeQwenEngine(), log=logs.append,
    )
    assert captured["vocals_path"] == "/local/vocals.wav"
    assert captured["background_path"] == "/local/background.wav"
    assert any("Separating background audio locally" in m for m in logs)


def test_local_separation_failure_aborts_job_with_no_fallback(monkeypatch, tmp_path):
    # There is no container to fall back to -- a local separation
    # failure must fail the whole job loudly instead of silently degrading.
    monkeypatch.setattr(pipeline, "SeparationEngine", _FailingSeparationEngine)

    def boom(*a, **k):
        raise AssertionError("run_qwen_dub must not run when local separation failed")

    monkeypatch.setattr(pipeline, "run_qwen_dub", boom)

    video, out, srt = _write_inputs(tmp_path)
    try:
        pipeline.run_dub(
            video_path=video, out_path=out, srt_path=srt,
            language="Korean", language_code="ko",
            qwen_engine=_FakeQwenEngine(), log=[].append,
        )
        assert False, "expected RuntimeError to propagate"
    except RuntimeError as e:
        assert "Local separation failed" in str(e)


def test_n_takes_reaches_run_qwen_dub(monkeypatch, tmp_path):
    # n_takes=None (the default) resolves to app.config.QWEN_N_TAKES; an explicit
    # value overrides it. Both must reach run_qwen_dub's n_takes argument.
    captured = {}

    def fake_run_qwen_dub(engine, segments, ref_cues, work_dir, vocals_path, background_path,
                          language=None, n_takes=1, log=None, on_notice=None):
        captured["n_takes"] = n_takes
        p = os.path.join(work_dir, "qwen_dub_48k.wav")
        with open(p, "wb") as f:
            f.write(b"MIXED")
        return p

    monkeypatch.setattr(pipeline, "run_qwen_dub", fake_run_qwen_dub)
    monkeypatch.setattr(pipeline, "SeparationEngine", _FakeSeparationEngine)
    monkeypatch.setattr(pipeline, "transcribe_local",
                        lambda audio_path, language=None, **k: [{"start": 0.0, "end": 2.0, "text": "hi"}])
    monkeypatch.setattr(pipeline, "diarize", lambda vocals_path, cues, num_speakers=None: cues)
    monkeypatch.setattr(pipeline, "_video_duration", lambda path: 2.0)
    monkeypatch.setattr(pipeline, "_mux", _fake_mux)
    monkeypatch.setattr(pipeline, "ensure_video_length", lambda *a, **k: None)

    video, _, srt = _write_inputs(tmp_path)
    from app.config import QWEN_N_TAKES

    pipeline.run_dub(
        video_path=video, out_path=str(tmp_path / "d1.mp4"), srt_path=srt,
        language="Korean", language_code="ko",
        qwen_engine=_FakeQwenEngine(), log=[].append,
    )
    assert captured["n_takes"] == QWEN_N_TAKES  # default

    pipeline.run_dub(
        video_path=video, out_path=str(tmp_path / "d2.mp4"), srt_path=srt,
        language="Korean", language_code="ko", n_takes=7,
        qwen_engine=_FakeQwenEngine(), log=[].append,
    )
    assert captured["n_takes"] == 7


def test_step3_log_names_the_translation_engine(monkeypatch, tmp_path):
    # The job log says WHICH engine translated (user feedback 2026-08-06: a
    # Gemini run was indistinguishable from a local Gemma run in the log).
    _stub_qwen_io(monkeypatch)
    monkeypatch.setattr(pipeline, "_video_duration", lambda path: 2.0)
    monkeypatch.setattr(pipeline, "_mux", _fake_mux)
    monkeypatch.setattr(pipeline, "ensure_video_length", lambda *a, **k: None)

    def fake_auto_translate(source_cues, target_lang, translator, work_dir, **k):
        p = os.path.join(work_dir, "auto.srt")
        with open(p, "w") as f:
            f.write("1\n00:00:00,000 --> 00:00:02,000\nhi\n")
        return p

    monkeypatch.setattr(pipeline, "_auto_translate_srt", fake_auto_translate)

    class _NamedTranslator:
        display_name = "Google Gemini (AI Studio)"
        model = "gemini-2.5-flash"

    video, out, _ = _write_inputs(tmp_path)
    logs = []
    pipeline.run_dub(
        video_path=video, out_path=out, srt_path=None,
        language="Korean", language_code="ko",
        qwen_engine=_FakeQwenEngine(), translator=_NamedTranslator(),
        log=logs.append,
    )
    assert any("3/6" in m and "Google Gemini (AI Studio)" in m
               and "gemini-2.5-flash" in m for m in logs)


def test_step4_log_shows_the_quality_mode(monkeypatch, tmp_path):
    # The job log says which Voice-quality mode ran: fast (1 take) vs
    # high quality (best of N) — user feedback 2026-08-06.
    _stub_qwen_io(monkeypatch)
    monkeypatch.setattr(pipeline, "_video_duration", lambda path: 2.0)
    monkeypatch.setattr(pipeline, "_mux", _fake_mux)
    monkeypatch.setattr(pipeline, "ensure_video_length", lambda *a, **k: None)

    video, _, srt = _write_inputs(tmp_path)

    logs_fast = []
    pipeline.run_dub(
        video_path=video, out_path=str(tmp_path / "f.mp4"), srt_path=srt,
        language="Korean", language_code="ko", n_takes=1,
        qwen_engine=_FakeQwenEngine(), log=logs_fast.append,
    )
    assert any("4/6" in m and "fast" in m for m in logs_fast)

    logs_high = []
    pipeline.run_dub(
        video_path=video, out_path=str(tmp_path / "h.mp4"), srt_path=srt,
        language="Korean", language_code="ko", n_takes=4,
        qwen_engine=_FakeQwenEngine(), log=logs_high.append,
    )
    assert any("4/6" in m and "high quality" in m and "best of 4" in m
               for m in logs_high)


# --- local job workspace + SRT bookkeeping (replaces the old upload/import_srt) --

def test_job_id_is_a_local_uuid_not_a_container_job(monkeypatch, tmp_path):
    _stub_qwen_io(monkeypatch)
    monkeypatch.setattr(pipeline, "_video_duration", lambda path: 2.0)
    monkeypatch.setattr(pipeline, "_mux", _fake_mux)
    monkeypatch.setattr(pipeline, "ensure_video_length", lambda *a, **k: None)

    video, out, srt = _write_inputs(tmp_path)
    result = pipeline.run_dub(
        video_path=video, out_path=out, srt_path=srt,
        language="Korean", language_code="ko",
        qwen_engine=_FakeQwenEngine(), log=[].append,
    )
    # A local hex tag (uuid4().hex[:8]) -- never touched a network/container job id.
    job_id = result["job_id"]
    assert len(job_id) == 8
    int(job_id, 16)  # must be valid hex


def test_segments_are_parsed_locally_from_the_srt_file(monkeypatch, tmp_path):
    # Two-line SRT -> segments must come from app.text.srt.parse_srt directly
    # (no container import_srt round-trip -- that client no longer exists).
    _stub_qwen_io(monkeypatch)
    monkeypatch.setattr(pipeline, "_video_duration", lambda path: 4.0)
    monkeypatch.setattr(pipeline, "_mux", _fake_mux)
    monkeypatch.setattr(pipeline, "ensure_video_length", lambda *a, **k: None)

    video = tmp_path / "in.mp4"; video.write_bytes(b"vid")
    out = tmp_path / "dubbed.mp4"
    srt = tmp_path / "sub.srt"
    srt.write_text(
        "1\n00:00:00,000 --> 00:00:02,000\nfirst line\n\n"
        "2\n00:00:02,000 --> 00:00:04,000\nsecond line\n"
    )

    engine = _FakeQwenEngine()
    result = pipeline.run_dub(
        video_path=str(video), out_path=str(out), srt_path=str(srt),
        language="Korean", language_code="ko",
        qwen_engine=engine, log=[].append,
    )
    assert result["num_segments"] == 2
    assert engine.synth_calls[0].text == "first line"


# --- cooperative cancellation (cancel_check) --------------------------------

def test_run_dub_cancelled_before_any_stage_runs(monkeypatch, tmp_path):
    # cancel_check() true from the very first checkpoint -- nothing downstream
    # (not even Demucs separation) should ever run.
    def boom(*a, **k):
        raise AssertionError("no stage should run once cancellation was requested")

    monkeypatch.setattr(pipeline, "SeparationEngine", lambda: type("S", (), {"separate": boom})())

    video, out, srt = _write_inputs(tmp_path)
    logs = []
    with pytest.raises(JobCancelled):
        pipeline.run_dub(
            video_path=video, out_path=out, srt_path=srt,
            language="Korean", language_code="ko",
            qwen_engine=_FakeQwenEngine(), log=logs.append,
            cancel_check=lambda: True,
        )
    assert any("Cancelled by user request" in m for m in logs)


def test_run_dub_stops_at_the_next_stage_boundary_when_cancelled_mid_run(monkeypatch, tmp_path):
    # Cancellation requested partway through -- stages already started finish
    # (separation, transcription, diarization, "using provided subtitles"),
    # but the run stops at the next checkpoint (right before stage 4) instead
    # of reaching Qwen3-TTS synthesis.
    _stub_qwen_io(monkeypatch)
    monkeypatch.setattr(pipeline, "_video_duration", lambda path: 2.0)
    monkeypatch.setattr(pipeline, "_mux", _fake_mux)
    monkeypatch.setattr(pipeline, "ensure_video_length", lambda *a, **k: None)

    def boom(*a, **k):
        raise AssertionError("run_qwen_dub must not run once cancellation was requested")

    monkeypatch.setattr(pipeline, "run_qwen_dub", boom)

    calls = {"n": 0}

    def cancel_check():
        calls["n"] += 1
        return calls["n"] >= 4  # 1st-3rd checkpoints (stages 1-3) pass; 4th (before stage 4) cancels

    video, out, srt = _write_inputs(tmp_path)
    logs = []
    with pytest.raises(JobCancelled):
        pipeline.run_dub(
            video_path=video, out_path=out, srt_path=srt,
            language="Korean", language_code="ko",
            qwen_engine=_FakeQwenEngine(), log=logs.append,
            cancel_check=cancel_check,
        )
    assert any("Separating background audio locally" in m for m in logs)
    assert not any("Cloning & synthesizing" in m for m in logs)
