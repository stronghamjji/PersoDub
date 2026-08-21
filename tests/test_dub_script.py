# -*- coding: utf-8 -*-
"""Reading a job's script, pairing it with its source, and measuring line length.

Pure logic over files only -- no container, no network, no TTS (docs/development.md).
"""
import pytest

from app.dub_script import (
    DUB_NAME, EDITED_NAME, ORIGINAL_NAME, edit_line, export_srt, load_lines, script_path,
)
from app.text.srt import build_srt


def write(path, cues):
    """Write (start, end, text) triples out as an SRT file."""
    path.write_text(
        build_srt([{"start": s, "end": e, "text": t} for s, e, t in cues]),
        encoding="utf-8",
    )


def test_pairs_translation_with_source_by_time(tmp_path):
    # Sentence splitting after translation (app/pipeline.py:235) can turn one source line
    # into two translated ones, so line numbers no longer line up -- pairing by number
    # would leave the second translation without a source. Pair by time instead.
    write(tmp_path / ORIGINAL_NAME, [(0.0, 4.0, "You have no idea what you have done.")])
    write(tmp_path / DUB_NAME, [(0.0, 2.0, "네가 무슨 짓을 했는지"), (2.0, 4.0, "넌 몰라")])

    lines = load_lines(str(tmp_path), "ko")

    assert [line["line"] for line in lines] == [1, 2]
    # both halves point at the same source line
    assert [line["source"] for line in lines] == [
        "You have no idea what you have done.",
        "You have no idea what you have done.",
    ]


def test_reports_slot_and_whether_it_fits(tmp_path):
    # Korean is estimated at 4.4 syllables/sec, so a 2.0s slot fits roughly 7.5-10 chars.
    write(tmp_path / ORIGINAL_NAME, [(0.0, 2.0, "Stay with me.")])
    write(tmp_path / DUB_NAME, [(0.0, 2.0, "이건 도저히 이 시간 안에 다 읽을 수 없는 아주 긴 문장입니다")])

    line = load_lines(str(tmp_path), "ko")[0]

    assert line["slot"] == 2.0
    assert line["estimated"] > 2.0
    assert line["fits"] is False


def test_short_line_also_does_not_fit(tmp_path):
    # A line too short for its slot leaves dead silence, so it is "not fitting" too --
    # app.text.length_fit.in_window is a window, not a ceiling.
    write(tmp_path / ORIGINAL_NAME, [(0.0, 6.0, "A very long sentence indeed.")])
    write(tmp_path / DUB_NAME, [(0.0, 6.0, "응")])

    assert load_lines(str(tmp_path), "ko")[0]["fits"] is False


def test_missing_original_leaves_source_empty(tmp_path):
    # Jobs from before original.srt existed, and jobs given a ready-made translated SRT
    # (app/main.py:315), never go through _auto_translate_srt -- still readable, no source.
    write(tmp_path / DUB_NAME, [(0.0, 2.0, "네가 무슨 짓을 했는지 넌 몰라")])

    lines = load_lines(str(tmp_path), "ko")

    assert len(lines) == 1
    assert lines[0]["source"] is None
    assert lines[0]["text"] == "네가 무슨 짓을 했는지 넌 몰라"


def test_edited_file_wins_over_the_dubbed_one(tmp_path):
    # translated.srt is what the dub actually read; edits always land in edited.srt.
    write(tmp_path / DUB_NAME, [(0.0, 2.0, "옛날 번역")])
    write(tmp_path / EDITED_NAME, [(0.0, 2.0, "고친 번역")])

    assert script_path(str(tmp_path)).endswith(EDITED_NAME)
    assert load_lines(str(tmp_path), "ko")[0]["text"] == "고친 번역"


def test_missing_script_raises_a_clear_error(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_lines(str(tmp_path), "ko")


def test_edit_writes_to_edited_and_leaves_the_dub_alone(tmp_path):
    # translated.srt is the record of what the dub actually read -- without it there is
    # nothing to compare an edit against, so edits go to edited.srt instead.
    write(tmp_path / ORIGINAL_NAME, [(0.0, 2.0, "Stay with me.")])
    write(tmp_path / DUB_NAME, [(0.0, 2.0, "나와 함께 있어주세요 제발")])  # 2.50s, overshoots

    line = edit_line(str(tmp_path), 1, "정신 차려요 지금 당장", "ko")  # 2.05s, inside [1.70, 2.30]

    assert line["line"] == 1
    assert line["text"] == "정신 차려요 지금 당장"
    assert line["fits"] is True
    assert (tmp_path / EDITED_NAME).exists()
    assert "나와 함께 있어주세요 제발" in (tmp_path / DUB_NAME).read_text(encoding="utf-8")


def test_second_edit_builds_on_the_first(tmp_path):
    write(tmp_path / DUB_NAME, [(0.0, 2.0, "첫째 줄"), (2.0, 4.0, "둘째 줄")])

    edit_line(str(tmp_path), 1, "고친 첫째", "ko")
    edit_line(str(tmp_path), 2, "고친 둘째", "ko")

    assert [ln["text"] for ln in load_lines(str(tmp_path), "ko")] == ["고친 첫째", "고친 둘째"]


def test_edit_keeps_the_timing(tmp_path):
    # Only the words change. Shifting a line's timing would pull the voice out of sync.
    write(tmp_path / DUB_NAME, [(1.5, 3.25, "옛날 번역")])

    line = edit_line(str(tmp_path), 1, "새 번역", "ko")

    assert line["start"] == 1.5
    assert line["end"] == 3.25


def test_edit_rejects_a_line_number_out_of_range(tmp_path):
    write(tmp_path / DUB_NAME, [(0.0, 2.0, "한 줄뿐")])

    with pytest.raises(ValueError) as e:
        edit_line(str(tmp_path), 7, "아무거나", "ko")
    assert "7" in str(e.value)
    assert "1" in str(e.value)  # says how many lines there actually are


def test_export_writes_the_current_script(tmp_path):
    write(tmp_path / DUB_NAME, [(0.0, 2.0, "옛날 번역")])
    out = tmp_path / "exported.srt"

    export_srt(str(tmp_path), str(out))
    assert "옛날 번역" in out.read_text(encoding="utf-8")

    edit_line(str(tmp_path), 1, "고친 번역", "ko")
    export_srt(str(tmp_path), str(out))
    assert "고친 번역" in out.read_text(encoding="utf-8")
    assert "옛날 번역" not in out.read_text(encoding="utf-8")
