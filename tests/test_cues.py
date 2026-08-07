"""Pure-function quality helpers that survive OmniVoice's removal -- used by the
Qwen3-TTS dub path (app/qwen_pipeline.py). Everything that used to talk to the
OmniVoice container (docker exec) has been deleted along with the container itself.
"""

import pytest

from app.text import cues as quality


def test_effective_slots_adds_gap_spill():
    from app.text.cues import effective_slots
    segs = [
        {"start": 0.0, "end": 2.0},   # 1.0s of silence until the next -> borrow up to 0.4s
        {"start": 3.0, "end": 5.0},   # adjacent to the next -> own slot only
        {"start": 5.0, "end": 6.0},   # last -> own slot only
    ]
    assert effective_slots(segs) == [2.4, 2.0, 1.0]


def test_effective_slots_extends_last_seg_with_total():
    # if the full video length is known, the last segment can also spill a little into the trailing silence
    from app.text.cues import effective_slots
    segs = [{"start": 0.0, "end": 2.0}, {"start": 3.0, "end": 5.0}]
    # total 6.0s -> 1.0s of trailing silence after the last segment -> borrow up to 0.4s
    assert effective_slots(segs, total_dur=6.0) == [2.4, 2.4]
    # if the total is unknown, existing behavior (last segment gets its own slot only)
    assert effective_slots(segs) == [2.4, 2.0]


def test_match_cue_index_by_midpoint():
    from app.text.cues import match_cue_index
    cues = [{"start": 0.0, "end": 2.0}, {"start": 3.0, "end": 5.0}]
    assert match_cue_index({"start": 0.1, "end": 1.9}, cues) == 0
    assert match_cue_index({"start": 3.2, "end": 4.8}, cues) == 1
    assert match_cue_index({"start": 7.0, "end": 8.0}, cues) is None


def test_ref_text_from_spans_joins_overlapping_lines():
    from app.text.cues import ref_text_from_spans
    cues = [
        {"start": 0.0, "end": 2.0, "text": "You let five people die."},
        {"start": 3.9, "end": 6.6, "text": "Then you let Dent take your place."},
        {"start": 50.0, "end": 52.0, "text": "NOT THIS ONE"},
    ]
    t = ref_text_from_spans(cues, [[0.03, 6.77]])
    assert t == "You let five people die. Then you let Dent take your place."


def test_ref_text_from_spans_drops_short_interjections():
    from app.text.cues import ref_text_from_spans
    cues = [
        {"start": 0.0, "end": 0.6, "text": "No, no. No."},        # short interjection -> excluded
        {"start": 1.0, "end": 3.0, "text": "You let five people die."},
    ]
    assert ref_text_from_spans(cues, [[0.0, 3.0]]) == "You let five people die."


def test_ref_text_from_spans_keeps_all_when_every_line_short():
    from app.text.cues import ref_text_from_spans
    cues = [
        {"start": 0.0, "end": 0.5, "text": "No, no."},
        {"start": 0.6, "end": 1.0, "text": "Why?"},
    ]
    assert ref_text_from_spans(cues, [[0.0, 1.0]]) == "No, no. Why?"


def test_ref_text_skips_barely_touched_lines():
    # a line touching the reference audio only slightly (0.13s) is dropped from the script --
    # including it makes the model read that whole sentence (v11 measured: the English line leaked into the dub)
    from app.text.cues import ref_text_from_spans
    cues = [
        {"start": 0.07, "end": 1.64, "text": "You let five people die."},
        {"start": 3.90, "end": 6.63, "text": "Then you let Dent take your place."},
        {"start": 6.63, "end": 9.45, "text": "Even to a guy like me, that's cold."},  # overlaps only 0.14s
    ]
    t = ref_text_from_spans(cues, [[0.03, 6.77]])
    assert "Even to a guy" not in t
    assert "You let five people die." in t


def test_cut_vocals_span_local_empty_spans_returns_empty():
    from app.text.cues import cut_vocals_span_local
    assert cut_vocals_span_local("/any/path.wav", []) == b""


# --- PERSODUB_FORBID_DOCKER tripwire (default ON) -----------------------------

def test_docker_guard_forbids_by_default(monkeypatch):
    monkeypatch.delenv("PERSODUB_FORBID_DOCKER", raising=False)
    with pytest.raises(RuntimeError):
        quality._check_docker_allowed()


def test_docker_guard_can_be_disabled_for_debugging(monkeypatch):
    monkeypatch.setenv("PERSODUB_FORBID_DOCKER", "0")
    quality._check_docker_allowed()  # must not raise


def test_docker_guard_forbids_when_explicitly_set_to_1(monkeypatch):
    monkeypatch.setenv("PERSODUB_FORBID_DOCKER", "1")
    with pytest.raises(RuntimeError):
        quality._check_docker_allowed()
