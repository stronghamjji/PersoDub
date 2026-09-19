"""app/room.py: can this computer finish the dub -- room on disk, memory."""
import os
import sys

import pytest

from app import models, pipeline, room
from app.jobs import error_text_for_ui

GB = room.GB
MB = 1024 ** 2
# Captured at import, before conftest pins every test's memory to 24 GB.
_REAL_TOTAL_RAM = room.total_ram_bytes


def _video_of(monkeypatch, tmp_path, size, folder=None):
    """A video of this size in a job folder holding this much, without writing
    gigabytes to the test machine's disk."""
    video = tmp_path / "input.mp4"
    video.write_bytes(b"vid")
    monkeypatch.setattr(os.path, "getsize", lambda p: size)
    monkeypatch.setattr(room, "_folder_bytes", lambda d: size if folder is None else folder)
    return video


def test_need_is_twice_the_video_plus_its_minutes_plus_a_margin():
    # 2 x 1 GB + 0.08 GB x 60 minutes + 1 GB
    assert room.dub_need(1 * GB, 3600) == int(2 * GB + 4.8 * GB + 1 * GB)
    assert room.dub_need(1 * GB, None) == 3 * GB   # a length ffprobe would not give


def test_a_small_video_needs_the_floor_to_start_but_not_between_stages(monkeypatch, tmp_path):
    video = _video_of(monkeypatch, tmp_path, 10 * MB)
    monkeypatch.setattr(models, "free_bytes_at", lambda path: 2 * GB)
    assert room.short_of_room(str(tmp_path), str(video), 30, floor=room.FLOOR) == \
        "Not enough space. Needs 3.0 GB, 2.0 GB free."
    assert room.short_of_room(str(tmp_path), str(video), 30) is None


def test_the_message_names_both_numbers():
    assert room.space_message(8.2 * GB, 1.1 * GB) == "Not enough space. Needs 8.2 GB, 1.1 GB free."


def test_this_mac_dubs_a_26_minute_video_without_a_block_or_a_warning(monkeypatch, tmp_path):
    # The owner's own machine: 24 GB of memory, about 22 GB free, and a
    # 26-minute video of about 480 MB. Nothing new may stop or warn it.
    video = _video_of(monkeypatch, tmp_path, 480 * MB)
    monkeypatch.setattr(models, "free_bytes_at", lambda path: 22 * GB)
    assert room.dub_need(480 * MB, 26 * 60) < 5 * GB
    assert room.short_of_room(str(tmp_path), str(video), 26 * 60, floor=room.FLOOR) is None
    assert room.short_of_room(str(tmp_path), str(video), 26 * 60) is None
    assert room.ram_refusal(24 * GB) is None
    assert room.ram_warning(24 * GB, "gemma") is None
    assert room.ram_warning(24 * GB, "hunyuan") is None


def test_what_the_folder_already_holds_is_not_counted_twice(monkeypatch, tmp_path):
    # 2 GB video, 60 minutes: 9.8 GB for the whole job. Halfway, the folder
    # holds the video and 5 GB of stages, so 2.8 GB more is all it needs.
    video = _video_of(monkeypatch, tmp_path, 2 * GB, folder=7 * GB)
    monkeypatch.setattr(models, "free_bytes_at", lambda path: 3 * GB)
    assert room.short_of_room(str(tmp_path), str(video), 3600) is None
    monkeypatch.setattr(models, "free_bytes_at", lambda path: 2 * GB)
    assert room.short_of_room(str(tmp_path), str(video), 3600) == \
        "Not enough space. Needs 2.8 GB, 2.0 GB free."


def test_a_disk_or_a_video_that_will_not_say_never_stops_a_job(monkeypatch, tmp_path):
    monkeypatch.setattr(models, "free_bytes_at", lambda path: None)
    assert room.short_of_room(str(tmp_path), str(tmp_path / "input.mp4"), 60) is None
    monkeypatch.setattr(models, "free_bytes_at", lambda path: 1)
    assert room.short_of_room(str(tmp_path), str(tmp_path / "missing.mp4"), 60) is None


def test_memory_under_7_gb_is_refused_and_unknown_memory_is_not():
    assert room.ram_refusal(6 * GB) == "This computer needs 8 GB of memory to dub."
    assert room.ram_refusal(7.8 * GB) is None   # an "8 GB" computer
    assert room.ram_refusal(None) is None
    assert room.ram_warning(None, "gemma") is None


def test_memory_under_12_gb_or_gemma_under_16_gb_is_only_a_warning():
    assert room.ram_warning(10 * GB, "gemini") == "This may be slow on this computer."
    assert room.ram_warning(14 * GB, "gemma") == "This may be slow on this computer."
    assert room.ram_warning(14 * GB, "hunyuan") is None
    assert room.ram_warning(16 * GB, "gemma") is None


def test_this_computers_memory_can_be_read():
    total = _REAL_TOTAL_RAM()
    assert isinstance(total, int) and total > 1 * GB


def test_memory_that_cannot_be_read_is_none(monkeypatch):
    if sys.platform == "win32":
        pytest.skip("reads through ctypes on Windows")

    def boom(name):
        raise ValueError(name)
    monkeypatch.setattr(os, "sysconf", boom)
    assert _REAL_TOTAL_RAM() is None


# --- between stages ----------------------------------------------------------

def test_a_dub_stops_between_stages_when_the_disk_fills_up(monkeypatch, tmp_path):
    """Room before separation, none before transcription: the job fails with
    the numbers, and the stage that would have written into a full disk never
    starts."""
    video = tmp_path / "input.mp4"
    video.write_bytes(b"vid")
    readings = iter([10 * GB])
    monkeypatch.setattr(models, "free_bytes_at", lambda path: next(readings, GB // 2))
    monkeypatch.setattr(pipeline, "_video_duration", lambda path: 60.0)
    ran = []

    class _Sep:
        def __init__(self, *a, **k):
            pass

        def separate(self, video_path, out_dir):
            ran.append("separate")
            return {"vocals": "/v.wav", "background": "/b.wav"}

    monkeypatch.setattr(pipeline, "SeparationEngine", _Sep)
    monkeypatch.setattr(pipeline, "transcribe_local",
                        lambda *a, **k: ran.append("transcribe") or [])
    with pytest.raises(RuntimeError) as e:
        pipeline.run_dub(video_path=str(video), out_path=str(tmp_path / "dubbed.mp4"),
                         language="Korean", language_code="ko")
    assert ran == ["separate"]
    # A one-minute video: 1 GB margin and 0.08 GB for its minute.
    assert str(e.value) == "Not enough space. Needs 1.1 GB, 0.5 GB free."
    # What the job store shows under the red bar is the sentence itself.
    assert error_text_for_ui(e.value) == str(e.value)
