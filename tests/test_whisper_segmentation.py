"""Sentence segmentation in the local Whisper worker.

Whisper returns Korean (and other CJK) speech as ONE unpunctuated segment
spanning the whole clip, so the dub pipeline sees a single 24s "line", the
translator cannot fit it, and TTS synthesizes 2 lines instead of 15. The worker
re-runs with a punctuated initial_prompt and splits on sentence ends.
"""
import importlib.util
import os

SCRIPT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "app", "scripts", "whisper_transcribe.py",
)
_spec = importlib.util.spec_from_file_location("whisper_transcribe", SCRIPT)
wt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(wt)


class FakeWord:
    def __init__(self, word, start, end):
        self.word, self.start, self.end = word, start, end


def test_needs_split_on_one_unpunctuated_cue():
    cues = [{"start": 0.0, "end": 23.84, "text": "넌 꿈이 뭐니 앞으로 어떻게 살 작정이야 짜증나"}]
    assert wt.needs_split(cues) is True


def test_no_split_when_already_punctuated():
    cues = [{"start": 0.0, "end": 23.84, "text": "넌 꿈이 뭐니? 앞으로 어떻게 살 작정이야."}]
    assert wt.needs_split(cues) is False


def test_no_split_when_whisper_already_segmented():
    cues = [
        {"start": 0.0, "end": 1.0, "text": "What is your dream"},
        {"start": 1.0, "end": 2.0, "text": "How will you live"},
    ]
    assert wt.needs_split(cues) is False


def test_no_split_on_empty():
    assert wt.needs_split([]) is False


def test_split_by_sentence_uses_word_times():
    words = [
        FakeWord("넌", 0.00, 0.30), FakeWord(" 꿈이", 0.30, 0.70), FakeWord(" 뭐니?", 0.70, 1.08),
        FakeWord(" 앞으로", 1.10, 1.60), FakeWord(" 살", 1.60, 2.00), FakeWord(" 작정이야?", 2.00, 2.60),
        FakeWord(" 짜증나.", 23.26, 23.70),
    ]
    cues = wt.split_by_sentence(words)
    assert [c["text"] for c in cues] == ["넌 꿈이 뭐니?", "앞으로 살 작정이야?", "짜증나."]
    assert cues[0]["start"] == 0.0 and cues[0]["end"] == 1.08
    assert cues[1]["start"] == 1.1 and cues[1]["end"] == 2.6
    assert cues[2]["start"] == 23.26 and cues[2]["end"] == 23.7


def test_split_keeps_trailing_words_without_final_punctuation():
    words = [
        FakeWord("알겠어.", 0.0, 0.5),
        FakeWord(" 근데", 0.6, 0.9), FakeWord(" 왜", 0.9, 1.2),
    ]
    cues = wt.split_by_sentence(words)
    assert [c["text"] for c in cues] == ["알겠어.", "근데 왜"]


def test_split_of_empty_word_list():
    assert wt.split_by_sentence([]) == []


def test_korean_prompt_is_punctuated():
    # The prompt is what teaches Whisper to emit sentence marks at all.
    assert "?" in wt.SENTENCE_PROMPTS["ko"] or "." in wt.SENTENCE_PROMPTS["ko"]
