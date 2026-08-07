from app.text.srt import (
    borrow_time,
    build_srt,
    estimate_seconds,
    parse_srt,
    split_cues_into_sentences,
)

SAMPLE = """1
00:00:00,490 --> 00:00:01,414
What is your dream?

2
00:00:01,414 --> 00:00:03,410
What are you going to do with your future?
"""


def test_parse_srt_basic():
    cues = parse_srt(SAMPLE)
    assert len(cues) == 2
    assert cues[0]["text"] == "What is your dream?"
    assert abs(cues[0]["start"] - 0.49) < 0.001
    assert abs(cues[0]["end"] - 1.414) < 0.001


def test_parse_multiline_text_joined():
    srt = "1\n00:00:00,000 --> 00:00:02,000\nfirst line\nsecond line\n"
    cues = parse_srt(srt)
    assert cues[0]["text"] == "first line second line"


def test_build_srt_roundtrip():
    cues = parse_srt(SAMPLE)
    rebuilt = parse_srt(build_srt(cues))
    assert [c["text"] for c in rebuilt] == [c["text"] for c in cues]
    assert abs(rebuilt[1]["start"] - cues[1]["start"]) < 0.001


def test_split_cues_into_sentences_splits_multi_sentence():
    cues = [{"start": 0.0, "end": 6.0, "text": "What is your dream? Do you have a plan? Why fail?"}]
    out = split_cues_into_sentences(cues)
    assert len(out) == 3
    assert out[0]["text"] == "What is your dream?"
    assert out[2]["text"] == "Why fail?"
    # times stay contiguous and the original end time is preserved
    assert out[0]["start"] == 0.0
    assert out[-1]["end"] == 6.0
    assert out[0]["end"] == out[1]["start"]


def test_split_cues_single_sentence_unchanged():
    cues = [{"start": 1.0, "end": 3.0, "text": "Just one sentence."}]
    out = split_cues_into_sentences(cues)
    assert len(out) == 1
    assert out[0] == cues[0]


def test_split_merges_tiny_last_fragment():
    # if the final "Why?" ends up in a very short slot, it should be merged into the preceding sentence
    cues = [{"start": 0.0, "end": 6.0,
             "text": "You want to do ballet, but you always fail. Why?"}]
    out = split_cues_into_sentences(cues)
    # "Why?" is merged rather than left as its own sub-second fragment
    assert all((c["end"] - c["start"]) >= 0.8 for c in out)
    assert "Why?" in out[-1]["text"]
    assert out[-1]["end"] == 6.0


def test_estimate_seconds_longer_text_more_time():
    short = estimate_seconds("Hi there", "en")
    long = estimate_seconds("Hi there, this is a much longer sentence indeed", "en")
    assert long > short
    # rough estimate based on ~15 CPS for English
    assert 0.3 < short < 1.0


def test_estimate_seconds_default_for_unknown_lang():
    # an unknown language should not crash and should still return an estimate
    assert estimate_seconds("hello world", "klingon") > 0


def test_estimate_seconds_korean_ignores_punctuation():
    # syllable-based: punctuation should not affect speaking time
    assert estimate_seconds("안녕하세요.", "ko") == estimate_seconds("안녕하세요", "ko")


def test_estimate_seconds_english_counts_syllables_not_chars():
    # "through" (7 letters, 1 syllable) should be estimated shorter than "banana" (6 letters, 3 syllables)
    assert estimate_seconds("through", "en") < estimate_seconds("banana", "en")


def test_estimate_seconds_korean_rate_reasonable():
    # a 10-syllable line ~ 2.3s (2026-07-30 measured Qwen3-TTS CPS: median 4.38, using 4.4)
    sec = estimate_seconds("안녕하세요 반갑습니다", "ko")
    assert 2.0 < sec < 2.5


def test_borrow_time_merges_overflowing_cue_with_next():
    long_text = "This is a very long sentence that cannot possibly fit here"
    need = estimate_seconds(long_text, "en")
    cues = [
        {"start": 0.0, "end": need / 3, "text": long_text},   # won't fit even at 1.5x
        {"start": need / 3, "end": need * 2, "text": "Okay."},
    ]
    out = borrow_time(cues, "en")
    assert len(out) == 1
    assert out[0]["start"] == 0.0 and out[0]["end"] == need * 2
    assert "Okay." in out[0]["text"]


def test_borrow_time_leaves_fitting_cues_alone():
    cues = [
        {"start": 0.0, "end": 3.0, "text": "Hi."},
        {"start": 3.0, "end": 6.0, "text": "Bye."},
    ]
    assert borrow_time(cues, "en") == cues


def test_borrow_time_caps_at_max_group():
    long_text = "This is a very long sentence that cannot possibly fit here at all"
    need = estimate_seconds(long_text, "en")
    tiny = need / 10  # keep it short even after merging to verify the cap (3)
    cues = [
        {"start": i * tiny, "end": (i + 1) * tiny, "text": long_text} for i in range(4)
    ]
    out = borrow_time(cues, "en", max_group=3)
    assert len(out) == 2  # first 3 merged + last 1


def test_estimate_seconds_silent_e_not_counted():
    # "made" (1 syllable) should equal "mad" (1 syllable) -- trailing silent-e correction
    assert estimate_seconds("made", "en") == estimate_seconds("mad", "en")
    # when a word ends in "-le" the e is pronounced (little = 2 syllables) -- exception to the correction
    assert estimate_seconds("little", "en") > estimate_seconds("lit", "en")


def test_borrow_time_uses_gap_instead_of_merging():
    # real case (Joker, 2:23): a 0.83s slot + 3.1s of silence after (a laughter beat).
    # borrowing just 0.4s of that silence makes it fit within 1.5x, so it must not merge
    # (merging would swallow the laughter into the speech region and erase it).
    from app.text.srt import borrow_time
    cues = [
        {"start": 21.71, "end": 22.54, "text": "그럼 왜 날 죽이려 해?"},   # ~1.55s needed
        {"start": 25.65, "end": 27.43, "text": "널 죽이고 싶지 않아."},
    ]
    out = borrow_time(cues, "ko")
    assert len(out) == 2                      # must not be merged
    assert out[0]["end"] == 22.54             # timing stays unchanged too


def test_borrow_time_still_merges_when_gap_too_small():
    # adjacent lines (no silence to borrow) are still merged to borrow time, as before
    from app.text.srt import borrow_time
    cues = [
        {"start": 0.0, "end": 0.8, "text": "아주 길어서 절대로 못 들어가는 한국어 문장입니다"},
        {"start": 0.85, "end": 3.0, "text": "다음 줄"},
    ]
    out = borrow_time(cues, "ko")
    assert len(out) == 1


def test_borrow_time_never_merges_across_speakers():
    # Batman's short line must NOT be swallowed into Joker's cue (2026-07-30
    # regression: "Where's Dent?" was spoken in Joker's voice).
    long_text = "This is a very long sentence that cannot possibly fit here"
    need = estimate_seconds(long_text, "en")
    cues = [
        {"start": 0.0, "end": need / 3, "text": long_text, "speaker_id": "Joker"},
        {"start": need / 3, "end": need * 2, "text": "Where's Dent?", "speaker_id": "Batman"},
    ]
    out = borrow_time(cues, "en")
    assert len(out) == 2
    assert out[1]["text"] == "Where's Dent?"
    assert out[1]["speaker_id"] == "Batman"


def test_borrow_time_still_merges_same_speaker_with_labels():
    long_text = "This is a very long sentence that cannot possibly fit here"
    need = estimate_seconds(long_text, "en")
    cues = [
        {"start": 0.0, "end": need / 3, "text": long_text, "speaker_id": "Joker"},
        {"start": need / 3, "end": need * 2, "text": "Okay.", "speaker_id": "Joker"},
    ]
    out = borrow_time(cues, "en")
    assert len(out) == 1


def test_split_cues_preserves_speaker_id():
    # The splitter rebuilt cues as {start,end,text}, dropping every other key.
    cues = [{"start": 0.0, "end": 4.0,
             "text": "First sentence here. Second sentence here.",
             "speaker_id": "Joker"}]
    out = split_cues_into_sentences(cues)
    assert len(out) == 2
    assert [c["speaker_id"] for c in out] == ["Joker", "Joker"]


def test_split_then_borrow_never_merges_across_speakers():
    """The composed path is what production runs (app/pipeline.py:153-155).

    borrow_time's cross-speaker guard reads speaker_id. The splitter used to
    drop it, so the guard compared None != None -> False and merged anyway,
    putting one character's words in another's mouth.
    """
    joker = "This is a very long sentence that cannot possibly fit. " \
            "And this second one cannot possibly fit either."
    batman = "Where is Dent right now, answer me. Tell me immediately please."
    cues = [
        {"start": 0.0, "end": 2.0, "text": joker, "speaker_id": "Joker"},
        {"start": 2.0, "end": 4.0, "text": batman, "speaker_id": "Batman"},
    ]

    out = borrow_time(split_cues_into_sentences(cues), "en")

    for c in out:
        assert not ("fit" in c["text"] and "Dent" in c["text"]), (
            "cross-speaker merge produced: %r" % c["text"]
        )
    assert all(c.get("speaker_id") in ("Joker", "Batman") for c in out)
