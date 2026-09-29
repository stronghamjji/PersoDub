"""The voice stage cannot hang on one line any more (2026-09-23).

A speech cap and a waiting time per line, both from the line's slot; a line
that runs away is skipped with its numbers in the log; an engine that stops
answering ends the job at once with a notice; a closing summary says what was
made. Plus the two small guards around it: dashes are spoken as commas, and
the translation prompt asks for none.
"""
import httpx
import pytest

from app.engines import qwen_tts as qt
from app.engines.base import SynthesisCut, SynthesisRequest, SynthesisResult, SynthesisTimeout, VoiceEngineDown
from app.text.speech import speech_text


# --- the two ceilings ------------------------------------------------------

def test_speech_cap_and_wait_follow_the_slot():
    assert qt.speech_cap_seconds(5.5) == 18.5
    assert qt.wait_seconds(5.5) == 115.0
    assert qt.speech_cap_seconds(11.0) == 35.0
    assert qt.wait_seconds(11.0) == 170.0
    assert qt.speech_cap_seconds(None) == 30.0
    assert qt.wait_seconds(0) == 120.0


def test_form_carries_the_speech_cap():
    form = qt.QwenTTSEngine(base_url="http://x")._build_form(
        SynthesisRequest(text="hola", voice_id="v", duration=5.5))
    assert form["max_seconds"] == "18.50"


class _Reply:
    def __init__(self, headers, content=b"RIFF"):
        self.headers = headers
        self.content = content

    def raise_for_status(self):
        return None


def test_cut_header_becomes_synthesis_cut(monkeypatch):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: _Reply({"x-audio-duration": "18.48", "x-audio-cut": "1"}))
    with pytest.raises(SynthesisCut) as e:
        qt.QwenTTSEngine(base_url="http://x").synthesize(SynthesisRequest(text="t", voice_id="v", duration=5.5))
    assert e.value.cut_at == 18.48 and e.value.slot == 5.5


def test_httpx_timeout_becomes_synthesis_timeout_with_the_wait(monkeypatch):
    seen = {}

    def post(*a, **k):
        seen["timeout"] = k["timeout"]
        raise httpx.ReadTimeout("slow")
    monkeypatch.setattr(httpx, "post", post)
    with pytest.raises(SynthesisTimeout) as e:
        qt.QwenTTSEngine(base_url="http://x").synthesize(SynthesisRequest(text="t", voice_id="v", duration=5.5))
    assert seen["timeout"] == 115.0 and e.value.waited == 115.0


# --- the line loop ---------------------------------------------------------

@pytest.fixture(autouse=True)
def _no_probe_pause(monkeypatch):
    from app import qwen_pipeline
    monkeypatch.setattr(qwen_pipeline, "ENGINE_PROBE_PAUSE", 0)


class _Engine:
    """Answers per call from a script: a SynthesisResult, or an exception to raise."""

    def __init__(self, script, alive=True):
        self.script = list(script)
        self.alive = alive
        self.calls = []

    def synthesize(self, req):
        self.calls.append(req)
        answer = self.script.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    def is_available(self):
        return self.alive


def _ok(seconds=1.0):
    return SynthesisResult(audio_bytes=b"RIFFok", duration=seconds)


def _run(engine, tmp_path, slot=5.5):
    from app.qwen_pipeline import _synth_one

    logs, stats = [], []
    path = _synth_one(engine, {"text": "bones jut out—they look"}, "v", "English", 7,
                      str(tmp_path / "line.wav"), logs.append, "line 23", slot=slot, stats=stats)
    return path, logs, stats


def test_a_runaway_line_is_skipped_with_its_numbers(tmp_path):
    path, logs, stats = _run(_Engine([SynthesisCut(18.5, 5.5)]), tmp_path)
    assert path is None
    assert logs == ["   line 23: ran away, cut at 18.5s (slot 5.5s), skipped"]
    assert stats[0][0] == "line 23" and stats[0][2] is False


def test_a_dash_is_spoken_as_a_comma(tmp_path):
    engine = _Engine([_ok()])
    path, _, _ = _run(engine, tmp_path)
    assert path and engine.calls[0].text == "bones jut out, they look"
    assert engine.calls[0].duration == 5.5


def test_a_timeout_with_a_live_engine_is_retried_once_then_skipped(tmp_path):
    engine = _Engine([SynthesisTimeout(115), SynthesisTimeout(115)], alive=True)
    path, logs, _ = _run(engine, tmp_path)
    assert path is None and len(engine.calls) == 2
    assert logs == ["   line 23: no answer in 115s, retrying",
                    "   line 23: no answer in 115s again, skipped"]


def test_a_timeout_then_a_good_answer_is_kept(tmp_path):
    engine = _Engine([SynthesisTimeout(115), _ok()], alive=True)
    path, logs, stats = _run(engine, tmp_path)
    assert path and (tmp_path / "line.wav").read_bytes() == b"RIFFok"
    assert stats[-1][2] is True


def test_a_timeout_with_a_dead_engine_ends_the_job(tmp_path):
    engine = _Engine([SynthesisTimeout(115)], alive=False)
    with pytest.raises(VoiceEngineDown) as e:
        _run(engine, tmp_path)
    assert "after line 23" in str(e.value)


def test_the_stage_ends_with_a_summary_line():
    from app.qwen_pipeline import _log_synth_summary

    logs = []
    _log_synth_summary(logs.append, [("line 0", 4.2, True), ("line 1", 19.0, True), ("line 2", 60.0, False)],
                       ["a.wav", "b.wav", None, None], silent=1)
    assert logs == ["   voices done: 4 lines, 2 made, 1 skipped, median 19.0s/line, slowest 60s (line 2)"]


def test_engine_down_becomes_a_notice_that_stops_the_job(tmp_path):
    from app import pipeline

    notices, logs = [], []
    with pytest.raises(RuntimeError):
        pipeline.raise_notice(VoiceEngineDown("line 23"), logs.append, notices.append)
    assert notices[0]["type"] == "voice_engine_down"
    assert "reopen PersoDub, then Resume" in notices[0]["message"]


# --- the small guards ------------------------------------------------------

def test_speech_text_turns_dashes_into_commas():
    assert speech_text("bones jut out—they look like neither") == "bones jut out, they look like neither"
    assert speech_text("wait – no -- really") == "wait, no, really"
    assert speech_text("—so it goes—") == "so it goes"
    assert speech_text("well-known") == "well-known"
    assert speech_text("") == ""


def test_translation_prompts_ask_for_no_dashes():
    from app.text.length_fit import build_budget_prompt
    from app.translate import build_dub_prompt

    assert "no dashes" in build_dub_prompt(["안녕"], "English", "Korean", [1.0])
    assert "no dashes" in build_budget_prompt(["안녕"], "English", "Korean", [10])


def test_stage_ceiling_is_twelve_hours_by_default(monkeypatch):
    import importlib

    from app import timeouts

    monkeypatch.delenv("PERSODUB_TIMEOUT_CAP", raising=False)
    importlib.reload(timeouts)
    assert timeouts.PERSODUB_TIMEOUT_CAP == 43200.0
    assert timeouts.scaled_timeout(7200, 900) == 43200.0


def test_a_crashed_engine_ends_the_job_instead_of_skipping_every_line(tmp_path, monkeypatch):
    from app import qwen_pipeline

    monkeypatch.setattr(qwen_pipeline, "ENGINE_PROBE_PAUSE", 0)
    engine = _Engine([httpx.ConnectError("refused")], alive=False)
    with pytest.raises(VoiceEngineDown):
        _run(engine, tmp_path)


def test_a_one_off_failure_with_a_live_engine_is_still_just_skipped(tmp_path):
    path, logs, _ = _run(_Engine([RuntimeError("bad text")], alive=True), tmp_path)
    assert path is None and "Qwen synth failed (bad text) - skipping" in logs[0]


def test_a_cpu_machine_waits_five_times_as_long(monkeypatch):
    import importlib

    monkeypatch.delenv("PERSODUB_TTS_WAIT_SCALE", raising=False)
    monkeypatch.setenv("PERSODUB_TORCH_VARIANT", "cpu")
    importlib.reload(qt)
    try:
        assert qt.PERSODUB_TTS_WAIT_SCALE == 5.0
        assert qt.wait_seconds(5.5) == 575.0
    finally:
        monkeypatch.undo()
        importlib.reload(qt)


def test_failure_reports_hide_sign_in_tokens_and_email():
    from app.report_mask import mask_text

    said = "auth eyJhbGciOiJ.eyJzdWIiOiIx.c2lnbmF0dXJl for someone@example.co.kr failed"
    out = mask_text(said)
    assert "eyJ" not in out and "@example" not in out and "failed" in out
