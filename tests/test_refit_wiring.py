# -*- coding: utf-8 -*-
"""The refit, wired to a voice engine and to files on disk (app/qwen_pipeline.
refit_long_lines). The engine here is a fake whose voice runs 0.1s per
character, so a rewrite's length aloud is known exactly."""
import io
import os
import struct
import wave

from app.engines.base import SynthesisResult
from app.qwen_assemble import line_play_durations
from app.qwen_pipeline import refit_long_lines


def _tone(seconds, rate=24000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        n = int(rate * seconds)
        w.writeframes(b"".join(struct.pack("<h", 9000 if (i // 40) % 2 else -9000) for i in range(n)))
    return buf.getvalue()


class _Engine:
    def __init__(self):
        self.spoken = []

    def synthesize(self, req):
        self.spoken.append(req.text)
        return SynthesisResult(audio_bytes=_tone(0.1 * len(req.text)), engine_id="fake",
                               duration=None, seed=req.seed)


def _line(tmp_path, i, text):
    p = tmp_path / ("qwen_line_%d.wav" % i)
    p.write_bytes(_tone(0.1 * len(text)))
    return str(p)


def test_a_long_line_is_respoken_shorter_and_its_words_change(tmp_path):
    segments = [{"start": 0.0, "end": 2.0, "text": "x" * 15},      # 1.5s in 2.0s: fine
                {"start": 3.0, "end": 5.0, "text": "y" * 30}]      # 3.0s in 2.0s: 1.0s over
    paths = [_line(tmp_path, 0, segments[0]["text"]), _line(tmp_path, 1, segments[1]["text"])]
    engine = _Engine()
    asked = []

    def shorten(items):
        asked.append(items)
        return {i: "z" * budget for i, _s, _c, budget in items}

    changed = refit_long_lines(engine, segments, ["S0", "S0"], {"S0": "voice-1"}, "English",
                               paths, shorten, ["src a", "src b"], count=len)

    assert list(changed) == [1]
    assert segments[0]["text"] == "x" * 15                     # untouched
    assert segments[1]["text"] == asked[0][0][3] * "z"          # the shorter words are the line now
    assert asked[0][0][1] == "src b"
    assert line_play_durations(paths)[1] <= 2.0 + 0.05          # and the wav on disk is the short one
    assert not [f for f in os.listdir(tmp_path) if "refit" in f]  # no candidate files left behind


def test_nothing_is_touched_when_every_line_fits(tmp_path):
    segments = [{"start": 0.0, "end": 2.0, "text": "x" * 15}]
    paths = [_line(tmp_path, 0, segments[0]["text"])]
    engine = _Engine()
    changed = refit_long_lines(engine, segments, ["S0"], {"S0": "v"}, "English", paths,
                               lambda items: pytest_fail(), ["src"], count=len)
    assert changed == {} and engine.spoken == []


def pytest_fail():
    raise AssertionError("the translator must not be asked when nothing ran long")


# --- asking the translator, and what the pipeline hands over -------------------

def test_shorten_to_budgets_is_one_ask_for_every_long_line():
    from app.text.length_fit import shorten_to_budgets
    prompts = []

    class _Tr:
        def _ask(self, prompt):
            prompts.append(prompt)
            return '["짧게 하나", "짧게 둘"]'

    out = shorten_to_budgets(_Tr(), [(2, "src two", "길고 긴 문장 하나", 5), (7, "src seven", "길고 긴 문장 둘", 6)], "Korean")
    assert out == {2: "짧게 하나", 7: "짧게 둘"}
    assert len(prompts) == 1 and "within 5" in prompts[0] and "src seven" in prompts[0]


def test_the_pipeline_hands_the_refit_a_translator_only_for_its_own_translation(monkeypatch, tmp_path):
    import app.pipeline as pipeline
    seen = {}
    monkeypatch.setattr(pipeline, "run_qwen_dub", lambda *a, **kw: seen.update(kw) or "out.wav")

    class _Tr:
        max_budget_retries = 3

        def _ask(self, prompt):
            return '["짧게"]'

    segments = [{"start": 0.0, "end": 2.0, "text": "아주 길고 긴 번역 문장"}]
    sources = [{"start": 0.0, "end": 2.0, "text": "a long source line"}]
    hooks = pipeline._refit_hooks(True, _Tr(), segments, sources, "Korean")
    pipeline._stage_synthesize(segments, sources, str(tmp_path), "v.wav", "b.wav", "Korean", 1,
                               object(), None, lambda m: None, **hooks)
    assert seen["source_texts"] == ["a long source line"]
    assert seen["shorten"]([(0, "a long source line", "아주 길고 긴 번역 문장", 3)]) == {0: "짧게"}
    # The user's own subtitles are spoken as written, and a paid translator
    # (max_budget_retries 0) is not called again behind the user's back.
    assert pipeline._refit_hooks(False, _Tr(), segments, sources, "Korean") == {}
    _Tr.max_budget_retries = 0
    assert pipeline._refit_hooks(True, _Tr(), segments, sources, "Korean") == {}


def test_the_switch_turns_it_off(monkeypatch):
    import app.pipeline as pipeline
    monkeypatch.setattr(pipeline.config, "REFIT_AFTER_VOICE", False)

    class _Tr:
        max_budget_retries = 3

    assert pipeline._refit_hooks(True, _Tr(), [], [], "Korean") == {}
