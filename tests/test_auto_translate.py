# -*- coding: utf-8 -*-
"""Characterization tests for pipeline._auto_translate_srt and pipeline._carry_speaker_labels.

Both are pure-ish helpers, so no container, no ffmpeg and no network: the translator is a
fake passed in as an argument (same style as tests/test_len_fit.py's FakeEngine), and the
only side effect is writing translated.srt into a tmp_path work dir.

_auto_translate_srt is the auto-translate branch (run_dub with srt_path=None), which every
other test in the suite skips by handing run_dub a ready-made translated SRT.
"""
import json

import pytest

from app import pipeline
from app.translate import GEMINI_UPGRADE_URL, GeminiQuotaExhaustedError, GeminiUnavailableError
from app.text.srt import parse_srt


def j(arr):
    return json.dumps(arr, ensure_ascii=False)


class FakeTranslator:
    """Stands in for a TranslationEngine.

    `_ask` is what app.text.length_fit.fit_translate drives (raw JSON candidate arrays);
    `translate` is the higher-level call the pipeline uses for its own fallback and
    its wrong-language re-translation. Both record what they were asked.

    max_budget_retries=0 (what a paid engine declares) is used where a test wants to
    isolate the pipeline's own behaviour from len_fit's budget-window retry rounds --
    then the draft is exactly one `_ask` call.
    """

    def __init__(self, ask_responses=(), translate_responses=(), max_budget_retries=None):
        self.ask_responses = list(ask_responses)
        self.translate_responses = list(translate_responses)
        self.prompts = []
        self.translate_calls = []
        if max_budget_retries is not None:
            self.max_budget_retries = max_budget_retries

    def _ask(self, prompt):
        self.prompts.append(prompt)
        assert self.ask_responses, "unexpected extra _ask call:\n%s" % prompt[:200]
        return self.ask_responses.pop(0)

    def translate(self, texts, target_lang, source_lang=None, durations=None, fuller=False):
        self.translate_calls.append(
            (list(texts), target_lang, source_lang, list(durations) if durations else durations)
        )
        assert self.translate_responses, "unexpected extra translate call: %r" % (texts,)
        return list(self.translate_responses.pop(0))


class UnparseableTranslator(FakeTranslator):
    """Never returns parseable JSON, so fit_translate exhausts its format retries and
    raises ValueError -- the pipeline's fallback trigger (app/pipeline.py:127)."""

    def _ask(self, prompt):
        self.prompts.append(prompt)
        return "sorry, I can't do that"


def read_cues(path):
    with open(path, encoding="utf-8") as f:
        return parse_srt(f.read())


# --- _auto_translate_srt ---------------------------------------------------------


def test_happy_path_writes_translated_srt(tmp_path):
    # Korean CPS 4.4: a 2.0s slot budgets 10 chars and its window is [1.7, 2.3]s, so both
    # drafts fit on the first try and no retry round runs.
    src = [
        {"start": 0.0, "end": 2.0, "text": "Hello there, nice to meet you."},
        {"start": 3.0, "end": 5.0, "text": "The weather is lovely today."},
    ]
    eng = FakeTranslator(ask_responses=[
        j([["안녕하세요 반갑습니다"], ["오늘 날씨가 좋네요"]]),  # 2.27s / 1.82s -- both in window
    ])
    logs = []
    out = pipeline._auto_translate_srt(src, "ko", eng, str(tmp_path), source_lang="en", log=logs.append)

    assert out == str(tmp_path / "translated.srt")
    cues = read_cues(out)
    assert [c["text"] for c in cues] == ["안녕하세요 반갑습니다", "오늘 날씨가 좋네요"]
    assert [(c["start"], c["end"]) for c in cues] == [(0.0, 2.0), (3.0, 5.0)]
    # one draft call, and the plain translate() path is never touched
    assert len(eng.prompts) == 1
    assert eng.translate_calls == []
    # the cue's slot reached the prompt as a character budget (2.0s x 4.4 cps x 1.15 = 10)
    assert "10자 이내" in eng.prompts[0]
    assert "from en " in eng.prompts[0]


def test_translated_block_is_split_into_one_cue_per_sentence(tmp_path):
    # One source cue whose translation is two sentences -> two SRT cues, time divided in
    # proportion to character count (srt_utils.split_cues_into_sentences).
    src = [{"start": 0.0, "end": 6.0,
            "text": "Hi everyone. The weather is so nice that it's a good day for a walk."}]
    eng = FakeTranslator(ask_responses=[
        j([["안녕하세요 여러분. 오늘은 날씨가 정말 좋아서 산책하기 좋습니다."]]),  # 6.14s, window [5.1, 6.9]
    ])
    out = pipeline._auto_translate_srt(src, "ko", eng, str(tmp_path))

    cues = read_cues(out)
    assert len(cues) == 2
    assert [c["text"] for c in cues] == [
        "안녕하세요 여러분.",
        "오늘은 날씨가 정말 좋아서 산책하기 좋습니다.",
    ]
    assert cues[0]["start"] == 0.0
    assert cues[0]["end"] == cues[1]["start"] == 1.714  # 6.0s split 10:25 by character count
    assert cues[1]["end"] == 6.0


def test_source_cues_are_not_mutated(tmp_path):
    src = [{"start": 0.0, "end": 2.0, "text": "Hello there, nice to meet you.", "speaker_id": "SPK0"}]
    eng = FakeTranslator(ask_responses=[j([["안녕하세요 반갑습니다"]])])

    pipeline._auto_translate_srt(src, "ko", eng, str(tmp_path))

    assert src == [{"start": 0.0, "end": 2.0, "text": "Hello there, nice to meet you.",
                    "speaker_id": "SPK0"}]


def test_fit_translate_failure_falls_back_to_plain_translate(tmp_path):
    # app/pipeline.py:127-130 -- if the length-fit draft keeps coming back unparseable,
    # fall back to the engine's own translate() (which guarantees the line count).
    src = [{"start": 0.0, "end": 2.0, "text": "Hello there, nice to meet you."}]
    eng = UnparseableTranslator(translate_responses=[["안녕하세요 반갑습니다"]])
    logs = []

    out = pipeline._auto_translate_srt(src, "ko", eng, str(tmp_path), source_lang="en", log=logs.append)

    assert any("Length-fit translation failed" in m for m in logs)
    # the fallback gets the ORIGINAL texts, the target/source languages and the slot seconds
    assert eng.translate_calls == [(["Hello there, nice to meet you."], "ko", "en", [2.0])]
    assert [c["text"] for c in read_cues(out)] == ["안녕하세요 반갑습니다"]


def test_wrong_language_line_is_retranslated_from_the_source_text(tmp_path):
    # app/pipeline.py:134-145 -- a draft line that is not in the target script is re-asked
    # from the ORIGINAL source text (not from the bad translation).
    src = [
        {"start": 0.0, "end": 2.0, "text": "Hello there, nice to meet you."},
        {"start": 3.0, "end": 5.0, "text": "Where did Dent go?"},
    ]
    eng = FakeTranslator(
        ask_responses=[j([["안녕하세요 반갑습니다"], ["Dent, where?"]])],  # line 2 came back in English
        translate_responses=[["덴트는 어디 있죠"]],
        max_budget_retries=0,
    )
    logs = []

    out = pipeline._auto_translate_srt(src, "ko", eng, str(tmp_path), source_lang="en", log=logs.append)

    assert eng.translate_calls == [(["Where did Dent go?"], "ko", "en", [2.0])]
    assert [c["text"] for c in read_cues(out)] == ["안녕하세요 반갑습니다", "덴트는 어디 있죠"]
    assert any("1 lines not in the target language" in m for m in logs)
    assert not any("still not in the target language" in m for m in logs)


def test_second_wrong_language_round_only_asks_the_lines_still_wrong(tmp_path):
    # The bad-line list is recomputed each round, so round 2 re-asks only what round 1
    # failed to fix -- and a redo that is itself in the wrong language is discarded.
    src = [
        {"start": 0.0, "end": 2.0, "text": "Hello there, nice to meet you."},
        {"start": 3.0, "end": 5.0, "text": "Where did Dent go?"},
        {"start": 6.0, "end": 8.0, "text": "He walked out the back."},
    ]
    eng = FakeTranslator(
        ask_responses=[j([["안녕하세요 반갑습니다"], ["Dent, where?"], ["He left"]])],
        translate_responses=[
            ["덴트는 어디 있죠", "Still English"],  # round 1 fixes line 2 only
            ["그 사람 어디 갔어"],                  # round 2 fixes line 3
        ],
        max_budget_retries=0,
    )
    logs = []

    out = pipeline._auto_translate_srt(src, "ko", eng, str(tmp_path), source_lang="en", log=logs.append)

    assert eng.translate_calls == [
        (["Where did Dent go?", "He walked out the back."], "ko", "en", [2.0, 2.0]),
        (["He walked out the back."], "ko", "en", [2.0]),
    ]
    assert [c["text"] for c in read_cues(out)] == [
        "안녕하세요 반갑습니다", "덴트는 어디 있죠", "그 사람 어디 갔어",
    ]
    assert any("2 lines not in the target language" in m for m in logs)
    assert any("1 lines not in the target language" in m for m in logs)
    assert not any("still not in the target language" in m for m in logs)


def test_line_still_in_the_wrong_language_after_two_rounds_is_kept_and_warned(tmp_path):
    # app/pipeline.py:146-148 -- the retry loop is capped at 2 rounds. A line that is still
    # wrong is NOT dropped: the original bad draft (not the equally-bad redo) is written out.
    src = [
        {"start": 0.0, "end": 2.0, "text": "Hello there, nice to meet you."},
        {"start": 3.0, "end": 5.0, "text": "Where did Dent go?"},
    ]
    eng = FakeTranslator(
        ask_responses=[j([["안녕하세요 반갑습니다"], ["Dent, where?"]])],
        translate_responses=[["Where is Dent"], ["Dent? where?"]],  # both redos still English
        max_budget_retries=0,
    )
    logs = []

    out = pipeline._auto_translate_srt(src, "ko", eng, str(tmp_path), source_lang="en", log=logs.append)

    assert len(eng.translate_calls) == 2  # capped at 2 rounds
    assert [c["text"] for c in read_cues(out)] == ["안녕하세요 반갑습니다", "Dent, where?"]
    assert any("1 lines still not in the target language" in m for m in logs)


# --- _carry_speaker_labels -------------------------------------------------------


def test_carry_speaker_labels_by_midpoint():
    labelled = [
        {"start": 0.0, "end": 2.0, "text": "line one", "speaker_id": "SPK0"},
        {"start": 9.0, "end": 11.0, "text": "line two", "speaker_id": "SPK1"},
    ]
    target = [
        {"start": 0.2, "end": 1.8, "text": "script one"},
        {"start": 9.5, "end": 10.5, "text": "script two"},
    ]

    assert pipeline._carry_speaker_labels(target, labelled) is None  # mutates in place
    assert [c["speaker_id"] for c in target] == ["SPK0", "SPK1"]


def test_carry_speaker_labels_normalises_speaker_key_to_speaker_id():
    # diarize() returns its label under "speaker"; the carried label is always written to
    # "speaker_id", which is the field cue_speaker() reads first.
    labelled = [{"start": 0.0, "end": 2.0, "text": "line one", "speaker": "SPK7"}]
    target = [{"start": 0.5, "end": 1.5, "text": "script one"}]

    pipeline._carry_speaker_labels(target, labelled)

    assert target[0]["speaker_id"] == "SPK7"
    assert "speaker" not in target[0]


def test_carry_speaker_labels_leaves_unmatched_cue_alone():
    labelled = [{"start": 0.0, "end": 2.0, "text": "line one", "speaker_id": "SPK0"}]
    target = [{"start": 20.0, "end": 21.0, "text": "script one"}]

    pipeline._carry_speaker_labels(target, labelled)

    assert target == [{"start": 20.0, "end": 21.0, "text": "script one"}]


def test_carry_speaker_labels_skips_when_the_matched_line_has_no_label():
    labelled = [
        {"start": 0.0, "end": 2.0, "text": "line one"},                          # unlabelled
        {"start": 9.0, "end": 11.0, "text": "line two", "speaker_id": "SPK1"},   # labelled
    ]
    target = [{"start": 0.5, "end": 1.5, "text": "script one"}]

    pipeline._carry_speaker_labels(target, labelled)

    assert "speaker_id" not in target[0]


def test_carry_speaker_labels_does_not_overwrite_existing_labels():
    labelled = [{"start": 0.0, "end": 2.0, "text": "line one", "speaker_id": "SPK0"}]
    target = [
        {"start": 0.5, "end": 1.5, "text": "a", "speaker_id": "MINE"},
        {"start": 0.6, "end": 1.6, "text": "b", "speaker": "ALSO_MINE"},
    ]

    pipeline._carry_speaker_labels(target, labelled)

    assert target[0]["speaker_id"] == "MINE"
    assert target[1] == {"start": 0.6, "end": 1.6, "text": "b", "speaker": "ALSO_MINE"}


def test_carry_speaker_labels_is_a_noop_without_diarization():
    unlabelled = [{"start": 0.0, "end": 2.0, "text": "line one"}]
    target = [{"start": 0.5, "end": 1.5, "text": "script one"}]

    pipeline._carry_speaker_labels(target, unlabelled)   # nothing to carry
    pipeline._carry_speaker_labels(target, [])           # no transcript at all
    pipeline._carry_speaker_labels([], unlabelled)       # no script cues

    assert target == [{"start": 0.5, "end": 1.5, "text": "script one"}]


# --- run_dub: Gemini quota/outage notices (app/pipeline.py step 3) ---------------

def _stub_run_dub_until_translation(monkeypatch):
    """Stub everything run_dub touches BEFORE the translation stage (separation,
    local Whisper, CAM++). The translator under test raises there, so nothing
    after translation needs stubbing."""
    class _FakeSep:
        def separate(self, video_path, out_dir):
            return {"vocals": "/local/vocals.wav", "background": "/local/background.wav"}

    monkeypatch.setattr(pipeline, "SeparationEngine", _FakeSep)
    monkeypatch.setattr(
        pipeline, "transcribe_local",
        lambda video, language=None, log=None, on_language=None: [{"start": 0.0, "end": 2.0, "text": "hi"}],
    )
    monkeypatch.setattr(pipeline, "diarize", lambda path, cues, num_speakers=None: cues)


class _QuotaExhaustedTranslator(FakeTranslator):
    def _ask(self, prompt):
        raise GeminiQuotaExhaustedError()


class _UnavailableTranslator(FakeTranslator):
    def _ask(self, prompt):
        raise GeminiUnavailableError("Gemini server error (HTTP 503)")


def test_gemini_quota_error_fails_the_job_with_an_upgrade_notice(monkeypatch, tmp_path):
    # Same contract as the Perso credit notice (tests/test_stt_engine_wiring.py):
    # short clean error, structured notice with the link -- so the UI can pop
    # the quota dialog instead of printing a raw HTTP error.
    _stub_run_dub_until_translation(monkeypatch)
    video = tmp_path / "in.mp4"; video.write_bytes(b"vid")
    notices = []
    with pytest.raises(RuntimeError, match="quota"):
        pipeline.run_dub(
            video_path=str(video), out_path=str(tmp_path / "out.mp4"),
            srt_path=None, language="Korean", language_code="ko",
            translator=_QuotaExhaustedTranslator(), on_notice=notices.append,
        )
    assert len(notices) == 1
    assert notices[0]["type"] == "gemini_quota_exhausted"
    assert notices[0]["link"] == GEMINI_UPGRADE_URL


def test_gemini_unavailable_fails_the_job_with_a_try_later_notice(monkeypatch, tmp_path):
    # A 503 is not a quota problem: the notice carries no link (nowhere useful
    # to send the user) and the message says to retry later.
    _stub_run_dub_until_translation(monkeypatch)
    video = tmp_path / "in.mp4"; video.write_bytes(b"vid")
    notices = []
    with pytest.raises(RuntimeError, match="[Oo]verloaded"):
        pipeline.run_dub(
            video_path=str(video), out_path=str(tmp_path / "out.mp4"),
            srt_path=None, language="Korean", language_code="ko",
            translator=_UnavailableTranslator(), on_notice=notices.append,
        )
    assert len(notices) == 1
    assert notices[0]["type"] == "gemini_unavailable"
    assert "link" not in notices[0]
