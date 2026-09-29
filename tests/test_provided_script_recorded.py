"""A dub handed its translation still leaves the finished screen a script."""
import json
import os

from app import pipeline

CUES = [{"start": 0.0, "end": 1.5, "text": "안녕하세요", "speaker": "A"},
        {"start": 1.5, "end": 3.2, "text": "잘 가요", "speaker": "B"}]
SRT = "1\n00:00:00,000 --> 00:00:01,500\nHello\n\n2\n00:00:01,500 --> 00:00:03,200\nGoodbye\n"


def test_provided_subtitles_are_recorded_as_the_script(tmp_path):
    sub = tmp_path / "sub.srt"
    sub.write_text(SRT, encoding="utf-8")
    logs = []
    segments, auto = pipeline._stage_translate(str(sub), CUES, "English", "chatgpt", None,
                                               str(tmp_path), None, logs.append)
    assert auto is False and len(segments) == 2
    assert (tmp_path / "translated.srt").read_text(encoding="utf-8") == SRT
    assert "안녕하세요" in (tmp_path / "original.srt").read_text(encoding="utf-8")
    assert [s["speaker"] for s in json.loads((tmp_path / "speakers.json").read_text())] == ["A", "B"]
    from app.dub_script import load_lines
    assert [l["text"] for l in load_lines(str(tmp_path), "English")] == ["Hello", "Goodbye"]


def test_recording_never_overwrites_an_existing_script(tmp_path):
    (tmp_path / "translated.srt").write_text("kept", encoding="utf-8")
    pipeline._record_provided_script(str(tmp_path / "translated.srt"), CUES, str(tmp_path))
    assert (tmp_path / "translated.srt").read_text(encoding="utf-8") == "kept"
    assert os.path.exists(tmp_path / "original.srt")
